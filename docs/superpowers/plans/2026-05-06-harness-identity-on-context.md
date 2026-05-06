# Harness Identity on PluginContext — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose raw harness metadata (`jsonPath`, `ref`) on `PluginContext` so plugins can derive a stable namespacing key for on-disk state.

**Architecture:** Thread two optional strings (`jsonPath`, `ref`) from `cli.ts` bootstrap through `runHarness` → `initializePluginSystem` → `PluginManager` → `createPluginContext`, surfacing them as `ctx.harness = { jsonPath?, ref? }`. The outer field is always present; inner fields are individually optional. No canonical name derivation in core — plugins manipulate the raw metadata themselves.

**Tech Stack:** TypeScript, Bun (runtime + test runner).

**Spec:** `docs/superpowers/specs/2026-05-06-harness-identity-on-context-design.md`

---

## File Structure

**Modify:**
- `src/types/plugin.ts` — add `harness` to `PluginContext` interface
- `src/core/context.ts` — add parameter to `createPluginContext`, spread onto returned ctx
- `src/core/plugin-manager.ts` — add trailing optional constructor param, store as private field, forward to `createPluginContext` call
- `src/core/index.ts` — add `harness?` to `InitializePluginSystemOpts` and `RunHarnessOpts`, forward to `PluginManager` ctor and to the driver's `createPluginContext`
- `src/cli.ts` — populate `harness` from `resolvedHarnessJsonPath` and `harnessArg` and pass to `runHarness`
- `docs/guides/plugin-authoring.md` — add "Harness identity" section
- `docs/concepts/architecture.md` — mention `ctx.harness` if context fields are enumerated

**Create:**
- `src/core/plugin-manager-harness.test.ts` — integration test that loads a plugin and verifies `ctx.harness` flows from the constructor

No existing files need to be split. The constructor of `PluginManager` is already long; we add a trailing optional param to avoid churning all `new PluginManager(...)` call sites.

---

## Task 1: Failing integration test for `ctx.harness`

**Files:**
- Create: `src/core/plugin-manager-harness.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/plugin-manager-harness.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PluginManager } from "./plugin-manager.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";

const createdDirs: string[] = [];
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeProbePlugin(name: string, bridgeKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kz-pm-harness-${name}-`));
  createdDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name, version: "1.0.0", type: "module", main: "index.mjs",
  }));
  // Capture ctx.harness from setup() AND onReady() into the bridge so the
  // test can assert both phases see the same metadata.
  writeFileSync(join(dir, "index.mjs"), `
export default {
  name: ${JSON.stringify(name)},
  apiVersion: "3",
  driver: true,
  async setup(ctx) {
    globalThis[${JSON.stringify(bridgeKey)}].setup = ctx.harness;
  },
  async onReady(ctx) {
    globalThis[${JSON.stringify(bridgeKey)}].onReady = ctx.harness;
  },
  async start(ctx) {
    globalThis[${JSON.stringify(bridgeKey)}].start = ctx.harness;
  },
};
`);
  return dir;
}

