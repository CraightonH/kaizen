# Plugin Host-API Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `import "kaizen/types"` work from any dynamically-loaded plugin, regardless of the plugin's filesystem location, without relying on an external installer or filesystem shim. Ship a `kaizen` binary that is self-contained.

**Architecture:** Register a `Bun.plugin` hook at binary boot that declares `kaizen/types` as a virtual module whose exports come from a curated host-API object (`src/host-api.ts`). Same pattern VS Code uses for the `vscode` module. No disk seeding, no external installer step.

**Tech Stack:** TypeScript, bun runtime (`Bun.plugin` with `build.module(...)`), ESM imports with `.js` extensions, `bun test`, `bun x tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-04-20-plugin-host-api-resolution-design.md`

---

## Task 1: Probe — verify `Bun.plugin` + `build.module` affects runtime `import()`

This entire plan rests on the assumption that `Bun.plugin` registered at runtime affects subsequent `await import(<abs-path>)` calls for plugin modules that do `import "kaizen/types"`. Confirm that assumption on the currently-installed bun before building anything else.

**Files:**
- Create: `src/spike/host-api-probe.ts`

- [ ] **Step 1: Write the probe**

```typescript
// src/spike/host-api-probe.ts
/**
 * Probe: does Bun.plugin + build.module at runtime affect subsequent
 * dynamic imports that reference the virtual module?
 *
 * Run:  bun src/spike/host-api-probe.ts
 * Exit: 0 on success, non-zero on failure.
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const marker = Symbol("kaizen-probe");
const hostApi = { marker, PLUGIN_API_VERSION: "probe" };

Bun.plugin({
  name: "kaizen-host-api-probe",
  setup(build) {
    build.module("kaizen/types", () => ({
      loader: "object",
      exports: hostApi,
    }));
  },
});

const dir = mkdtempSync(join(tmpdir(), "kaizen-probe-"));
const pluginPath = join(dir, "plugin.ts");
writeFileSync(pluginPath, `
  import { marker, PLUGIN_API_VERSION } from "kaizen/types";
  export default { marker, PLUGIN_API_VERSION };
`);

try {
  const mod = await import(pluginPath) as { default: { marker: symbol; PLUGIN_API_VERSION: string } };
  if (mod.default.marker !== marker) {
    console.error(`FAIL: marker identity mismatch`);
    process.exit(1);
  }
  if (mod.default.PLUGIN_API_VERSION !== "probe") {
    console.error(`FAIL: PLUGIN_API_VERSION mismatch`);
    process.exit(1);
  }
  console.log("PASS: Bun.plugin virtual module resolves from arbitrary filesystem paths");
  process.exit(0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run the probe**

Run: `bun src/spike/host-api-probe.ts`
Expected stdout: `PASS: Bun.plugin virtual module resolves from arbitrary filesystem paths`
Expected exit: `0`

**If the probe fails:** stop the plan. The resolver-hook approach is not viable on the currently-installed bun. Escalate to the user before proceeding — this would invalidate the spec's architectural choice, and we need a revised design (most likely a bun version bump or the fallback physical-shim approach).

- [ ] **Step 3: Commit**

```bash
git add src/spike/host-api-probe.ts
git commit -m "spike: probe Bun.plugin virtual module resolution from runtime"
```

---

## Task 2: Create `src/host-api.ts` (curated surface)

Add the curated public-API module. Nothing consumes it yet.

**Files:**
- Create: `src/host-api.ts`

- [ ] **Step 1: Write the module**

```typescript
// src/host-api.ts
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

import { ServiceToken } from "./core/service-registry.js";
import { readStdinLine } from "./core/stdin.js";
import { SecretsProviderToken } from "./core/secrets.js";
import { createLLMRuntime } from "./core/llm.js";
import { PLUGIN_API_VERSION } from "./types/plugin.js";

/** Runtime values exposed to plugins via `import "kaizen/types"`. */
export const hostApi = {
  ServiceToken,
  createLLMRuntime,
  readStdinLine,
  SecretsProviderToken,
  PLUGIN_API_VERSION,
} as const;

