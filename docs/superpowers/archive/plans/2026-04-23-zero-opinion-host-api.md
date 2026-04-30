# Zero-Opinion Host API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip kaizen core's host API down to the plugin contract + `PLUGIN_API_VERSION`. Remove `createLLMRuntime`, `readStdinLine`, and pre-ServiceRegistry role types. Add a `stop()` lifecycle hook so resource-owning plugins can clean up (closes #43 and #42).

**Architecture:** Four layers of change, landed in this order: (1) add `stop()` lifecycle + call it on unload + unload everything in `runHarness`'s `finally`; (2) delete `createLLMRuntime` and drop AI SDK deps; (3) delete `readStdinLine` and colocate a tiny readline helper with the CLI commands that still need it; (4) delete the pre-ServiceRegistry role types and bump `PLUGIN_API_VERSION`.

**Tech Stack:** TypeScript, Bun, `bun test`, no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-23-zero-opinion-host-api-design.md`

---

## File map

**Modified:**
- `src/types/plugin.ts` — add `stop?()` to `KaizenPlugin`; delete 12 stale types; bump `PLUGIN_API_VERSION` from `"2"` to `"3"`.
- `src/core/plugin-manager.ts` — cache ctx per plugin record; call `stop(ctx)` in `unload()`; add `unloadAll()`.
- `src/core/index.ts` — call `manager.unloadAll()` in `runHarness`'s `finally`.
- `src/host-api.ts` — remove `createLLMRuntime`, `readStdinLine` runtime exports + all stale type re-exports.
- `src/core/host-api-register.test.ts` — update to the smaller surface.
- `src/commands/install.ts` — swap `readStdinLine` import for the new CLI-local helper.
- `package.json` — drop `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`.

**Created:**
- `src/commands/cli-readline.ts` — tiny stdin-line helper for CLI-only code paths.
- `src/core/plugin-manager-stop.test.ts` — tests for `stop()` on unload + `unloadAll()`.
- `src/core/run-harness-teardown.test.ts` — regression for #42-style hangs.

**Deleted:**
- `src/core/llm.ts`
- `src/core/stdin.ts`

---

## Task 1: Add `stop?()` to the plugin contract (types only)

**Files:**
- Modify: `src/types/plugin.ts` (lines 297–328, the `KaizenPlugin` interface)

- [ ] **Step 1: Add the optional `stop` method to `KaizenPlugin`**

Edit `src/types/plugin.ts`. In the `KaizenPlugin` interface, append `stop?` after `start?`:

```ts
  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
  /**
   * Called during unload, before events/services/permissions are deregistered.
   * Use to close resources opened in setup() or start() (readline interfaces,
   * network listeners, timers, file watchers). Errors are logged but do not
   * prevent deregistration.
   */
  stop?(ctx: PluginContext): Promise<void>;
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no implementers yet, nothing to break)

- [ ] **Step 3: Commit**

```bash
git add src/types/plugin.ts
git commit -m "feat(types): add optional stop() lifecycle hook to KaizenPlugin"
```

---

## Task 2: Cache ctx per loaded plugin

The `stop(ctx)` hook needs the same `PluginContext` the plugin got at setup. Today `setupPlugin` builds ctx as a local and drops it. We add a `ctx` field to the plugin record.

**Files:**
- Modify: `src/core/plugin-manager.ts` (the record type around line 59; `setupPlugin` around line 608; stores in `this.plugins.set(...)` at lines ~410, ~513)

- [ ] **Step 1: Find the plugin-record type**

Run: `grep -n "this.plugins" src/core/plugin-manager.ts | head -20`

You'll see `this.plugins: Map<string, { plugin: KaizenPlugin; entry: PluginEntry }>` (or equivalent). Locate the declaration (grep for `plugins:` or `plugins =` in the class).

- [ ] **Step 2: Add a `ctx` field to the record type**

Find the plugin-record type declaration (near the top of the `PluginManager` class). Extend it:

