# Lifecycle → Driver Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every driver-plugin-sense use of "lifecycle" to "driver" across types, implementation, tests, and docs — making the manifest flag, variable names, error messages, and plugin name consistent with the "session driver" concept already used in prose.

**Architecture:** Type-first rename — update `KaizenPlugin.lifecycle` → `driver` first, let TypeScript surface all call sites, then fix them in order. Tests that assert on error message strings are updated last. Docs updated in a final batch commit. The CI orchestration test references an external fixture plugin (`fixture-lifecycle`) in `kaizen-official-plugins`; those lines are updated here but CI won't be green until the coordinated plugins PR lands.

**Tech Stack:** TypeScript, Bun (test runner: `bun test`), `tsc --noEmit` for type-check

---

### Task 1: Update `KaizenPlugin.lifecycle` → `driver` in types

**Files:**
- Modify: `src/types/plugin.ts:312-327`

- [ ] **Step 1: Update the field name and its JSDoc**

  In `src/types/plugin.ts`, replace lines 312–327:

  ```typescript
  /**
   * True if this plugin drives the session loop. Core calls start() on the
   * one plugin with driver=true after bootstrap. Exactly one loaded
   * plugin must declare this; zero or two+ is a fatal startup error.
   */
  driver?: boolean;

  /** What this plugin provides and consumes in the capability registry. */
  capabilities?: PluginCapabilities;

  /**
   * Map short or alternative capability names to canonical owner-qualified names.
   * Resolved when reading the `capabilities` lists above.
   * e.g. { "ui.input": "core-driver:ui.input" }
   */
  aliases?: Record<string, string>;
  ```

- [ ] **Step 2: Run type-check to see expected errors**

  ```bash
  bunx tsc --noEmit 2>&1 | grep "lifecycle"
  ```

  Expected: errors in `src/core/plugin-manager.ts` at the `plugin.lifecycle` and `lifecycleProvider` usages. No other files should error from this change alone.

- [ ] **Step 3: Commit**

  ```bash
  git add src/types/plugin.ts
  git commit -m "refactor(types): rename KaizenPlugin.lifecycle flag to driver"
  ```

---

### Task 2: Fix `plugin-manager.ts` — flag check, variables, error messages

**Files:**
- Modify: `src/core/plugin-manager.ts:175`, `src/core/plugin-manager.ts:331`, `src/core/plugin-manager.ts:413-437`

- [ ] **Step 1: Update `isCritical` to check `plugin.driver`**

  At line 175, replace:
  ```typescript
  if (plugin.lifecycle === true) return true;
  ```
  with:
  ```typescript
  if (plugin.driver === true) return true;
  ```

- [ ] **Step 2: Update `initialize()` return type and driver-resolution block**

  At line 331, replace:
  ```typescript
  async initialize(): Promise<{ lifecycleProvider: KaizenPlugin }> {
  ```
  with:
  ```typescript
  async initialize(): Promise<{ driver: KaizenPlugin }> {
  ```

  Then replace the full driver-resolution block (lines 413–437):

  ```typescript
  // Resolve driver — the one plugin with `driver: true`.
  // Core's single cross-plugin contract: call start() on the session driver.
  const driverNames: string[] = [];
  for (const [name, entry] of this.plugins) {
    if (entry.plugin.driver === true && entry.entry.status === "loaded") {
      driverNames.push(name);
    }
  }
  if (driverNames.length === 0) {
    fatal("No driver plugin found. A plugin with 'driver: true' must be loaded. Add one to kaizen.json.");
  }
  if (driverNames.length > 1) {
    const quoted = driverNames.map((n) => `'${n}'`).join(", ");
    fatal(
      `Multiple driver plugins loaded: ${quoted}. ` +
      `A harness may have exactly one plugin with 'driver: true'. Remove one from your kaizen.json.`,
    );
  }
  const driverName = driverNames[0]!;
  const driver = this.plugins.get(driverName)?.plugin;
  if (!driver || typeof driver.start !== "function") {
    fatal(`Plugin '${driverName}' declares 'driver: true' but does not export a start() function.`);
  }

  return { driver: driver! };
  ```