/** Type-only exports — stripped at runtime, picked up by TypeScript. */
export type {
  KaizenPlugin,
  KaizenConfig,
  KaizenGlobalConfig,
  PluginContext,
  ToolDefinition,
  ToolResult,
  Executor,
  UiProvider,
  UiChannel,
  AgentMessage,
  UserMessage,
  Message,
  MessageRole,
  ToolCall,
  LLMResponse,
  LLMStreamChunk,
  PluginPermissions,
  PluginCapabilities,
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
  CapabilitySpec,
  Cardinality,
  PluginManagerPublicApi,
  PluginManagerLifecycleApi,
  PluginEntry,
  JsonSchema,
} from "./types/plugin.js";

export type {
  CtxFs, CtxNet, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult,
} from "./core/plugin-ctx-io.js";

export type { SecretProvider } from "./core/secret-providers/types.js";
```

- [ ] **Step 2: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/host-api.ts
git commit -m "feat(host-api): add curated plugin-facing export surface"
```

---

## Task 3: Create `src/core/host-api-register.ts` + unit tests

Install the `Bun.plugin` hook. Idempotent (warns on second call). Fails loudly on non-bun runtimes.

**Files:**
- Create: `src/core/host-api-register.ts`
- Create: `src/core/host-api-register.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/host-api-register.test.ts
import { describe, it, expect, mock } from "bun:test";
import { registerHostApi, _resetForTesting } from "./host-api-register.js";
import { hostApi } from "../host-api.js";

describe("registerHostApi", () => {
  it("makes `kaizen/types` resolvable with the host-api exports", async () => {
    _resetForTesting();
    registerHostApi();
    const mod = (await import("kaizen/types")) as Record<string, unknown>;
    expect(mod.ServiceToken).toBe(hostApi.ServiceToken);
    expect(mod.createLLMRuntime).toBe(hostApi.createLLMRuntime);
    expect(mod.readStdinLine).toBe(hostApi.readStdinLine);
    expect(mod.SecretsProviderToken).toBe(hostApi.SecretsProviderToken);
    expect(mod.PLUGIN_API_VERSION).toBe(hostApi.PLUGIN_API_VERSION);
  });

  it("warns on second call and does not throw", () => {
    _resetForTesting();
    registerHostApi();
    const warnSpy = mock((_msg: string) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      registerHostApi(); // must not throw
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/host-api-register.test.ts`
Expected: FAIL — module `./host-api-register.js` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/core/host-api-register.ts
import { hostApi } from "../host-api.js";
import { warn, fatal } from "./errors.js";

let registered = false;

/**
 * Register the `kaizen/types` virtual module with bun's runtime resolver.
 * Must be called once at binary boot, before any dynamic plugin import.
 * Safe to call again — subsequent calls warn and no-op.
 */
export function registerHostApi(): void {
  if (registered) {
    warn("registerHostApi() called more than once; ignoring subsequent call");
    return;
  }
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") {
    fatal("kaizen requires the bun runtime; Bun.plugin is unavailable");
  }
  Bun.plugin({
    name: "kaizen-host-api",
    setup(build) {
      build.module("kaizen/types", () => ({
        loader: "object",
        exports: hostApi as unknown as Record<string, unknown>,
      }));
    },
  });
  registered = true;
}

/** Test-only: reset the one-shot flag. Do not call from production code. */
export function _resetForTesting(): void {
  registered = false;
}
```

Note on `_resetForTesting`: bun's plugin registrations persist across `_resetForTesting` calls within a single process — that's fine, because `build.module` with the same specifier overrides the previous mapping. We just need to let the guard allow re-registration in the test.

- [ ] **Step 4: Check `warn`/`fatal` signatures match `src/core/errors.ts`**

Run: `grep -nE "^export function (warn|fatal)" src/core/errors.ts`
Expected: `warn(message: string)` and `fatal(message: string)` (may also accept an error). If signatures differ from `(message: string)`, adjust the implementation's call sites to match.

- [ ] **Step 5: Run tests**

Run: `bun test src/core/host-api-register.test.ts`
Expected: 2 pass, 0 fail.

- [ ] **Step 6: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/host-api-register.ts src/core/host-api-register.test.ts
git commit -m "feat(host-api): register kaizen/types virtual module on bun"
```

---

## Task 4: Wire `registerHostApi()` into `src/cli.ts`

First commit that changes user-visible behavior. After this, any plugin imported by the running kaizen process resolves `kaizen/types` through the virtual module.

