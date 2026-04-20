# Lifecycle Driver Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `core-lifecycle:lifecycle.drive` capability lookup with a `lifecycle: true` manifest flag, so any plugin can be the session driver without pretending to own the `core-lifecycle` namespace.

**Architecture:** Core identifies the session driver by scanning loaded plugins for a boolean `lifecycle` flag on the default export. The capability registry keeps its ownership-prefix rule. The `core-lifecycle:lifecycle.drive` capability is deleted; other `core-lifecycle:*` capabilities (executor.send, ui.input, ui.output) are untouched because `core-lifecycle` legitimately owns them. Coordinated release with `kaizen-official-plugins` — three consumer plugins drop a now-meaningless `consumes` line, and `core-lifecycle` gains the flag.

**Tech Stack:** TypeScript, Bun, `bun test`. Plan touches two repos: `kaizen` (this repo) and `kaizen-official-plugins` (sibling checkout at `~/git/kaizen-official-plugins`).

**Spec:** `docs/superpowers/specs/2026-04-20-lifecycle-driver-decoupling-design.md`

---

## File Structure

**kaizen repo (this repo):**
- Modify `src/types/plugin.ts` — add `lifecycle?: boolean` to `KaizenPlugin`.
- Modify `src/core/plugin-manager.ts` — replace driver-lookup block (~lines 449–457); update `isCritical` (~line 207) to treat `lifecycle: true` plugins as critical.
- Modify `src/core/plugin-manager.test.ts` — convert existing lifecycle fixtures to use the flag; add error-path tests.
- Modify `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs` — rename back to `fixture-lifecycle`, add flag, drop `lifecycle.drive` capability, remove issue-#13 comment.
- Modify `DESIGN.md` — narrow update: add "Platform Contract" framing; deprecate "role" language for the lifecycle hand-off.

**kaizen-official-plugins repo:**
- Modify `plugins/core-lifecycle/index.ts` — add `lifecycle: true`; remove `lifecycle.drive` provides + defineCapability.
- Modify `plugins/core-lifecycle/index.test.ts` — update affected assertions.
- Modify `plugins/core-cli/index.ts` — drop `consumes: ["core-lifecycle:lifecycle.drive"]`.
- Modify `plugins/core-plugin-manager/index.ts` — same.
- Modify `plugins/timestamps/index.ts` — remove `lifecycle.drive` from consumes.

---

## Task 1: Add `lifecycle` flag to plugin manifest type

**Files:**
- Modify: `src/types/plugin.ts:338-362`

- [ ] **Step 1: Add the optional flag to `KaizenPlugin`**

Edit `src/types/plugin.ts`. In the `KaizenPlugin` interface (starts around line 338), add a new optional field between `name`/`apiVersion` and `capabilities`:

```ts
export interface KaizenPlugin {
  /** kebab-case. Must match the config namespace key in kaizen.json. */
  name: string;

  /** semver. Core warns if major != PLUGIN_API_VERSION. */
  apiVersion: string;

  /**
   * True if this plugin drives the session loop. Core calls start() on the
   * one plugin with lifecycle=true after bootstrap. Exactly one loaded
   * plugin must declare this; zero or two+ is a fatal startup error.
   */
  lifecycle?: boolean;

  /** What this plugin provides and consumes in the capability registry. */
  capabilities?: PluginCapabilities;

  // ... rest unchanged
```

- [ ] **Step 2: Typecheck**