```ts
  private plugins = new Map<string, { plugin: KaizenPlugin; entry: PluginEntry; ctx?: PluginContext }>();
```

(Make `ctx` optional because failed plugins never get one.)

Also add the import if not present — `PluginContext` is already imported; confirm via `grep -n "PluginContext" src/core/plugin-manager.ts`.

- [ ] **Step 3: Return the ctx from `setupPlugin`**

In `setupPlugin` (around line 608), change the signature and return statement:

```ts
  private async setupPlugin(plugin: KaizenPlugin, resolvedPath: string | null = null): Promise<PluginContext> {
```

At the end of the method (after the secret-provider block around line 676), add:

```ts
    return ctx;
```

- [ ] **Step 4: Store ctx on the record at both call sites**

In `initialize()` around line 408:

```ts
        const ctx = await this.setupPlugin(plugin, rPath);
        loadedNames.add(plugin.name);
        this.plugins.set(plugin.name, {
          plugin,
          entry: { name: plugin.name, apiVersion: plugin.apiVersion, services: plugin.services ?? {}, status: "loaded" },
          ctx,
        });
```

In `load()` around line 512:

```ts
      const ctx = await this.setupPlugin(plugin, resolvedPath);
      this.plugins.set(name, {
        plugin,
        entry: { name: plugin.name, apiVersion: plugin.apiVersion, services: plugin.services ?? {}, status: "loaded" },
        ctx,
      });
```

Leave the `catch` branches that set `status: "failed"` alone — they don't have a ctx and shouldn't.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Run existing tests**

Run: `bun test src/core/plugin-manager.test.ts`
Expected: PASS (no behavior change yet)

- [ ] **Step 7: Commit**

```bash
git add src/core/plugin-manager.ts
git commit -m "refactor(plugin-manager): cache PluginContext per loaded plugin"
```

---

## Task 3: Call `stop()` on unload (TDD)

**Files:**
- Create: `src/core/plugin-manager-stop.test.ts`
- Modify: `src/core/plugin-manager.ts` (`unload` method around line 545)

- [ ] **Step 1: Write the failing tests**

Create `src/core/plugin-manager-stop.test.ts`. Look at `src/core/plugin-manager.test.ts` first to match its harness/setup style. Then:

```ts
import { describe, it, expect, mock } from "bun:test";
import type { KaizenPlugin } from "../types/plugin.js";
import { buildTestManager } from "./plugin-manager.test-utils.js";
// If plugin-manager.test-utils.ts does not exist, inline the setup from
// src/core/plugin-manager.test.ts — do not fabricate an import.

describe("PluginManager.unload", () => {
  it("calls plugin.stop(ctx) before deregistering", async () => {
    const stop = mock(async () => {});
    const plugin: KaizenPlugin = {
      name: "stoppable",
      apiVersion: "3.0.0",
      permissions: { tier: "trusted" },
      async setup() {},
      stop,
    };
    const mgr = await buildTestManager({ plugins: [plugin] });
    await mgr.initialize();
    await mgr.unload("stoppable");
    expect(stop).toHaveBeenCalledTimes(1);
    const ctxArg = stop.mock.calls[0]![0]!;
    expect(typeof ctxArg.log).toBe("function");
    expect(typeof ctxArg.emit).toBe("function");
  });

  it("unload succeeds when plugin has no stop()", async () => {
    const plugin: KaizenPlugin = {
      name: "quiet",
      apiVersion: "3.0.0",
      permissions: { tier: "trusted" },
      async setup() {},
    };
    const mgr = await buildTestManager({ plugins: [plugin] });
    await mgr.initialize();
    await expect(mgr.unload("quiet")).resolves.toBeUndefined();
  });

  it("errors in stop() are logged but do not block deregistration", async () => {
    const stop = mock(async () => { throw new Error("boom"); });
    const plugin: KaizenPlugin = {
      name: "noisy",
      apiVersion: "3.0.0",
      permissions: { tier: "trusted" },
      async setup() {},
      stop,
    };
    const mgr = await buildTestManager({ plugins: [plugin] });
    await mgr.initialize();
    await expect(mgr.unload("noisy")).resolves.toBeUndefined();
    expect(mgr.list().find((p) => p.name === "noisy")).toBeUndefined();
  });
});
```

