import { describe, expect, test, afterEach, beforeEach, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager, findPackageRoot, isInstalled } from "./plugin-manager.js";
import { pluginInstallDir } from "./kaizen-config.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import type { KaizenPlugin, KaizenConfig } from "../types/plugin.js";

describe("findPackageRoot", () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns directory itself when package.json is at the entry dir", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaizen-pkgroot-"));
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "index.js"), "");
    expect(findPackageRoot(join(tmpDir, "index.js"))).toBe(tmpDir);
  });

  test("walks up from dist/index.js to find package.json at parent", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaizen-pkgroot-"));
    mkdirSync(join(tmpDir, "dist"));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "foo", main: "dist/index.js" }));
    writeFileSync(join(tmpDir, "dist", "index.js"), "");
    const result = findPackageRoot(join(tmpDir, "dist", "index.js"));
    expect(result).toBe(tmpDir);
  });

  test("throws when no package.json found", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kaizen-pkgroot-"));
    mkdirSync(join(tmpDir, "deep", "path"), { recursive: true });
    writeFileSync(join(tmpDir, "deep", "path", "index.js"), "");
    expect(() => findPackageRoot(join(tmpDir, "deep", "path", "index.js"))).toThrow(/no package.json found/);
  });
});

function makeRegistries() {
  return {
    eventBus: new EventBus(),
    capabilityRegistry: new CapabilityRegistry(),
    serviceRegistry: new ServiceRegistry(),
  };
}

function makeSandboxStubs() {
  const enforcer = new PermissionEnforcer({ mode: "log-only" });
  const auditLog = new AuditLog({
    rootDir: mkdtempSync(join(tmpdir(), "kaizen-test-audit-")),
    sessionId: "test",
    enabled: false,
  });
  const lockfilePath = join(mkdtempSync(join(tmpdir(), "kaizen-test-lock-")), "kaizen.permissions.lock");
  const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };
  return { enforcer, auditLog, lockfilePath, options };
}

function makePlugin(
  name: string,
  setupFn?: (ctx: Parameters<KaizenPlugin["setup"]>[0]) => Promise<void>,
  capabilities?: KaizenPlugin["capabilities"],
): KaizenPlugin {
  return {
    name,
    apiVersion: "2",
    ...(capabilities ? { capabilities } : {}),
    async setup(ctx) {
      await setupFn?.(ctx);
    },
  };
}

describe("PluginManager.initialize", () => {
  test("calls setup on all plugins and returns lifecycle provider", async () => {
    const setupCalls: string[] = [];
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();

    const config: KaizenConfig = { plugins: ["core-lifecycle"] };
    const lifecyclePlugin: KaizenPlugin = {
      name: "core-lifecycle",
      apiVersion: "2",
      lifecycle: true,
      async setup() {
        setupCalls.push("core-lifecycle");
      },
      async start() {},
    };

    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      config, { "core-lifecycle": lifecyclePlugin },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    const { lifecycleProvider } = await manager.initialize();
    expect(setupCalls).toEqual(["core-lifecycle"]);
    expect(lifecycleProvider.name).toBe("core-lifecycle");
  });

  test("plugin with lifecycle:true is treated as critical — setup throws are fatal", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();

    const life: KaizenPlugin = {
      name: "core-lifecycle",
      apiVersion: "2",
      lifecycle: true,
      async setup() { throw new Error("boom"); },
      async start() {},
    };
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: ["core-lifecycle"] }, { "core-lifecycle": life },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(/provides critical capability.*boom/i);
  });

  test("finds session driver via lifecycle:true flag — no capability required", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();

    const driver: KaizenPlugin = {
      name: "fixture-lifecycle",
      apiVersion: "2",
      lifecycle: true,
      async setup() {},
      async start() {},
    };
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: ["fixture-lifecycle"] }, { "fixture-lifecycle": driver },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    const { lifecycleProvider } = await manager.initialize();
    expect(lifecycleProvider.name).toBe("fixture-lifecycle");
  });

  test("fatals when no plugin declares lifecycle:true", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const plain = makePlugin("tool-only", async () => {});
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: ["tool-only"] }, { "tool-only": plain },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(/No lifecycle plugin found.*lifecycle: true/);
  });

  test("fatals with names listed when two plugins declare lifecycle:true", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const a: KaizenPlugin = { name: "a-life", apiVersion: "2", lifecycle: true, async setup() {}, async start() {} };
    const b: KaizenPlugin = { name: "b-life", apiVersion: "2", lifecycle: true, async setup() {}, async start() {} };
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: ["a-life", "b-life"] }, { "a-life": a, "b-life": b },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(
      /Multiple lifecycle plugins loaded: 'a-life', 'b-life'.*exactly one/,
    );
  });

  test("fatals when lifecycle plugin has no start() function", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    // Deliberately omit start().
    const broken: KaizenPlugin = {
      name: "broken-life",
      apiVersion: "2",
      lifecycle: true,
      async setup() {},
    };
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: ["broken-life"] }, { "broken-life": broken },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(
      /'broken-life' declares 'lifecycle: true' but does not export a start\(\) function/,
    );
  });
});