Run: `bun run tsc --noEmit -p tsconfig.json` (or the repo's usual typecheck command — check `package.json` scripts).
Expected: No new errors. Existing code is untouched because the field is optional.

- [ ] **Step 3: Commit**

```bash
git add src/types/plugin.ts
git commit -m "feat(types): add lifecycle flag to KaizenPlugin manifest (#13)"
```

---

## Task 2: Update `isCritical` to treat flagged plugins as critical

**Files:**
- Modify: `src/core/plugin-manager.ts:207-215`
- Test: `src/core/plugin-manager.test.ts`

**Why:** Today, `isCritical` returns true only when a plugin provides a `cardinality: "one"` capability that has consumers. After we remove the `lifecycle.drive` capability, `core-lifecycle` would no longer be critical by that rule, so a `setup()` throw would be demoted from fatal to warning. The `lifecycle: true` flag must preserve criticality.

- [ ] **Step 1: Write the failing test**

Add this test to `src/core/plugin-manager.test.ts` in the `PluginManager.initialize` describe block (around line 89–153 area):

```ts
test("plugin with lifecycle:true is treated as critical — setup throws are fatal", async () => {
  const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
  executorRegistry.register(stubExecutor, "test-exec");
  uiRegistry.register(stubUi, "test-ui");

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
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  await expect(manager.initialize()).rejects.toThrow(/provides critical capability.*boom/i);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun test src/core/plugin-manager.test.ts -t "lifecycle:true is treated as critical"`
Expected: FAIL (the plugin is not treated as critical — setup throw becomes a logged failure, not a thrown fatal).

- [ ] **Step 3: Update `isCritical`**

In `src/core/plugin-manager.ts`, replace the body of `isCritical` (lines ~207–215) with:

```ts
function isCritical(plugin: KaizenPlugin, reg: CapabilityRegistry): boolean {
  if (plugin.lifecycle === true) return true;
  const aliases = plugin.aliases ?? {};
  for (const raw of plugin.capabilities?.provides ?? []) {
    const cap = resolveCapName(raw, aliases);
    const spec = reg.getSpec(cap);
    if (spec?.cardinality === "one" && reg.consumersOf(cap).length > 0) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test src/core/plugin-manager.test.ts -t "lifecycle:true is treated as critical"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager.test.ts
git commit -m "feat(core): treat lifecycle-flagged plugins as critical during setup (#13)"
```

---

## Task 3: Replace the hardcoded driver lookup with the manifest-flag scan

**Files:**
- Modify: `src/core/plugin-manager.ts:449-457`
- Test: `src/core/plugin-manager.test.ts`

- [ ] **Step 1: Write the failing test — driver found via flag**

In `src/core/plugin-manager.test.ts`, add this test inside the `PluginManager.initialize` describe:

```ts
test("finds session driver via lifecycle:true flag — no capability required", async () => {
  const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
  executorRegistry.register(stubExecutor, "test-exec");
  uiRegistry.register(stubUi, "test-ui");

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
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  const { lifecycleProvider } = await manager.initialize();
  expect(lifecycleProvider.name).toBe("fixture-lifecycle");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun test src/core/plugin-manager.test.ts -t "finds session driver via lifecycle:true flag"`
Expected: FAIL — the current code greps the capability registry for `core-lifecycle:lifecycle.drive` and finds no provider.

- [ ] **Step 3: Replace the driver lookup block**

In `src/core/plugin-manager.ts`, find the block starting at the comment `// Resolve lifecycle provider` (around line 449) and replace it with:

```ts
    // Resolve lifecycle provider — the one plugin with `lifecycle: true`.
    // Core's single cross-plugin contract: call start() on the session driver.
    const lifecyclePluginNames: string[] = [];
    for (const [name, entry] of this.plugins) {
      if (entry.plugin.lifecycle === true && entry.entry.status === "loaded") {
        lifecyclePluginNames.push(name);
      }
    }
    if (lifecyclePluginNames.length === 0) {
      fatal("No lifecycle plugin found. A plugin with 'lifecycle: true' must be loaded. Add one to kaizen.json.");
    }
    if (lifecyclePluginNames.length > 1) {
      const quoted = lifecyclePluginNames.map((n) => `'${n}'`).join(", ");
      fatal(
        `Multiple lifecycle plugins loaded: ${quoted}. ` +
        `A harness may have exactly one plugin with 'lifecycle: true'. Remove one from your kaizen.json.`,
      );
    }
    const lifecycleName = lifecyclePluginNames[0]!;
    const lifecycleProvider = this.plugins.get(lifecycleName)?.plugin;
    if (!lifecycleProvider || typeof lifecycleProvider.start !== "function") {
      fatal(`Plugin '${lifecycleName}' declares 'lifecycle: true' but does not export a start() function.`);
    }

    return { lifecycleProvider: lifecycleProvider! };
  }
```

- [ ] **Step 4: Run the new test to confirm it passes**

Run: `bun test src/core/plugin-manager.test.ts -t "finds session driver via lifecycle:true flag"`
Expected: PASS.

- [ ] **Step 5: Run the full file to see what else breaks**

Run: `bun test src/core/plugin-manager.test.ts`
Expected: Existing tests that rely on `provides: ["core-lifecycle:lifecycle.drive"]` now fail with "No lifecycle plugin found." — that's expected; Task 4 fixes them.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager.test.ts
git commit -m "feat(core): resolve session driver via lifecycle flag, not capability (#13)"
```

---

## Task 4: Migrate existing plugin-manager tests to the flag

**Files:**
- Modify: `src/core/plugin-manager.test.ts` (multiple locations)

**Goal:** Every existing test that set up a lifecycle plugin via `provides: ["core-lifecycle:lifecycle.drive"]` + `defineCapability` must switch to `lifecycle: true`. There are 6 occurrences (lines ~100, 135, 286, 417, 458, 486 per the spec's grep).

- [ ] **Step 1: Convert all lifecycle fixture declarations**

For each of the six test fixture objects that currently look like this:

```ts
const lifecyclePlugin: KaizenPlugin = {
  name: "core-lifecycle", apiVersion: "2",
  capabilities: { provides: ["core-lifecycle:lifecycle.drive"] },
  async setup(ctx) {
    ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "lifecycle" });
    // (optionally more setup code)
  },
  async start() {},
};
```

rewrite them to:

```ts
const lifecyclePlugin: KaizenPlugin = {
  name: "core-lifecycle", apiVersion: "2",
  lifecycle: true,
  async setup(ctx) {
    // (preserve any remaining setup code — drop only the lifecycle.drive defineCapability)
  },
  async start() {},
};
```

Preserve any other body in `setup()` (for example, the test at line ~454 defines additional capabilities or registers tools — keep those). Only remove the `capabilities.provides` entry for `core-lifecycle:lifecycle.drive` and its matching `defineCapability` call.

**Special case — alias resolution test (around line 454):** the test asserts a consumer plugin with `aliases: { "lifecycle": "core-lifecycle:lifecycle.drive" }` consumes `["lifecycle"]`. Since we're deleting the `lifecycle.drive` capability, this assertion is now testing a scenario that can't occur in production. Rewrite the test to assert alias resolution against some *other* capability that still exists — e.g. have the lifecycle plugin also define `core-lifecycle:executor.send` (cardinality "many") and consume that through the alias, OR replace the test's capability with a made-up one like `core-lifecycle:ui` with cardinality "many". Pick whichever is a smaller diff. The goal of the test is alias resolution mechanics, not lifecycle specifically.

- [ ] **Step 2: Run the affected test file**

Run: `bun test src/core/plugin-manager.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Run the whole suite to catch collateral damage**