- [ ] **Step 3: Run type-check — expect errors only in `index.ts` now**

  ```bash
  bunx tsc --noEmit 2>&1 | grep "lifecycle"
  ```

  Expected: errors in `src/core/index.ts` only (`lifecycleProvider` no longer exists on the return type).

- [ ] **Step 4: Commit**

  ```bash
  git add src/core/plugin-manager.ts
  git commit -m "refactor(core): rename lifecycle → driver in plugin-manager"
  ```

---

### Task 3: Fix `index.ts` — rename `lifecycleProvider` and `lifecycleConfig`

**Files:**
- Modify: `src/core/index.ts:30`, `src/core/index.ts:71-103`

- [ ] **Step 1: Update `InitializedSystem` interface**

  At line 30, replace:
  ```typescript
  lifecycleProvider: Awaited<ReturnType<PluginManager["initialize"]>>["lifecycleProvider"];
  ```
  with:
  ```typescript
  driver: Awaited<ReturnType<PluginManager["initialize"]>>["driver"];
  ```

- [ ] **Step 2: Update `initializePluginSystem`**

  At line 71, replace:
  ```typescript
  const { lifecycleProvider } = await manager.initialize();
  return {
    capabilityRegistry, manager, eventBus, serviceRegistry,
    enforcer, auditLog, lifecycleProvider,
  };
  ```
  with:
  ```typescript
  const { driver } = await manager.initialize();
  return {
    capabilityRegistry, manager, eventBus, serviceRegistry,
    enforcer, auditLog, driver,
  };
  ```

- [ ] **Step 3: Update `runHarness`**

  At lines 91–103, replace:
  ```typescript
  const {
    manager, eventBus, capabilityRegistry, serviceRegistry, enforcer, auditLog, lifecycleProvider,
  } = await initializePluginSystem(kaizenConfig, init);

  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const secretsCtx = createSecretsContext(new SecretsRegistry(), lifecycleProvider.name, {});
  const ctx = createPluginContext(
    lifecycleProvider.name, lifecycleConfig, secretsCtx, eventBus, capabilityRegistry, serviceRegistry,
    enforcer, () => "RUNNING", manager.getPublicApi(), manager.getLifecycleApi(),
  );

  try {
    await runInPluginScope(lifecycleProvider.name, async () => { await lifecycleProvider.start!(ctx); });
  ```
  with:
  ```typescript
  const {
    manager, eventBus, capabilityRegistry, serviceRegistry, enforcer, auditLog, driver,
  } = await initializePluginSystem(kaizenConfig, init);

  const driverConfig =
    (kaizenConfig[driver.name] as Record<string, unknown> | undefined) ?? {};
  const secretsCtx = createSecretsContext(new SecretsRegistry(), driver.name, {});
  const ctx = createPluginContext(
    driver.name, driverConfig, secretsCtx, eventBus, capabilityRegistry, serviceRegistry,
    enforcer, () => "RUNNING", manager.getPublicApi(), manager.getLifecycleApi(),
  );

  try {
    await runInPluginScope(driver.name, async () => { await driver.start!(ctx); });
  ```