If `plugin-manager.test-utils.ts` does not exist, copy the test-harness bootstrap from `src/core/plugin-manager.test.ts` inline — do not invent a helper.

- [ ] **Step 2: Run tests; verify they fail**

Run: `bun test src/core/plugin-manager-stop.test.ts`
Expected: FAIL — `stop` is never called.

- [ ] **Step 3: Wire `stop()` into `unload()`**

Edit `src/core/plugin-manager.ts`, in `unload` (around line 545):

```ts
  async unload(name: string): Promise<void> {
    const record = this.plugins.get(name);
    if (!record) {
      warn(`Cannot unload plugin '${name}': not loaded.`);
      return;
    }
    if (typeof record.plugin.stop === "function" && record.ctx) {
      try {
        await runInPluginScope(name, async () => {
          await record.plugin.stop!(record.ctx!);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Plugin '${name}' stop() failed: ${msg}`);
      }
    }
    this.eventBus.deregisterByPlugin(name);
    this.serviceRegistry.deregisterByPlugin(name);
    this.enforcer.deregister(name);
    record.entry.status = "unloaded";
    this.plugins.delete(name);
    debug(`Plugin '${name}' unloaded.`);
  }
```

- [ ] **Step 4: Run tests; verify they pass**

Run: `bun test src/core/plugin-manager-stop.test.ts`
Expected: PASS (all 3)

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS — no regression.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager-stop.test.ts
git commit -m "feat(plugin-manager): call plugin.stop() on unload"
```

---

## Task 4: `unloadAll()` and `runHarness` teardown (closes #42)

**Files:**
- Modify: `src/core/plugin-manager.ts` (add `unloadAll` near `unload`)
- Modify: `src/core/index.ts` (`runHarness`, lines 81–104)
- Create: `src/core/run-harness-teardown.test.ts`

- [ ] **Step 1: Write the failing regression test**

Create `src/core/run-harness-teardown.test.ts`:

```ts
import { describe, it, expect, mock } from "bun:test";
import type { KaizenPlugin } from "../types/plugin.js";
import { runHarness } from "./index.js";
// Reuse whatever fixture helper src/core/index.test.ts uses to bootstrap
// a minimal harness from an in-memory plugin. If none exists, write a
// tmpdir-based one inline — do not invent an import.

describe("runHarness teardown", () => {
  it("calls stop() on every loaded plugin after driver.start() returns", async () => {
    const driverStop = mock(async () => {});
    const observerStop = mock(async () => {});
    const driver: KaizenPlugin = {
      name: "test-driver",
      apiVersion: "3.0.0",
      driver: true,
      permissions: { tier: "trusted" },
      async setup() {},
      async start() {},           // returns immediately
      stop: driverStop,
    };
    const observer: KaizenPlugin = {
      name: "test-observer",
      apiVersion: "3.0.0",
      permissions: { tier: "trusted" },
      async setup() {},
      stop: observerStop,
    };
    // Use the same fixture style as src/core/index.test.ts.
    await runHarnessWithPlugins([driver, observer]); // replace with the actual fixture call
    expect(driverStop).toHaveBeenCalledTimes(1);
    expect(observerStop).toHaveBeenCalledTimes(1);
  });
});
```

Look at `src/core/index.test.ts` (if it exists) or search for existing harness-level tests: `rg -l "runHarness" src/`. Match their bootstrap pattern and replace the placeholder `runHarnessWithPlugins` call. If no harness-level test exists, skip this test and write a narrower one on `PluginManager.unloadAll` only — do **not** invent infrastructure.

- [ ] **Step 2: Run test; verify it fails**

Run: `bun test src/core/run-harness-teardown.test.ts`
Expected: FAIL — stops never called.

- [ ] **Step 3: Add `unloadAll()` to `PluginManager`**

