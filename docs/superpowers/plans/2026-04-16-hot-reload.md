# Plugin Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `PluginManager` core primitive that owns plugin lifecycle — including hot-reload at turn boundaries — and expose it to plugins via `ctx.pluginManager` and to lifecycle plugins via `ctx.runtime.pluginManager.drainPendingReloads()`.

**Architecture:** `PluginManager` absorbs the existing `loader.ts` initialization logic and adds `load`, `unload`, `reload`, `queueReload`, and `drainPendingReloads`. Per-plugin state getters (always returning `"INITIALIZING"` during `setup()`) decouple plugin initialization from the global runtime state, enabling hot-reload mid-session. A thin `core-plugin-manager` plugin exposes three destructive LLM tools that queue plugin management operations for the next turn boundary.

**Tech Stack:** Bun, TypeScript, ESM/CJS interop via `createRequire`, `bun:test`

---

## File Map

| File | Action |
|------|--------|
| `src/core/tool-registry.ts` | Add `deregisterByPlugin(pluginName)` |
| `src/core/tool-registry.test.ts` | New test file |
| `src/core/event-bus.ts` | Add `pluginName` param to `defineEvent`/`on`; add `deregisterByPlugin` |
| `src/core/event-bus.test.ts` | New test file |
| `src/core/service-registry.ts` | Add `pluginName` param to `register`; add `deregisterByPlugin` |
| `src/core/service-registry.test.ts` | Add `deregisterByPlugin` tests |
| `src/core/executor-registry.ts` | Add `deregisterByPlugin(pluginName)` |
| `src/core/executor-registry.test.ts` | New test file |
| `src/core/ui-registry.ts` | Add `deregisterByPlugin(pluginName)` |
| `src/core/ui-registry.test.ts` | New test file |
| `src/types/plugin.ts` | Add `PluginEntry`, `PluginManagerPublicApi`, `PluginManagerLifecycleApi`; update `PluginContext` and `runtime` |
| `src/core/plugin-manager.ts` | New — owns all plugin lifecycle |
| `src/core/plugin-manager.test.ts` | New test file |
| `src/core/context.ts` | Accept and wire `PluginManagerPublicApi` + `PluginManagerLifecycleApi` |
| `src/core/index.ts` | Use `PluginManager`; remove `loadPlugins` import |
| `src/core/loader.ts` | Delete (logic moved to `plugin-manager.ts`) |
| `src/commands/manage.ts` | Update import from `loader.ts` → `plugin-manager.ts` |
| `plugins/core-lifecycle/index.ts` | Call `ctx.runtime.pluginManager.drainPendingReloads()` between turns |
| `plugins/core-plugin-manager/index.ts` | New plugin — LLM-facing management tools |
| `plugins/core-plugin-manager/package.json` | New package manifest |
| `harnesses/core-anthropic/kaizen.json` | Add `core-plugin-manager` to plugins list |
| `harnesses/core-debug/kaizen.json` | Add `core-plugin-manager` to plugins list |

---

## Task 1: ToolRegistry — `deregisterByPlugin`

**Files:**
- Modify: `src/core/tool-registry.ts`
- Create: `src/core/tool-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/tool-registry.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "./tool-registry.js";

const noop = async () => ({ ok: true as const });

describe("ToolRegistry.deregisterByPlugin", () => {
  test("removes only tools registered by the named plugin", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "", parameters: {}, execute: noop }, "plugin-a");
    registry.register({ name: "b", description: "", parameters: {}, execute: noop }, "plugin-b");
    registry.register({ name: "c", description: "", parameters: {}, execute: noop }, "plugin-a");
    registry.deregisterByPlugin("plugin-a");
    expect(registry.list().map((t) => t.name)).toEqual(["b"]);
  });

  test("no-op when plugin has no registered tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "x", description: "", parameters: {}, execute: noop }, "plugin-x");
    registry.deregisterByPlugin("plugin-none");
    expect(registry.list().map((t) => t.name)).toEqual(["x"]);
  });

  test("deregistered tool name can be re-registered", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "t", description: "", parameters: {}, execute: noop }, "plugin-a");
    registry.deregisterByPlugin("plugin-a");
    registry.register({ name: "t", description: "new", parameters: {}, execute: noop }, "plugin-a");
    expect(registry.list()[0]?.description).toBe("new");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/core/tool-registry.test.ts
```

Expected: FAIL — `registry.deregisterByPlugin is not a function`

- [ ] **Step 3: Add `deregisterByPlugin` to `src/core/tool-registry.ts`**

Add this method to the `ToolRegistry` class after `execute()`:

```typescript
deregisterByPlugin(pluginName: string): void {
  for (const [name, entry] of this.tools) {
    if (entry.registeredBy === pluginName) {
      this.tools.delete(name);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/core/tool-registry.test.ts
```

Expected: 3 passed, 0 failed

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-registry.ts src/core/tool-registry.test.ts
git commit -m "feat: add ToolRegistry.deregisterByPlugin"
```

---

## Task 2: EventBus — plugin tracking + `deregisterByPlugin`

**Files:**
- Modify: `src/core/event-bus.ts`
- Create: `src/core/event-bus.test.ts`

`on()` and `defineEvent()` need a `pluginName` parameter. `deregisterByPlugin` removes that plugin's handlers and event definitions.

- [ ] **Step 1: Write the failing tests**

Create `src/core/event-bus.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "./event-bus.js";

