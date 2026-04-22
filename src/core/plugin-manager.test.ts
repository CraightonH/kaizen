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
import type { KaizenConfig } from "../types/plugin.js";

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
  const lockfilePath = join(mkdtempSync(join(tmpdir(), "kaizen-test-lock-")), "permissions.lock");
  const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };
  return { enforcer, auditLog, lockfilePath, options };
}

// Tracks all temp plugin dirs created in a test so we can clean them up.
const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Write a plugin to a temp dir as an ESM module and return its absolute path.
 * Uses a globalThis bridge so behaviors defined in the test (setup callbacks,
 * errors, capability calls) run when the plugin is imported in its own scope.
 */
interface PluginSpec {
  name: string;
  apiVersion?: string;
  driver?: boolean;
  capabilities?: { provides?: string[]; consumes?: string[] };
  aliases?: Record<string, string>;
  permissions?: unknown;
  /** Inline body for setup(ctx). Has access to `ctx`. */
  setupBody?: string;
  /** If true, include a start() that does nothing. */
  hasStart?: boolean;
}

function writePlugin(spec: PluginSpec): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-pm-test-${spec.name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: spec.name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  const parts: string[] = [];
  parts.push(`export default {`);
  parts.push(`  name: ${JSON.stringify(spec.name)},`);
  parts.push(`  apiVersion: ${JSON.stringify(spec.apiVersion ?? "2")},`);
  if (spec.driver) parts.push(`  driver: true,`);
  if (spec.capabilities) parts.push(`  capabilities: ${JSON.stringify(spec.capabilities)},`);
  if (spec.aliases) parts.push(`  aliases: ${JSON.stringify(spec.aliases)},`);
  if (spec.permissions !== undefined) parts.push(`  permissions: ${JSON.stringify(spec.permissions)},`);
  parts.push(`  async setup(ctx) {`);
  if (spec.setupBody) parts.push(spec.setupBody);
  parts.push(`  },`);
  if (spec.hasStart) parts.push(`  async start() {},`);
  parts.push(`};`);
  writeFileSync(join(dir, "index.mjs"), parts.join("\n"));
  return dir;
}

describe("PluginManager.initialize", () => {
  test("calls setup on all plugins and returns driver", async () => {
    const bridgeKey = `__kz_test_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };
    const lifeDir = writePlugin({
      name: "core-driver",
      driver: true,
      hasStart: true,
      setupBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("core-driver");`,
    });

    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const config: KaizenConfig = { plugins: [lifeDir] };
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      config,
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    const { driver } = await manager.initialize();
    const bridge = (globalThis as unknown as Record<string, { calls: string[] }>)[bridgeKey]!;
    expect(bridge.calls).toEqual(["core-driver"]);
    expect(driver.name).toBe("core-driver");
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("plugin with driver:true is treated as critical — setup throws are fatal", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const lifeDir = writePlugin({
      name: "core-driver",
      driver: true,
      hasStart: true,
      setupBody: `throw new Error("boom");`,
    });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [lifeDir] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(/provides critical capability.*boom/i);
  });

  test("finds session driver via driver:true flag — no capability required", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const driverDir = writePlugin({
      name: "fixture-driver",
      driver: true,
      hasStart: true,
    });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [driverDir] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    const { driver } = await manager.initialize();
    expect(driver.name).toBe("fixture-driver");
  });

  test("fatals when no plugin declares driver:true", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const dir = writePlugin({ name: "tool-only" });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [dir] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(/No driver plugin found.*driver: true/);
  });

  test("fatals with names listed when two plugins declare driver:true", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const a = writePlugin({ name: "a-driver", driver: true, hasStart: true });
    const b = writePlugin({ name: "b-driver", driver: true, hasStart: true });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [a, b] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(
      /Multiple driver plugins loaded: 'a-driver', 'b-driver'.*exactly one/,
    );
  });

  test("fatals when driver plugin has no start() function", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    // Deliberately omit start().
    const brokenDir = writePlugin({ name: "broken-driver", driver: true });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [brokenDir] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.initialize()).rejects.toThrow(
      /'broken-driver' declares 'driver: true' but does not export a start\(\) function/,
    );
  });
});

describe("PluginManager.load + unload + reload", () => {
  test("load then unload a plugin (no tools)", async () => {
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const dir = writePlugin({ name: "simple-plugin" });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load(dir);
    expect(manager.list().map((e) => e.name)).toContain("simple-plugin");
    await manager.unload(dir);
    expect(manager.list().map((e) => e.name)).not.toContain("simple-plugin");
  });
});