function makeStubs() {
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

describe("PluginContext.harness", () => {
  test("populated from PluginManager harness opt", async () => {
    const bridgeKey = `__kz_harness_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {};
    const driverDir = writeProbePlugin("driver", bridgeKey);

    const { enforcer, auditLog, lockfilePath, options } = makeStubs();
    const manager = new PluginManager(
      { plugins: [driverDir] },
      new EventBus(), new ServiceRegistry(),
      enforcer, auditLog,
      lockfilePath, options,
      undefined, // globalConfig
      { jsonPath: "/abs/path/kaizen.json", ref: "official/openai-compatible@1.2.3" },
    );

    await manager.initialize();

    const bridge = (globalThis as Record<string, { setup: unknown; onReady: unknown }>)[bridgeKey]!;
    expect(bridge.setup).toEqual({
      jsonPath: "/abs/path/kaizen.json",
      ref: "official/openai-compatible@1.2.3",
    });
    expect(bridge.onReady).toEqual(bridge.setup);
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });

  test("defaults to empty object when no harness opt provided", async () => {
    const bridgeKey = `__kz_harness_default_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {};
    const driverDir = writeProbePlugin("driver", bridgeKey);

    const { enforcer, auditLog, lockfilePath, options } = makeStubs();
    const manager = new PluginManager(
      { plugins: [driverDir] },
      new EventBus(), new ServiceRegistry(),
      enforcer, auditLog,
      lockfilePath, options,
    );

    await manager.initialize();

    const bridge = (globalThis as Record<string, { setup: unknown }>)[bridgeKey]!;
    expect(bridge.setup).toEqual({});
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/plugin-manager-harness.test.ts`
Expected: FAIL — TypeScript error or runtime error indicating `PluginManager` constructor takes 8 args but 9 were passed; OR `ctx.harness` is undefined.

**Do not commit yet — the test is allowed to be red until Tasks 2 and 3 land.**

---

## Task 2: Add `harness` field to `PluginContext` and `createPluginContext`

**Files:**
- Modify: `src/types/plugin.ts` (PluginContext interface)
- Modify: `src/core/context.ts:15-79`

- [ ] **Step 1: Add `harness` field to the `PluginContext` interface**

In `src/types/plugin.ts`, find the `interface PluginContext { ... }` block (starts near line 83). Add the following field. Place it adjacent to `config` (the other static-metadata field) for readability:

```ts
  /**
   * Raw metadata about the harness this plugin was loaded under. Both inner
   * fields may be absent (e.g. programmatic `runHarness()` without a file on
   * disk, or `kaizen` invoked from a directory containing `kaizen.json` with
   * no `--harness` ref). Kaizen does not derive a canonical `name`. Plugins
   * that need a stable namespacing key derive one from these inputs themselves
   * — typically by preferring `jsonPath` over `ref` and falling back to a
   * literal default when both are absent.
   */
  harness: {
    /** Absolute path to the resolved harness JSON, if bootstrapped from a file. */
    jsonPath?: string;
    /** The ref the user passed (`--harness <ref>` or `defaults.harness`), if any. */
    ref?: string;
  };
```

- [ ] **Step 2: Add parameter and spread to `createPluginContext`**

In `src/core/context.ts`, modify the `createPluginContext` signature and return value:

```ts
export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  secretsContext: SecretsContext,
  eventBus: EventBus,
  serviceRegistry: ServiceRegistry,
  enforcer: PermissionEnforcer,
  getState: () => CoreState,
  pluginManagerPublicApi: PluginManagerPublicApi,
  pluginManagerLifecycleApi: PluginManagerLifecycleApi,
  harness: { jsonPath?: string; ref?: string } = {},
): PluginContext {
  const io = createCtxIo(pluginName, enforcer);
  return {
    config: pluginConfig,
    harness,

    log(msg: string): void {
      console.log(`[${pluginName}] ${msg}`);
    },
    // ...rest unchanged...
```

The `harness` parameter is the new last argument with a default of `{}`. Spread the field onto the returned object via `harness,` (one line under `config`).

- [ ] **Step 3: Run typecheck**

Run: `bun run build` (or `bunx tsc --noEmit` if a typecheck-only script exists)
Expected: PASS — no callers of `createPluginContext` are broken because the new param is optional.

---

## Task 3: Thread `harness` through `PluginManager`

**Files:**
- Modify: `src/core/plugin-manager.ts:329-341` (constructor) and `:731` (`createPluginContext` call)

- [ ] **Step 1: Add constructor parameter and forward**

In `src/core/plugin-manager.ts`, modify the constructor (around `:329`) to add a trailing optional parameter. Place it after `globalConfig?` so existing call sites that pass 8 args still work:

```ts
  constructor(
    private readonly config: KaizenConfig,
    private readonly eventBus: EventBus,
    private readonly serviceRegistry: ServiceRegistry,
    private readonly enforcer: PermissionEnforcer,
    private readonly auditLog: AuditLog,
    private readonly lockfilePath: string,
    private readonly options: { trustLockfile: boolean; allowUnscoped: boolean; nonInteractive: boolean },
    private readonly globalConfig?: KaizenGlobalConfig,
    private readonly harness: { jsonPath?: string; ref?: string } = {},
  ) {
    // Wire denial listener → audit log.
    this.enforcer.onDenial((r) => this.auditLog.record(r));
  }
```

- [ ] **Step 2: Forward `this.harness` to `createPluginContext`**

In `src/core/plugin-manager.ts`, find the `createPluginContext(...)` call (around `:731`) and add `this.harness` as the trailing argument:

```ts
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
      this.harness,
    );
```

- [ ] **Step 3: Run the Task 1 test to verify the populated case passes**

Run: `bun test src/core/plugin-manager-harness.test.ts`
Expected: BOTH tests PASS.

- [ ] **Step 4: Run the broader test suite**

Run: `bun test src/core/`
Expected: PASS. Existing `new PluginManager(...)` sites omit the new param; the default `{}` keeps them green.

- [ ] **Step 5: Commit Tasks 1, 2, 3 together**

```bash
git add \
  src/types/plugin.ts \
  src/core/context.ts \
  src/core/plugin-manager.ts \
  src/core/plugin-manager-harness.test.ts
git commit -m "feat(plugin-manager): expose ctx.harness with jsonPath and ref"
```

---

## Task 4: Thread `harness` through `runHarness` / `initializePluginSystem`

**Files:**
- Modify: `src/core/index.ts` (opts types, `initializePluginSystem`, `runHarness`)
- Modify: `src/core/plugin-manager-harness.test.ts` (add a `runHarness`-level test)

- [ ] **Step 1: Add a failing test that drives `runHarness` and asserts `ctx.harness`**

Append the following test to `src/core/plugin-manager-harness.test.ts` inside the existing `describe("PluginContext.harness", ...)` block:

```ts
  test("runHarness forwards harness opt to driver ctx", async () => {
    const { runHarness } = await import("./index.js");
    const bridgeKey = `__kz_harness_runharness_${Date.now()}_${Math.random()}__`;
    (globalThis as Record<string, unknown>)[bridgeKey] = {};
    const driverDir = writeProbePlugin("driver", bridgeKey);

    const lockfilePath = join(
      mkdtempSync(join(tmpdir(), "kaizen-test-lock-")),
      "permissions.lock",
    );

    await runHarness({
      kaizenConfig: { plugins: [driverDir] },
      lockfilePath,
      enforcer: new PermissionEnforcer({ mode: "log-only" }),
      harness: { jsonPath: "/abs/path/kaizen.json", ref: "x/y@1.0.0" },
    });

    const bridge = (globalThis as Record<string, { start: unknown }>)[bridgeKey]!;
    expect(bridge.start).toEqual({
      jsonPath: "/abs/path/kaizen.json",
      ref: "x/y@1.0.0",
    });
    delete (globalThis as Record<string, unknown>)[bridgeKey];
  });
```

Run: `bun test src/core/plugin-manager-harness.test.ts`
Expected: FAIL — `runHarness` doesn't accept a `harness` opt yet (TypeScript error), or `ctx.harness` in the driver `start()` is `{}`.

- [ ] **Step 2: Extend opts types and forward in `src/core/index.ts`**

Modify `InitializePluginSystemOpts` and `RunHarnessOpts`:

```ts
export interface InitializePluginSystemOpts {
  lockfilePath: string;
  injectedEnforcer?: PermissionEnforcer;
  harness?: { jsonPath?: string; ref?: string };
}
```

```ts
export interface RunHarnessOpts {
  kaizenConfig: KaizenConfig;
  lockfilePath: string;
  enforcer?: PermissionEnforcer;
  harness?: { jsonPath?: string; ref?: string };
}
```

Update `initializePluginSystem` to accept and forward:

```ts
export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  opts: InitializePluginSystemOpts,
): Promise<InitializedSystem> {
  const { lockfilePath, injectedEnforcer, harness = {} } = opts;
  // ...existing eventBus/serviceRegistry/enforcer/auditLog setup unchanged...

  const manager = new PluginManager(
    kaizenConfig,
    eventBus, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, { trustLockfile, allowUnscoped, nonInteractive },
    undefined, // globalConfig
    harness,
  );
  const { driver } = await manager.initialize();
  return {
    manager, eventBus, serviceRegistry,
    enforcer, auditLog, driver,
  };
}
```

Update `runHarness` to forward `harness` into `initializePluginSystem` and into the driver's `createPluginContext` call (around `:97`):

```ts
export async function runHarness(opts: RunHarnessOpts): Promise<void> {
  const { kaizenConfig, lockfilePath, enforcer: injectedEnforcer, harness = {} } = opts;
  const init: InitializePluginSystemOpts = {
    lockfilePath,
    harness,
    ...(injectedEnforcer !== undefined ? { injectedEnforcer } : {}),
  };
  const {
    manager, eventBus, serviceRegistry, enforcer, auditLog, driver,
  } = await initializePluginSystem(kaizenConfig, init);

  const driverConfig =
    (kaizenConfig[driver.name] as Record<string, unknown> | undefined) ?? {};
  const secretsCtx = createSecretsContext(new SecretsRegistry(), driver.name, {});
  const ctx = createPluginContext(
    driver.name, driverConfig, secretsCtx, eventBus, serviceRegistry,
    enforcer, () => "RUNNING", manager.getPublicApi(), manager.getLifecycleApi(),
    harness,
  );

  try {
    await runInPluginScope(driver.name, async () => { await driver.start!(ctx); });
  } finally {
    try { await manager.unloadAll(); } catch (err) {
      console.error("[kaizen] error during plugin teardown:", err);
    }
    await auditLog.flush();
  }
}
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `bun test src/core/plugin-manager-harness.test.ts`
Expected: ALL three tests PASS.

- [ ] **Step 4: Run the broader test suite**

Run: `bun test src/core/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/index.ts src/core/plugin-manager-harness.test.ts
git commit -m "feat(core): forward harness opt through runHarness and initializePluginSystem"
```

---

## Task 5: Wire `harness` from `cli.ts` bootstrap

**Files:**
- Modify: `src/cli.ts:410-440` (or wherever `runHarness`/`initializePluginSystem` is invoked from the main run path)

- [ ] **Step 1: Locate the main `runHarness` invocation**

Search:

```bash
grep -n "runHarness\|initializePluginSystem" src/cli.ts
```

Identify the call site that drives the harness for the default `kaizen` / `kaizen run` path. The plugin subcommand path (`consent`, `review`, `audit`) does not currently call `runHarness`; leave it alone.

- [ ] **Step 2: Build the `harness` object from already-resolved values and pass it through**

The bootstrap already computes `resolvedHarnessJsonPath` and knows `harnessArg` (the raw user-supplied `--harness` value or `defaults.harness`). At the call site, build:

```ts
const harness: { jsonPath?: string; ref?: string } = {};
if (resolvedHarnessJsonPath) harness.jsonPath = resolvedHarnessJsonPath;
if (harnessArg) harness.ref = harnessArg;

await runHarness({
  kaizenConfig: resolvedHarnessConfig!,
  lockfilePath,
  harness,
});
```

If `runHarness` is called via a different shape in the actual code, preserve that shape and add `harness` alongside the existing options.

If `harnessArg` is not in scope at the call site (it's resolved earlier inside an `if (needsHarness)` block at `:410-428`), hoist its declaration so it survives to the call site, or move the `harness` object construction up next to where the values are resolved.

- [ ] **Step 3: Typecheck and run all tests**

Run: `bun run build`
Expected: PASS.

Run: `bun test`
Expected: PASS — no test regressions.

- [ ] **Step 4: Manual smoke test**

Build kaizen and run a sample harness with a temporary probe plugin (or against an existing harness in your dev tree). One way:

```bash
# In a temp dir with a kaizen.json that loads any plugin with a setup() that logs ctx.harness
bun run /path/to/kaizen/dist/cli.js --harness official/<some-harness>@<some-version>
# Expected: ctx.harness logged as { jsonPath: "<absolute path>", ref: "official/<some-harness>@<some-version>" }

# Without --harness, from a directory with a local kaizen.json
bun run /path/to/kaizen/dist/cli.js
# Expected: ctx.harness logged as { jsonPath: "<absolute path>" } (no `ref`)
```

If you don't have a probe plugin handy, skip the smoke test and rely on Task 4's `runHarness` test plus a manual diff review of `cli.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): populate ctx.harness from bootstrap-resolved jsonPath and ref"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/guides/plugin-authoring.md`
- Modify: `docs/concepts/architecture.md` (if it enumerates `PluginContext` fields)

- [ ] **Step 1: Add "Harness identity" section to plugin-authoring.md**

Open `docs/guides/plugin-authoring.md`. Add the following section. Place it near other context-related guidance (e.g. after the `onReady` section or alongside the discussion of `ctx.config`):

````markdown
### Harness identity {#harness-identity}

Plugins that persist state to disk often need to partition that state by
harness — otherwise data captured under harness A (with plugins X, Y, Z)
can be silently loaded under harness B with a different plugin set,
producing missing tools or mismatched message shapes.

`ctx.harness` exposes raw metadata about the harness the plugin is loaded
under:

```ts
ctx.harness.jsonPath  // absolute path to the resolved harness JSON, or undefined
ctx.harness.ref       // the user's --harness ref / defaults.harness value, or undefined
```

Both inner fields may be absent — `kaizen` invoked from a directory
containing `kaizen.json` (no `--harness`) will populate `jsonPath` only;
programmatic `runHarness()` calls may populate neither. Kaizen does not
derive a canonical "name" — plugins choose their own namespacing rule.

A typical pattern:

```ts
async setup(ctx) {
  const key =
    ctx.harness.jsonPath ??
    ctx.harness.ref ??
    "default";
  const stateDir = path.join(os.homedir(), ".kaizen", "my-plugin", slugify(key));
  // …
}
```

Decide your own fallback when both fields are absent: a sentinel like
`"default"`, a refusal to persist, or whatever fits your plugin's
guarantees.
````

- [ ] **Step 2: Update PluginContext doc comment in `src/types/plugin.ts` if it has a top-level summary**

The interface comment block above `PluginContext` (around `:82`) — if it lists fields, add a one-line mention of `harness`. The per-field doc on `harness` itself (added in Task 2) is already authoritative; this is just for the table-of-contents-style summary if one exists.

- [ ] **Step 3: Update architecture.md if it enumerates ctx fields**

```bash
grep -n "PluginContext\|ctx\." docs/concepts/architecture.md | head -30
```

If the file has a section listing context fields (e.g. config, fs, net, secrets, exec), add `harness` to that list with a one-sentence description ("raw harness metadata; see plugin-authoring.md#harness-identity"). If it has no such enumeration, skip this step.

- [ ] **Step 4: Commit**

```bash
git add docs/guides/plugin-authoring.md src/types/plugin.ts docs/concepts/architecture.md 2>/dev/null
git commit -m "docs: document ctx.harness for plugin authors"
```

(`git add` of `architecture.md` is a no-op if the file wasn't modified; that's fine.)

---

## Self-review checklist (run after all tasks complete)

- [ ] All three tests in `plugin-manager-harness.test.ts` pass.
- [ ] `bun test` runs clean across the whole repo.
- [ ] `bun run build` typechecks.
- [ ] `git log --oneline -6` shows four feature/docs commits in the expected order.
- [ ] Manual smoke (Task 5 Step 4) produced the expected `ctx.harness` shape both with and without `--harness`.
