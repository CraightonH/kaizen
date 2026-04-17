import { describe, expect, test } from "bun:test";
import { PluginManager } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
import { CapabilityRegistry } from "./capability-registry.js";
import type { KaizenPlugin, KaizenConfig, Executor, UiProvider } from "../types/plugin.js";

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
    capabilityRegistry: new CapabilityRegistry(),
    serviceRegistry: new ServiceRegistry(),
  };
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
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
    executorRegistry.register(stubExecutor, "test-exec");
    uiRegistry.register(stubUi, "test-ui");

    const config: KaizenConfig = { plugins: ["core-lifecycle"] };
    const lifecyclePlugin: KaizenPlugin = {
      name: "core-lifecycle",
      apiVersion: "2",
      capabilities: { provides: ["core-lifecycle:lifecycle.drive"] },
      async setup(ctx) {
        ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "lifecycle" });
        setupCalls.push("core-lifecycle");
      },
      async start() {},
    };

    const manager = new PluginManager(
      config, { "core-lifecycle": lifecyclePlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    );
    const { lifecycleProvider } = await manager.initialize();
    expect(setupCalls).toEqual(["core-lifecycle"]);
    expect(lifecycleProvider.name).toBe("core-lifecycle");
  });

  test("plugins can register tools during setup", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
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
      name: "core-lifecycle", apiVersion: "2",
      capabilities: { provides: ["core-lifecycle:lifecycle.drive"] },
      async setup(ctx) {
        ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "lifecycle" });
      },
      async start() {},
    };

    const manager = new PluginManager(
      { plugins: ["tool-plugin", "core-lifecycle"] },
      { "tool-plugin": toolPlugin, "core-lifecycle": lifecyclePlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    );
    await manager.initialize();
    expect(toolRegistry.list().map((t) => t.name)).toContain("my-tool");
  });
});

describe("PluginManager.load + unload + reload", () => {
  test("load registers a plugin's tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
    const config: KaizenConfig = { plugins: [] };
    const newPlugin = makePlugin("dyn-plugin", async (ctx) => {
      ctx.registerTool({ name: "dyn-tool", description: "", parameters: {}, execute: async () => ({ ok: true }) });
    });
    const manager = new PluginManager(
      config, { "dyn-plugin": newPlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    );
    await manager.load("dyn-plugin");
    expect(toolRegistry.list().map((t) => t.name)).toContain("dyn-tool");
  });

  test("unload deregisters a plugin's tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
    const config: KaizenConfig = { plugins: [] };
    const plugin = makePlugin("rm-plugin", async (ctx) => {
      ctx.registerTool({ name: "rm-tool", description: "", parameters: {}, execute: async () => ({ ok: true }) });
    });
    const manager = new PluginManager(
      config, { "rm-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    );
    await manager.load("rm-plugin");
    await manager.unload("rm-plugin");
    expect(toolRegistry.list().map((t) => t.name)).not.toContain("rm-tool");
  });

  test("reload replaces plugin tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
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
    const manager = new PluginManager(
      { plugins: [] }, { "swap-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
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
    const manager = new PluginManager(
      { plugins: [] }, {},
      registries.eventBus, registries.toolRegistry, registries.executorRegistry,
      registries.uiRegistry, registries.capabilityRegistry, registries.serviceRegistry,
    );
    await expect(manager.drainPendingReloads()).resolves.toBeUndefined();
  });

  test("drains queued reloads in order", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
    const drained: string[] = [];
    const pluginA = makePlugin("a", async () => { drained.push("a"); });
    const pluginB = makePlugin("b", async () => { drained.push("b"); });
    const manager = new PluginManager(
      { plugins: [] }, { a: pluginA, b: pluginB },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
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
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
    const plugin = makePlugin("listed-plugin");
    const manager = new PluginManager(
      { plugins: [] }, { "listed-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
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
    return {
      eventBus: new EventBus(),
      toolRegistry: new ToolRegistry(),
      executorRegistry: new ExecutorRegistry(),
      uiRegistry: new UiRegistry(),
      capabilityRegistry: new CapabilityRegistry(),
      serviceRegistry: new ServiceRegistry(),
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
      regs.eventBus, regs.toolRegistry, regs.executorRegistry, regs.uiRegistry, regs.capabilityRegistry, regs.serviceRegistry,
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
      regs.eventBus, regs.toolRegistry, regs.executorRegistry, regs.uiRegistry, regs.capabilityRegistry, regs.serviceRegistry,
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
      capabilities: { provides: ["core-lifecycle:lifecycle.drive"] },
      async setup(ctx) {
        ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "" });
      },
      async start() {},
    };
    const manager = new PluginManager(
      { plugins: ["owner", "consumer", "core-lifecycle"] },
      { owner, consumer, "core-lifecycle": life },
      regs.eventBus, regs.toolRegistry, regs.executorRegistry, regs.uiRegistry, regs.capabilityRegistry, regs.serviceRegistry,
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
      regs.eventBus, regs.toolRegistry, regs.executorRegistry, regs.uiRegistry, regs.capabilityRegistry, regs.serviceRegistry,
    );
    await expect(manager.initialize()).rejects.toThrow(/Cycle/i);
  });

  test("alias resolution in consumes", async () => {
    const regs = baseRegistries();
    const life: KaizenPlugin = {
      name: "core-lifecycle", apiVersion: "2",
      capabilities: { provides: ["core-lifecycle:lifecycle.drive"] },
      async setup(ctx) {
        ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "" });
      },
      async start() {},
    };
    let consumerRan = false;
    const consumer: KaizenPlugin = {
      name: "consumer", apiVersion: "2",
      aliases: { "lifecycle": "core-lifecycle:lifecycle.drive" },
      capabilities: { consumes: ["lifecycle"] },
      async setup() { consumerRan = true; },
    };
    const manager = new PluginManager(
      { plugins: ["consumer", "core-lifecycle"] },
      { consumer, "core-lifecycle": life },
      regs.eventBus, regs.toolRegistry, regs.executorRegistry, regs.uiRegistry, regs.capabilityRegistry, regs.serviceRegistry,
    );
    await manager.initialize();
    expect(consumerRan).toBe(true);
  });

  test("owner-prefix mismatch throws during setup (plugin flagged as failed when not critical)", async () => {
    const regs = baseRegistries();
    const life: KaizenPlugin = {
      name: "core-lifecycle", apiVersion: "2",
      capabilities: { provides: ["core-lifecycle:lifecycle.drive"] },
      async setup(ctx) {
        ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "" });
      },
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
      regs.eventBus, regs.toolRegistry, regs.executorRegistry, regs.uiRegistry, regs.capabilityRegistry, regs.serviceRegistry,
    );
    await manager.initialize();
    const entries = manager.list();
    expect(entries.find((e) => e.name === "bad")?.status).toBe("failed");
  });
});