describe("EventBus.deregisterByPlugin", () => {
  test("removes only handlers registered by named plugin", async () => {
    const bus = new EventBus();
    bus.defineEvent("test:event", "plugin-a");
    const calls: string[] = [];
    bus.on("test:event", async () => { calls.push("a"); }, "plugin-a");
    bus.on("test:event", async () => { calls.push("b"); }, "plugin-b");
    bus.deregisterByPlugin("plugin-a");
    await bus.emit("test:event");
    expect(calls).toEqual(["b"]);
  });

  test("removes event definitions owned by named plugin", async () => {
    const bus = new EventBus();
    bus.defineEvent("plugin-a:event", "plugin-a");
    bus.deregisterByPlugin("plugin-a");
    // After deregister, re-defining the event must not warn about duplicate
    // (we test indirectly by re-defining without error)
    expect(() => bus.defineEvent("plugin-a:event", "plugin-a")).not.toThrow();
  });

  test("no-op when plugin has no handlers", async () => {
    const bus = new EventBus();
    bus.defineEvent("evt", "plugin-x");
    bus.on("evt", async () => {}, "plugin-x");
    bus.deregisterByPlugin("plugin-none");
    const results = await bus.emit("evt");
    expect(results).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/core/event-bus.test.ts
```

Expected: FAIL — `bus.deregisterByPlugin is not a function` (and signature mismatch on `defineEvent`/`on`)

- [ ] **Step 3: Rewrite `src/core/event-bus.ts`**

Replace the entire file with:

```typescript
import type { EventHandler } from "../types/plugin.js";
import { debug, warn } from "./errors.js";

export class EventBus {
  private defined = new Set<string>();
  private definedBy = new Map<string, string>();
  private handlers = new Map<string, Array<{ handler: EventHandler; pluginName: string }>>();

  defineEvent(name: string, pluginName: string): void {
    if (this.defined.has(name)) {
      warn(`Event '${name}' already defined. Ignoring duplicate definition.`);
      return;
    }
    this.defined.add(name);
    this.definedBy.set(name, pluginName);
  }

  on(name: string, handler: EventHandler, pluginName: string): void {
    const existing = this.handlers.get(name) ?? [];
    existing.push({ handler, pluginName });
    this.handlers.set(name, existing);
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [event, entries] of this.handlers) {
      const remaining = entries.filter((e) => e.pluginName !== pluginName);
      if (remaining.length > 0) {
        this.handlers.set(event, remaining);
      } else {
        this.handlers.delete(event);
      }
    }
    for (const [event, owner] of this.definedBy) {
      if (owner === pluginName) {
        this.defined.delete(event);
        this.definedBy.delete(event);
      }
    }
  }

  async emit(name: string, payload?: unknown): Promise<unknown[]> {
    if (!this.defined.has(name)) {
      warn(`Unknown event '${name}' — possible typo or missing plugin dependency.`);
    }
    const entries = this.handlers.get(name) ?? [];
    const results: unknown[] = [];
    for (const { handler } of entries) {
      try {
        results.push(await handler(payload));
      } catch (err) {
        debug(`Handler for event '${name}' threw: ${err}`);
        console.error(
          `[kaizen] error: handler for '${name}' threw:`,
          err instanceof Error ? err.message : err,
        );
        if (err instanceof Error && err.stack) debug(err.stack);
        results.push(undefined);
      }
    }
    return results;
  }
}
```

- [ ] **Step 4: Fix `src/core/context.ts` — pass `pluginName` to `eventBus.defineEvent` and `eventBus.on`**

In `context.ts`, update these two methods:

```typescript
defineEvent(name: string): void {
  assertInitializing(getState(), "define events");
  eventBus.defineEvent(name, pluginName);   // add pluginName
},

on(event: string, handler: Parameters<PluginContext["on"]>[1]): void {
  assertInitializing(getState(), "register event handlers");
  eventBus.on(event, handler, pluginName);  // add pluginName
},
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test src/core/event-bus.test.ts
bun test src/core/service-registry.test.ts
```

Expected: event-bus 3 passed; service-registry all pass (no changes yet)

- [ ] **Step 6: Run full typecheck**

```bash
bun x tsc --noEmit
```

Fix any type errors (likely just the EventBus signature changes in context.ts).

- [ ] **Step 7: Commit**

```bash
git add src/core/event-bus.ts src/core/event-bus.test.ts src/core/context.ts
git commit -m "feat: add EventBus.deregisterByPlugin with plugin-name tracking"
```

---

## Task 3: ServiceRegistry — plugin tracking + `deregisterByPlugin`

**Files:**
- Modify: `src/core/service-registry.ts`
- Modify: `src/core/service-registry.test.ts`
- Modify: `src/core/context.ts` (one line)

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/core/service-registry.test.ts`:

```typescript
describe("ServiceRegistry.deregisterByPlugin", () => {
  test("removes services registered by named plugin", () => {
    const tokenA = new ServiceToken<string>("SvcA");
    const tokenB = new ServiceToken<string>("SvcB");
    const registry = new ServiceRegistry();
    registry.register(tokenA, "implA", "plugin-a");
    registry.register(tokenB, "implB", "plugin-b");
    registry.deregisterByPlugin("plugin-a");
    expect(() => registry.get(tokenA)).toThrow("not found");
    expect(registry.get(tokenB)).toBe("implB");
  });

  test("deregistered token can be re-registered", () => {
    const token = new ServiceToken<string>("ResettableSvc");
    const registry = new ServiceRegistry();
    registry.register(token, "first", "plugin-a");
    registry.deregisterByPlugin("plugin-a");
    registry.register(token, "second", "plugin-a");
    expect(registry.get(token)).toBe("second");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/core/service-registry.test.ts
```

Expected: FAIL — `register` called with 3 args (type error) and `deregisterByPlugin` missing

- [ ] **Step 3: Update `src/core/service-registry.ts`**

Replace entire file:

```typescript
export class ServiceToken<T> {
  readonly label: string;
  private readonly _symbol: symbol;
  declare readonly _type: T;

  constructor(label: string) {
    this.label = label;
    this._symbol = Symbol(label);
  }
}

export class ServiceRegistry {
  private readonly services = new Map<ServiceToken<unknown>, unknown>();
  private readonly owners = new Map<ServiceToken<unknown>, string>();

  register<T>(token: ServiceToken<T>, impl: T, pluginName: string): void {
    if (this.services.has(token)) {
      throw new Error(
        `Service '${token.label}' is already registered. Each service token may only have one provider.`,
      );
    }
    this.services.set(token, impl);
    this.owners.set(token, pluginName);
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [token, owner] of this.owners) {
      if (owner === pluginName) {
        this.services.delete(token);
        this.owners.delete(token);
      }
    }
  }

  get<T>(token: ServiceToken<T>): T {
    if (!this.services.has(token)) {
      throw new Error(
        `Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin.`,
      );
    }
    return this.services.get(token) as T;
  }
}
```

- [ ] **Step 4: Fix the existing test calls — they don't pass `pluginName`**

In `src/core/service-registry.test.ts`, update all existing `registry.register(token, ...)` calls to pass a plugin name. Change:

```typescript
registry.register(token, impl);
```
to:
```typescript
registry.register(token, impl, "test-plugin");
```

Do this for every `register` call in the file that doesn't already have a third argument.

- [ ] **Step 5: Update `src/core/context.ts` — pass `pluginName` to `serviceRegistry.register`**

```typescript
registerService<T>(token: ServiceToken<T>, impl: T): void {
  assertInitializing(getState(), "register services");
  serviceRegistry.register(token, impl, pluginName);   // add pluginName
},
```

- [ ] **Step 6: Run tests**

```bash
bun test src/core/service-registry.test.ts
bun x tsc --noEmit
```

Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/service-registry.ts src/core/service-registry.test.ts src/core/context.ts
git commit -m "feat: add ServiceRegistry.deregisterByPlugin with plugin-name tracking"
```

---

## Task 4: ExecutorRegistry + UiRegistry — `deregisterByPlugin`

**Files:**
- Modify: `src/core/executor-registry.ts`
- Modify: `src/core/ui-registry.ts`
- Create: `src/core/executor-registry.test.ts`
- Create: `src/core/ui-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/core/executor-registry.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ExecutorRegistry } from "./executor-registry.js";
import type { Executor } from "../types/plugin.js";

const stubExecutor: Executor = {
  send: async () => ({ content: "", tool_calls: [], stop_reason: "end_turn" }),
  stream: async function* () { yield { type: "done" }; },
};

describe("ExecutorRegistry.deregisterByPlugin", () => {
  test("removes executor registered by named plugin", () => {
    const registry = new ExecutorRegistry();
    registry.register(stubExecutor, "plugin-exec");
    registry.deregisterByPlugin("plugin-exec");
    expect(registry.isRegistered()).toBe(false);
  });

  test("no-op when plugin name does not match", () => {
    const registry = new ExecutorRegistry();
    registry.register(stubExecutor, "plugin-exec");
    registry.deregisterByPlugin("plugin-other");
    expect(registry.isRegistered()).toBe(true);
  });

  test("deregistered executor slot can be re-registered", () => {
    const registry = new ExecutorRegistry();
    registry.register(stubExecutor, "plugin-exec");
    registry.deregisterByPlugin("plugin-exec");
    expect(() => registry.register(stubExecutor, "plugin-exec")).not.toThrow();
  });
});
```

Create `src/core/ui-registry.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { UiRegistry } from "./ui-registry.js";
import type { UiProvider } from "../types/plugin.js";

const stubUi: UiProvider = {
  accept: async function* () {},
};

describe("UiRegistry.deregisterByPlugin", () => {
  test("removes UI provider registered by named plugin", () => {
    const registry = new UiRegistry();
    registry.register(stubUi, "plugin-ui");
    registry.deregisterByPlugin("plugin-ui");
    expect(registry.isRegistered()).toBe(false);
  });

  test("no-op when plugin name does not match", () => {
    const registry = new UiRegistry();
    registry.register(stubUi, "plugin-ui");
    registry.deregisterByPlugin("plugin-other");
    expect(registry.isRegistered()).toBe(true);
  });

  test("deregistered UI slot can be re-registered", () => {
    const registry = new UiRegistry();
    registry.register(stubUi, "plugin-ui");
    registry.deregisterByPlugin("plugin-ui");
    expect(() => registry.register(stubUi, "plugin-ui")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/core/executor-registry.test.ts src/core/ui-registry.test.ts
```

Expected: FAIL — `deregisterByPlugin is not a function`

- [ ] **Step 3: Add `deregisterByPlugin` to `src/core/executor-registry.ts`**

Add after `isRegistered()`:

```typescript
deregisterByPlugin(pluginName: string): void {
  if (this.registeredBy === pluginName) {
    this.impl = null;
    this.registeredBy = null;
  }
}
```

- [ ] **Step 4: Add `deregisterByPlugin` to `src/core/ui-registry.ts`**

Add after `isRegistered()`:

```typescript
deregisterByPlugin(pluginName: string): void {
  if (this.registeredBy === pluginName) {
    this.impl = null;
    this.registeredBy = null;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
bun test src/core/executor-registry.test.ts src/core/ui-registry.test.ts
bun x tsc --noEmit
```

Expected: 6 passed, 0 failed; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor-registry.ts src/core/ui-registry.ts \
        src/core/executor-registry.test.ts src/core/ui-registry.test.ts
git commit -m "feat: add deregisterByPlugin to ExecutorRegistry and UiRegistry"
```

---

## Task 5: `types/plugin.ts` — new types + interface updates

**Files:**
- Modify: `src/types/plugin.ts`

- [ ] **Step 1: Add `PluginEntry`, `PluginManagerPublicApi`, and `PluginManagerLifecycleApi`**

Add the following after the `KaizenConfig` interface at the bottom of `src/types/plugin.ts`:

```typescript
// ---------------------------------------------------------------------------
// Plugin Manager API
// ---------------------------------------------------------------------------

export interface PluginEntry {
  name: string;
  apiVersion: string;
  provides: string[];
  status: "loaded" | "unloaded" | "failed";
}

export interface PluginManagerPublicApi {
  load(name: string): Promise<void>;
  unload(name: string): Promise<void>;
  reload(name: string): Promise<void>;
  queueLoad(name: string): void;
  queueUnload(name: string): void;
  queueReload(name: string): void;
  list(): PluginEntry[];
}

export interface PluginManagerLifecycleApi {
  drainPendingReloads(): Promise<void>;
}
```

- [ ] **Step 2: Add `pluginManager` to `PluginContext`**

In the `PluginContext` interface, add after the `config` and `log` lines:

```typescript
/** Access plugin loading/unloading at runtime. */
pluginManager: PluginManagerPublicApi;
```

- [ ] **Step 3: Add `pluginManager` to `PluginContext.runtime`**

Update the `runtime` property in `PluginContext`:

```typescript
runtime: {
  executor: Executor;
  ui: UiProvider;
  tools: {
    list(): ToolDefinition[];
    execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  };
  /** Call drainPendingReloads() between turns. Required for hot-reload support. */
  pluginManager: PluginManagerLifecycleApi;
};
```

- [ ] **Step 4: Run typecheck**

```bash
bun x tsc --noEmit
```

Expected: errors on `context.ts` (missing `pluginManager` in returned object) — that's fine, Task 7 fixes it.

- [ ] **Step 5: Commit**

```bash
git add src/types/plugin.ts
git commit -m "feat: add PluginEntry, PluginManagerPublicApi, PluginManagerLifecycleApi types"
```

---

## Task 6: Create `PluginManager`

**Files:**
- Create: `src/core/plugin-manager.ts`
- Create: `src/core/plugin-manager.test.ts`

This is the core of the feature. `PluginManager` absorbs `loadPlugins` from `loader.ts` and adds hot-reload. `loader.ts` is NOT deleted yet — that happens in Task 11.

- [ ] **Step 1: Write the failing tests**

Create `src/core/plugin-manager.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { PluginManager } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
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
    serviceRegistry: new ServiceRegistry(),
  };
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

    const manager = new PluginManager(
      config, { "lifecycle-plugin": lifecyclePlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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

    const manager = new PluginManager(
      { plugins: ["tool-plugin", "lc"] },
      { "tool-plugin": toolPlugin, "lc": lifecyclePlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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
    const manager = new PluginManager(
      config, { "dyn-plugin": newPlugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
    );
    // Minimal initialize (no lifecycle plugin needed for unit testing load/unload directly)
    await manager.load("dyn-plugin");
    expect(toolRegistry.list().map((t) => t.name)).toContain("dyn-tool");
  });

  test("unload deregisters a plugin's tools", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    const config: KaizenConfig = { plugins: [] };
    const plugin = makePlugin("rm-plugin", async (ctx) => {
      ctx.registerTool({ name: "rm-tool", description: "", parameters: {}, execute: async () => ({ ok: true }) });
    });
    const manager = new PluginManager(
      config, { "rm-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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
    const manager = new PluginManager(
      { plugins: [] }, { "swap-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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
      registries.uiRegistry, registries.serviceRegistry,
    );
    await expect(manager.drainPendingReloads()).resolves.toBeUndefined();
  });

  test("drains queued reloads in order", async () => {
    const { eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry } = makeRegistries();
    const drained: string[] = [];
    const pluginA = makePlugin("a", async () => { drained.push("a"); });
    const pluginB = makePlugin("b", async () => { drained.push("b"); });
    const manager = new PluginManager(
      { plugins: [] }, { a: pluginA, b: pluginB },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
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
    const manager = new PluginManager(
      { plugins: [] }, { "listed-plugin": plugin },
      eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
    );
    await manager.load("listed-plugin");
    const entries = manager.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("listed-plugin");
    expect(entries[0]?.status).toBe("loaded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/core/plugin-manager.test.ts
```

Expected: FAIL — `Cannot find module './plugin-manager.js'`

- [ ] **Step 3: Create `src/core/plugin-manager.ts`**

```typescript
import { createRequire } from "module";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { KaizenPlugin, KaizenConfig, PluginEntry, PluginManagerPublicApi, PluginManagerLifecycleApi } from "../types/plugin.js";
import { PLUGIN_API_VERSION } from "../types/plugin.js";
import { fatal, warn, debug } from "./errors.js";
import { RESERVED_KEYS, KAIZEN_HOME, KAIZEN_HOME_PLUGINS, PROJECT_PLUGINS } from "./config.js";
import type { EventBus } from "./event-bus.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
import type { ServiceRegistry } from "./service-registry.js";
import { createPluginContext } from "./context.js";
import type { CoreState } from "./context.js";

// ---------------------------------------------------------------------------
// Resolution paths (cached once per process)
// ---------------------------------------------------------------------------

function getBunGlobalRoot(): string {
  try {
    const line = execSync("bun pm ls --global 2>/dev/null", { timeout: 5000 })
      .toString().split("\n")[0] ?? "";
    const match = line.match(/^(\S+)\s+node_modules/);
    return match ? `${match[1]}/node_modules` : "";
  } catch { return ""; }
}

function getNpmGlobalRoot(): string {
  try {
    return execSync("npm root -g 2>/dev/null", { timeout: 5000 }).toString().trim();
  } catch { return ""; }
}

const BUN_GLOBAL_ROOT = getBunGlobalRoot();
const NPM_GLOBAL_ROOT = getNpmGlobalRoot();

export const RESOLVE_PATHS = [
  join(KAIZEN_HOME, "node_modules"),
  join(process.cwd(), ".kaizen/node_modules"),
  BUN_GLOBAL_ROOT,
  NPM_GLOBAL_ROOT,
  process.cwd() + "/node_modules",
].filter(Boolean);

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

export type Builtins = Record<string, KaizenPlugin>;

function loadPluginFromPath(path: string, name: string): KaizenPlugin | null {
  const req = createRequire(process.execPath);
  try {
    const mod = req(path) as { default?: unknown };
    const plugin = mod.default;
    if (
      typeof plugin !== "object" || plugin === null ||
      typeof (plugin as Record<string, unknown>)["name"] !== "string" ||
      typeof (plugin as Record<string, unknown>)["setup"] !== "function"
    ) {
      warn(`Plugin '${name}' does not export a valid KaizenPlugin. Skipping.`);
      return null;
    }
    return plugin as KaizenPlugin;
  } catch (err) {
    warn(`Failed to load plugin at '${path}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function resolvePlugin(name: string, builtins: Builtins): KaizenPlugin | null {
  if (builtins[name]) return builtins[name]!;
  const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");
  if (!isPath) {
    const projectPlugin = join(process.cwd(), PROJECT_PLUGINS, name);
    if (existsSync(projectPlugin)) return loadPluginFromPath(projectPlugin, name);
    const homePlugin = join(KAIZEN_HOME_PLUGINS, name);
    if (existsSync(homePlugin)) return loadPluginFromPath(homePlugin, name);
  }
  const req = createRequire(process.execPath);
  try {
    const resolved = isPath ? req.resolve(name) : req.resolve(name, { paths: RESOLVE_PATHS });
    return loadPluginFromPath(resolved, name);
  } catch (err) {
    warn(
      `Cannot find plugin '${name}'.\n` +
      `  Project-scoped: .kaizen/plugins/${name}/\n` +
      `  Global install: kaizen plugin install ${name}\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function bustRequireCache(name: string): void {
  const req = createRequire(process.execPath);
  try {
    const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");
    const resolved = isPath ? req.resolve(name) : req.resolve(name, { paths: RESOLVE_PATHS });
    delete req.cache[resolved];
  } catch {
    // Ignore — load() will surface resolution errors
  }
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

function topoSort(plugins: KaizenPlugin[]): KaizenPlugin[] {
  const nameToPlugin = new Map(plugins.map((p) => [p.name, p]));
  const roleToPlugin = new Map<string, KaizenPlugin>();
  for (const p of plugins) {
    for (const role of p.provides ?? []) roleToPlugin.set(role, p);
  }
  const inDegree = new Map(plugins.map((p) => [p.name, 0]));
  const edges = new Map<string, string[]>();
  for (const p of plugins) {
    for (const dep of p.depends ?? []) {
      const depPlugin = roleToPlugin.get(dep) ?? nameToPlugin.get(dep);
      if (!depPlugin) continue;
      const depName = depPlugin.name;
      if (depName === p.name) continue;
      const existing = edges.get(depName) ?? [];
      existing.push(p.name);
      edges.set(depName, existing);
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
    }
  }
  const queue = plugins.filter((p) => (inDegree.get(p.name) ?? 0) === 0);
  const sorted: KaizenPlugin[] = [];
  while (queue.length > 0) {
    const p = queue.shift()!;
    sorted.push(p);
    for (const dependent of edges.get(p.name) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        const plugin = nameToPlugin.get(dependent);
        if (plugin) queue.push(plugin);
      }
    }
  }
  if (sorted.length !== plugins.length) {
    fatal("Cycle detected in plugin dependencies. Check your kaizen.json 'plugins' list.");
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

interface PluginRecord {
  plugin: KaizenPlugin;
  entry: PluginEntry;
}

export class PluginManager {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly pendingLoads = new Set<string>();
  private readonly pendingUnloads = new Set<string>();
  private readonly pendingReloads = new Set<string>();

  constructor(
    private readonly config: KaizenConfig,
    private readonly builtins: Builtins,
    private readonly eventBus: EventBus,
    private readonly toolRegistry: ToolRegistry,
    private readonly executorRegistry: ExecutorRegistry,
    private readonly uiRegistry: UiRegistry,
    private readonly serviceRegistry: ServiceRegistry,
  ) {}

  // --------------------------------------------------------------------------
  // Initialization (startup path — replaces loadPlugins)
  // --------------------------------------------------------------------------

  async initialize(): Promise<{ lifecycleProvider: KaizenPlugin }> {
    const resolved: KaizenPlugin[] = [];
    for (const name of this.config.plugins) {
      if (RESERVED_KEYS.has(name)) {
        warn(`Plugin name '${name}' collides with reserved config key. Skipping.`);
        continue;
      }
      const plugin = resolvePlugin(String(name), this.builtins);
      if (plugin) resolved.push(plugin);
    }

    const sorted = topoSort(resolved);

    const requiredRoles = new Set<string>();
    for (const p of sorted) {
      for (const dep of p.depends ?? []) {
        const isPluginName = sorted.some((q) => q.name === dep);
        if (!isPluginName) requiredRoles.add(dep);
      }
    }

    const loadedNames = new Set<string>();
    for (const plugin of sorted) {
      const pluginMajor = plugin.apiVersion.split(".")[0];
      if (pluginMajor !== PLUGIN_API_VERSION) {
        warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
      }
      const providesRequiredRole = (plugin.provides ?? []).some((r) => requiredRoles.has(r));
      try {
        await this.setupPlugin(plugin);
        loadedNames.add(plugin.name);
        this.plugins.set(plugin.name, {
          plugin,
          entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "loaded" },
        });
        debug(`Plugin '${plugin.name}' initialized.`);
      } catch (err) {
        if (providesRequiredRole) {
          const role = (plugin.provides ?? []).find((r) => requiredRoles.has(r))!;
          fatal(`${plugin.name} (provides: ${role}) failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          if (err instanceof Error && err.stack) debug(err.stack);
          console.error(`[kaizen] error: plugin '${plugin.name}' failed to initialize:`, err instanceof Error ? err.message : err);
          this.plugins.set(plugin.name, {
            plugin,
            entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "failed" },
          });
        }
      }
    }

    // Role validation
    const roleProviders = new Map<string, string[]>();
    for (const [name, record] of this.plugins) {
      if (record.entry.status !== "loaded") continue;
      for (const role of record.plugin.provides ?? []) {
        const existing = roleProviders.get(role) ?? [];
        existing.push(name);
        roleProviders.set(role, existing);
      }
    }
    for (const role of requiredRoles) {
      const providers = roleProviders.get(role) ?? [];
      if (providers.length === 0) fatal(`No plugin provides role '${role}'. Add one to kaizen.json.`);
      if (providers.length > 1) fatal(`Multiple plugins provide role '${role}': ${providers.join(", ")}. Remove one.`);
    }

    // Warn on unclaimed config keys
    const claimedKeys = new Set(["plugins", ...loadedNames]);
    for (const key of Object.keys(this.config)) {
      if (!claimedKeys.has(key)) warn(`Unknown config key '${key}'. No plugin claimed it.`);
    }

    // Find lifecycle provider
    const lifecycleProviderName = roleProviders.get("lifecycle")?.[0];
    if (!lifecycleProviderName) fatal("No lifecycle plugin found. Add one to kaizen.json.");
    const lifecycleProvider = this.plugins.get(lifecycleProviderName!)?.plugin;
    if (!lifecycleProvider || typeof lifecycleProvider.start !== "function") {
      fatal("No lifecycle plugin found. Add one to kaizen.json.");
    }

    return { lifecycleProvider: lifecycleProvider! };
  }

  // --------------------------------------------------------------------------
  // Hot-reload API
  // --------------------------------------------------------------------------

  async load(name: string): Promise<void> {
    const plugin = resolvePlugin(name, this.builtins);
    if (!plugin) {
      warn(`Cannot load plugin '${name}': not found.`);
      return;
    }
    const pluginMajor = plugin.apiVersion.split(".")[0];
    if (pluginMajor !== PLUGIN_API_VERSION) {
      warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
    }
    try {
      await this.setupPlugin(plugin);
      this.plugins.set(name, {
        plugin,
        entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "loaded" },
      });
      debug(`Plugin '${name}' loaded.`);
    } catch (err) {
      this.plugins.set(name, {
        plugin,
        entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "failed" },
      });
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Plugin '${name}' failed to load: ${msg}`);
      const providesList = (plugin.provides ?? []).join(", ");
      if (providesList) warn(`Plugin '${name}' provides [${providesList}] but failed — role may be unavailable.`);
    }
  }

  async unload(name: string): Promise<void> {
    const record = this.plugins.get(name);
    if (!record) {
      warn(`Cannot unload plugin '${name}': not loaded.`);
      return;
    }
    this.toolRegistry.deregisterByPlugin(name);
    this.eventBus.deregisterByPlugin(name);
    this.serviceRegistry.deregisterByPlugin(name);
    this.executorRegistry.deregisterByPlugin(name);
    this.uiRegistry.deregisterByPlugin(name);
    record.entry.status = "unloaded";
    this.plugins.delete(name);
    debug(`Plugin '${name}' unloaded.`);
  }

  async reload(name: string): Promise<void> {
    await this.unload(name);
    bustRequireCache(name);
    await this.load(name);
  }

  queueLoad(name: string): void { this.pendingLoads.add(name); }
  queueUnload(name: string): void { this.pendingUnloads.add(name); }
  queueReload(name: string): void { this.pendingReloads.add(name); }

  async drainPendingReloads(): Promise<void> {
    const loads = [...this.pendingLoads];
    const unloads = [...this.pendingUnloads];
    const reloads = [...this.pendingReloads];
    this.pendingLoads.clear();
    this.pendingUnloads.clear();
    this.pendingReloads.clear();
    for (const name of unloads) await this.unload(name);
    for (const name of loads) await this.load(name);
    for (const name of reloads) await this.reload(name);
  }

  list(): PluginEntry[] {
    return Array.from(this.plugins.values()).map((r) => ({ ...r.entry }));
  }

  // --------------------------------------------------------------------------
  // Scoped API surfaces
  // --------------------------------------------------------------------------

  getPublicApi(): PluginManagerPublicApi {
    return {
      load: (name) => this.load(name),
      unload: (name) => this.unload(name),
      reload: (name) => this.reload(name),
      queueLoad: (name) => this.queueLoad(name),
      queueUnload: (name) => this.queueUnload(name),
      queueReload: (name) => this.queueReload(name),
      list: () => this.list(),
    };
  }

  getLifecycleApi(): PluginManagerLifecycleApi {
    return { drainPendingReloads: () => this.drainPendingReloads() };
  }

  // --------------------------------------------------------------------------
  // Internal setup
  // --------------------------------------------------------------------------

  private async setupPlugin(plugin: KaizenPlugin): Promise<void> {
    let pluginState: CoreState = "INITIALIZING";
    const pluginConfig = (this.config[plugin.name] as Record<string, unknown> | undefined) ?? {};
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      this.eventBus,
      this.toolRegistry,
      this.executorRegistry,
      this.uiRegistry,
      this.serviceRegistry,
      () => pluginState,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
    await plugin.setup(ctx);
    pluginState = "READY";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/core/plugin-manager.test.ts
```

Expected: all tests pass (note: tests that call `initialize()` with a lifecycle provider pass; `load`/`unload`/`reload` tests pass)

- [ ] **Step 5: Run typecheck**

```bash
bun x tsc --noEmit
```

Expected: errors only on `context.ts` (missing new parameters) — handled in Task 7.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager.test.ts
git commit -m "feat: add PluginManager — core plugin lifecycle primitive"
```

---

## Task 7: Update `context.ts` — wire `pluginManager` on ctx

**Files:**
- Modify: `src/core/context.ts`

- [ ] **Step 1: Update `createPluginContext` signature and return value**

Replace the entire `src/core/context.ts` with:

```typescript
import type { PluginContext, ToolDefinition, PluginManagerPublicApi, PluginManagerLifecycleApi } from "../types/plugin.js";
import type { ServiceToken } from "../types/plugin.js";
import type { EventBus } from "./event-bus.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
import type { ServiceRegistry } from "./service-registry.js";

export type CoreState = "INITIALIZING" | "READY" | "RUNNING" | "CLOSED";

function assertInitializing(state: CoreState, operation: string): void {
  if (state !== "INITIALIZING") {
    throw new Error(`Cannot ${operation} after initialization.`);
  }
}

export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  eventBus: EventBus,
  toolRegistry: ToolRegistry,
  executorRegistry: ExecutorRegistry,
  uiRegistry: UiRegistry,
  serviceRegistry: ServiceRegistry,
  getState: () => CoreState,
  pluginManagerPublicApi: PluginManagerPublicApi,
  pluginManagerLifecycleApi: PluginManagerLifecycleApi,
): PluginContext {
  return {
    config: pluginConfig,

    log(msg: string): void {
      console.log(`[${pluginName}] ${msg}`);
    },

    pluginManager: pluginManagerPublicApi,

    registerService<T>(token: ServiceToken<T>, impl: T): void {
      assertInitializing(getState(), "register services");
      serviceRegistry.register(token, impl, pluginName);
    },

    getService<T>(token: ServiceToken<T>): T {
      return serviceRegistry.get(token);
    },

    registerTool(tool: ToolDefinition): void {
      assertInitializing(getState(), "register tools");
      toolRegistry.register(tool, pluginName);
    },

    registerExecutor(impl) {
      assertInitializing(getState(), "register executor");
      executorRegistry.register(impl, pluginName);
    },

    registerUi(impl) {
      assertInitializing(getState(), "register UI provider");
      uiRegistry.register(impl, pluginName);
    },

    defineEvent(name: string): void {
      assertInitializing(getState(), "define events");
      eventBus.defineEvent(name, pluginName);
    },

    on(event: string, handler: Parameters<PluginContext["on"]>[1]): void {
      assertInitializing(getState(), "register event handlers");
      eventBus.on(event, handler, pluginName);
    },

    async emit(event: string, payload?: unknown): Promise<unknown[]> {
      return eventBus.emit(event, payload);
    },

    runtime: {
      get executor() {
        return executorRegistry.get();
      },
      get ui() {
        return uiRegistry.get();
      },
      tools: {
        list() {
          return toolRegistry.list();
        },
        execute(name: string, args: Record<string, unknown>) {
          return toolRegistry.execute(name, args);
        },
      },
      pluginManager: pluginManagerLifecycleApi,
    },
  };
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun x tsc --noEmit
```

Expected: errors on callers of `createPluginContext` that don't pass the two new args (`index.ts`). Task 8 fixes those.

- [ ] **Step 3: Commit**

```bash
git add src/core/context.ts
git commit -m "feat: wire pluginManager onto PluginContext via createPluginContext"
```

---

## Task 8: Update `index.ts` and `manage.ts`

**Files:**
- Modify: `src/core/index.ts`
- Modify: `src/commands/manage.ts`

- [ ] **Step 1: Rewrite `src/core/index.ts`**

Replace entire file:

```typescript
import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
import { PluginManager, type Builtins } from "./plugin-manager.js";
import { createPluginContext } from "./context.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";
export type { Builtins } from "./plugin-manager.js";

export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<void> {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const executorRegistry = new ExecutorRegistry();
  const uiRegistry = new UiRegistry();
  const serviceRegistry = new ServiceRegistry();

  const manager = new PluginManager(
    kaizenConfig, builtins,
    eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
  );

  const { lifecycleProvider } = await manager.initialize();

  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const ctx = createPluginContext(
    lifecycleProvider.name,
    lifecycleConfig,
    eventBus,
    toolRegistry,
    executorRegistry,
    uiRegistry,
    serviceRegistry,
    () => "RUNNING",
    manager.getPublicApi(),
    manager.getLifecycleApi(),
  );

  try {
    await lifecycleProvider.start!(ctx);
  } finally {
    // state is implicitly CLOSED after start() returns
  }
}
```

- [ ] **Step 2: Update `src/commands/manage.ts` import**

Change line 14 from:

```typescript
import { RESOLVE_PATHS } from "../core/loader.js";
```

to:

```typescript
import { RESOLVE_PATHS } from "../core/plugin-manager.js";
```

- [ ] **Step 3: Run typecheck**

```bash
bun x tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/commands/manage.ts
git commit -m "refactor: bootstrap uses PluginManager; update manage.ts import"
```

---

## Task 9: `core-lifecycle` — call `drainPendingReloads` between turns

**Files:**
- Modify: `plugins/core-lifecycle/index.ts`

The turn boundary is after the assistant response is sent to the channel and before the next `channel.receive()`.

- [ ] **Step 1: Add `drainPendingReloads()` call in `runSession`**

In `plugins/core-lifecycle/index.ts`, after the block that sends `response.content` to the channel, add the drain call. The `while (true)` loop body should end as:

```typescript
      if (response.content) {
        await channel.send({ type: "text", content: respPayload.content + "\n" });
      }

      // Drain any plugin load/unload/reload requests queued during this turn.
      await ctx.runtime.pluginManager.drainPendingReloads();
    }
```

The full updated `runSession` function is:

```typescript
async function runSession(channel: UiChannel, ctx: PluginContext, events: CoreEventsService["events"]): Promise<void> {
  const sessionId = randomUUID();
  const history: Message[] = [];

  const systemPrompt = ctx.config["systemPrompt"];
  if (typeof systemPrompt === "string") {
    history.push({ role: "system", content: systemPrompt });
  }

  await ctx.emit(events.SESSION_START, { sessionId, config: ctx.config });

  try {
    while (true) {
      let userMsg;
      try {
        userMsg = await channel.receive();
      } catch {
        break;
      }

      const msgPayload: UserMessageContext = { sessionId, content: userMsg.content };
      await ctx.emit(events.USER_MESSAGE, msgPayload);
      history.push({ role: "user", content: msgPayload.content });

      const tools = ctx.runtime.tools.list();
      const response = await ctx.runtime.executor.send(history, tools);

      const respPayload: ResponseContext = { sessionId, content: response.content };
      if (response.content) {
        await ctx.emit(events.AGENT_RESPONSE, respPayload);
      }

      history.push({
        role: "assistant",
        content: respPayload.content,
        ...(response.tool_calls.length > 0 ? { tool_calls: response.tool_calls } : {}),
      });

      for (const tc of response.tool_calls) {
        await ctx.emit(events.TOOL_BEFORE, { sessionId, tool: tc.name, args: tc.args });
        await channel.send({ type: "tool_call", name: tc.name, args: tc.args });

        const result = await ctx.runtime.tools.execute(tc.name, tc.args);
        const output = result.error ?? result.output ?? JSON.stringify(result.data) ?? "";
        history.push({ role: "tool", content: output, tool_call_id: tc.id });

        await ctx.emit(events.TOOL_AFTER, { sessionId, tool: tc.name, ok: result.ok, output });
        await channel.send({ type: "tool_result", name: tc.name, ok: result.ok, output });
      }

      if (response.content) {
        await channel.send({ type: "text", content: respPayload.content + "\n" });
      }

      await ctx.runtime.pluginManager.drainPendingReloads();
    }
  } finally {
    await ctx.emit(events.SESSION_END, { sessionId });
    await channel.close();
  }
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun x tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add plugins/core-lifecycle/index.ts
git commit -m "feat: core-lifecycle drains pending plugin reloads between turns"
```

---

## Task 10: Create `core-plugin-manager` plugin

**Files:**
- Create: `plugins/core-plugin-manager/index.ts`
- Create: `plugins/core-plugin-manager/package.json`

- [ ] **Step 1: Create `plugins/core-plugin-manager/package.json`**

```json
{
  "name": "core-plugin-manager",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"]
}
```

- [ ] **Step 2: Create `plugins/core-plugin-manager/index.ts`**

```typescript
import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-plugin-manager",
  apiVersion: "1.0.0",
  provides: [],
  depends: [],

  async setup(ctx) {
    ctx.registerTool({
      name: "kaizen_load_plugin",
      description:
        "Load a kaizen plugin by name or path. The plugin will be available after the current turn completes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin package name or path (./relative or /absolute)" },
        },
        required: ["name"],
      },
      destructive: true,
      async execute(args) {
        const name = args["name"] as string;
        ctx.pluginManager.queueLoad(name);
        return { ok: true, output: `Plugin '${name}' queued for load at next turn boundary.` };
      },
    });

    ctx.registerTool({
      name: "kaizen_unload_plugin",
      description:
        "Unload a kaizen plugin by name. The plugin will be removed after the current turn completes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name to unload" },
        },
        required: ["name"],
      },
      destructive: true,
      async execute(args) {
        const name = args["name"] as string;
        ctx.pluginManager.queueUnload(name);
        return { ok: true, output: `Plugin '${name}' queued for unload at next turn boundary.` };
      },
    });

    ctx.registerTool({
      name: "kaizen_reload_plugin",
      description:
        "Reload a kaizen plugin by name — unloads the current version and loads the latest from disk. " +
        "Use this after editing a plugin's source code. Takes effect after the current turn completes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name or path to reload" },
        },
        required: ["name"],
      },
      destructive: true,
      async execute(args) {
        const name = args["name"] as string;
        ctx.pluginManager.queueReload(name);
        return { ok: true, output: `Plugin '${name}' queued for reload at next turn boundary.` };
      },
    });
  },
};

