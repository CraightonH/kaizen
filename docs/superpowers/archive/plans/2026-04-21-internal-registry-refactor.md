# Internal Registry Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `UIRegistry`, `ExecutorRegistry`, and `ToolRegistry` from core. Collapse UI/executor/tool concepts into plugin-to-plugin concerns resolved via `CapabilityRegistry` + `ServiceRegistry`.

**Architecture:** Core retains only the generic `CapabilityRegistry` (graph validation) and `ServiceRegistry` (DI). Domain-specific registries and the `registerTool/Executor/Ui` methods on `PluginContext` are deleted along with their `runtime.*` surface. Plugins that want to play a role (UI provider, executor, tool source) declare it via `provides:` in their manifest and register their implementation through `registerService` using a shared token that the consuming plugin (driver) defines. Core enshrines no capability names and no domain concepts.

**Tech Stack:** TypeScript, Bun test runner, existing kaizen internals (`CapabilityRegistry`, `ServiceRegistry`, `PluginContext`).

**Spec:** `docs/superpowers/specs/2026-04-21-internal-registry-refactor-design.md`

**Issue:** [#21](https://github.com/CraightonH/kaizen/issues/21)

---

## File Structure

### Modified
- `src/types/plugin.ts` — remove `registerTool`, `registerExecutor`, `registerUi`, and the `runtime.executors` / `runtime.ui` / `runtime.tools` / `runtime.executor` fields from `PluginContext`. The `Executor`, `UiProvider`, `ToolDefinition`, `ToolResult`, `UiChannel`, `AgentMessage`, `UserMessage`, `LLMStreamChunk`, `LLMResponse`, `Message`, `ToolCall` types stay — they're still useful to plugin authors that opt into those shapes. They just aren't referenced by `PluginContext` anymore.
- `src/core/context.ts` — drop the removed methods and runtime accessors; drop the `toolRegistry`, `executorRegistry`, `uiRegistry` constructor params.
- `src/core/plugin-manager.ts` — drop the three registry constructor params; drop their `deregisterByPlugin` calls in `unload()`; drop them from the `createPluginContext` call in `loadPlugin`.
- `src/core/index.ts` — stop instantiating the three registries; drop them from `InitializedSystem`, `initializePluginSystem`'s return value, and `runHarness`'s `createPluginContext` call.
- `src/commands/plugin-create.ts` — remove `registerTool: mock(() => {})` from the generated plugin template's test stub.
- `src/core/plugin-manager.test.ts` — remove the registry instances from the test harness setup; rewrite tests that use `registerTool`/`registerExecutor`/`registerUi` to use `registerService` + `defineCapability` (or delete the tests if they only exercise removed behavior).

### Deleted
- `src/core/tool-registry.ts`
- `src/core/tool-registry.test.ts`
- `src/core/executor-registry.ts`
- `src/core/executor-registry.test.ts`
- `src/core/ui-registry.ts`
- `src/core/ui-registry.test.ts`

### Notes on boundaries
- Keep `ServiceRegistry` and `CapabilityRegistry` untouched.
- `PluginContext` shrinks. Do not add new fields in this refactor — resist the urge. The driver plugin (in `kaizen-official-plugins`) will define its own tokens and expose them; that work happens in that repo, after this PR lands.
- Tests for `plugin-manager` that cover cross-plugin wiring should remain; tests that only check registry plumbing go with the registries.

---

## Ground Rules

- **TDD where meaningful.** This is largely a deletion + surface-narrowing refactor. For most tasks, the "test" is the existing type checker + existing tests adapting to the new shape. Where a new integration scenario needs coverage (Task 9), write the test first.
- **Run the full test suite after every task** to make sure nothing else depends on the removed surface.
  - Command: `bun test`
  - Expected at start of this plan: all tests pass.
- **Commit after every task.** Atomic commits make the cross-repo coordination easier to follow.
- **Do not touch `kaizen-official-plugins` from this repo.** The plugin-side migration is a sibling PR — not part of this plan. The kaizen build will have no external consumers during the gap; that's acceptable for a pre-1.0 breaking change.

---

## Task 1: Baseline — confirm starting state

**Files:**
- None (verification only)

- [ ] **Step 1: Confirm clean working tree**

Run: `git status`
Expected: working tree clean, on a feature branch (not `master`). If on `master`, create a branch: `git checkout -b refactor/internal-registries`.

- [ ] **Step 2: Run full test suite to establish baseline**

Run: `bun test`
Expected: all tests pass. Record any pre-existing failures; they must stay the same after the refactor.

- [ ] **Step 3: Commit (marker)**

No changes. Skip commit for this task.

---

## Task 2: Remove `registerTool` / `registerExecutor` / `registerUi` and `runtime.*` from `PluginContext` type

**Files:**
- Modify: `src/types/plugin.ts` (lines 202–287 approx, specifically the `registerTool`, `registerExecutor`, `registerUi` members and the `runtime.executors`, `runtime.executor`, `runtime.ui`, `runtime.tools` fields)

- [ ] **Step 1: Delete the three register methods from `PluginContext`**

Remove these blocks from `src/types/plugin.ts`:

```ts
  // --- Tool registration (INITIALIZING state only) -------------------------
  registerTool(tool: ToolDefinition): void;

  // --- Executor registration (INITIALIZING state only) ---------------------
  /** Register the executor implementation. Exactly one plugin must call this. */
  registerExecutor(impl: Executor): void;

  // --- UI registration (INITIALIZING state only) ---------------------------
  /** Register the UI provider. Exactly one plugin must call this. */
  registerUi(impl: UiProvider): void;
```

- [ ] **Step 2: Shrink the `runtime` object on `PluginContext`**

Replace the current `runtime` block (the one containing `executors`, `executor`, `ui`, `tools`, `pluginManager`) with:

```ts
  runtime: {
    /** Call drainPendingReloads() between turns. Required for hot-reload support. */
    pluginManager: PluginManagerLifecycleApi;
  };
```

- [ ] **Step 3: Run typecheck / tests to surface call-site breakages**

Run: `bun test`
Expected: **many failures.** Type errors in `src/core/context.ts`, `src/core/plugin-manager.ts`, `src/core/index.ts`, `src/core/plugin-manager.test.ts`, `src/commands/plugin-create.ts`. This is expected — subsequent tasks fix each call site.

- [ ] **Step 4: Commit**

```bash
git add src/types/plugin.ts
git commit -m "refactor(types): remove registerTool/Executor/Ui and runtime.{tools,ui,executors} from PluginContext"
```

---

## Task 3: Update `context.ts` to match the narrowed `PluginContext`

**Files:**
- Modify: `src/core/context.ts`

- [ ] **Step 1: Drop the three now-unused registry imports and constructor params**

Edit `src/core/context.ts`:

Replace the imports block with:

```ts
import type { PluginContext, PluginManagerPublicApi, PluginManagerLifecycleApi, SecretsContext } from "../types/plugin.js";
import type { ServiceToken } from "../types/plugin.js";
import type { EventBus } from "./event-bus.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
import type { CapabilityRegistry } from "./capability-registry.js";
```

(The `ToolDefinition` type import is dropped because nothing in this file uses it anymore. The `ToolRegistry`, `ExecutorRegistry`, `UiRegistry` imports are dropped.)

Replace the `createPluginContext` signature and body so it no longer takes or uses the three registries. The final file should read:

```ts
import type { PluginContext, PluginManagerPublicApi, PluginManagerLifecycleApi, SecretsContext } from "../types/plugin.js";
import type { ServiceToken } from "../types/plugin.js";
import type { EventBus } from "./event-bus.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
import type { CapabilityRegistry } from "./capability-registry.js";

export type CoreState = "INITIALIZING" | "READY" | "RUNNING" | "CLOSED";

function assertInitializing(state: CoreState, operation: string): void {
  if (state !== "INITIALIZING") {
    throw new Error(`Cannot ${operation} after initialization.`);
  }
}

export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  secretsContext: SecretsContext,
  eventBus: EventBus,
  capabilityRegistry: CapabilityRegistry,
  serviceRegistry: ServiceRegistry,
  enforcer: PermissionEnforcer,
  getState: () => CoreState,
  pluginManagerPublicApi: PluginManagerPublicApi,
  pluginManagerLifecycleApi: PluginManagerLifecycleApi,
): PluginContext {
  const io = createCtxIo(pluginName, enforcer);
  return {
    config: pluginConfig,

    log(msg: string): void {
      console.log(`[${pluginName}] ${msg}`);
    },

    pluginManager: pluginManagerPublicApi,

    fs: io.fs,
    net: io.net,
    secrets: secretsContext,
    exec: io.exec,

    registerService<T>(token: ServiceToken<T>, impl: T): void {
      assertInitializing(getState(), "register services");
      serviceRegistry.register(token, impl, pluginName);
    },

    getService<T>(token: ServiceToken<T>): T {
      return serviceRegistry.get(token);
    },

    defineCapability(name, spec) {
      assertInitializing(getState(), "define capabilities");
      capabilityRegistry.define(name, pluginName, spec);
    },

    defineEvent(name: string): void {
      assertInitializing(getState(), "define events");
      eventBus.defineEvent(name, pluginName);
    },

    on(event: string, handler: Parameters<PluginContext["on"]>[1]): void {
      assertInitializing(getState(), "register event handlers");
      enforcer.check(pluginName, { kind: "events.subscribe", event });
      eventBus.on(event, handler, pluginName);
    },

    async emit(event: string, payload?: unknown): Promise<unknown[]> {
      return eventBus.emit(event, payload);
    },

    runtime: {
      pluginManager: pluginManagerLifecycleApi,
    },
  };
}
```

- [ ] **Step 2: Run typecheck / tests**

Run: `bun test`
Expected: `src/core/context.ts` itself now typechecks cleanly, but callers (`plugin-manager.ts`, `index.ts`, test harnesses) still fail because they pass the old argument list.

- [ ] **Step 3: Commit**

```bash
git add src/core/context.ts
git commit -m "refactor(context): drop tool/executor/ui registry wiring from createPluginContext"
```

---

## Task 4: Update `plugin-manager.ts` — drop registry fields and call sites

**Files:**
- Modify: `src/core/plugin-manager.ts`

- [ ] **Step 1: Remove the three registry imports**

Delete these three lines near the top of the file:

```ts
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
```

- [ ] **Step 2: Remove them from the `PluginManager` constructor**

In the `PluginManager` constructor parameter list (around line 289), delete these three lines:

```ts
    private readonly toolRegistry: ToolRegistry,
    private readonly executorRegistry: ExecutorRegistry,
    private readonly uiRegistry: UiRegistry,
```

So the constructor now reads:

```ts
  constructor(
    private readonly config: KaizenConfig,
    private readonly builtins: Builtins,
    private readonly eventBus: EventBus,
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly serviceRegistry: ServiceRegistry,
    private readonly enforcer: PermissionEnforcer,
    private readonly auditLog: AuditLog,
    private readonly lockfilePath: string,
    private readonly options: { trustLockfile: boolean; allowUnscoped: boolean; nonInteractive: boolean },
    private readonly globalConfig?: KaizenGlobalConfig,
  ) {
```

- [ ] **Step 3: Remove deregister calls in `unload()`**

In the `unload(name: string)` method (around line 547), delete these three lines:

```ts
    this.toolRegistry.deregisterByPlugin(name);
    ...
    this.executorRegistry.deregisterByPlugin(name);
    this.uiRegistry.deregisterByPlugin(name);
```

The final `unload` body should look like:

```ts
  async unload(name: string): Promise<void> {
    const record = this.plugins.get(name);
    if (!record) {
      warn(`Cannot unload plugin '${name}': not loaded.`);
      return;
    }
    this.eventBus.deregisterByPlugin(name);
    this.serviceRegistry.deregisterByPlugin(name);
    this.enforcer.deregister(name);
    this.capabilityRegistry.deregisterByPlugin(name);
    record.entry.status = "unloaded";
    this.plugins.delete(name);
    debug(`Plugin '${name}' unloaded.`);
  }
```

- [ ] **Step 4: Update the `createPluginContext` call in `loadPlugin`**

Around line 662, remove the three registry arguments:

```ts
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      secretsCtx,
      this.eventBus,
      this.capabilityRegistry,
      this.serviceRegistry,
      this.enforcer,
      () => pluginState,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
```

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: `plugin-manager.ts` now typechecks. The test file `plugin-manager.test.ts` and `src/core/index.ts` still fail — they're fixed in later tasks.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts
git commit -m "refactor(plugin-manager): drop tool/executor/ui registry fields and deregister calls"
```

---

## Task 5: Update `src/core/index.ts` — drop registry instantiation

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Replace the file with the narrowed version**

The full updated file:

```ts
import { join } from "path";
import { randomUUID } from "crypto";
import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { PluginManager, type Builtins } from "./plugin-manager.js";
import { createPluginContext } from "./context.js";
import { SecretsRegistry, createSecretsContext } from "./secrets.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import type { EnforcerMode } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import { initializeSandbox } from "./sandbox-bootstrap.js";
import { runInPluginScope } from "./plugin-scope.js";

export { CapabilityRegistry } from "./capability-registry.js";
export { PluginManager } from "./plugin-manager.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";
export type { Builtins } from "./plugin-manager.js";
export { PermissionEnforcer } from "./permission-enforcer.js";

interface InitializedSystem {
  capabilityRegistry: CapabilityRegistry;
  manager: PluginManager;
  eventBus: EventBus;
  serviceRegistry: ServiceRegistry;
  enforcer: PermissionEnforcer;
  auditLog: AuditLog;
  lifecycleProvider: Awaited<ReturnType<PluginManager["initialize"]>>["lifecycleProvider"];
}

export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
  injectedEnforcer?: PermissionEnforcer,
): Promise<InitializedSystem> {
  const eventBus = new EventBus();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();

  let enforcer: PermissionEnforcer;
  if (injectedEnforcer) {
    enforcer = injectedEnforcer;
  } else {
    const mode = (process.env["KAIZEN_SANDBOX_MODE"] as EnforcerMode | undefined) ?? "enforce";
    enforcer = new PermissionEnforcer({ mode });
    initializeSandbox(enforcer);
  }

  const auditLog = new AuditLog({
    rootDir: join(process.cwd(), ".kaizen", "audit"),
    sessionId: randomUUID(),
  });

  const trustLockfile = process.argv.includes("--trust-lockfile");
  const allowUnscoped = process.argv.includes("--allow-unscoped");
  const nonInteractive = process.argv.includes("--non-interactive");
  const lockfilePath = join(process.cwd(), "kaizen.permissions.lock");

  const manager = new PluginManager(
    kaizenConfig, builtins,
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, { trustLockfile, allowUnscoped, nonInteractive },
  );
  const { lifecycleProvider } = await manager.initialize();
  return {
    capabilityRegistry, manager, eventBus, serviceRegistry,
    enforcer, auditLog, lifecycleProvider,
  };
}

