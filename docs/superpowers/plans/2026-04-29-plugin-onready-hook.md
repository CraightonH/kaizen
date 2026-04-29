# `onReady` Plugin Lifecycle Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `onReady(ctx)` plugin lifecycle hook that core invokes on every loaded plugin in topo order after `setup()` and before `driver.start()`, with `RUNNING` state active so `useService()` is legal.

**Architecture:** Add `onReady?` to the `KaizenPlugin` type. Refactor `setupPlugin()` so the per-plugin `pluginState` lives in a mutable ref stored on `PluginRecord`, allowing `initialize()` to flip it from `READY` to `RUNNING` for the new pass. Add a fourth pass to `PluginManager.initialize()` that iterates the existing topo-sorted plugin list, flips each loaded plugin's state to `RUNNING`, and invokes `onReady` if defined. Errors are fatal. No new pass for hot-reload (`load()`); explicitly out of scope.

**Tech Stack:** TypeScript, Bun test runner. Test pattern follows `src/core/plugin-manager-stop.test.ts` (filesystem-loaded plugins via a `writePlugin` helper).

**Spec:** `docs/superpowers/specs/2026-04-29-plugin-onready-hook-design.md`

---

## File Structure

**Created:**
- `src/core/plugin-manager-onready.test.ts` — unit + integration tests for the new hook.

**Modified:**
- `src/types/plugin.ts` — add `onReady?` field to `KaizenPlugin` interface (~line 218, alongside `start?`).
- `src/core/plugin-manager.ts` — `PluginRecord` gains `stateRef`; `setupPlugin()` uses it instead of a local; `initialize()` adds PASS 4 to invoke `onReady` after PASS 3 validation.
- `docs/guides/plugin-authoring.md` — new `onReady` section adjacent to `setup-start-closure`.
- `docs/concepts/plugin-model.md` — extend lifecycle description.
- `docs/concepts/architecture.md` — update lifecycle prose / diagram.
- `docs/reference/host-api.md` — document `onReady` signature and phase legality.

---

## Task 1: Add `onReady?` to `KaizenPlugin` type

**Files:**
- Modify: `src/types/plugin.ts:217-225`

- [ ] **Step 1: Add the optional method to `KaizenPlugin`**

In `src/types/plugin.ts`, after the `start?` line and before `stop?`, insert:

```ts
  /**
   * Optional `RUNNING`-phase wiring hook. Called once per loaded plugin in
   * topological order after every `setup()` resolves and before
   * `driver.start()` is invoked. `useService()` is legal here; setup-only
   * APIs (`on`, `defineService`, `provideService`, `consumeService`,
   * `defineEvent`) are not. Throwing is fatal.
   *
   * Use this for non-driver plugins that need to call `useService()` against
   * a peer's service. The driver's `start()` retains its "session loop"
   * meaning and is unaffected.
   */
  onReady?(ctx: PluginContext): Promise<void> | void;
```

The full lifecycle block becomes:

```ts
  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
  /**
   * Optional `RUNNING`-phase wiring hook. … (full doc above)
   */
  onReady?(ctx: PluginContext): Promise<void> | void;
  /**
   * Called during unload, before events/services/permissions are deregistered.
   * …existing stop() doc…
   */
  stop?(ctx: PluginContext): Promise<void>;
```

- [ ] **Step 2: Verify typecheck passes**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if no script).
Expected: clean — no type errors. Optional fields don't break existing plugin definitions.

- [ ] **Step 3: Commit**

```bash
git add src/types/plugin.ts
git commit -m "feat(types): add optional onReady() lifecycle hook to KaizenPlugin"
```

---

## Task 2: Lift `pluginState` to a mutable ref on `PluginRecord`

This is preparatory for Task 3. No behavior change; existing tests must continue to pass.

**Files:**
- Modify: `src/core/plugin-manager.ts:284-288` (PluginRecord)
- Modify: `src/core/plugin-manager.ts:638-700` (setupPlugin)

- [ ] **Step 1: Define a `StateRef` type and extend `PluginRecord`**