In `src/core/plugin-manager.ts`, add directly after `unload`:

```ts
  async unloadAll(): Promise<void> {
    const names = [...this.plugins.keys()];
    // Unload in reverse order so consumers stop before their providers.
    for (const name of names.reverse()) {
      await this.unload(name);
    }
  }
```

- [ ] **Step 4: Call `unloadAll()` in `runHarness`'s `finally`**

Edit `src/core/index.ts` lines 99–103:

```ts
  try {
    await runInPluginScope(driver.name, async () => { await driver.start!(ctx); });
  } finally {
    try { await manager.unloadAll(); } catch (err) {
      console.error("[kaizen] error during plugin teardown:", err);
    }
    await auditLog.flush();
  }
```

- [ ] **Step 5: Run tests; verify they pass**

Run: `bun test src/core/run-harness-teardown.test.ts src/core/plugin-manager-stop.test.ts`
Expected: PASS

- [ ] **Step 6: Full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/plugin-manager.ts src/core/index.ts src/core/run-harness-teardown.test.ts
git commit -m "feat(runtime): unload all plugins after driver.start() returns (closes #42)"
```

---

## Task 5: Remove `createLLMRuntime` and AI SDK deps

**Files:**
- Delete: `src/core/llm.ts`
- Modify: `src/host-api.ts`
- Modify: `package.json`
- Modify: `src/types/plugin.ts` (delete LLM primitive types)

- [ ] **Step 1: Verify no internal consumer besides `host-api.ts`**

Run: `rg -n "createLLMRuntime|from \"./core/llm" src/`
Expected: matches only in `src/host-api.ts` and `src/core/llm.ts` itself.

Run: `rg -n "from \"kaizen/types\"" ~/git/kaizen-official-plugins --glob '!node_modules'`
Expected: no hits for `createLLMRuntime`, `Message`, `ToolDefinition`, `ToolCall`, `LLMResponse`, `LLMStreamChunk`, `MessageRole`, `ToolResult`, `Executor`.

- [ ] **Step 2: Delete `src/core/llm.ts`**

```bash
git rm src/core/llm.ts
```

- [ ] **Step 3: Delete LLM primitive types from `src/types/plugin.ts`**

Remove the entire "LLM primitives" and "Tools" sections (lines 61–129 in the current file):

- `MessageRole`
- `Message`
- `ToolCall`
- `LLMResponse`
- `LLMStreamChunk`
- `Executor`
- `ToolResult`
- `ToolDefinition`

Leave `JsonSchema` — it's still used by `ServiceSpec.schema`.

- [ ] **Step 4: Update `src/host-api.ts`**

Replace the file content with:

```ts
/**
 * Curated host-API surface exposed to plugins via `import "kaizen/types"`.
 *
 * Runtime values live in `hostApi` and are served by the virtual module
 * registered in `src/core/host-api-register.ts`. Type-only exports are
 * re-exported from the modules that own them and are stripped at runtime.
 *
 * Adding to the plugin API = editing this file. This file is the
 * authoritative, reviewable contract between kaizen and all plugins.
 */

import { PLUGIN_API_VERSION } from "./types/plugin.js";

/** Runtime values exposed to plugins via `import "kaizen/types"`. */
export const hostApi = {
  PLUGIN_API_VERSION,
} as const;

/** Type-only exports — stripped at runtime, picked up by TypeScript. */
export type {
  KaizenPlugin,
  KaizenConfig,
  KaizenGlobalConfig,
  PluginContext,
  PluginPermissions,
  PluginServices,
  PluginConfigDeclaration,
  PermissionTier,
  PermissionOp,
  SecretRef,
  StructuredSecretRef,
  SecretsContext,
  MarketplaceCatalog,
  MarketplaceEntry,
  MarketplacePluginEntry,
  MarketplaceHarnessEntry,
  MarketplaceRef,
  PluginSource,
  PluginVersionEntry,
  HarnessVersionEntry,
  EventHandler,
  ServiceSpec,
  PluginManagerPublicApi,
  PluginManagerLifecycleApi,
  PluginEntry,
  JsonSchema,
} from "./types/plugin.js";