export interface RunHarnessOpts {
  kaizenConfig: KaizenConfig;
  builtins?: Builtins;
  enforcer?: PermissionEnforcer;
}

export async function runHarness(opts: RunHarnessOpts): Promise<void> {
  const { kaizenConfig, builtins = {}, enforcer: injectedEnforcer } = opts;
  const {
    manager, eventBus, capabilityRegistry, serviceRegistry, enforcer, auditLog, lifecycleProvider,
  } = await initializePluginSystem(kaizenConfig, builtins, injectedEnforcer);

  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const secretsCtx = createSecretsContext(new SecretsRegistry(), lifecycleProvider.name, {});
  const ctx = createPluginContext(
    lifecycleProvider.name,
    lifecycleConfig,
    secretsCtx,
    eventBus,
    capabilityRegistry,
    serviceRegistry,
    enforcer,
    () => "RUNNING",
    manager.getPublicApi(),
    manager.getLifecycleApi(),
  );

  try {
    await runInPluginScope(lifecycleProvider.name, async () => { await lifecycleProvider.start!(ctx); });
  } finally {
    await auditLog.flush();
  }
}

export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<void> {
  return runHarness({ kaizenConfig, builtins });
}
```

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: `src/core/index.ts` typechecks. Remaining failures: `plugin-manager.test.ts`, `plugin-create.ts`, and the three registry test files (which still exist but their referenced imports are about to be deleted — expect compile errors but that's harmless, we'll delete them next).

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts
git commit -m "refactor(core): stop instantiating tool/executor/ui registries in bootstrap"
```