In `src/core/plugin-manager.ts`, near the top (after the existing imports and before `interface PluginRecord`), add:

```ts
interface StateRef {
  current: CoreState;
}
```

Then change `PluginRecord` to:

```ts
interface PluginRecord {
  plugin: KaizenPlugin;
  entry: PluginEntry;
  ctx?: PluginContext;
  stateRef?: StateRef;
}
```

`CoreState` is already imported from `./context.js` (line 16 of the file).

- [ ] **Step 2: Update `setupPlugin()` to use the ref**

Locate the block in `setupPlugin()` (around line 676):

```ts
    let pluginState: CoreState = "INITIALIZING";
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      secretsCtx,
      this.eventBus,
      this.serviceRegistry,
      this.enforcer,
      () => pluginState,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
    await runInPluginScope(plugin.name, async () => { await plugin.setup(ctx); });
    pluginState = "READY";
```

Replace with:

```ts
    const stateRef: StateRef = { current: "INITIALIZING" };
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      secretsCtx,
      this.eventBus,
      this.serviceRegistry,
      this.enforcer,
      () => stateRef.current,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
    await runInPluginScope(plugin.name, async () => { await plugin.setup(ctx); });
    stateRef.current = "READY";

    return { ctx, stateRef };
```

- [ ] **Step 3: Update `setupPlugin()`'s return type and call sites**

`setupPlugin()` previously returned just the ctx. Update its signature (the method is `private async setupPlugin(...)`). Find the existing return type and change to:

```ts
  private async setupPlugin(
    plugin: KaizenPlugin,
    resolvedPath: string | null,
  ): Promise<{ ctx: PluginContext; stateRef: StateRef }> {
```

Then in `initialize()` (around line 410):

```ts
        const ctx = await this.setupPlugin(plugin, rPath);
        loadedNames.add(plugin.name);
        this.plugins.set(plugin.name, {
          plugin,
          entry: { ... },
          ctx,
        });
```

becomes:

```ts
        const { ctx, stateRef } = await this.setupPlugin(plugin, rPath);
        loadedNames.add(plugin.name);
        this.plugins.set(plugin.name, {
          plugin,
          entry: { ... },
          ctx,
          stateRef,
        });
```

Also update the analogous call site in `load()` (around line 522):

```ts
        const { ctx, stateRef } = await this.setupPlugin(plugin, resolvedPath);
        this.plugins.set(name, {
          plugin,
          entry: { ... },
          ctx,
          stateRef,
        });
```

(Locate by searching for `await this.setupPlugin(` — there should be exactly two call sites.)

- [ ] **Step 4: Run the existing test suite**

Run: `bun test`
Expected: all existing tests pass. This is a refactor with no behavior change.

If any test fails, the refactor introduced a regression — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-manager.ts
git commit -m "refactor(plugin-manager): lift per-plugin state to mutable ref"
```

---

## Task 3: TDD — `onReady` is invoked on every loaded plugin

**Files:**
- Create: `src/core/plugin-manager-onready.test.ts`
- Modify: `src/core/plugin-manager.ts` (PASS 4 in `initialize()`)

- [ ] **Step 1: Write the failing test scaffolding**

Create `src/core/plugin-manager-onready.test.ts` with:

```ts
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";