export type {
  CtxFs, CtxNet, CtxExec, CtxIo, ExecOpts, ExecResult,
} from "./core/plugin-ctx-io.js";

export type { SecretProvider } from "./core/secret-providers/types.js";
```

(This also removes `readStdinLine` — Task 7 handles the CLI usage of it, but deleting it here first fails the build until Task 7 runs. That's fine: we do Task 6 next, then Task 7.)

- [ ] **Step 5: Remove AI SDK deps from `package.json`**

Edit `package.json`:

```json
  "dependencies": {
    "ajv": "^8.18.0",
    "yaml": "^2.8.3"
  }
```

- [ ] **Step 6: Install to prune lockfile**

Run: `bun install`
Expected: removes `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai` from `bun.lock`.

- [ ] **Step 7: Typecheck — expected to still have one break**

Run: `bun run typecheck`
Expected: `host-api-register.test.ts` fails (asserts `createLLMRuntime`/`readStdinLine`). `install.ts` fails (imports `readStdinLine`). These are fixed in Tasks 6–7. Do NOT commit yet if there are other unexpected errors — investigate and fix first.

- [ ] **Step 8: Commit (interim — tests will be red until Task 7)**

```bash
git add -u
git commit -m "refactor(core): remove createLLMRuntime and AI SDK deps"
```

---

## Task 6: Remove the stale UI/role types

**Files:**
- Modify: `src/types/plugin.ts`

- [ ] **Step 1: Verify no consumers**

Run: `rg -n "UiChannel|UiProvider|UserMessage|AgentMessage" src/ ~/git/kaizen-official-plugins --glob '!node_modules'`
Expected: matches only the definitions in `src/types/plugin.ts` (if any remain after Task 5).

- [ ] **Step 2: Delete the UI-channel block**

Remove the "UI channel" section (lines ~131–162 in the original, which defines `UserMessage`, `AgentMessage`, `UiChannel`, `UiProvider`). `Executor` was already removed in Task 5.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no new errors beyond the CLI `readStdinLine` ones from Task 5.

- [ ] **Step 4: Commit**

```bash
git add src/types/plugin.ts
git commit -m "refactor(types): remove pre-ServiceRegistry UI role types"
```

---

## Task 7: Remove `readStdinLine`; CLI keeps its own small helper

**Files:**
- Delete: `src/core/stdin.ts`
- Create: `src/commands/cli-readline.ts`
- Modify: `src/commands/install.ts`

- [ ] **Step 1: Write the CLI-local helper**

Create `src/commands/cli-readline.ts`:

```ts
/**
 * Line reader for CLI commands that run as the kaizen binary itself
 * (install consent prompts, scaffolding wizards). Plugin code must NOT
 * use this — it is not part of the plugin host API. A plugin that
 * needs stdin input should own its own readline interface and expose
 * it as a service.
 */
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin, terminal: false });
const waiting: Array<(line: string) => void> = [];
const buffered: string[] = [];

rl.on("line", (line) => {
  const resolve = waiting.shift();
  if (resolve) resolve(line);
  else buffered.push(line);
});

rl.on("close", () => {
  for (const resolve of waiting) resolve("");
  waiting.length = 0;
});

