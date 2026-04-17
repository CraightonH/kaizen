import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager, findPackageRoot } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import type { KaizenPlugin, KaizenConfig, Executor, UiProvider } from "../types/plugin.js";

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

const stubExecutor: Executor = {
  send: async () => ({ content: "", tool_calls: [], stop_reason: "end_turn" }),
  stream: async function* () { yield { type: "done" }; },
};
const stubUi: UiProvider = { accept: async function* () {} };

function makeRegistries() {
  return {
    eventBus: new EventBus(),
    toolRegistry: new ToolRegistry(),
    executorRegistry: new ExecutorRegistry(),
    uiRegistry: new UiRegistry(),
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

function makePlugin(name: string, setupFn?: (ctx: Parameters<KaizenPlugin["setup"]>[0]) => Promise<void>): KaizenPlugin {
  return {
    name,
    apiVersion: "1",
    provides: [],
    depends: [],
    async setup(ctx) {
      await setupFn?.(ctx);
    },
  };
}

describe("PluginManager.initialize", () => {
  test("calls setup on all plugins and returns lifecycle provider", async () => {
    const setupCalls: string[] = [];
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    executorRegistry.register(stubExecutor, "test-exec");
    uiRegistry.register(stubUi, "test-ui");

    const config: KaizenConfig = { plugins: ["lifecycle-plugin"] };
    const lifecyclePlugin: KaizenPlugin = {
      name: "lifecycle-plugin",
      apiVersion: "1",
      provides: ["lifecycle"],
      depends: [],
      async setup() { setupCalls.push("lifecycle-plugin"); },
      async start() {},
    };

    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      config, { "lifecycle-plugin": lifecyclePlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    const { lifecycleProvider } = await manager.initialize();
    expect(setupCalls).toEqual(["lifecycle-plugin"]);
    expect(lifecycleProvider.name).toBe("lifecycle-plugin");
  });

  test("plugins can register tools during setup", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    executorRegistry.register(stubExecutor, "test-exec");
    uiRegistry.register(stubUi, "test-ui");

    const toolPlugin = makePlugin("tool-plugin", async (ctx) => {
      ctx.registerTool({
        name: "my-tool",
        description: "test",
        parameters: {},
        execute: async () => ({ ok: true }),
      });
    });
    const lifecyclePlugin: KaizenPlugin = {
      name: "lc", apiVersion: "1", provides: ["lifecycle"], depends: [],
      async setup() {}, async start() {},
    };

    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: ["tool-plugin", "lc"] },
      { "tool-plugin": toolPlugin, "lc": lifecyclePlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();
    expect(toolRegistry.list().map((t) => t.name)).toContain("my-tool");
  });
});

describe("PluginManager.load + unload + reload", () => {
  test("load registers a plugin's tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    const config: KaizenConfig = { plugins: [] };
    const newPlugin = makePlugin("dyn-plugin", async (ctx) => {
      ctx.registerTool({ name: "dyn-tool", description: "", parameters: {}, execute: async () => ({ ok: true }) });
    });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      config, { "dyn-plugin": newPlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load("dyn-plugin");
    expect(toolRegistry.list().map((t) => t.name)).toContain("dyn-tool");
  });

  test("unload deregisters a plugin's tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    const config: KaizenConfig = { plugins: [] };
    const plugin = makePlugin("rm-plugin", async (ctx) => {
      ctx.registerTool({ name: "rm-tool", description: "", parameters: {}, execute: async () => ({ ok: true }) });
    });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      config, { "rm-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load("rm-plugin");
    await manager.unload("rm-plugin");
    expect(toolRegistry.list().map((t) => t.name)).not.toContain("rm-tool");
  });

  test("reload replaces plugin tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    let callCount = 0;
    const plugin = makePlugin("swap-plugin", async (ctx) => {
      callCount++;
      ctx.registerTool({
        name: "swap-tool",
        description: `version-${callCount}`,
        parameters: {},
        execute: async () => ({ ok: true }),
      });
    });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, { "swap-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.load("swap-plugin");
    await manager.reload("swap-plugin");
    const tool = toolRegistry.list().find((t) => t.name === "swap-tool");
    expect(tool?.description).toBe("version-2");
  });
});

describe("PluginManager.drainPendingReloads", () => {
  test("no-op when queue is empty", async () => {
    const registries = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, {},
      registries.eventBus, registries.toolRegistry, registries.executorRegistry,
      registries.uiRegistry, registries.serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await expect(manager.drainPendingReloads()).resolves.toBeUndefined();
  });

  test("drains queued reloads in order", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    const drained: string[] = [];
    const pluginA = makePlugin("a", async () => { drained.push("a"); });
    const pluginB = makePlugin("b", async () => { drained.push("b"); });
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, { a: pluginA, b: pluginB },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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

describe("PluginManager.list", () => {
  test("returns loaded plugin entries", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    const plugin = makePlugin("listed-plugin");
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [] }, { "listed-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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