**Files:**
- Modify: `src/cli.ts:1-20` (add import + call near the top, after the shebang/header comment and before any dynamic-import code path runs)

- [ ] **Step 1: Edit `src/cli.ts`**

Insert the import alongside the other core imports (immediately after the existing `import` block near the top), and call `registerHostApi()` before any plugin-loading path. Specifically: after the existing imports, before the `const rawArgs = process.argv.slice(2);` line.

Add this import to the top-of-file import block:

```typescript
import { registerHostApi } from "./core/host-api-register.js";
```

Add this call after the import block and before any subcommand handling:

```typescript
// Register the `kaizen/types` virtual module for plugin imports.
// Must run before any dynamic plugin import (bootstrap, plugin dev,
// capability list, tests, etc.).
registerHostApi();
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: all tests pass (matches the current baseline: 350 pass, 0 fail).

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(host-api): wire registerHostApi into cli boot"
```

---

## Task 5: Add cross-directory integration test

Force resolution through the virtual module by placing a plugin in a tmp dir with no ancestor `node_modules/kaizen/`. This is the test the current e2e accidentally skipped.

**Files:**
- Create: `src/integration/host-api-plugin-load.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/integration/host-api-plugin-load.test.ts
/**
 * Asserts that a plugin located in a temp dir (with no ancestor
 * node_modules/kaizen/) can `import "kaizen/types"` and load cleanly after
 * `registerHostApi()` runs. This is the regression test for the gap the
 * original e2e test missed.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerHostApi } from "../core/host-api-register.js";

describe("host-api virtual module — plugin load from foreign dir", () => {
  let tmpRoot: string;
  let pluginDir: string;

  beforeAll(() => {
    registerHostApi();
    // Use tmpdir to ensure no ancestor node_modules/kaizen on the walk.
    tmpRoot = mkdtempSync(join(tmpdir(), "kaizen-host-api-"));
    pluginDir = join(tmpRoot, "plugin@0.0.1");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "probe-plugin", version: "0.0.1", type: "module", exports: { ".": "./index.ts" } }),
    );
    writeFileSync(
      join(pluginDir, "index.ts"),
      `import { ServiceToken, PLUGIN_API_VERSION } from "kaizen/types";
       import type { KaizenPlugin } from "kaizen/types";
       const token = new ServiceToken<{ hi(): string }>("probe-svc");
       const plugin: KaizenPlugin = {
         name: "probe-plugin",
         apiVersion: PLUGIN_API_VERSION + ".0.0",
         permissions: { tier: "trusted" },
         capabilities: {},
         async setup(ctx) { ctx.registerService(token, { hi: () => "hi" }); },
       };
       export default plugin;
       export { token };`,
    );
  });

  afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  it("resolves kaizen/types when loading a plugin from an isolated tmp dir", async () => {
    const mod = (await import(join(pluginDir, "index.ts"))) as {
      default: { name: string; apiVersion: string };
      token: unknown;
    };
    expect(mod.default.name).toBe("probe-plugin");
    expect(mod.default.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mod.token).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/integration/host-api-plugin-load.test.ts`
Expected: 1 pass, 0 fail.

If it fails with `Cannot find module 'kaizen/types' from …`, the wiring in Task 4 is not running before this test file executes. Confirm the test file imports `registerHostApi` and calls it in `beforeAll` (not only relying on `src/cli.ts`, which `bun test` does not execute).

- [ ] **Step 3: Commit**

```bash
git add src/integration/host-api-plugin-load.test.ts
git commit -m "test(host-api): integration test for foreign-dir plugin load"
```

---

## Task 6: Trim `src/types/plugin.ts` to type-only declarations

Remove the runtime re-exports now that they live in `host-api.ts`. Update the one internal consumer.

**Files:**
- Modify: `src/types/plugin.ts:12-23` (remove runtime re-exports, keep `PLUGIN_API_VERSION` and type-only exports)
- Modify: `src/core/context.ts:2` (update `ServiceToken` import path)

- [ ] **Step 1: Edit `src/types/plugin.ts`**

Replace the current lines 12–23:

```typescript
export const PLUGIN_API_VERSION = "2";

import { ServiceToken } from "../core/service-registry.js";
export { ServiceToken };

export type { CtxFs, CtxNet, CtxSecrets, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";

// Re-exports so first-party plugins can import everything they need from `kaizen/types`.
export { readStdinLine } from "../core/stdin.js";
export { SecretsProviderToken } from "../core/secrets.js";
export type { SecretProvider } from "../core/secret-providers/types.js";
export { createLLMRuntime } from "../core/llm.js";
```

With:

```typescript
export const PLUGIN_API_VERSION = "2";

/**
 * Type-only declarations live here. Runtime values that plugins need are
 * exposed via the `kaizen/types` virtual module (see `src/host-api.ts`
 * and `src/core/host-api-register.ts`). Internal kaizen code should
 * import runtime symbols from their owning modules, not from here.
 */

export type { CtxFs, CtxNet, CtxSecrets, CtxExec, CtxLog, CtxIo, ExecOpts, ExecResult } from "../core/plugin-ctx-io.js";
export type { SecretProvider } from "../core/secret-providers/types.js";

// ServiceToken is the type of the class instance; the class itself is
// exposed to plugins through host-api.ts. Internal consumers import the
// class directly from service-registry.js.
export type { ServiceToken } from "../core/service-registry.js";
```

- [ ] **Step 2: Update the one internal consumer in `src/core/context.ts`**

Find the current line (around line 2):

```typescript
import type { ServiceToken } from "../types/plugin.js";
```

Leave it as-is — the `export type { ServiceToken }` in the trimmed `plugin.ts` still satisfies this import. Verify by running typecheck below. If the typecheck fails, switch the import to:

```typescript
import type { ServiceToken } from "./service-registry.js";
```

- [ ] **Step 3: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0.

If typecheck fails on consumers of `ServiceToken`, `readStdinLine`, `SecretsProviderToken`, or `createLLMRuntime` that were importing from `../types/plugin.js`, change each consumer's import to the real source module:

- `ServiceToken` → `./service-registry.js` (or `../core/service-registry.js` depending on location)
- `readStdinLine` → `./stdin.js` / `../core/stdin.js`
- `SecretsProviderToken` → `./secrets.js` / `../core/secrets.js`
- `createLLMRuntime` → `./llm.js` / `../core/llm.js`