describe("PluginManager.load + unload + reload", () => {
  test("load then unload a plugin (no tools)", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const plugin = makePlugin("simple-plugin");
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, { "simple-plugin": plugin },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load("simple-plugin");
    expect(manager.list().map((e) => e.name)).toContain("simple-plugin");
    await manager.unload("simple-plugin");
    expect(manager.list().map((e) => e.name)).not.toContain("simple-plugin");
  });
});

describe("PluginManager.drainPendingReloads", () => {
  test("no-op when queue is empty", async () => {
    const registries = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, {},
      registries.eventBus, registries.capabilityRegistry, registries.serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.drainPendingReloads()).resolves.toBeUndefined();
  });

  test("drains queued reloads in order", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const drained: string[] = [];
    const pluginA = makePlugin("a", async () => { drained.push("a"); });
    const pluginB = makePlugin("b", async () => { drained.push("b"); });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, { a: pluginA, b: pluginB },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load("a");
    await manager.load("b");
    drained.length = 0; // reset after initial loads
    manager.queueReload("a");
    manager.queueReload("b");
    await manager.drainPendingReloads();
    expect(drained).toEqual(["a", "b"]);
  });
});

describe("PluginManager runtime accept-and-record (item 2)", () => {
  test("trusted external plugin on first runtime load does NOT write lockfile", async () => {
    // Create a real plugin file on disk (non-builtin path) with a TRUSTED manifest.
    // The runtime load path uses persistOnAcceptAndRecord=false, so accept-and-record
    // must not write the lockfile even when decideConsent returns that decision.
    const pluginDir = mkdtempSync(join(tmpdir(), "kaizen-test-ext-plugin-"));
    const lockDir = mkdtempSync(join(tmpdir(), "kaizen-test-lock-"));
    const lockfilePath = join(lockDir, "kaizen.permissions.lock");

    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "ext-trusted", version: "1.0.0", main: "index.js" }));
    // Plugin file exports a minimal trusted plugin + lifecycle role
    writeFileSync(join(pluginDir, "index.js"), [
      "exports.default = {",
      "  name: 'ext-trusted',",
      "  apiVersion: '2',",
      "  capabilities: { provides: [] },",
      "  permissions: { tier: 'trusted' },",
      "  async setup() {},",
      "};",
    ].join("\n"));

    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const enforcer = new PermissionEnforcer({ mode: "log-only" });
    const auditLog = new AuditLog({
      rootDir: mkdtempSync(join(tmpdir(), "kaizen-test-audit-")),
      sessionId: "test",
      enabled: false,
    });
    const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };

    // Need a lifecycle provider for initialize() to succeed.
    const lifePlugin: KaizenPlugin = {
      name: "core-lifecycle", apiVersion: "2",
      lifecycle: true,
      async setup() {},
      async start() {},
    };

    // Load via absolute path so resolvedPath is non-null → consultLockfile is exercised.
    const manager = new PluginManager(
      { plugins: [pluginDir, "core-lifecycle"] },
      { "core-lifecycle": lifePlugin },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await manager.initialize();

    // Lockfile must NOT have been created by the runtime path.
    expect(existsSync(lockfilePath)).toBe(false);

    rmSync(pluginDir, { recursive: true, force: true });
    rmSync(lockDir, { recursive: true, force: true });
  });
});

describe("PluginManager.list", () => {
  test("returns loaded plugin entries", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const plugin = makePlugin("listed-plugin");
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, { "listed-plugin": plugin },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load("listed-plugin");
    const entries = manager.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("listed-plugin");
    expect(entries[0]?.status).toBe("loaded");
  });
});