export default plugin;
```

- [ ] **Step 3: Add `core-plugin-manager` to root `package.json` dependencies**

The `workspaces` array already uses `"plugins/*"` glob — no change needed there. Only add the dependency entry:

```json
"core-plugin-manager": "workspace:*"
```

Add it to the `dependencies` object in `package.json`, alongside the other `workspace:*` entries.

- [ ] **Step 4: Run `bun install` to link the new workspace**

```bash
bun install
```

- [ ] **Step 5: Add to `src/cli.ts` builtins**

Open `src/cli.ts` and find where built-in plugins are imported and add:

```typescript
import corePluginManager from "../plugins/core-plugin-manager/index.js";
```

Then add `"core-plugin-manager": corePluginManager` to the builtins object passed to `bootstrap()`.

- [ ] **Step 6: Run typecheck**

```bash
bun x tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add plugins/core-plugin-manager/ package.json src/cli.ts bun.lock
git commit -m "feat: add core-plugin-manager plugin with kaizen_load/unload/reload_plugin tools"
```

---

## Task 11: Update harnesses, delete `loader.ts`

**Files:**
- Modify: `harnesses/core-anthropic/kaizen.json`
- Modify: `harnesses/core-debug/kaizen.json`
- Delete: `src/core/loader.ts`

- [ ] **Step 1: Add `core-plugin-manager` to `harnesses/core-anthropic/kaizen.json`**

```json
{
  "plugins": [
    "core-events",
    "core-executor-anthropic",
    "core-ui-terminal",
    "core-cli",
    "core-plugin-manager",
    "core-lifecycle"
  ],
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  },
  "core-cli": {
    "clis": [],
    "allow_destructive": false,
    "subprocess_timeout_ms": 30000
  }
}
```

- [ ] **Step 2: Add `core-plugin-manager` to `harnesses/core-debug/kaizen.json`**

```json
{
  "plugins": [
    "core-events",
    "core-executor-debug",
    "kaizen-plugin-timestamps",
    "core-ui-terminal",
    "core-plugin-manager",
    "core-lifecycle"
  ],
  "core-executor-debug": {
    "color": true
  },
  "core-ui-terminal": {
    "responsePrefix": "\nagent: "
  }
}
```

- [ ] **Step 3: Verify no remaining imports of `loader.ts`**

```bash
grep -r "from.*loader" src/ plugins/ --include="*.ts"
```

Expected: no output (only `manage.ts` imported from loader, already fixed in Task 8).

- [ ] **Step 4: Delete `loader.ts`**

```bash
git rm src/core/loader.ts
```

- [ ] **Step 5: Run typecheck and tests**

```bash
bun x tsc --noEmit
bun test
```

Expected: no errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add harnesses/core-anthropic/kaizen.json harnesses/core-debug/kaizen.json
git commit -m "feat: add core-plugin-manager to default harnesses; remove loader.ts"
```