function makeRegistries() {
  return {
    eventBus: new EventBus(),
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

const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface PluginSpec {
  name: string;
  driver?: boolean;
  setupBody?: string;
  onReadyBody?: string;
  hasOnReady?: boolean;
  startBody?: string;
  hasStart?: boolean;
  consumes?: string[];
  provides?: string[];
}

function writePlugin(spec: PluginSpec): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-pm-onready-${spec.name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: spec.name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  const parts: string[] = [];
  parts.push(`export default {`);
  parts.push(`  name: ${JSON.stringify(spec.name)},`);
  parts.push(`  apiVersion: "3",`);
  if (spec.driver) parts.push(`  driver: true,`);
  if (spec.consumes || spec.provides) {
    parts.push(`  services: ${JSON.stringify({
      ...(spec.consumes ? { consumes: spec.consumes } : {}),
      ...(spec.provides ? { provides: spec.provides } : {}),
    })},`);
  }
  parts.push(`  async setup(ctx) {`);
  if (spec.setupBody) parts.push(spec.setupBody);
  parts.push(`  },`);
  if (spec.hasOnReady) {
    parts.push(`  async onReady(ctx) {`);
    if (spec.onReadyBody) parts.push(spec.onReadyBody);
    parts.push(`  },`);
  }
  if (spec.hasStart) {
    parts.push(`  async start(ctx) {`);
    if (spec.startBody) parts.push(spec.startBody);
    parts.push(`  },`);
  }
  parts.push(`};`);
  writeFileSync(join(dir, "index.mjs"), parts.join("\n"));
  return dir;
}

describe("PluginManager.initialize calls onReady()", () => {
  test("onReady is invoked on every loaded plugin", async () => {
    const bridgeKey = `__kz_onready_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op driver */`,
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("driver");`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("consumer");`,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [driverDir, consumerDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await manager.initialize();

    const bridge = (globalThis as Record<string, { calls: string[] }>)[bridgeKey]!;
    expect(bridge.calls.sort()).toEqual(["consumer", "driver"]);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: FAIL — `bridge.calls` is empty (`[]` vs `["consumer", "driver"]`) because core does not yet invoke `onReady`.

- [ ] **Step 3: Implement PASS 4 in `initialize()`**

In `src/core/plugin-manager.ts`, locate `initialize()` around line 372. The current end of the method (after driver resolution, around line 477) returns `{ driver: driver! }`. Insert PASS 4 *before* the driver resolution block (i.e. after PASS 3 / unclaimed-key warnings, before "Resolve driver"), but use the topo-sorted list. Concretely, between:

```ts
    // Warn on unclaimed config keys
    const claimedKeys = new Set(["plugins", "extends", ...loadedNames]);
    for (const key of Object.keys(this.config)) {
      if (!claimedKeys.has(key)) warn(`Unknown config key '${key}'. No plugin claimed it.`);
    }
```

and the "Resolve driver" block, add:

```ts
    // PASS 4: invoke onReady() on every loaded plugin in topo order.
    // Flips each plugin's state to RUNNING so useService() is legal.
    // Setup-only APIs (on/defineService/provideService/consumeService/defineEvent)
    // remain forbidden — same gating as start().
    for (const plugin of sorted) {
      const record = this.plugins.get(plugin.name);
      if (!record || record.entry.status !== "loaded") continue;
      if (!record.stateRef || !record.ctx) continue;
      record.stateRef.current = "RUNNING";
      if (typeof plugin.onReady !== "function") continue;
      try {
        await runInPluginScope(plugin.name, async () => {
          await plugin.onReady!(record.ctx!);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fatal(`Plugin '${plugin.name}' onReady() failed: ${msg}`);
      }
    }
```

`sorted` is the local from earlier in `initialize()` (around line 386: `const sorted = topoSort(...)`). It is already in topo order and already filtered to plugins that resolved/consented.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS — `bridge.calls` contains both `"driver"` and `"consumer"`.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager-onready.test.ts
git commit -m "feat(plugin-manager): invoke onReady() on every loaded plugin (#63)"
```

---

## Task 4: TDD — `onReady` runs in topological order

**Files:**
- Modify: `src/core/plugin-manager-onready.test.ts`

- [ ] **Step 1: Add the failing test**

Append to the existing `describe("PluginManager.initialize calls onReady()", ...)` block:

```ts
  test("onReady runs in topological order (provider before consumer)", async () => {
    const bridgeKey = `__kz_onready_topo_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const providerDir = writePlugin({
      name: "provider",
      provides: ["provider:thing"],
      setupBody: `ctx.provideService("provider:thing", { ok: true });`,
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("provider");`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      consumes: ["provider:thing"],
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("consumer");`,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [consumerDir, providerDir, driverDir] }, // consumer listed first
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();

    const bridge = (globalThis as Record<string, { calls: string[] }>)[bridgeKey]!;
    const providerIdx = bridge.calls.indexOf("provider");
    const consumerIdx = bridge.calls.indexOf("consumer");
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(consumerIdx).toBeGreaterThan(providerIdx);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS — Task 3's implementation iterates `sorted` (the topo-sorted list), so provider runs before consumer despite declaration order.

(If it fails: the iteration in Task 3 is not using `sorted`, or `topoSort` isn't seeing the `services.consumes`/`provides` edges. Inspect.)

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-manager-onready.test.ts
git commit -m "test: onReady invokes plugins in topo order"
```

---

## Task 5: TDD — `useService` is legal inside `onReady`

**Files:**
- Modify: `src/core/plugin-manager-onready.test.ts`

- [ ] **Step 1: Add the failing test**

Append:

```ts
  test("useService() is legal inside onReady", async () => {
    const bridgeKey = `__kz_onready_useservice_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { ok: false, error: null as string | null };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const providerDir = writePlugin({
      name: "provider",
      provides: ["provider:thing"],
      setupBody: `ctx.provideService("provider:thing", { value: 42 });`,
    });
    const consumerDir = writePlugin({
      name: "consumer",
      consumes: ["provider:thing"],
      hasOnReady: true,
      onReadyBody: `
        try {
          const svc = ctx.useService("provider:thing");
          globalThis[${JSON.stringify(bridgeKey)}].ok = svc.value === 42;
        } catch (e) {
          globalThis[${JSON.stringify(bridgeKey)}].error = e.message;
        }
      `,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [providerDir, consumerDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();

    const bridge = (globalThis as Record<string, { ok: boolean; error: string | null }>)[bridgeKey]!;
    expect(bridge.error).toBeNull();
    expect(bridge.ok).toBe(true);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS. Task 3 flipped `stateRef.current = "RUNNING"` before invoking `onReady`, and `useService` does not currently gate on state — it succeeds when an impl is registered. The test asserts the consumer can read the provider's value.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-manager-onready.test.ts
git commit -m "test: useService() succeeds inside onReady"
```

---

## Task 6: TDD — setup-only APIs throw inside `onReady`

**Files:**
- Modify: `src/core/plugin-manager-onready.test.ts`

- [ ] **Step 1: Add the failing test**

Append:

```ts
  test("setup-only APIs throw inside onReady", async () => {
    const bridgeKey = `__kz_onready_gating_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {
      provideErr: null as string | null,
      onErr: null as string | null,
      consumeErr: null as string | null,
      defineSvcErr: null as string | null,
      defineEvtErr: null as string | null,
    };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const pluginDir = writePlugin({
      name: "p",
      hasOnReady: true,
      onReadyBody: `
        const b = globalThis[${JSON.stringify(bridgeKey)}];
        try { ctx.provideService("p:x", {}); } catch (e) { b.provideErr = e.message; }
        try { ctx.on("evt", () => {}); } catch (e) { b.onErr = e.message; }
        try { ctx.consumeService("other:thing"); } catch (e) { b.consumeErr = e.message; }
        try { ctx.defineService("p:y", { schema: {} }); } catch (e) { b.defineSvcErr = e.message; }
        try { ctx.defineEvent("p:evt"); } catch (e) { b.defineEvtErr = e.message; }
      `,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [pluginDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );
    await manager.initialize();

    const bridge = (globalThis as Record<string, {
      provideErr: string | null; onErr: string | null; consumeErr: string | null;
      defineSvcErr: string | null; defineEvtErr: string | null;
    }>)[bridgeKey]!;
    expect(bridge.provideErr).toMatch(/after initialization/i);
    expect(bridge.onErr).toMatch(/after initialization/i);
    expect(bridge.consumeErr).toMatch(/after initialization/i);
    expect(bridge.defineSvcErr).toMatch(/after initialization/i);
    expect(bridge.defineEvtErr).toMatch(/after initialization/i);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS. The setup-only APIs in `src/core/context.ts` use `assertInitializing(getState(), ...)` which throws when state is anything other than `"INITIALIZING"`. Since Task 3 flipped state to `"RUNNING"` before `onReady`, all five calls throw with the existing "Cannot … after initialization." message.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-manager-onready.test.ts
git commit -m "test: setup-only APIs throw inside onReady"
```

---

## Task 7: TDD — a throw from `onReady` is fatal

**Files:**
- Modify: `src/core/plugin-manager-onready.test.ts`

- [ ] **Step 1: Add the failing test**

Append:

```ts
  test("a throw from onReady is fatal", async () => {
    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const badDir = writePlugin({
      name: "bad",
      hasOnReady: true,
      onReadyBody: `throw new Error("onReady kaboom");`,
    });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [badDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await expect(manager.initialize()).rejects.toThrow(/onReady\(\) failed.*onReady kaboom/);
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS. Task 3's catch block calls `fatal(...)`, which throws a `KaizenError` with the message `Plugin 'bad' onReady() failed: onReady kaboom`.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-manager-onready.test.ts
git commit -m "test: onReady throw is fatal"
```

---

## Task 8: TDD — `onReady` runs before `driver.start()`

This guards against a future regression where someone reorders `initialize()` and the driver's session loop accidentally starts before peers' `onReady` complete.

**Files:**
- Modify: `src/core/plugin-manager-onready.test.ts`

- [ ] **Step 1: Add the failing test**

This test uses `runHarness` (the end-to-end driver-start path) rather than just `initialize()`, because `start()` is invoked by `runHarness`, not `initialize`.

Append (importing `runHarness` at the top of the file — add `import { runHarness } from "./index.js";`):

```ts
  test("driver.start() runs after every plugin's onReady", async () => {
    const bridgeKey = `__kz_onready_before_start_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };

    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("driver:onReady");`,
      hasStart: true,
      startBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("driver:start");`,
    });
    const peerDir = writePlugin({
      name: "peer",
      hasOnReady: true,
      onReadyBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("peer:onReady");`,
    });

    const lockfilePath = join(mkdtempSync(join(tmpdir(), "kaizen-test-lock-")), "permissions.lock");
    await runHarness({
      kaizenConfig: { plugins: [peerDir, driverDir] },
      lockfilePath,
    });

    const bridge = (globalThis as Record<string, { calls: string[] }>)[bridgeKey]!;
    const startIdx = bridge.calls.indexOf("driver:start");
    const peerOnReadyIdx = bridge.calls.indexOf("peer:onReady");
    const driverOnReadyIdx = bridge.calls.indexOf("driver:onReady");
    expect(startIdx).toBeGreaterThan(peerOnReadyIdx);
    expect(startIdx).toBeGreaterThan(driverOnReadyIdx);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
```

`runHarness` accepts `{ kaizenConfig, lockfilePath, enforcer? }` (see `src/core/index.ts:75-81`). The two-field form above is sufficient.

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS. `runHarness` first awaits `manager.initialize()` (which now invokes `onReady` for every plugin), then calls `driver.start()`. So both `onReady` calls land before `driver:start`.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-manager-onready.test.ts
git commit -m "test: onReady runs before driver.start()"
```

---

## Task 9: TDD — plugins without `onReady` are unaffected

**Files:**
- Modify: `src/core/plugin-manager-onready.test.ts`

- [ ] **Step 1: Add the test**

Append:

```ts
  test("plugins without onReady() initialize without error", async () => {
    const driverDir = writePlugin({
      name: "driver",
      driver: true,
      hasStart: true,
      startBody: `/* no-op */`,
    });
    const plainDir = writePlugin({ name: "plain" });

    const { eventBus, serviceRegistry } = makeRegistries();
    const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
    const manager = new PluginManager(
      { plugins: [plainDir, driverDir] },
      eventBus, serviceRegistry,
      enforcer, auditLog,
      lockfilePath, options,
    );

    await expect(manager.initialize()).resolves.toBeDefined();
    expect(manager.list().map((e) => e.name).sort()).toEqual(["driver", "plain"]);
  });
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/core/plugin-manager-onready.test.ts`
Expected: PASS. The PASS 4 loop in Task 3 includes `if (typeof plugin.onReady !== "function") continue;`, so plugins without the hook are skipped after their state is flipped to `RUNNING`.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-manager-onready.test.ts
git commit -m "test: plugins without onReady initialize cleanly"
```

---

## Task 10: Documentation — `plugin-authoring.md`

**Files:**
- Modify: `docs/guides/plugin-authoring.md` (after the `setup-start-closure` section, line ~218)

- [ ] **Step 1: Add an `onReady` section**

After the closing of the existing `### Setup-start closure pattern {#setup-start-closure}` section (which ends around line 218 with the prose about the `finally` block), insert:

````markdown
### Non-driver `RUNNING`-phase wiring with `onReady` {#on-ready}

`useService()` is `RUNNING`-only — it throws if called from `setup()`. This is
straightforward for the driver (do it in `start()`) but used to be awkward for
non-driver plugins, since core only invokes `start()` on the driver. The
`onReady(ctx)` hook closes that gap.

`onReady` is an optional plugin method. Core invokes it once per loaded plugin,
in topological order (same edges as `setup()`), after every `setup()` resolves
and before `driver.start()` is invoked. Inside `onReady`, `useService()` is
legal; the same setup-only APIs that are forbidden in `start()` (`ctx.on`,
`provideService`, `consumeService`, `defineService`, `defineEvent`) are
forbidden here.

```ts
const plugin: KaizenPlugin = {
  name: "my-consumer",
  services: { consumes: ["peer:thing"] },

  async setup(ctx) {
    // setup-only wiring goes here
  },

  async onReady(ctx) {
    // RUNNING-phase wiring: legal to call useService now.
    const peer = ctx.useService<PeerThing>("peer:thing");
    peer.onSomething(() => {
      // …
    });
  },
};
```

A throw from `onReady` is fatal — the harness aborts with the same shape as a
`setup()` failure. `onReady` runs exactly once during the initial harness boot;
hot-reload (`PluginManager.reload`) does not re-invoke it.

The driver may also define `onReady` for the same purpose. `start()` retains
its "session loop" meaning and is unaffected.

#### When to still use the events pattern

`onReady` solves the "I need `useService()` legality" problem. Cross-plugin
coordination that depends on another plugin's *runtime* state — e.g. waiting
until the driver's session loop has actually started — still belongs in an
event handshake. Define a vocabulary event in a shared events plugin, have
the driver emit it during `start()`, and subscribe to it in `setup()` of any
plugin that needs to react.
````

- [ ] **Step 2: Verify the doc renders sensibly**

Run: `grep -n "on-ready\|setup-start-closure\|onReady" docs/guides/plugin-authoring.md`
Expected: the new anchor `{#on-ready}`, the new `### Non-driver` heading, and the new code block all appear after the existing `setup-start-closure` section.

- [ ] **Step 3: Commit**

```bash
git add docs/guides/plugin-authoring.md
git commit -m "docs(plugin-authoring): document onReady() lifecycle hook"
```

---

## Task 11: Documentation — concept docs

**Files:**
- Modify: `docs/concepts/plugin-model.md`
- Modify: `docs/concepts/architecture.md`

- [ ] **Step 1: Update `plugin-model.md` lifecycle section**

In `docs/concepts/plugin-model.md`, find the lifecycle list (around line 70 — "Setup. Plugins are topologically sorted…"). Find the existing list of lifecycle steps and insert a new step between `setup()` and `start()`:

```markdown
5. **Ready.** After every plugin's `setup()` resolves, core calls
   `onReady(ctx)` on each plugin in topological order. Core state is
   `RUNNING`, so `useService()` is legal. Setup-only APIs (`on`,
   `defineService`, `provideService`, `consumeService`, `defineEvent`)
   are not. Errors are fatal. Optional — plugins that do not need
   `RUNNING`-phase wiring may omit it.
```

Renumber any subsequent steps. (If the file uses different prose / numbering
conventions, adapt to match. The intent is: explicitly add `onReady` to the
lifecycle narrative between `setup()` and `start()`.)

- [ ] **Step 2: Update `architecture.md` lifecycle prose**

In `docs/concepts/architecture.md`, find the lifecycle / driver section (around lines 42, 93, 98 per earlier grep). Add a sentence wherever the lifecycle phases are summarized, e.g.:

```markdown
After all `setup()` calls resolve, core invokes the optional `onReady(ctx)`
hook on every loaded plugin in topological order. `onReady` runs with core
state `RUNNING` — `useService()` is legal — and is the canonical place for
non-driver `RUNNING`-phase wiring. The driver's `start()` runs after every
`onReady` returns.
```

Place this near the existing description of `setup()` → `start()` flow.

- [ ] **Step 3: Commit**

```bash
git add docs/concepts/plugin-model.md docs/concepts/architecture.md
git commit -m "docs(concepts): add onReady to lifecycle prose"
```

---

## Task 12: Documentation — host API reference

**Files:**
- Modify: `docs/reference/host-api.md`

- [ ] **Step 1: Document the hook**

Find the existing lifecycle methods section (look for `setup`, `start`, `stop` documentation). Add an `onReady` entry alongside, with the same prose style as the surrounding entries:

```markdown
#### `onReady?(ctx: PluginContext): Promise<void> | void`

Optional `RUNNING`-phase wiring hook. Core invokes it once per loaded plugin
in topological order (same edges as `setup()`), after every `setup()` resolves
and before `driver.start()` is invoked.

**Phase legality during `onReady`:**

| API | Legal? |
| --- | --- |
| `ctx.useService` | yes |
| `ctx.emit` | yes |
| `ctx.fs` / `ctx.net` / `ctx.exec` / `ctx.secrets` | yes |
| `ctx.on` | no (setup-only) |
| `ctx.defineService` | no (setup-only) |
| `ctx.provideService` | no (setup-only) |
| `ctx.consumeService` | no (setup-only) |
| `ctx.defineEvent` | no (setup-only) |

A throw from `onReady` is fatal. Plugins that do not need `RUNNING`-phase
wiring may omit it. See the [authoring guide][on-ready] for usage.

[on-ready]: ../guides/plugin-authoring.md#on-ready
```

If the existing host-api doc uses a different prose style for lifecycle
methods (e.g. function-prototype headers, no tables), match that style instead.
Inspect `setup` and `start` entries first, then mirror.

- [ ] **Step 2: Commit**

```bash
git add docs/reference/host-api.md
git commit -m "docs(host-api): document onReady() lifecycle hook"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all tests pass, including the new `plugin-manager-onready.test.ts`.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck` (or whatever script the repo uses).
Expected: clean.

- [ ] **Step 3: Spot-check the issue's repro scenario**

The original issue describes a non-driver plugin needing `useService` in a
`RUNNING`-state hook. Confirm the new pattern works end-to-end by re-reading
Task 5's test ("useService() is legal inside onReady") — it's exactly that
scenario. Optionally exercise it by hand with a small fixture in
`/tmp/onready-smoke/`.

- [ ] **Step 4: Update the spec status**

Edit `docs/superpowers/specs/2026-04-29-plugin-onready-hook-design.md`:
change `**Status:** Proposed` to `**Status:** Implemented`.

```bash
git add docs/superpowers/specs/2026-04-29-plugin-onready-hook-design.md
git commit -m "docs: mark onReady spec as implemented"
```

---

## Notes on what is intentionally NOT in this plan

These map to the "Non-Goals" section of the spec — call them out explicitly so
no one expands scope:

- **No teardown counterpart.** `stop()` already exists and is already called on
  every plugin in reverse topo order during `unloadAll()`.
- **No hot-reload `onReady` re-invocation.** `PluginManager.load()` (the hot
  reload path) does not call `onReady`. The PASS 4 loop only runs from
  `initialize()`. Adding hot-reload semantics is a separate change with its
  own design questions (which other plugins should re-fire? what about their
  state?).
- **No new ordering hints.** Topo order is reused from the existing sort. No
  priority field, no per-hook ordering metadata, no parallelism flag.
- **No driver carve-out.** The driver's `onReady` (if defined) runs the same
  way as any other plugin's. Symmetric is simpler.