---

## Task 6: Delete the three registry files and their tests

**Files:**
- Delete: `src/core/tool-registry.ts`
- Delete: `src/core/tool-registry.test.ts`
- Delete: `src/core/executor-registry.ts`
- Delete: `src/core/executor-registry.test.ts`
- Delete: `src/core/ui-registry.ts`
- Delete: `src/core/ui-registry.test.ts`

- [ ] **Step 1: Delete the six files**

Run:

```bash
rm src/core/tool-registry.ts src/core/tool-registry.test.ts \
   src/core/executor-registry.ts src/core/executor-registry.test.ts \
   src/core/ui-registry.ts src/core/ui-registry.test.ts
```

- [ ] **Step 2: Grep for any remaining references**

Run: `rg -n "tool-registry|executor-registry|ui-registry|ToolRegistry|ExecutorRegistry|UiRegistry" src/`
Expected: only matches in `src/core/plugin-manager.test.ts` (fixed in Task 7) and possibly `src/commands/plugin-create.ts` (fixed in Task 8). Zero matches elsewhere.

- [ ] **Step 3: Commit**

```bash
git add -A src/core/
git commit -m "refactor(core): delete tool-registry, executor-registry, ui-registry and tests"
```

---

## Task 7: Update `plugin-manager.test.ts`