List all such consumers first with: `grep -rn "from \"\\.\\./types/plugin" src/ --include="*.ts"`.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/types/plugin.ts src/core/context.ts
git commit -m "refactor(host-api): move runtime re-exports out of types/plugin.ts"
```

---

## Task 7: Rewrite the e2e test to run through the virtual module

The current `src/integration/plugins-repo-e2e.test.ts` passes only because bun accidentally resolves `kaizen/types` through kaizen's own source tree. Make it run through the virtual module instead, so it actually exercises the real install path.

**Files:**
- Modify: `src/integration/plugins-repo-e2e.test.ts` (full rewrite)

- [ ] **Step 1: Rewrite the test**

Replace the full contents of `src/integration/plugins-repo-e2e.test.ts` with:

```typescript
/**
 * End-to-end integration test against the real kaizen-official-plugins repo.
 *
 * Exercises the actual install flow: seeds a tmp KAIZEN_HOME, registers
 * the sibling checkout as a local marketplace, installs a plugin through
 * the standard flow, loads it via the runtime loader, and asserts the
 * plugin's own `import "kaizen/types"` resolved via the host-api virtual
 * module (not via walking up into kaizen's source tree).
 *
 * Skips when the sibling repo is absent.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { addMarketplace, readCatalog } from "../core/marketplace.js";
import { installPlugin, installHarness } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import {
  pluginInstallDir, harnessInstallDir, marketplaceRepoDir,
} from "../core/kaizen-config.js";
import { registerHostApi } from "../core/host-api-register.js";

const SIBLING = resolve(process.cwd(), "..", "kaizen-official-plugins");

describe("kaizen-official-plugins e2e (through host-api virtual module)", () => {
  if (!existsSync(SIBLING)) {
    it.skip("sibling kaizen-official-plugins repo not found — skipping e2e", () => {});
    return;
  }

  beforeAll(() => { registerHostApi(); });

  let tmpHome: string;
  let originalOverride: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "kaizen-e2e-"));
    originalOverride = process.env.KAIZEN_HOME_OVERRIDE;
    process.env.KAIZEN_HOME_OVERRIDE = tmpHome;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
    else process.env.KAIZEN_HOME_OVERRIDE = originalOverride;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("installs and loads core-events through the virtual module", async () => {
    await addMarketplace(SIBLING, { id: "official", local: true });
    expect(existsSync(marketplaceRepoDir("official"))).toBe(true);

    const cat = await readCatalog("official");
    const coreEvents = cat.entries.find((e) => e.kind === "plugin" && e.name === "core-events");
    expect(coreEvents).toBeDefined();

    const version = coreEvents!.versions[0]!;
    await installPlugin(
      "official",
      "core-events",
      version.version,
      (version as { source: import("../types/plugin.js").PluginSource }).source,
    );
    expect(existsSync(pluginInstallDir("official", "core-events", version.version))).toBe(true);

    const plugin = await loadPluginFromInstallDir("official", "core-events", version.version);
    expect(plugin.name).toBe("core-events");
    expect(plugin.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("installs core-debug harness from the official marketplace", async () => {
    await addMarketplace(SIBLING, { id: "official", local: true });
    const cat = await readCatalog("official");
    const h = cat.entries.find((e) => e.kind === "harness" && e.name === "core-debug");
    expect(h).toBeDefined();
    const v = h!.versions[0]!;
    await installHarness("official", "core-debug", (v as { path: string }).path);
    expect(existsSync(join(harnessInstallDir("official", "core-debug"), "kaizen.json"))).toBe(true);
  });

  it("loads an executor plugin that imports createLLMRuntime via kaizen/types", async () => {
    // core-executor-anthropic imports `createLLMRuntime` from "kaizen/types"
    // — a runtime value that only the virtual module provides.
    await addMarketplace(SIBLING, { id: "official", local: true });
    const cat = await readCatalog("official");
    const entry = cat.entries.find((e) => e.kind === "plugin" && e.name === "core-executor-anthropic");
    expect(entry).toBeDefined();
    const version = entry!.versions[0]!;
    await installPlugin(
      "official",
      "core-executor-anthropic",
      version.version,
      (version as { source: import("../types/plugin.js").PluginSource }).source,
    );
    const plugin = await loadPluginFromInstallDir("official", "core-executor-anthropic", version.version);
    expect(plugin.name).toBe("core-executor-anthropic");
  });
});
```

- [ ] **Step 2: Delete the sibling repo's kaizen symlink workaround**

These symlinks were created as a workaround during Spec 4 and are no longer needed — the virtual module provides the resolution. Removing them also means the next run of the test proves it.

Run:

```bash
for d in /Users/chancock/git/kaizen-official-plugins/plugins/*/node_modules/kaizen \
         /Users/chancock/git/kaizen-official-plugins/node_modules/kaizen; do
  [ -L "$d" ] && rm "$d"
done
```

Expected: command succeeds, no errors. Symlinks that don't exist are silently skipped.

- [ ] **Step 3: Run the e2e test**

Run: `bun test src/integration/plugins-repo-e2e.test.ts`
Expected: 3 pass, 0 fail.

If any test fails with `Cannot find module 'kaizen/types'`, `registerHostApi()` is not running before the plugin load — verify `beforeAll(() => { registerHostApi(); })` is present and executes.

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/integration/plugins-repo-e2e.test.ts
git commit -m "test(host-api): rewrite e2e to exercise the virtual module path"
```

---

## Task 8: Add the smoke harness

Build the binary, run it against a fresh `KAIZEN_HOME`, go through the real user install flow, assert plugin loads. This catches divergence between `bun src/cli.ts` and the compiled binary — the gap that let the original bug reach the previous PR.

**Files:**
- Create: `scripts/smoke-install.sh`
- Modify: `package.json` (add `"smoke": "scripts/smoke-install.sh"` to `scripts`)

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
#
# scripts/smoke-install.sh — compile the binary, run it against a fresh
# KAIZEN_HOME, add the official marketplace by its git URL, install a
# plugin, and assert no errors.
#
# Catches divergence between `bun src/cli.ts` and the compiled binary.
# Run manually: bash scripts/smoke-install.sh
# Skip via:      SKIP_SMOKE=1 bash scripts/smoke-install.sh   (exits 0)
#
set -euo pipefail