- [ ] **Step 4: Run type-check — expect clean**

  ```bash
  bunx tsc --noEmit
  ```

  Expected: no output (zero errors).

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/index.ts
  git commit -m "refactor(core): rename lifecycleProvider → driver in index"
  ```

---

### Task 4: Fix `cli.ts` — default plugin name

**Files:**
- Modify: `src/cli.ts:69`

- [ ] **Step 1: Update the default plugin list**

  At line 69, replace:
  ```typescript
  "official/core-lifecycle@0.1.0",
  ```
  with:
  ```typescript
  "official/core-driver@0.1.0",
  ```

- [ ] **Step 2: Run type-check**

  ```bash
  bunx tsc --noEmit
  ```

  Expected: no output.

- [ ] **Step 3: Commit**

  ```bash
  git add src/cli.ts
  git commit -m "refactor(cli): rename default plugin core-lifecycle → core-driver"
  ```

---

### Task 5: Fix `plugin-manager.test.ts`

**Files:**
- Modify: `src/core/plugin-manager.test.ts:76-215`

- [ ] **Step 1: Run the existing tests to confirm which ones fail**

  ```bash
  bun test src/core/plugin-manager.test.ts 2>&1
  ```

  Expected failures: all tests in the `PluginManager.initialize` describe block that reference `lifecycle` in fixture code, variable names, or error regex patterns. Tests outside that block should still pass.

- [ ] **Step 2: Update `PluginSpec` interface and `writePlugin`**

  Replace lines 73–107:

  ```typescript
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
  ```

- [ ] **Step 3: Update the five tests in `PluginManager.initialize`**

  Replace lines 109–215 with:

  ```typescript
  describe("PluginManager.initialize", () => {
    test("calls setup on all plugins and returns driver", async () => {
      const bridgeKey = `__kz_test_${Date.now()}_${Math.random()}__`;
      (globalThis as Record<string, unknown>)[bridgeKey] = { calls: [] as string[] };
      const driverDir = writePlugin({
        name: "core-driver",
        driver: true,
        hasStart: true,
        setupBody: `globalThis[${JSON.stringify(bridgeKey)}].calls.push("core-driver");`,
      });

      const { eventBus, capabilityRegistry, serviceRegistry } = makeRegistries();
      const config: KaizenConfig = { plugins: [driverDir] };
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
      const driverDir = writePlugin({
        name: "core-driver",
        driver: true,
        hasStart: true,
        setupBody: `throw new Error("boom");`,
      });
      const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
      const manager = new PluginManager(
        { plugins: [driverDir] },
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
  ```

- [ ] **Step 4: Run tests — expect all passing**

  ```bash
  bun test src/core/plugin-manager.test.ts 2>&1
  ```

  Expected: all tests pass, including the six `PluginManager.initialize` tests.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/plugin-manager.test.ts
  git commit -m "test(core): update plugin-manager tests for driver rename"
  ```

---

### Task 6: Fix event namespace in remaining test files

**Files:**
- Modify: `src/core/capability-registry.test.ts:7,10,88,93,94`
- Modify: `src/core/manifest-synthesizer.test.ts:61,63`
- Modify: `src/core/plugin-hash.test.ts:56,62`
- Modify: `src/core/permission-enforcer.test.ts:86,87`
- Modify: `src/core/uac-renderer.test.ts:14,21`

- [ ] **Step 1: Update `capability-registry.test.ts`**

  Replace all four occurrences of `"core-lifecycle:ui.input"` with `"core-driver:ui.input"` and both occurrences of the string `"core-lifecycle"` (the owner argument) with `"core-driver"`:

  ```typescript
  // Line 7-10: define + getSpec round-trips test
  r.define("core-driver:ui.input", "core-driver", {
    cardinality: "many", description: "User input source"
  });
  const spec = r.getSpec("core-driver:ui.input");

  // Line 88: resolveName passthrough test
  expect(r.resolveName("core-driver:ui.input", {})).toBe("core-driver:ui.input");

  // Lines 93-94: resolveName with aliases test
  const aliases = { "ui.input": "core-driver:ui.input" };
  expect(r.resolveName("ui.input", aliases)).toBe("core-driver:ui.input");
  ```

- [ ] **Step 2: Update `manifest-synthesizer.test.ts`**

  Replace both occurrences of `"core-lifecycle:tool:before"` with `"core-driver:tool:before"`:

  ```typescript
  rec("p1", { kind: "events.subscribe", event: "core-driver:tool:before" }),
  // ...
  expect(synthesizeManifest("p1", records).events?.subscribe).toEqual(["core-driver:tool:before"]);
  ```

- [ ] **Step 3: Update `plugin-hash.test.ts`**

  Replace both occurrences of `"core-lifecycle:tool:before"` with `"core-driver:tool:before"`:

  ```typescript
  events: { subscribe: ["core-driver:tool:before"] },
  ```
  (appears twice — both the input fixture and the expected output)

- [ ] **Step 4: Update `permission-enforcer.test.ts`**

  Replace both occurrences of `"core-lifecycle:tool:before"` with `"core-driver:tool:before"`:

  ```typescript
  e.register("p1", { tier: "scoped", events: { subscribe: ["core-driver:tool:before", "other:*"] } });
  expect(() => e.check("p1", { kind: "events.subscribe", event: "core-driver:tool:before" })).not.toThrow();
  ```

- [ ] **Step 5: Update `uac-renderer.test.ts`**

  Replace both occurrences of `"core-lifecycle:tool:before"` with `"core-driver:tool:before"`:

  ```typescript
  events: { subscribe: ["core-driver:tool:before"] },
  // ...
  expect(out).toContain("core-driver:tool:before");
  ```

- [ ] **Step 6: Run all unit tests — expect all passing**

  ```bash
  bun test --exclude "**/*.integration.test.*" 2>&1
  ```

  Expected: full pass. No lifecycle-related test failures.

- [ ] **Step 7: Commit**

  ```bash
  git add src/core/capability-registry.test.ts src/core/manifest-synthesizer.test.ts \
          src/core/plugin-hash.test.ts src/core/permission-enforcer.test.ts \
          src/core/uac-renderer.test.ts
  git commit -m "test(core): rename core-lifecycle event namespace to core-driver"
  ```

---

### Task 7: Update orchestration and marketplace tests (coordinated with plugins PR)

> **Note:** These tests reference `fixture-lifecycle` from the `kaizen-official-plugins` CI fixture marketplace. Update them here, but CI will only be green once the coordinated plugins PR (renaming `fixture-lifecycle` → `fixture-driver`) also lands.

**Files:**
- Modify: `src/core/orchestration.test.ts:32,39-48,99,109-116`
- Modify: `src/core/harness-marketplace.test.ts:87`

- [ ] **Step 1: Update `orchestration.test.ts`**

  Replace both occurrences of `"ci/fixture-lifecycle@1.0.0"` with `"ci/fixture-driver@1.0.0"` (lines 32 and 99).

  Replace the `EVENTS` array (lines 39–48) — the driver-emitted events rename:
  ```typescript
  const EVENTS = [
    "test:driver:start",
    "session:start",
    "session:user_message",
    "test:executor:send",
    "session:response",
    "test:ui:sent",
    "session:end",
    "test:driver:end",
  ];
  ```

  Replace the `expect(observed).toEqual(...)` assertion (lines 108–117):
  ```typescript
  expect(observed).toEqual([
    "test:driver:start",
    "session:start",
    "session:user_message",
    "test:executor:send",
    "session:response",
    "test:ui:sent",
    "session:end",
    "test:driver:end",
  ]);
  ```

- [ ] **Step 2: Update `harness-marketplace.test.ts`**

  At line 87, replace:
  ```typescript
  expect(lockRaw).toContain("fixture-lifecycle");
  ```
  with:
  ```typescript
  expect(lockRaw).toContain("fixture-driver");
  ```

- [ ] **Step 3: Run unit tests (non-integration) — expect clean**

  ```bash
  bun test --exclude "**/*.integration.test.*" 2>&1
  ```

  Expected: all pass. (Integration tests that hit the CI marketplace will fail until the plugins PR lands — that's expected and acceptable.)

- [ ] **Step 4: Commit**

  ```bash
  git add src/core/orchestration.test.ts src/core/harness-marketplace.test.ts
  git commit -m "test(core): update fixture references from fixture-lifecycle to fixture-driver"
  ```

---

### Task 8: Update docs

**Files:**
- Modify: `docs/concepts/architecture.md`
- Modify: `docs/concepts/platform.md`
- Modify: `docs/concepts/plugin-model.md`
- Modify: `docs/concepts/harnesses.md`
- Modify: `docs/concepts/security.md`
- Modify: `docs/guides/plugin-authoring.md`
- Modify: `docs/guides/contributing.md`
- Modify: `docs/core-internals.md`

In each file, apply these substitutions (leave generic lifecycle language untouched):

| Find | Replace |
|------|---------|
| `lifecycle: true` (in code blocks / flag references) | `driver: true` |
| `core-lifecycle` (plugin name) | `core-driver` |
| `lifecycleProvider` (in prose/code) | `driver` |
| `"core-lifecycle:*"` (event namespace strings) | `"core-driver:*"` |
| kaizen.json config key `"core-lifecycle"` | `"core-driver"` |

**Do not change:** "plugin lifecycle", "lifecycle state", "lifecycle hooks", "lifecycle shape", "lifecycle management" — these refer to the generic concept, not the driver plugin.

- [ ] **Step 1: Update `docs/concepts/architecture.md`**

  Change the ASCII diagram label from `core-lifecycle` to `core-driver`. Change `lifecycle: true` to `driver: true`. Leave "lifecycle.start(ctx)" prose as "driver.start(ctx)" only where it refers to the variable name; generic "lifecycle" phrases stay.

- [ ] **Step 2: Update `docs/concepts/platform.md`**

  Change `lifecycle: true` to `driver: true`. The `core-lifecycle` plugin name → `core-driver`. The prose "session driver" wording is already correct; only the flag name and plugin name need updating.

- [ ] **Step 3: Update `docs/concepts/plugin-model.md`**

  Change `lifecycle: true` to `driver: true`. The heading "## Plugin lifecycle" and the sentence "A plugin may additionally declare `driver: true`..." should use `driver`. Keep the `## Plugin lifecycle` section heading as-is (it describes the general plugin lifecycle phases, not the driver concept).

- [ ] **Step 4: Update `docs/concepts/harnesses.md`**

  Change all `"core-lifecycle"` config keys in kaizen.json examples to `"core-driver"`. Change `lifecycle` capability reference to `driver` where it means the plugin kind.

- [ ] **Step 5: Update `docs/concepts/security.md`**

  Change `"core-lifecycle:*"` event subscription example to `"core-driver:*"`.

- [ ] **Step 6: Update `docs/guides/plugin-authoring.md`**

  Change `lifecycle` field reference to `driver`. The sentence "Optional: `lifecycle`, ..." should read "Optional: `driver`, ...".

- [ ] **Step 7: Update `docs/guides/contributing.md`**

  Change the example commit message from `lifecycle flag` to `driver flag`.

- [ ] **Step 8: Update `docs/core-internals.md`**

  Change `lifecycleProvider` variable references to `driver`. Change `lifecycle plugin` to `driver plugin`. Change `lifecycle: true` to `driver: true` in any code examples.

- [ ] **Step 9: Commit**

  ```bash
  git add docs/concepts/ docs/guides/ docs/core-internals.md
  git commit -m "docs: rename lifecycle flag and plugin to driver throughout"
  ```

---

### Task 9: Final verification

- [ ] **Step 1: Full type-check**

  ```bash
  bunx tsc --noEmit
  ```

  Expected: no output.

- [ ] **Step 2: Run unit tests**

  ```bash
  bun test --exclude "**/*.integration.test.*" 2>&1
  ```

  Expected: all pass.

- [ ] **Step 3: Confirm no driver-sense lifecycle references remain in src/**

  ```bash
  grep -rn "lifecycle" src/ --include="*.ts" | grep -v "node_modules" | grep -v "lifecycle state\|lifecycle hook\|lifecycle shape\|lifecycle management\|any lifecycle\|object lifecycle\|entity lifecycle\|plugin lifecycle"
  ```

  Expected: no output. Any remaining hits are generic lifecycle language that doesn't need renaming.

- [ ] **Step 4: Confirm no driver-sense lifecycle references remain in docs/**

  ```bash
  grep -rn "lifecycle: true\|core-lifecycle\|lifecycleProvider\|lifecycleConfig" docs/ | grep -v "superpowers/"
  ```

  Expected: no output.