**Files:**
- Modify: `src/core/plugin-manager.test.ts`

This test file currently instantiates all three removed registries and has several test cases that call `ctx.registerTool(...)`. Those tests were exercising core's tool plumbing, which no longer exists. They should be deleted (the behavior they test is gone). The test harness setup needs to stop instantiating the removed registries.

- [ ] **Step 1: Read the test file to understand its current structure**

Run: `rg -n "ToolRegistry|ExecutorRegistry|UiRegistry|registerTool|registerExecutor|registerUi" src/core/plugin-manager.test.ts`

Note every match. Each falls into one of two categories:
- **Harness setup** (lines around 54–56, 430–432): remove the three `new ToolRegistry()` / `new ExecutorRegistry()` / `new UiRegistry()` lines and the corresponding params passed to `new PluginManager(...)`.
- **Test cases that exercise tool/executor/ui plumbing** (lines around 125, 256, 273, 292): delete these test cases entirely. They test deleted behavior.

- [ ] **Step 2: Update the harness setup**

In the test setup object(s) that build a `PluginManager` instance, remove the three registry fields. The `PluginManager` constructor call should now pass only: `config`, `builtins`, `eventBus`, `capabilityRegistry`, `serviceRegistry`, `enforcer`, `auditLog`, `lockfilePath`, `options`.