describe("PluginManager capability validation", () => {
  function baseRegistries() {
    const stubs = makeSandboxStubs();
    return {
      eventBus: new EventBus(),
      capabilityRegistry: new CapabilityRegistry(),
      serviceRegistry: new ServiceRegistry(),
      enforcer: stubs.enforcer,
      auditLog: stubs.auditLog,
      lockfilePath: stubs.lockfilePath,
      options: stubs.options,
    };
  }

  test("zero providers for a consumed 'one' capability is fatal", async () => {
    const regs = baseRegistries();
    const owner: KaizenPlugin = {
      name: "owner", apiVersion: "2",
      capabilities: { provides: [] },
      async setup(ctx) {
        ctx.defineCapability("owner:thing", { cardinality: "one", description: "t" });
      },
    };
    const consumer: KaizenPlugin = {
      name: "consumer", apiVersion: "2",
      capabilities: { consumes: ["owner:thing"] },
      async setup() {},
    };
    const manager = new PluginManager(
      { plugins: ["owner", "consumer"] }, { owner, consumer },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).rejects.toThrow();
  });

  test("two providers for a consumed 'one' capability is fatal", async () => {
    const regs = baseRegistries();
    const owner: KaizenPlugin = {
      name: "owner", apiVersion: "2",
      capabilities: { provides: ["owner:thing"] },
      async setup(ctx) {
        ctx.defineCapability("owner:thing", { cardinality: "one", description: "" });
      },
    };
    const a: KaizenPlugin = {
      name: "a", apiVersion: "2", capabilities: { provides: ["owner:thing"] },
      async setup() {},
    };
    const b: KaizenPlugin = {
      name: "b", apiVersion: "2", capabilities: { provides: ["owner:thing"] },
      async setup() {},
    };
    const consumer: KaizenPlugin = {
      name: "consumer", apiVersion: "2", capabilities: { consumes: ["owner:thing"] },
      async setup() {},
    };
    const manager = new PluginManager(
      { plugins: ["owner", "a", "b", "consumer"] }, { owner, a, b, consumer },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).rejects.toThrow(/Multiple plugins provide/);
  });

  test("zero providers for a consumed 'many' capability is ok", async () => {
    const regs = baseRegistries();
    const owner: KaizenPlugin = {
      name: "owner", apiVersion: "2",
      capabilities: { provides: [] },
      async setup(ctx) {
        ctx.defineCapability("owner:bag", { cardinality: "many", description: "" });
      },
    };
    const consumer: KaizenPlugin = {
      name: "consumer", apiVersion: "2",
      capabilities: { consumes: ["owner:bag"] },
      async setup() {},
    };
    const life: KaizenPlugin = {
      name: "core-lifecycle", apiVersion: "2",
      lifecycle: true,
      async setup() {},
      async start() {},
    };
    const manager = new PluginManager(
      { plugins: ["owner", "consumer", "core-lifecycle"] },
      { owner, consumer, "core-lifecycle": life },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).resolves.toBeDefined();
  });

  test("cycle in consumes graph is fatal", async () => {
    const regs = baseRegistries();
    const a: KaizenPlugin = {
      name: "a", apiVersion: "2",
      capabilities: { provides: ["a:x"], consumes: ["b:y"] },
      async setup(ctx) { ctx.defineCapability("a:x", { cardinality: "many", description: "" }); },
    };
    const b: KaizenPlugin = {
      name: "b", apiVersion: "2",
      capabilities: { provides: ["b:y"], consumes: ["a:x"] },
      async setup(ctx) { ctx.defineCapability("b:y", { cardinality: "many", description: "" }); },
    };
    const manager = new PluginManager(
      { plugins: ["a", "b"] }, { a, b },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).rejects.toThrow(/Cycle/i);
  });

  test("alias resolution in consumes", async () => {
    const regs = baseRegistries();
    const life: KaizenPlugin = {
      name: "core-lifecycle", apiVersion: "2",
      lifecycle: true,
      capabilities: { provides: ["core-lifecycle:executor.send"] },
      async setup(ctx) {
        ctx.defineCapability("core-lifecycle:executor.send", { cardinality: "many", description: "" });
      },
      async start() {},
    };
    let consumerRan = false;
    const consumer: KaizenPlugin = {
      name: "consumer", apiVersion: "2",
      aliases: { "executor": "core-lifecycle:executor.send" },
      capabilities: { consumes: ["executor"] },
      async setup() { consumerRan = true; },
    };
    const manager = new PluginManager(
      { plugins: ["consumer", "core-lifecycle"] },
      { consumer, "core-lifecycle": life },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await manager.initialize();
    expect(consumerRan).toBe(true);
  });

  test("owner-prefix mismatch throws during setup (plugin flagged as failed when not critical)", async () => {
    const regs = baseRegistries();
    const life: KaizenPlugin = {
      name: "core-lifecycle", apiVersion: "2",
      lifecycle: true,
      async setup() {},
      async start() {},
    };
    const bad: KaizenPlugin = {
      name: "bad", apiVersion: "2",
      capabilities: { provides: [] },
      async setup(ctx) {
        ctx.defineCapability("someoneElse:thing", { cardinality: "one", description: "" });
      },
    };
    const manager = new PluginManager(
      { plugins: ["bad", "core-lifecycle"] },
      { bad, "core-lifecycle": life },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await manager.initialize();
    const entries = manager.list();
    expect(entries.find((e) => e.name === "bad")?.status).toBe("failed");
  });
});

describe("isInstalled(marketplaceId, name, version)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kz-home-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  it("returns false when install dir absent", async () => {
    expect(await isInstalled("m", "demo", "1.0.0")).toBe(false);
  });
  it("returns true when install dir has package.json", async () => {
    const dir = pluginInstallDir("m", "demo", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    expect(await isInstalled("m", "demo", "1.0.0")).toBe(true);
  });
});