if [[ "${SKIP_SMOKE:-}" == "1" ]]; then
  echo "smoke: SKIP_SMOKE=1 — skipping"
  exit 0
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$(mktemp -d)/kaizen"
HOME_DIR="$(mktemp -d)"
MARKETPLACE_URL="${KAIZEN_OFFICIAL_URL:-https://github.com/CraightonH/kaizen-official-plugins.git}"
PLUGIN_REF="${KAIZEN_SMOKE_PLUGIN:-official/core-events@0.1.0}"

cleanup() {
  rm -rf "$(dirname "$BIN")" "$HOME_DIR"
}
trap cleanup EXIT

echo "smoke: building binary → $BIN"
( cd "$REPO_DIR" && bun build --compile ./src/cli.ts --outfile "$BIN" >/dev/null )

echo "smoke: fresh KAIZEN_HOME → $HOME_DIR"
export KAIZEN_HOME_OVERRIDE="$HOME_DIR"

echo "smoke: marketplace add $MARKETPLACE_URL"
"$BIN" marketplace add "$MARKETPLACE_URL" --id official

echo "smoke: install $PLUGIN_REF"
"$BIN" install "$PLUGIN_REF" --non-interactive --allow-unscoped

# Install dir must exist.
VERSION="${PLUGIN_REF##*@}"
NAME_WITH_MP="${PLUGIN_REF%@*}"
NAME="${NAME_WITH_MP##*/}"
INSTALL_DIR="$HOME_DIR/marketplaces/official/plugins/${NAME}@${VERSION}"
if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "smoke: FAIL — install dir missing: $INSTALL_DIR" >&2
  exit 1
fi

echo "smoke: PASS"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/smoke-install.sh`

- [ ] **Step 3: Add the npm script**

Edit `package.json` and add the `smoke` script to the `scripts` object:

```json
"smoke": "scripts/smoke-install.sh"
```

Place it immediately after the existing `test:integration` script to keep test-related scripts grouped.

- [ ] **Step 4: Run the smoke harness**

Run: `bash scripts/smoke-install.sh`
Expected last line: `smoke: PASS`. Expected exit: 0.

If the smoke harness fails, stop and diagnose before committing — the purpose of Task 8 is to guard against exactly this kind of runtime/install divergence.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-install.sh package.json
git commit -m "test(host-api): smoke harness for compiled binary + real install"
```

---

## Task 9: Update `kaizen-official-plugins` devDep

Point the sibling workspace root at the local kaizen checkout so TypeScript in the plugin workspace finds types during authoring. (Symlink workaround was removed in Task 7 Step 2.) This lives in the sibling repo, not kaizen-code — commit there separately.

**Files:**
- Modify: `/Users/chancock/git/kaizen-official-plugins/package.json`

- [ ] **Step 1: Edit the sibling `package.json`**

Current shape:

```json
{
  "name": "kaizen-official-plugins-workspace",
  "private": true,
  "workspaces": ["plugins/*"]
}
```

Add a root-level `devDependencies` block pointing at the sibling kaizen checkout:

```json
{
  "name": "kaizen-official-plugins-workspace",
  "private": true,
  "workspaces": ["plugins/*"],
  "devDependencies": {
    "kaizen": "file:../kaizen"
  }
}
```

Note: bun will attempt to resolve kaizen's own workspace deps when installing from `file:../kaizen`. If `bun install` in the sibling fails (as it did during Spec 4), remove this block and fall back to the symlink workaround temporarily — the runtime resolution still works through the virtual module; only the design-time `tsc` experience depends on this devDep. Document the fallback in a comment.

- [ ] **Step 2: Run install in the sibling**

Run: `( cd /Users/chancock/git/kaizen-official-plugins && bun install )`
Expected: install succeeds, no workspace-resolution errors.

- [ ] **Step 3: Verify type-check in the sibling still works**

Run: `( cd /Users/chancock/git/kaizen-official-plugins && bun x tsc --noEmit 2>/dev/null || true )`
This is best-effort — the sibling may not have a tsconfig. The goal is no unresolved `kaizen/types` errors in IDE / editor.

- [ ] **Step 4: Commit in the sibling repo**