- [ ] **Step 3: Delete tests that exercised removed surface**

For each test case that calls `ctx.registerTool(...)`, `ctx.registerExecutor(...)`, or `ctx.registerUi(...)`, delete the whole `it("...")` block. If a `describe(...)` becomes empty, delete it too.

- [ ] **Step 4: Run the test file**

Run: `bun test src/core/plugin-manager.test.ts`
Expected: all remaining tests in this file pass.

- [ ] **Step 5: Run full suite**

Run: `bun test`
Expected: all tests pass except potentially `plugin-create.ts`-related ones (fixed in Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.test.ts
git commit -m "test(plugin-manager): remove harness wiring and cases for deleted registries"
```

---

## Task 8: Update `plugin-create.ts` template

**Files:**
- Modify: `src/commands/plugin-create.ts` (line ~206)

The plugin scaffolder generates a test stub for new plugins that includes a mock `registerTool: mock(() => {})`. Since `registerTool` no longer exists on `PluginContext`, this mock line must go.

- [ ] **Step 1: Locate the test-stub generation**

Run: `rg -n "registerTool|registerExecutor|registerUi" src/commands/plugin-create.ts`

- [ ] **Step 2: Remove the `registerTool`, `registerExecutor`, `registerUi` lines from the generated test stub**

Open `src/commands/plugin-create.ts` around line 206. In the string template that generates the plugin's test file, remove any lines that mock these three methods on the fake `ctx` object.

- [ ] **Step 3: Run any tests that exercise the plugin-create command**

Run: `bun test src/commands/plugin-create.test.ts` (if it exists; else skip).
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/commands/plugin-create.ts
git commit -m "refactor(plugin-create): drop mocks for removed ctx.register{Tool,Executor,Ui}"
```

---

## Task 9: Add integration test for capability-driven driver hand-off (TDD)

**Files:**
- Create: `src/core/integration/driver-capability-resolution.test.ts`

This test exercises the new model: a plugin that consumes a capability name (simulating what a driver plugin like `core-lifecycle` will do) correctly resolves the provider via `CapabilityRegistry`, and cardinality violations are fatal.

Since core no longer knows about UIs or executors, the test uses generic fabricated capability names (`test-driver:collaborator`, `test-helper:thing`) — not `kaizen.ui` or anything domain-flavored. Core holds zero opinion on names; the test reflects that.

- [ ] **Step 1: Write the failing test**

Create `src/core/integration/driver-capability-resolution.test.ts` with:

```ts
import { describe, it, expect } from "bun:test";
import { PluginManager } from "../plugin-manager.js";
import { EventBus } from "../event-bus.js";
import { ServiceRegistry } from "../service-registry.js";
import { CapabilityRegistry } from "../capability-registry.js";
import { PermissionEnforcer } from "../permission-enforcer.js";
import { AuditLog } from "../audit-log.js";
import type { KaizenPlugin, KaizenConfig } from "../../types/plugin.js";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";

function makeHarness(builtins: Record<string, KaizenPlugin>) {
  const eventBus = new EventBus();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();
  const enforcer = new PermissionEnforcer({ mode: "permissive" });
  const auditLog = new AuditLog({
    rootDir: join(tmpdir(), `kaizen-test-${randomUUID()}`),
    sessionId: randomUUID(),
  });
  const config: KaizenConfig = { plugins: [] };

  const manager = new PluginManager(
    config, { plugins: builtins },
    eventBus, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    join(tmpdir(), `lockfile-${randomUUID()}`),
    { trustLockfile: false, allowUnscoped: true, nonInteractive: true },
  );
  return { manager, capabilityRegistry };
}

describe("driver capability resolution (post-registry-refactor)", () => {
  it("resolves a provider by name via CapabilityRegistry when one plugin provides it", async () => {
    const providerPlugin: KaizenPlugin = {
      name: "test-helper",
      version: "0.0.0",
      capabilities: { provides: ["test-driver:collaborator"] },
      async setup(ctx) {
        ctx.defineCapability("test-helper:collaborator", { cardinality: "one", description: "test" });
      },
    };
    const driverPlugin: KaizenPlugin = {
      name: "test-driver",
      lifecycle: true,
      version: "0.0.0",
      capabilities: { consumes: ["test-helper:collaborator"] },
      async setup(ctx) {
        ctx.defineCapability("test-driver:collaborator", { cardinality: "one", description: "driver's view" });
      },
      async start() { /* no-op */ },
    };

    const { manager, capabilityRegistry } = makeHarness({
      "test-driver": driverPlugin,
      "test-helper": providerPlugin,
    });

    await manager.initialize();
    expect(capabilityRegistry.providersOf("test-helper:collaborator")).toContain("test-helper");
  });

  it("fails initialization when a cardinality-one capability has two providers", async () => {
    const p1: KaizenPlugin = {
      name: "helper-a",
      version: "0.0.0",
      capabilities: { provides: ["test-driver:ui"] },
      async setup(ctx) {
        ctx.defineCapability("helper-a:ui", { cardinality: "one", description: "A" });
      },
    };
    const p2: KaizenPlugin = {
      name: "helper-b",
      version: "0.0.0",
      capabilities: { provides: ["test-driver:ui"] },
      async setup(ctx) {
        ctx.defineCapability("helper-b:ui", { cardinality: "one", description: "B" });
      },
    };
    const driver: KaizenPlugin = {
      name: "test-driver",
      lifecycle: true,
      version: "0.0.0",
      capabilities: { consumes: ["helper-a:ui", "helper-b:ui"] },
      async setup(ctx) {
        ctx.defineCapability("test-driver:ui", { cardinality: "one", description: "driver" });
      },
      async start() { /* no-op */ },
    };

    const { manager } = makeHarness({
      "test-driver": driver,
      "helper-a": p1,
      "helper-b": p2,
    });

    // Note: this test asserts CapabilityRegistry.validateAll() semantics are still what #13 defined.
    // It does not assert the shape of the driver's typed resolution — that lives in the driver plugin.
    await expect(manager.initialize()).rejects.toThrow(/cardinality|provider|conflict/i);
  });
});
```

- [ ] **Step 2: Run the new test; expect it to pass**

Run: `bun test src/core/integration/driver-capability-resolution.test.ts`
Expected: both cases pass (the capability-registry behavior is unchanged; this test is pure verification). If the second case does not throw, inspect `CapabilityRegistry.validateAll` and adjust the test assertion to match the real error shape — do not weaken or skip the assertion.

- [ ] **Step 3: Run full suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/integration/driver-capability-resolution.test.ts
git commit -m "test(integration): driver resolves providers via CapabilityRegistry"
```

---

## Task 10: Sweep for any leftover references

**Files:**
- None (audit)

- [ ] **Step 1: Grep the full repo for removed surface**

Run:

```bash
rg -n "registerTool|registerExecutor|registerUi|runtime\.executors|runtime\.ui|runtime\.tools|runtime\.executor\b" src/
```

Expected: zero matches in `src/`. Any match is a missed call site — fix it now.

- [ ] **Step 2: Grep for stale imports**

Run:

```bash
rg -n "tool-registry|executor-registry|ui-registry|ToolRegistry|ExecutorRegistry|UiRegistry" src/
```

Expected: zero matches in `src/`. (Matches in `docs/` are acceptable — old plans/specs reference the deleted files, which is historical.)

- [ ] **Step 3: Full test run**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 4: No commit needed if no changes. If the sweep found missed references, make the fixes and commit:**

```bash
git add -A
git commit -m "refactor: clean up stray references to deleted registries"
```

---

## Task 11: Run `kaizen:update-docs`

**Files:**
- Driven by the skill — don't prescribe specific files.

- [ ] **Step 1: Invoke the skill**

Via the Skill tool: `kaizen:update-docs`.

The skill will scan for docs whose content is invalidated by this branch's changes (registration API narrowed, `PluginContext` shape, anything that referenced the removed registries) and refresh them.

- [ ] **Step 2: Review and commit whatever the skill produced**

Run: `git status`

If the skill modified docs:

```bash
git add docs/
git commit -m "docs: refresh for internal registry refactor"
```

If no changes, skip commit.

---

## Task 12: Final verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full test run**

Run: `bun test`
Expected: all tests pass. Pre-existing failures (from Task 1 baseline) unchanged — nothing new.

- [ ] **Step 2: Build**

Run: `bun run build` (if the project has a build script; check `package.json` if unsure).
Expected: build succeeds.

- [ ] **Step 3: Spec-to-plan trace**

Cross-check every non-goal and migration item in `docs/superpowers/specs/2026-04-21-internal-registry-refactor-design.md`:

- [ ] `src/core/ui-registry.ts` deleted — Task 6
- [ ] `src/core/executor-registry.ts` deleted — Task 6
- [ ] `src/core/tool-registry.ts` deleted — Task 6
- [ ] `registerUi`, `registerExecutor`, `registerTool` removed from `PluginContext` — Task 2
- [ ] `runtime.ui`, `runtime.executors`, `runtime.tools` removed — Task 2
- [ ] `bootstrap.ts` / `context.ts` no longer instantiate deleted registries — Tasks 3, 5
- [ ] Integration test for driver-via-capability resolution added — Task 9
- [ ] `CapabilityRegistry` unchanged — no task modifies it (verify with `git diff master -- src/core/capability-registry.ts` — expect no changes)
- [ ] `kaizen:update-docs` run — Task 11

- [ ] **Step 4: Hand off to `superpowers:finishing-a-development-branch`**

Invoke the `superpowers:finishing-a-development-branch` skill to decide between merging, opening a PR, or cleanup. That skill determines the right integration path; it is not this plan's job.

**Cross-repo reminder (surfaced in the PR description, not here):** `kaizen-official-plugins` needs a sibling PR that removes `ctx.registerExecutor(...)`, `ctx.registerUi(...)`, and `ctx.registerTool(...)` calls from every plugin (`core-executor-*`, `core-ui-terminal`, `core-lifecycle`, etc.). Without that, any downstream consumer of this kaizen build will fail at plugin load. Coordinate merge timing between the two PRs.