Run: `bun test`
Expected: All tests pass. Any failures are expected in `src/core/orchestration.test.ts` (fixed in Task 6) or are real regressions needing investigation.

- [ ] **Step 4: Commit**

```bash
git add src/core/plugin-manager.test.ts
git commit -m "test(core): migrate lifecycle fixtures to lifecycle flag (#13)"
```

---

## Task 5: Add error-path tests for zero / multiple / missing-start

**Files:**
- Modify: `src/core/plugin-manager.test.ts`

- [ ] **Step 1: Write the "zero lifecycle plugins" failing test**

Add to the `PluginManager.initialize` describe block:

```ts
test("fatals when no plugin declares lifecycle:true", async () => {
  const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
  const plain = makePlugin("tool-only", async () => {});
  const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
  const manager = new PluginManager(
    { plugins: ["tool-only"] }, { "tool-only": plain },
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  await expect(manager.initialize()).rejects.toThrow(/No lifecycle plugin found.*lifecycle: true/);
});
```

- [ ] **Step 2: Write the "multiple lifecycle plugins" failing test**

```ts
test("fatals with names listed when two plugins declare lifecycle:true", async () => {
  const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
  executorRegistry.register(stubExecutor, "test-exec");
  uiRegistry.register(stubUi, "test-ui");
  const a: KaizenPlugin = { name: "a-life", apiVersion: "2", lifecycle: true, async setup() {}, async start() {} };
  const b: KaizenPlugin = { name: "b-life", apiVersion: "2", lifecycle: true, async setup() {}, async start() {} };
  const { enforcer, auditLog, lockfilePath, options } = makeSandboxStubs();
  const manager = new PluginManager(
    { plugins: ["a-life", "b-life"] }, { "a-life": a, "b-life": b },
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  await expect(manager.initialize()).rejects.toThrow(
    /Multiple lifecycle plugins loaded: 'a-life', 'b-life'.*exactly one/,
  );
});
```