export function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const line = buffered.shift();
    if (line !== undefined) resolve(line);
    else waiting.push(resolve);
  });
}
```

- [ ] **Step 2: Update `src/commands/install.ts` import**

Find: `import { readStdinLine } from "../core/stdin.js";` (line 14)
Replace with: `import { readStdinLine } from "./cli-readline.js";`

- [ ] **Step 3: Find any other consumers**

Run: `rg -n "from \"\\.\\./core/stdin|from \"\\./stdin|from \"\\./core/stdin" src/`
Expected: only the import just changed. If any other file imports it, swap the import the same way (target `./cli-readline.js` or the correct relative path).

- [ ] **Step 4: Delete `src/core/stdin.ts`**

```bash
git rm src/core/stdin.ts
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: only `src/core/host-api-register.test.ts` still fails (covered in Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/commands/cli-readline.ts src/commands/install.ts
git commit -m "refactor: move readStdinLine out of core host API into CLI-local helper"
```

---

## Task 8: Update `host-api-register.test.ts` and bump `PLUGIN_API_VERSION`

**Files:**
- Modify: `src/core/host-api-register.test.ts`
- Modify: `src/types/plugin.ts` (version bump)

- [ ] **Step 1: Update the register test**

Replace the body of the first `it(...)` in `src/core/host-api-register.test.ts`:

```ts
  it("makes `kaizen/types` resolvable with the host-api exports", async () => {
    _resetForTesting();
    registerHostApi();
    const mod = (await import("kaizen/types")) as Record<string, unknown>;
    expect(mod.PLUGIN_API_VERSION).toBe(hostApi.PLUGIN_API_VERSION);
    expect(mod.createLLMRuntime).toBeUndefined();
    expect(mod.readStdinLine).toBeUndefined();
  });
```

- [ ] **Step 2: Bump `PLUGIN_API_VERSION`**

Edit `src/types/plugin.ts` line 12:

```ts
export const PLUGIN_API_VERSION = "3";
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/host-api-register.test.ts src/types/plugin.ts
git commit -m "feat(api): bump PLUGIN_API_VERSION to 3 (stop() hook, removed runtime surface)"
```

---

## Task 9: Final verification sweep

**Files:** none modified — verification only.

- [ ] **Step 1: Host-api surface audit**

Run: `rg -n "hostApi\\." src/ --glob '!node_modules'`
Expected: every reference is to `hostApi.PLUGIN_API_VERSION` or the object itself. No references to `createLLMRuntime` or `readStdinLine` anywhere under `src/`.

- [ ] **Step 2: Stale types audit**

Run: `rg -n "UiChannel|UiProvider|UserMessage|AgentMessage|\\bExecutor\\b|LLMResponse|LLMStreamChunk|\\bMessageRole\\b" src/`
Expected: zero matches.

- [ ] **Step 3: AI SDK audit**

Run: `rg -n "@ai-sdk|from \"ai\"" src/ package.json`
Expected: zero matches.

- [ ] **Step 4: Typecheck + full test suite**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 5: CI-strict typecheck (matches CI behavior flagged in memory)**

Run: `bun x tsc --noEmit --strict`
Expected: PASS.

- [ ] **Step 6: Smoke build**

Run: `bun run build 2>&1 | tail -20`
Expected: completes without error (binary may not be runnable on this host — that's fine; we're checking for compile-time issues that `bun test` misses).

- [ ] **Step 7: No untracked leftovers**

Run: `git status`
Expected: clean working tree.

---

## Self-review notes

- **Spec coverage:** §1 (stop lifecycle) → Tasks 1–4. §2 (stale types) → Tasks 5 (Executor) + 6 (UI). §3 (createLLMRuntime + AI SDK) → Task 5. §4 (readStdinLine) → Task 7. §5 (final shape) → Tasks 5+8. Breaking-change section (API version bump) → Task 8. Testing section → Tasks 3, 4, 8, 9.
- **Task 2** introduces an intermediate state (ctx cached but unused) — acceptable because Task 3 immediately consumes it; keeps each diff small.
- **Task 5 Step 8** lands with red tests intentionally; Tasks 6–8 close the gap. Don't rearrange — CLI helper needs the deletion to exist first to prove the import swap was necessary, and the types deletions need to happen before the version bump semantically.
- **Spec calls for PLUGIN_API_VERSION = "3"**: Task 8 executes this.
- **No placeholders** in any step except the explicit "look at the test harness" guidance in Tasks 3 & 4 — those are necessary because the test-manager fixture shape is already in the repo and shouldn't be reinvented. Engineers must match the existing pattern.

---

Plan complete and saved to `docs/superpowers/plans/2026-04-23-zero-opinion-host-api.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