```bash
cd /Users/chancock/git/kaizen-official-plugins
git add package.json bun.lock
git commit -m "build: depend on sibling kaizen for design-time types"
git push origin main
```

If `bun install` failed and you kept the symlink workaround, skip the commit and open an issue in the sibling repo describing the limitation for follow-up.

---

## Task 10: Publish `kaizen` npm package with types + stub (follow-up, non-blocking)

Third-party plugin authors outside the kaizen monorepo need types at TS compile time. VS Code solves this with `@types/vscode`. Mirror the pattern.

This task is **non-blocking for the current goal** — first-party plugins work without it because they live in the workspace. Complete it when first third-party plugin authorship begins.

**Files:**
- Create: `scripts/build-types-package.ts`
- Modify: `package.json` (add `publishConfig` + `files` fields)

- [ ] **Step 1: Write the build script**

```typescript
// scripts/build-types-package.ts
/**
 * Produce a publish-ready kaizen npm package containing:
 *   - dist/types.d.ts   bundled .d.ts for the host-api surface
 *   - dist/types.js     stub that throws if required outside a kaizen session
 *   - package.json      with exports["./types"] pointing at the above
 *
 * Run: bun scripts/build-types-package.ts
 * Output: dist/kaizen-types-pkg/
 */
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "fs";
import { join } from "path";

const OUT = join(process.cwd(), "dist", "kaizen-types-pkg");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "dist"), { recursive: true });

// Generate .d.ts using tsc.
const { $ } = await import("bun");
await $`bun x tsc -p tsconfig.types.json --outDir ${join(OUT, "dist")}`.quiet();

// Stub runtime module.
writeFileSync(join(OUT, "dist/types.js"),
  `export default null;
   throw new Error("kaizen/types is provided by the kaizen runtime; this module cannot be used outside a kaizen session.");
  `);

// Package.json.
const srcPkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
const pubPkg = {
  name: "kaizen",
  version: srcPkg.version,
  description: "Type declarations for kaizen plugin authoring.",
  type: "module",
  exports: {
    "./types": { types: "./dist/host-api.d.ts", default: "./dist/types.js" },
  },
  files: ["dist/"],
};
writeFileSync(join(OUT, "package.json"), JSON.stringify(pubPkg, null, 2) + "\n");

console.log(`built ${OUT}`);
```

- [ ] **Step 2: Add `tsconfig.types.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types"
  },
  "include": ["src/host-api.ts", "src/types/plugin.ts", "src/core/plugin-ctx-io.ts", "src/core/secret-providers/types.ts"]
}
```

- [ ] **Step 3: Verify the script**

Run: `bun scripts/build-types-package.ts`
Expected: `dist/kaizen-types-pkg/` directory exists, contains `package.json`, `dist/host-api.d.ts`, `dist/types.js`.

- [ ] **Step 4: Dry-run npm publish**

Run: `( cd dist/kaizen-types-pkg && npm publish --dry-run )`
Expected: tarball contents listed, exit 0. No actual publish.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-types-package.ts tsconfig.types.json
git commit -m "build: produce kaizen npm package with host-api types + runtime stub"
```

**Actual publish is out of scope for this plan.** When ready to publish, run `cd dist/kaizen-types-pkg && npm publish` with credentials configured.

---

## Rollback

Single commit changes user-visible behavior: **Task 4** (wiring `registerHostApi()` into `src/cli.ts`). Reverting that commit restores the pre-virtual-module state; every other commit in this plan is purely additive and can remain.

If a deeper rollback is needed (e.g., bun changes its plugin API in a breaking way), reverting Tasks 4 + 6 (the trimmed `plugin.ts`) gives a working build again — plugins would then regain the Spec 4 failure mode and would need to ship with an alternative resolution fix.

---

## Self-review notes

Plan covers every spec section:
- Architecture → Tasks 2, 3, 4
- Curated surface → Task 2
- Virtual-module registration → Task 3
- Internal consumer migration → Task 6
- Testing (unit/integration/e2e/smoke) → Tasks 3, 5, 7, 8
- Sibling repo symlink cleanup → Task 7 Step 2
- Sibling devDep → Task 9
- Published `kaizen` npm package → Task 10
- Rollback → documented above.

Task 1 (probe) is a plan-level validation gate for the spec's core assumption, executed before any production-affecting code is written.