- [ ] **Step 3: Write the "lifecycle flag but no start()" failing test**

```ts
test("fatals when lifecycle plugin has no start() function", async () => {
  const { eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry } = makeRegistries();
  executorRegistry.register(stubExecutor, "test-exec");
  uiRegistry.register(stubUi, "test-ui");
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
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, options,
  );
  await expect(manager.initialize()).rejects.toThrow(
    /'broken-life' declares 'lifecycle: true' but does not export a start\(\) function/,
  );
});
```

- [ ] **Step 4: Run the three new tests**

Run: `bun test src/core/plugin-manager.test.ts -t "fatals"`
Expected: All three pass (the production code from Task 3 already throws these messages).

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.test.ts
git commit -m "test(core): cover zero/multiple/missing-start lifecycle errors (#13)"
```

---

## Task 6: Fix the CI-marketplace fixture and orchestration test

**Files:**
- Modify: `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs`

- [ ] **Step 1: Rewrite the fixture manifest**

Replace the entire contents of `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs` with:

```js
// Minimal lifecycle provider. Drives exactly one session turn, emits
// test:lifecycle:start / :end bracketing the work, then returns so
// bootstrap() resolves.
export default {
  name: "fixture-lifecycle",
  apiVersion: "2",
  lifecycle: true,
  capabilities: {
    consumes: ["core-lifecycle:executor.send", "core-lifecycle:ui"],
  },
  async setup(ctx) {
    ctx.defineCapability("core-lifecycle:executor.send", { cardinality: "one", description: "LLM executor" });
    ctx.defineCapability("core-lifecycle:ui", { cardinality: "many", description: "UI provider" });
  },
  async start(ctx) {
    await ctx.emit("test:lifecycle:start");
    await ctx.emit("session:start");

    const ui = ctx.runtime.ui.getFirst();
    const executor = ctx.runtime.executors.getFirst();

    for await (const channel of ui.accept()) {
      const userMsg = await channel.receive();
      if (!userMsg) break;
      await ctx.emit("session:user_message", userMsg);

      const tools = ctx.runtime.tools.list();
      const response = await executor.send([userMsg], tools);
      await ctx.emit("session:response", response);
      await channel.send({ type: "text", content: response.content });

      await channel.close();
      break;
    }

    await ctx.emit("session:end");
    await ctx.emit("test:lifecycle:end");
  },
};
```

Notes on the diff from the current file:
- `name` changes from `"core-lifecycle"` back to `"fixture-lifecycle"`.
- The 6-line `// Workaround for issue #13` comment is deleted.
- `lifecycle: true` added.
- `provides: ["core-lifecycle:lifecycle.drive"]` removed from `capabilities`.
- The `defineCapability("core-lifecycle:lifecycle.drive", ...)` call is removed from `setup`.
- `capabilities.consumes` and the remaining two `defineCapability` calls are preserved — the fixture still needs an executor and UI, and it still owns defining those capabilities in this CI harness.

**Why it still defines `core-lifecycle:*` capabilities even though its name is no longer `core-lifecycle`:** The ownership-prefix rule in the capability registry (`src/core/capability-registry.ts:19`) will throw when `fixture-lifecycle` tries to `defineCapability("core-lifecycle:executor.send", ...)`. This fixture is the *only* plugin in the CI marketplace, and it needs an executor and UI capability to exist for validation. Two options:

1. **Preferred:** Change the defined capability names to `fixture-lifecycle:executor.send` / `fixture-lifecycle:ui`, and update the matching `consumes` entries (and the CI marketplace's executor/UI fixture plugins, if any exist — check `tests/fixtures/ci-marketplace/plugins/` for siblings).
2. If that expands the blast radius too far, leave the names as `core-lifecycle:*` and temporarily loosen (or work around) the ownership check in the fixture. Do *not* pursue this without explicit sign-off — it reintroduces the smell #13 was trying to eliminate.

Before implementing, `ls tests/fixtures/ci-marketplace/plugins/` and `grep -r "core-lifecycle:" tests/fixtures/ci-marketplace/` to survey. If the only definitions are in `fixture-lifecycle`, option 1 is mechanical.

- [ ] **Step 2: Survey sibling fixtures**

Run:
```bash
ls tests/fixtures/ci-marketplace/plugins/
grep -rn "core-lifecycle:\|defineCapability\|provides\|consumes" tests/fixtures/ci-marketplace/plugins/
```
Expected: understand which fixture plugins in the CI marketplace reference `core-lifecycle:*` capabilities. If `fixture-lifecycle` is the sole defining site, proceed with option 1 (rename the capabilities to `fixture-lifecycle:*`).

- [ ] **Step 3: Apply option 1 if applicable**

If the survey shows other fixtures provide `core-lifecycle:executor.send` or `core-lifecycle:ui`, update each to `fixture-lifecycle:executor.send` / `fixture-lifecycle:ui` so the namespace matches the defining plugin. Update the `consumes` list in `fixture-lifecycle/index.mjs` to match, and update the two `defineCapability` calls' names.

Final `fixture-lifecycle/index.mjs` (option 1 applied):

```js
export default {
  name: "fixture-lifecycle",
  apiVersion: "2",
  lifecycle: true,
  capabilities: {
    consumes: ["fixture-lifecycle:executor.send", "fixture-lifecycle:ui"],
  },
  async setup(ctx) {
    ctx.defineCapability("fixture-lifecycle:executor.send", { cardinality: "one", description: "LLM executor" });
    ctx.defineCapability("fixture-lifecycle:ui", { cardinality: "many", description: "UI provider" });
  },
  async start(ctx) {
    // (body unchanged from Step 1)
  },
};
```

- [ ] **Step 4: Run the orchestration test**

Run: `bun test src/core/orchestration.test.ts`
Expected: PASS. The fixture is now a legitimate `fixture-lifecycle` plugin, no name spoofing required, and the ownership check is satisfied because every defined capability uses the `fixture-lifecycle:` prefix.

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs
# Include any sibling fixture files touched in Step 3
git commit -m "test(fixtures): rename fixture-lifecycle back to its real name (#13)"
```

---

## Task 7: Update DESIGN.md — narrow framing update

**Files:**
- Modify: `DESIGN.md`

**Scope:** Add the "Platform Contract" framing. Do *not* attempt a full doc rewrite — "role" language appears throughout DESIGN.md (lines 67–70, 99–102, 130–142, etc.) and tackling all of it exceeds this plan. The goal here is to make the current reality discoverable to future readers.

- [ ] **Step 1: Replace the "Role" definition**

In `DESIGN.md`, find the `**Role:**` definition (around line 67) and replace the paragraph with:

```markdown
**Platform Contract:** After `bootstrap()`, core calls `start()` on exactly one
loaded plugin — the **session driver**. A plugin declares itself as the driver
by setting `lifecycle: true` on its default export. Exactly one loaded plugin
must declare this; zero or more than one is a fatal startup error. This is the
sole plugin-to-core contract; everything else (executor, UI, tools) is
plugin-to-plugin and modeled as capabilities.

**Capability:** A named plugin-to-plugin interface (`<owner-plugin>:<name>`)
registered at startup. Providers register their implementation; consumers
declare they'll use it. Core validates cardinality (`one` vs `many`) but
holds no opinion about semantics — capabilities are agreements between
plugins. The owner-prefix rule (name must match the defining plugin's name)
prevents namespace hijacking.

**(Historical note: earlier drafts used "role" as a first-class concept. The
capability registry subsumed roles for plugin-to-plugin interfaces; the
session-driver hand-off was decoupled from capabilities entirely via the
`lifecycle` flag. Other "role" language in this document is stale and
will be revised incrementally.)**
```

- [ ] **Step 2: Add a one-line deprecation note at the top of DESIGN.md**

Below the frontmatter (around line 9), after the existing `Supersedes:` line, add:

```markdown

> **Note (2026-04-20, issue #13):** "Role" terminology is deprecated. See the
> Platform Contract / Capability definitions below and the lifecycle-driver
> decoupling spec at `docs/superpowers/specs/2026-04-20-lifecycle-driver-decoupling-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): document platform contract and deprecate role language (#13)"
```

---

## Task 8: Update `core-lifecycle` in kaizen-official-plugins

**Files (in sibling repo):**
- Modify: `~/git/kaizen-official-plugins/plugins/core-lifecycle/index.ts`
- Modify: `~/git/kaizen-official-plugins/plugins/core-lifecycle/index.test.ts`

**Context:** This task and Task 9 happen in the sibling checkout `~/git/kaizen-official-plugins`. All `cd` into that repo first. The kaizen dev-setup script (`scripts/dev-setup.sh`) wires the sibling repo in for local integration; the coordinated release is a paired commit in each repo.

- [ ] **Step 1: Inspect current `core-lifecycle/index.ts`**

Run: `cat ~/git/kaizen-official-plugins/plugins/core-lifecycle/index.ts`

You should see (abridged):

```ts
export default {
  name: "core-lifecycle",
  apiVersion: "2",
  capabilities: {
    provides: ["core-lifecycle:lifecycle.drive"],
    consumes: [ /* executor.send, ui.input, ui.output */ ],
  },
  async setup(ctx) {
    ctx.defineCapability("core-lifecycle:lifecycle.drive", { ... });
    ctx.defineCapability("core-lifecycle:ui.input",  { ... });
    ctx.defineCapability("core-lifecycle:ui.output", { ... });
    ctx.defineCapability("core-lifecycle:executor.send", { ... });
  },
  async start(ctx) { /* ... */ },
};
```

- [ ] **Step 2: Apply the edits**

Make three changes to `core-lifecycle/index.ts`:

1. Add `lifecycle: true,` to the default export, between `apiVersion` and `capabilities`.
2. Remove `"core-lifecycle:lifecycle.drive"` from the `capabilities.provides` array. If that leaves `provides` empty, drop the `provides` key entirely.
3. Remove the `ctx.defineCapability("core-lifecycle:lifecycle.drive", { ... })` call from `setup(ctx)`.

Keep all other capabilities (`ui.input`, `ui.output`, `executor.send`) and all other `setup` logic unchanged.

- [ ] **Step 3: Update tests**

Inspect `plugins/core-lifecycle/index.test.ts`. If any test asserts on `core-lifecycle:lifecycle.drive` (either in `capabilities.provides` or via a `defineCapability` spy/mock), update or delete that assertion. The plugin's tests should now assert `lifecycle === true` on the default export.

- [ ] **Step 4: Run the plugin's tests**

Run: `cd ~/git/kaizen-official-plugins && bun test plugins/core-lifecycle/`
Expected: All tests pass.

- [ ] **Step 5: Commit (in the official-plugins repo)**

```bash
cd ~/git/kaizen-official-plugins
git add plugins/core-lifecycle/index.ts plugins/core-lifecycle/index.test.ts
git commit -m "feat(core-lifecycle): declare lifecycle flag, drop lifecycle.drive capability"
```

---

## Task 9: Drop vestigial `lifecycle.drive` consumes from three plugins

**Files (in sibling repo):**
- Modify: `~/git/kaizen-official-plugins/plugins/core-cli/index.ts`
- Modify: `~/git/kaizen-official-plugins/plugins/core-plugin-manager/index.ts`
- Modify: `~/git/kaizen-official-plugins/plugins/timestamps/index.ts`

**Why:** These plugins declare `consumes: ["core-lifecycle:lifecycle.drive"]` but never reference the capability at runtime — confirmed via grep earlier. It was a declarative "ensure a lifecycle plugin is loaded" signal. With the flag-based driver lookup, that check is handled at driver-resolution time.

- [ ] **Step 1: core-cli**

Edit `plugins/core-cli/index.ts`. Find the line (around line 148):

```ts
capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] },
```

Delete the entire `capabilities` key from the default export (it has no other entries — verify by reading the line; if there *are* other entries, delete only the `lifecycle.drive` string from the array).

- [ ] **Step 2: core-plugin-manager**

Edit `plugins/core-plugin-manager/index.ts`. Same pattern — find the `capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] }` line (around line 7) and delete the `capabilities` key (or the one array entry if there are siblings).

- [ ] **Step 3: timestamps**

Edit `plugins/timestamps/index.ts`. Find (around line 12):

```ts
capabilities: { consumes: ["core-lifecycle:lifecycle.drive", "core-events:service"] },
```

Change to:

```ts
capabilities: { consumes: ["core-events:service"] },
```

- [ ] **Step 4: Run all three plugins' tests**

Run: `cd ~/git/kaizen-official-plugins && bun test plugins/core-cli/ plugins/core-plugin-manager/ plugins/timestamps/`
Expected: All tests pass.

- [ ] **Step 5: Commit (in the official-plugins repo)**

```bash
cd ~/git/kaizen-official-plugins
git add plugins/core-cli/index.ts plugins/core-plugin-manager/index.ts plugins/timestamps/index.ts
git commit -m "chore: drop vestigial core-lifecycle:lifecycle.drive consumes"
```

---

## Task 10: End-to-end verification

**Files:** None modified. Verification only.

- [ ] **Step 1: Run the kaizen test suite**

Run: `cd ~/git/kaizen && bun test`
Expected: All tests pass. No failures related to lifecycle or capability lookup.

- [ ] **Step 2: Run the official-plugins test suite**

Run: `cd ~/git/kaizen-official-plugins && bun test`
Expected: All tests pass.

- [ ] **Step 3: Wire the sibling repo and boot the default stack**

Run:
```bash
cd ~/git/kaizen
./scripts/dev-setup.sh
bun run build    # or equivalent — check package.json for the build script
# Attempt a dry boot. Check the repo's CONTRIBUTING.md or package.json for how
# it's usually smoke-tested. Something like:
bun run kaizen --help
```
Expected: Binary builds without errors. `--help` runs to completion.

- [ ] **Step 4: Confirm the #13 acceptance criteria**

Manually verify against the spec's Acceptance section:

```bash
cd ~/git/kaizen
grep -rn 'core-lifecycle:lifecycle.drive' src/ tests/ docs/
```
Expected output: no hits in `src/core/` runtime code. Any remaining hits should only be in the design doc / comments.

```bash
cd ~/git/kaizen-official-plugins
grep -rn 'core-lifecycle:lifecycle.drive' plugins/
```
Expected: no hits.

- [ ] **Step 5: Report**

Summarize: (a) files changed in each repo, (b) tests added, (c) grep proofs that `lifecycle.drive` is gone, (d) that #13's acceptance bullets are met. If anything is unclear or the integration test couldn't be run, say so explicitly rather than claiming success.

---

## Self-review notes

- **Spec coverage:** every acceptance bullet maps to a task — Task 6 (fixture rename), Tasks 3+5 (flag-based lookup + errors), Tasks 8+9 (no more `lifecycle.drive` capability anywhere), Task 10 (grep proof). Non-goals in the spec (capability registry unchanged, no roles, no config override) are respected.
- **Placeholder scan:** every step contains concrete code, paths, or commands.
- **Type consistency:** the flag is named `lifecycle` consistently throughout (Task 1 declares it, Task 2 checks it in `isCritical`, Task 3 scans for it, tests use it).
- **Ambiguity flagged explicitly:** Task 6 Step 1 calls out the ownership-rule collision for capability names defined by the fixture and prescribes the preferred resolution (rename to `fixture-lifecycle:` prefix). No handwaving.