describe("PluginManager.drainPendingReloads", () => {
  test("no-op when queue is empty", async () => {
    const registries = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      registries.eventBus, registries.capabilityRegistry, registries.serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.drainPendingReloads()).resolves.toBeUndefined();
  });

  test("drains queued reloads in order", async () => {
    const bridgeKey = `__kz_drain_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { drained: [] as string[] };
    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const aDir = writePlugin({
      name: "a",
      setupBody: `globalThis[${JSON.stringify(bridgeKey)}].drained.push("a");`,
    });
    const bDir = writePlugin({
      name: "b",
      setupBody: `globalThis[${JSON.stringify(bridgeKey)}].drained.push("b");`,
    });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load(aDir);
    await manager.load(bDir);
    const bridge = (globalThis as unknown as Record<string, { drained: string[] }>)[bridgeKey]!;
    bridge.drained.length = 0; // reset after initial loads
    manager.queueReload(aDir);
    manager.queueReload(bDir);
    await manager.drainPendingReloads();
    expect(bridge.drained).toEqual(["a", "b"]);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
});

describe("PluginManager runtime accept-and-record (item 2)", () => {
  test("trusted external plugin on first runtime load does NOT write lockfile", async () => {
    // Create a real plugin file on disk (non-builtin path) with a TRUSTED manifest.
    // The runtime load path uses persistOnAcceptAndRecord=false, so accept-and-record
    // must not write the lockfile even when decideConsent returns that decision.
    const pluginDir = mkdtempSync(join(tmpdir(), "kaizen-test-ext-plugin-"));
    const lockDir = mkdtempSync(join(tmpdir(), "kaizen-test-lock-"));
    const lockfilePath = join(lockDir, "permissions.lock");

    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "ext-trusted", version: "1.0.0", main: "index.js" }));
    // Plugin file exports a minimal trusted plugin + driver role
    writeFileSync(join(pluginDir, "index.js"), [
      "exports.default = {",
      "  name: 'ext-trusted',",
      "  apiVersion: '2',",
      "  capabilities: { provides: [] },",
      "  permissions: { tier: 'trusted' },",
      "  async setup() {},",
      "};",
    ].join("\n"));

    const lifeDir = writePlugin({ name: "core-driver", driver: true, hasStart: true });

    const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
    const enforcer = new PermissionEnforcer({ mode: "log-only" });
    const auditLog = new AuditLog({
      rootDir: mkdtempSync(join(tmpdir(), "kaizen-test-audit-")),
      sessionId: "test",
      enabled: false,
    });
    const options = { trustLockfile: false, allowUnscoped: false, nonInteractive: true };

    // Load via absolute path so resolvedPath is non-null → consultLockfile is exercised.
    const manager = new PluginManager(
      { plugins: [pluginDir, lifeDir] },
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
    const dir = writePlugin({ name: "listed-plugin" });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] },
      eventBus, capabilityRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load(dir);
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
    const ownerDir = writePlugin({
      name: "owner",
      capabilities: { provides: [] },
      setupBody: `ctx.defineCapability("owner:thing", { cardinality: "one", description: "t" });`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      capabilities: { consumes: ["owner:thing"] },
    });
    const manager = new PluginManager(
      { plugins: [ownerDir, consumerDir] },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).rejects.toThrow();
  });

  test("two providers for a consumed 'one' capability is fatal", async () => {
    const regs = baseRegistries();
    const ownerDir = writePlugin({
      name: "owner",
      capabilities: { provides: ["owner:thing"] },
      setupBody: `ctx.defineCapability("owner:thing", { cardinality: "one", description: "" });`,
    });
    const aDir = writePlugin({ name: "a", capabilities: { provides: ["owner:thing"] } });
    const bDir = writePlugin({ name: "b", capabilities: { provides: ["owner:thing"] } });
    const consumerDir = writePlugin({ name: "consumer", capabilities: { consumes: ["owner:thing"] } });
    const manager = new PluginManager(
      { plugins: [ownerDir, aDir, bDir, consumerDir] },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).rejects.toThrow(/Multiple plugins provide/);
  });

  test("zero providers for a consumed 'many' capability is ok", async () => {
    const regs = baseRegistries();
    const ownerDir = writePlugin({
      name: "owner",
      capabilities: { provides: [] },
      setupBody: `ctx.defineCapability("owner:bag", { cardinality: "many", description: "" });`,
    });
    const consumerDir = writePlugin({ name: "consumer", capabilities: { consumes: ["owner:bag"] } });
    const lifeDir = writePlugin({ name: "core-driver", driver: true, hasStart: true });
    const manager = new PluginManager(
      { plugins: [ownerDir, consumerDir, lifeDir] },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).resolves.toBeDefined();
  });

  test("cycle in consumes graph is fatal", async () => {
    const regs = baseRegistries();
    const aDir = writePlugin({
      name: "a",
      capabilities: { provides: ["a:x"], consumes: ["b:y"] },
      setupBody: `ctx.defineCapability("a:x", { cardinality: "many", description: "" });`,
    });
    const bDir = writePlugin({
      name: "b",
      capabilities: { provides: ["b:y"], consumes: ["a:x"] },
      setupBody: `ctx.defineCapability("b:y", { cardinality: "many", description: "" });`,
    });
    const manager = new PluginManager(
      { plugins: [aDir, bDir] },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await expect(manager.initialize()).rejects.toThrow(/Cycle/i);
  });

  test("alias resolution in consumes", async () => {
    const regs = baseRegistries();
    const bridgeKey = `__kz_alias_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { ran: false };
    const lifeDir = writePlugin({
      name: "core-driver",
      driver: true,
      hasStart: true,
      capabilities: { provides: ["core-driver:executor.send"] },
      setupBody: `ctx.defineCapability("core-driver:executor.send", { cardinality: "many", description: "" });`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      aliases: { "executor": "core-driver:executor.send" },
      capabilities: { consumes: ["executor"] },
      setupBody: `globalThis[${JSON.stringify(bridgeKey)}].ran = true;`,
    });
    const manager = new PluginManager(
      { plugins: [consumerDir, lifeDir] },
      regs.eventBus, regs.capabilityRegistry, regs.serviceRegistry,
      regs.enforcer, regs.auditLog,
      regs.lockfilePath, regs.options,
    );
    await manager.initialize();
    const bridge = (globalThis as unknown as Record<string, { ran: boolean }>)[bridgeKey]!;
    expect(bridge.ran).toBe(true);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("owner-prefix mismatch throws during setup (plugin flagged as failed when not critical)", async () => {
    const regs = baseRegistries();
    const lifeDir = writePlugin({ name: "core-driver", driver: true, hasStart: true });
    const badDir = writePlugin({
      name: "bad",
      capabilities: { provides: [] },
      setupBody: `ctx.defineCapability("someoneElse:thing", { cardinality: "one", description: "" });`,
    });
    const manager = new PluginManager(
      { plugins: [badDir, lifeDir] },
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