---

## Spec Coverage Check

| Spec requirement | Covered by |
|-----------------|-----------|
| `PluginManager` core primitive | Task 6 |
| `load`, `unload`, `reload`, `queueReload`, `drainPendingReloads`, `list` | Task 6 |
| `queueLoad`, `queueUnload` | Task 6 |
| `deregisterByPlugin` on all 5 registries | Tasks 1–4 |
| Per-plugin state for re-initialization during hot-reload | Task 6 (`setupPlugin` private method) |
| `PluginEntry` type | Task 5 |
| `PluginManagerPublicApi` + `PluginManagerLifecycleApi` types | Task 5 |
| `ctx.pluginManager` on all plugin contexts | Tasks 5, 7 |
| `ctx.runtime.pluginManager.drainPendingReloads()` on lifecycle ctx | Tasks 5, 7, 8 |
| `core-lifecycle` calls `drainPendingReloads()` between turns | Task 9 |
| `core-plugin-manager` with 3 destructive LLM tools | Task 10 |
| Graceful failure on reload (session continues, status = "failed") | Task 6 (`load` method) |
| Role-provider failure warns but doesn't crash | Task 6 (`initialize` method) |
| `loader.ts` removed; `manage.ts` import updated | Tasks 8, 11 |
| Harnesses include `core-plugin-manager` | Task 11 |
| Require cache busted on reload | Task 6 (`bustRequireCache`) |
