# Kaizen Config Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #34 by deleting kaizen's legacy project-level config path, consolidating on the existing `KaizenGlobalConfig` at `~/.kaizen/kaizen.json`, and flipping the plugin-config merge order so user globals win over harness defaults.

**Architecture:** Kaizen today has two coexisting config systems reading the same file. The legacy path (`src/core/config.ts`: `resolveConfig` + `mergeConfigs` + `findProjectConfig` + `PROJECT_CONFIG`/`LEGACY_CONFIG`) is where #34's clobber happens. The newer path (`src/core/kaizen-config.ts`: `KaizenGlobalConfig`, `loadKaizenGlobalConfig`, `mergePluginConfig`) is what stays. We delete the legacy path, rename `KaizenGlobalConfig.defaults` → `plugin_config` and `KaizenGlobalConfig.defaultHarness` → `default_harness`, flip `mergePluginConfig`'s merge order so user wins, add validation that rejects `plugins`/`extends`/unknown top-level keys, rewrite `kaizen init` to global-only, and add migration warnings for deprecated `.kaizen/kaizen.json` / root `kaizen.json` files.

**Tech Stack:** TypeScript + Bun. Tests via `bun test`. Typecheck via `bun run typecheck`.

---

## Background for the executing engineer

**Read before starting:**
- Spec: `docs/superpowers/specs/2026-04-23-kaizen-config-simplification-design.md`
- Issue: https://github.com/CraightonH/kaizen/issues/34

**Key code paths (current state):**
- `src/core/config.ts` — legacy config resolution (`resolveConfig`, `mergeConfigs`, `findProjectConfig`, `loadKaizenConfig`, `PROJECT_CONFIG`, `LEGACY_CONFIG`). This file gets cut down significantly — `loadHarnessConfig`, `resolveHarness`, `parseAndValidateHarness`, and `KAIZEN_HOME_CONFIG` stay (they're still used).
- `src/core/kaizen-config.ts` — `loadKaizenGlobalConfig`, `saveKaizenGlobalConfig`, marketplace/harness install paths. Stays; we add validation here.
- `src/core/config-merge.ts` — `mergePluginConfig`. Stays; we flip the merge order.
- `src/core/plugin-manager.ts` — calls `mergePluginConfig` around line 637 using `this.globalConfig?.defaults?.[plugin.name]`. Stays; we rename `defaults` to `plugin_config`.
- `src/types/plugin.ts` — `KaizenGlobalConfig` interface at line 333. Stays; we rename fields.
- `src/cli.ts` — has `kaizen init` subcommand (line 141), imports legacy helpers. Stays; we rewrite init.

**Invariants to preserve:**
- Harness resolution (`resolveHarness`, `loadHarnessConfig`, `parseAndValidateHarness`): unchanged. Harness files still have `plugins` arrays and per-plugin config keys.
- `KAIZEN_HOME_OVERRIDE` test hook in `kaizen-config.ts:11` must keep working (tests depend on it).
- Secret handling (`separateSecrets`, `applyEnvOverrides` in `config-merge.ts`): unchanged.
- Marketplace refresh / `marketplaces` / `marketplaceUpdateTTL` fields in `~/.kaizen/kaizen.json`: unchanged.

**Conventions:**
- Commit frequently, one logical change per commit. Never `--no-verify`.
- Use `bun test <file>` for scoped runs; `bun test` for full suite; `bun run typecheck` before pushing (CI uses strict tsc and catches inference bugs `bun test` misses).
- Follow existing code style (snake_case for JSON keys, camelCase for TS locals).

---

## File Structure

**Files modified:**
- `src/types/plugin.ts` — rename `KaizenGlobalConfig` fields; add top-level-key whitelist type if helpful.
- `src/core/kaizen-config.ts` — add schema validation to `loadKaizenGlobalConfig`.
- `src/core/kaizen-config.test.ts` — add tests for new validation.
- `src/core/config-merge.ts` — flip `mergePluginConfig` arg order; rename param.
- `src/core/config-merge.test.ts` — update tests for new order and precedence.
- `src/core/config.ts` — delete `mergeConfigs`, `findProjectConfig`, `loadKaizenConfig`, `PROJECT_CONFIG`, `LEGACY_CONFIG`, project/legacy/home branches of `resolveConfig`.
- `src/core/plugin-manager.ts` — update field name (`defaults` → `plugin_config`).
- `src/cli.ts` — rewrite `kaizen init` as global-only; remove legacy imports; add deprecation warnings.
- `src/commands/manage.ts` — update any `PROJECT_CONFIG`-based error text.
- Other `src/commands/*.ts` — update imports if any referenced deleted symbols.
- Tests in `src/core/*.test.ts` and `src/commands/*.test.ts` referencing deleted symbols — update or remove.
- `docs/concepts/harnesses.md` — remove overlay/project-config discussion.
- `docs/guides/plugin-authoring.md` — document that plugin authors should enumerate config keys users can set under `plugin_config`.
- `docs/concepts/configuration.md` — **new** short doc describing the single overlay rule and valid `~/.kaizen/kaizen.json` shape.

**Files deleted:** none (all changes are in-place edits).

---

## Commit conventions

Task commit messages follow `<type>(<scope>): <subject> (#34)`. Types: `feat`, `refactor`, `fix`, `test`, `docs`, `chore`.

---

## Task 1: Rename `KaizenGlobalConfig` fields

**Files:**
- Modify: `src/types/plugin.ts:333-339`

- [ ] **Step 1: Update the interface**

Open `src/types/plugin.ts`. Replace the `KaizenGlobalConfig` interface with:

```typescript
export interface KaizenGlobalConfig {
  marketplaces?: MarketplaceRef[];
  /** Default harness ref used when --harness is not passed on the CLI. */
  default_harness?: string;
  /** Per-plugin config overrides. Keyed by plugin name. Values are plugin-specific objects. */
  plugin_config?: Record<string, Record<string, unknown>>;
  /** Seconds between background marketplace refreshes; 0 disables. Default 900. */
  marketplaceUpdateTTL?: number;
}
```

The prior shape had `defaultHarness` and `defaults` with a looser `Record<string, unknown>` type. We tighten `plugin_config` to a map of plugin-name → object.

- [ ] **Step 2: Typecheck to surface callers**

Run: `bun run typecheck`
Expected: FAIL in at least these locations:
- `src/core/plugin-manager.ts` (references `.defaults`)
- possibly `src/core/marketplace.ts` (reads/writes `marketplaces`, should still typecheck)
- possibly `src/core/kaizen-config.test.ts`

Note the failing files for Task 5 and 6.

- [ ] **Step 3: Commit (field rename alone, fix-ups come next)**

Do NOT commit yet — the tree won't compile. Continue to Task 2 before committing.

---

## Task 2: Update `plugin-manager.ts` to read `plugin_config`

**Files:**
- Modify: `src/core/plugin-manager.ts:637`

- [ ] **Step 1: Update the field read**

Open `src/core/plugin-manager.ts`. Around line 637 you'll find:

```typescript
const globalDefaults = (this.globalConfig?.defaults?.[plugin.name] as Record<string, unknown> | undefined) ?? {};
```

Replace with:

```typescript
const userPluginConfig = (this.globalConfig?.plugin_config?.[plugin.name] as Record<string, unknown> | undefined) ?? {};
```

Also update the call on the next line from `mergePluginConfig(plugin.config, globalDefaults, harnessConfig)` to `mergePluginConfig(plugin.config, userPluginConfig, harnessConfig)` — the arg order is still wrong at this point; Task 3 will flip it.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: any remaining `defaults` references flagged. Fix each one by reading `plugin_config` instead. If `marketplaces.ts` / `marketplace.ts` references `.defaults`, that's a different thing (the test is marketplace catalog defaults, not plugin defaults) — leave it alone unless the type error says otherwise.

- [ ] **Step 3: Run the affected unit tests**

Run: `bun test src/core/plugin-manager.test.ts src/core/kaizen-config.test.ts`
Expected: some failures around `defaults` vs `plugin_config`. Skip if tests still pass; otherwise note them for Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/types/plugin.ts src/core/plugin-manager.ts
git commit -m "refactor(config): rename KaizenGlobalConfig defaults → plugin_config, defaultHarness → default_harness (#34)"
```

---

## Task 3: Flip `mergePluginConfig` merge order

**Files:**
- Modify: `src/core/config-merge.ts:3-13`
- Modify: `src/core/config-merge.test.ts`

- [ ] **Step 1: Write the failing test for the new precedence**

Open `src/core/config-merge.test.ts`. Find the existing tests for `mergePluginConfig`. Add (or replace) a test that asserts **user globals win over harness config**:

```typescript
import { test, expect } from "bun:test";
import { mergePluginConfig } from "./config-merge.js";

test("mergePluginConfig: user global wins over harness default", () => {
  const declaration = { defaults: { base_url: "https://gitlab.com", timeout: 30 } };
  const userPluginConfig = { base_url: "https://gitlab.mycompany.com" };
  const harnessConfig = { base_url: "https://harness.example.com" };

  const merged = mergePluginConfig(declaration, userPluginConfig, harnessConfig);

  expect(merged).toEqual({
    base_url: "https://gitlab.mycompany.com", // user wins
    timeout: 30,                              // declaration fallback preserved
  });
});

test("mergePluginConfig: harness wins over plugin declaration defaults", () => {
  const declaration = { defaults: { base_url: "plugin-default" } };
  const userPluginConfig = {};
  const harnessConfig = { base_url: "harness-default" };

  const merged = mergePluginConfig(declaration, userPluginConfig, harnessConfig);

  expect(merged.base_url).toBe("harness-default");
});
```

Review any *existing* tests in this file that assert harness-wins behavior and either delete them or flip them to the new expectation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/config-merge.test.ts`
Expected: the new "user global wins" test FAILS because today harness wins.

- [ ] **Step 3: Flip the merge order**

Open `src/core/config-merge.ts`. Replace `mergePluginConfig` with:

```typescript
export function mergePluginConfig(
  declaration: PluginConfigDeclaration | undefined,
  userPluginConfig: Record<string, unknown>,
  harnessConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(declaration?.defaults ?? {}),
    ...harnessConfig,
    ...userPluginConfig,
  };
}
```

The first positional arg is unchanged (plugin's own declared defaults). The order of the remaining two spreads is flipped so `userPluginConfig` wins.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/config-merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full test suite to catch flipped assumptions**

Run: `bun test`
Expected: possibly failures in `plugin-manager.test.ts` or `bootstrap.test.ts` that relied on harness-wins. For each failure, determine whether the test encoded the old (buggy) precedence or a different invariant. Update test expectations that encode the old precedence; leave others alone.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/config-merge.ts src/core/config-merge.test.ts src/core/plugin-manager.test.ts src/core/bootstrap.test.ts
git commit -m "fix(config): flip mergePluginConfig so user globals win over harness defaults (#34)"
```

(Adjust the `git add` list to only files you actually changed.)

---

## Task 4: Validate `~/.kaizen/kaizen.json` schema

**Files:**
- Modify: `src/core/kaizen-config.ts` — augment `loadKaizenGlobalConfig`.
- Modify: `src/core/kaizen-config.test.ts` — add validation tests.

- [ ] **Step 1: Write failing tests**

Open `src/core/kaizen-config.test.ts`. Add a test block that covers the new validation:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { loadKaizenGlobalConfig, kaizenHomeConfigPath } from "./kaizen-config.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { tmpdir } from "os";
import { join } from "path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `kaizen-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.KAIZEN_HOME_OVERRIDE = tmpHome;
});

afterEach(() => {
  delete process.env.KAIZEN_HOME_OVERRIDE;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function writeCfg(obj: unknown) {
  const path = kaizenHomeConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

test("loadKaizenGlobalConfig: accepts default_harness and plugin_config", async () => {
  writeCfg({
    default_harness: "official/core-shell@1.0.0",
    plugin_config: { gitlab: { base_url: "https://gitlab.mycompany.com" } },
  });
  const cfg = await loadKaizenGlobalConfig();
  expect(cfg.default_harness).toBe("official/core-shell@1.0.0");
  expect(cfg.plugin_config?.gitlab).toEqual({ base_url: "https://gitlab.mycompany.com" });
});

test("loadKaizenGlobalConfig: rejects top-level `plugins` key", async () => {
  writeCfg({ plugins: ["foo/bar@1.0.0"] });
  await expect(loadKaizenGlobalConfig()).rejects.toThrow(/plugins.*not allowed|not supported/i);
});

test("loadKaizenGlobalConfig: rejects top-level `extends` key with rename hint", async () => {
  writeCfg({ extends: "foo/bar@1.0.0" });
  await expect(loadKaizenGlobalConfig()).rejects.toThrow(/extends.*default_harness/);
});

test("loadKaizenGlobalConfig: rejects unknown top-level keys", async () => {
  writeCfg({ default_harness: "x/y@1", random_nonsense: true });
  await expect(loadKaizenGlobalConfig()).rejects.toThrow(/random_nonsense/);
});

test("loadKaizenGlobalConfig: allows marketplaces and marketplaceUpdateTTL", async () => {
  writeCfg({
    marketplaces: [{ id: "official", url: "https://example.com/repo.git" }],
    marketplaceUpdateTTL: 600,
  });
  const cfg = await loadKaizenGlobalConfig();
  expect(cfg.marketplaces?.[0]?.id).toBe("official");
  expect(cfg.marketplaceUpdateTTL).toBe(600);
});

test("loadKaizenGlobalConfig: plugin_config must be an object of objects", async () => {
  writeCfg({ plugin_config: { gitlab: "not an object" } });
  await expect(loadKaizenGlobalConfig()).rejects.toThrow(/plugin_config/);
});

test("loadKaizenGlobalConfig: returns {} when file is absent", async () => {
  const cfg = await loadKaizenGlobalConfig();
  expect(cfg).toEqual({});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/kaizen-config.test.ts`
Expected: multiple FAIL — validation logic doesn't exist yet.

- [ ] **Step 3: Implement validation**

Open `src/core/kaizen-config.ts`. Replace `loadKaizenGlobalConfig` with:

```typescript
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "default_harness",
  "plugin_config",
  "marketplaces",
  "marketplaceUpdateTTL",
]);

export async function loadKaizenGlobalConfig(): Promise<KaizenGlobalConfig> {
  const path = kaizenHomeConfigPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;

  if ("plugins" in obj) {
    throw new Error(
      `${path}: top-level 'plugins' key is not allowed. The plugin set is defined by the harness; ` +
      `user config cannot add, remove, or replace plugins. Remove the 'plugins' key. See docs/concepts/configuration.md.`,
    );
  }
  if ("extends" in obj) {
    throw new Error(
      `${path}: top-level 'extends' has been renamed to 'default_harness'. Rename the key and try again.`,
    );
  }
  const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path}: unknown top-level keys: ${unknownKeys.join(", ")}. ` +
      `Allowed keys: ${[...ALLOWED_TOP_LEVEL_KEYS].join(", ")}.`,
    );
  }

  if (obj.default_harness !== undefined && typeof obj.default_harness !== "string") {
    throw new Error(`${path}: 'default_harness' must be a string.`);
  }
  if (obj.plugin_config !== undefined) {
    if (typeof obj.plugin_config !== "object" || obj.plugin_config === null || Array.isArray(obj.plugin_config)) {
      throw new Error(`${path}: 'plugin_config' must be an object.`);
    }
    for (const [name, value] of Object.entries(obj.plugin_config)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path}: 'plugin_config.${name}' must be an object.`);
      }
    }
  }

  return obj as KaizenGlobalConfig;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/kaizen-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/kaizen-config.ts src/core/kaizen-config.test.ts
git commit -m "feat(config): validate ~/.kaizen/kaizen.json schema (#34)"
```

---

## Task 5: Delete legacy project config in `src/core/config.ts`

**Files:**
- Modify: `src/core/config.ts` (heavy cut)
- Modify: `src/core/config-harness.test.ts` (if tests there reference deleted symbols)
- Modify: `src/commands/manage.ts` (it references `PROJECT_CONFIG`)

- [ ] **Step 1: Survey what imports the legacy symbols**

Run: `grep -rn "findProjectConfig\|PROJECT_CONFIG\|LEGACY_CONFIG\|mergeConfigs\|loadKaizenConfig" /Users/chancock/git/kaizen/src`

Expected to see references in:
- `src/cli.ts` (imports + uses)
- `src/commands/manage.ts` (imports `PROJECT_CONFIG`)
- `src/core/config.ts` (definitions)
- test files

Note each call-site — they all need to be updated or removed.

- [ ] **Step 2: Rewrite `resolveConfig` and delete legacy helpers**

Open `src/core/config.ts`. Delete these symbols entirely:
- `PROJECT_DIR` constant (if only used for project config — but note that `PROJECT_HARNESSES` is still used by `resolveHarness`; preserve that).
- `PROJECT_CONFIG` constant.
- `LEGACY_CONFIG` constant.
- `findProjectConfig` function.
- `loadKaizenConfig` function.
- `mergeConfigs` function.
- `parseConfigFile` function (if only used by deleted code).
- `validateConfig` function (if only used by deleted code; keep it if `parseAndValidateHarness` uses it).

Verify `parseAndValidateHarness` and `resolveHarness` still compile — they should.

Replace `resolveConfig` with:

```typescript
export function resolveConfig(opts: {
  harness?: string;
  /**
   * Pre-materialized extends path (set by the CLI pre-pass when the caller
   * already resolved a marketplace ref to a local harness dir).
   */
  extendsOverride?: string;
}): KaizenConfig {
  const { harness, extendsOverride } = opts;

  if (harness) {
    return loadHarnessConfig(harness);
  }
  if (extendsOverride) {
    return loadHarnessConfig(extendsOverride);
  }

  // Fall through to global default harness. The caller is responsible for
  // loading ~/.kaizen/kaizen.json and passing its default_harness via opts.harness
  // when they want that behavior; resolveConfig itself no longer reaches for
  // ~/.kaizen/kaizen.json synchronously (loadKaizenGlobalConfig is async).
  fatal(
    `A harness is required.\n` +
    `  kaizen --harness <marketplace>/<name>@<version>\n` +
    `  kaizen --harness ./path/to/harness/\n` +
    `  Set 'default_harness' in ~/.kaizen/kaizen.json`,
  );
}
```

Remove the `configPath` / explicit-config-file opt entirely (it only existed to point at project config). Update the `opts` type accordingly.

Also delete the unused `RESERVED_KEYS` set if it is only referenced by deleted code.

- [ ] **Step 3: Update `src/cli.ts`**

Open `src/cli.ts`. Remove the imports of `findProjectConfig`, `PROJECT_CONFIG`, `LEGACY_CONFIG` (line 10 import list and any other imports from `./core/config.js`). Keep `resolveConfig`, `resolveHarness`, `KAIZEN_HOME`, `KAIZEN_HOME_CONFIG`.

Find every call-site that references the removed symbols and rewrite:

- Before `resolveConfig({...})` is called, `cli.ts` needs to load `~/.kaizen/kaizen.json` via `loadKaizenGlobalConfig()` and pass `default_harness` as the `harness` opt when `--harness` is absent. The current `resolveConfig` call on line 647 looks like:
  ```typescript
  const kaizenConfig = resolveConfig({ harness, configPath, extendsOverride });
  ```
  Change to:
  ```typescript
  import { loadKaizenGlobalConfig } from "./core/kaizen-config.js";
  // ... before the call ...
  let effectiveHarness = harness;
  if (!effectiveHarness && !extendsOverride) {
    const global = await loadKaizenGlobalConfig();
    effectiveHarness = global.default_harness;
  }
  const kaizenConfig = resolveConfig({ harness: effectiveHarness, extendsOverride });
  ```
  Note: `loadKaizenGlobalConfig` is async. The surrounding context in `cli.ts` appears to already be async (top-level await is used in Bun). If it isn't, wrap the resolution in an `async function main()` and invoke it. Inspect lines 620–660 for context; adapt.

- If any subcommand in `cli.ts` references `PROJECT_CONFIG` for an error message ("no .kaizen/kaizen.json found, run kaizen init"), update the message to say "no `~/.kaizen/kaizen.json` found, run `kaizen init --global`" (or similar, depending on context).

- [ ] **Step 4: Update `src/commands/manage.ts`**

Open `src/commands/manage.ts:19`. It currently reads:
```typescript
console.error("No .kaizen/kaizen.json found. Run 'kaizen init' to create one.");
```
Replace with:
```typescript
console.error("No ~/.kaizen/kaizen.json found. Run 'kaizen init --global' to create one.");
```
Replace any `PROJECT_CONFIG` imports with `kaizenHomeConfigPath()` from `./core/kaizen-config.js` (or `KAIZEN_HOME_CONFIG` from `./core/config.js` — whichever this file's other imports are consistent with). Re-run `bun run typecheck` to find remaining references.

- [ ] **Step 5: Typecheck + test sweep**

Run: `bun run typecheck`
Expected: errors pointing at remaining references to deleted symbols (possibly in `src/commands/*.ts` or test files). Fix each one. Preferred fix: if a test references `PROJECT_CONFIG` / `findProjectConfig` / `mergeConfigs`, either rewrite it to exercise the new global-config path or delete the test if its invariant no longer exists.

Run: `bun test`
Expected: remaining failures from tests that rely on project-config merging. Triage each: rewrite if the test's *intent* is still valid under the new model; delete if it's testing deleted behavior.

- [ ] **Step 6: Commit**

```bash
git add src/core/config.ts src/cli.ts src/commands/manage.ts src/core/config-harness.test.ts
# ... plus any other modified files ...
git commit -m "refactor(config): delete legacy project config path (#34)"
```

---

## Task 6: Add deprecation warnings for stale project-local config files

**Files:**
- Modify: `src/cli.ts` (early in the startup path, before `resolveConfig`)
- Create: `src/core/deprecation-warn.ts` (small helper module)
- Create: `src/core/deprecation-warn.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/deprecation-warn.test.ts`:

```typescript
import { test, expect, afterEach, beforeEach } from "bun:test";
import { warnStaleProjectConfig } from "./deprecation-warn.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let cwdBackup: string;
let dir: string;

beforeEach(() => {
  cwdBackup = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "kaizen-stalecfg-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwdBackup);
  rmSync(dir, { recursive: true, force: true });
});

test("warnStaleProjectConfig: warns when .kaizen/kaizen.json exists", () => {
  mkdirSync(".kaizen");
  writeFileSync(".kaizen/kaizen.json", "{}", "utf8");
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toMatch(/\.kaizen\/kaizen\.json/);
  expect(warnings[0]).toMatch(/no longer supported/);
});

test("warnStaleProjectConfig: warns when root kaizen.json exists", () => {
  writeFileSync("kaizen.json", "{}", "utf8");
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toMatch(/^|\skaizen\.json/);
});

test("warnStaleProjectConfig: silent when neither file exists", () => {
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

test("warnStaleProjectConfig: warns for both when both exist", () => {
  mkdirSync(".kaizen");
  writeFileSync(".kaizen/kaizen.json", "{}", "utf8");
  writeFileSync("kaizen.json", "{}", "utf8");
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings.length).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/deprecation-warn.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `src/core/deprecation-warn.ts`:

```typescript
import { existsSync } from "fs";
import { join } from "path";

export interface WarnSink {
  warn: (message: string) => void;
}

const PROJECT_LOCAL = join(".kaizen", "kaizen.json");
const LEGACY_ROOT = "kaizen.json";

const MESSAGE = (path: string) =>
  `Found '${path}'. Project-level kaizen config is no longer supported. ` +
  `Move 'extends' to '~/.kaizen/kaizen.json' as 'default_harness', ` +
  `or pass --harness explicitly. See docs/concepts/configuration.md.`;

export function warnStaleProjectConfig(sink: WarnSink): void {
  if (existsSync(PROJECT_LOCAL)) sink.warn(MESSAGE(PROJECT_LOCAL));
  if (existsSync(LEGACY_ROOT)) sink.warn(MESSAGE(LEGACY_ROOT));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/deprecation-warn.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `src/cli.ts`**

In `src/cli.ts`, near the top of the main execution path (before `resolveConfig` is called), add:

```typescript
import { warn } from "./core/errors.js";
import { warnStaleProjectConfig } from "./core/deprecation-warn.js";
// ...
warnStaleProjectConfig({ warn });
```

The existing `warn` helper in `./core/errors.js` prints to stderr in the format the rest of kaizen uses. Place this call so it runs for every subcommand except `--help` / `-h` (don't pollute help output). A good spot is just before the `subcommand` switch begins, or wherever the config resolution block starts.

- [ ] **Step 6: Smoke test manually**

Run: `mkdir -p /tmp/kaizen-stale && cd /tmp/kaizen-stale && mkdir -p .kaizen && echo '{}' > .kaizen/kaizen.json && <path-to-built-kaizen> --help; cd -`

Expected: a warning line mentioning `.kaizen/kaizen.json` prints to stderr (or, if `--help` is excluded, try a non-help command that will error out before doing real work; the warning should still print). If `--help` is excluded, run with some failing subcommand instead — just verify the warning appears.

- [ ] **Step 7: Commit**

```bash
git add src/core/deprecation-warn.ts src/core/deprecation-warn.test.ts src/cli.ts
git commit -m "feat(config): warn when legacy project config files are present (#34)"
```

---

## Task 7: Rewrite `kaizen init` to be global-only

**Files:**
- Modify: `src/cli.ts` (the `kaizen init` subcommand, around line 141)
- Modify: any cli test exercising init

- [ ] **Step 1: Find existing init tests**

Run: `grep -rn "kaizen init\|init.*--global" /Users/chancock/git/kaizen/src --include="*.test.ts"`

Note the tests so you can update them in step 4.

- [ ] **Step 2: Rewrite the subcommand**

Open `src/cli.ts`, find the `if (subcommand === "init")` block (around line 141). Replace with:

```typescript
if (subcommand === "init") {
  const isGlobal = rawArgs.includes("--global");
  const harnessFlagIdx = rawArgs.findIndex((a) => a === "--harness");
  const harnessRef = harnessFlagIdx >= 0 ? rawArgs[harnessFlagIdx + 1] : undefined;

  if (!isGlobal) {
    console.error(
      `'kaizen init' now requires --global.\n` +
      `Project-level kaizen config is no longer supported.\n` +
      `Run: kaizen init --global [--harness <ref>]`,
    );
    process.exit(2);
  }

  if (existsSync(KAIZEN_HOME_CONFIG)) {
    console.log(`~/.kaizen/kaizen.json already exists.`);
    process.exit(0);
  }

  mkdirSync(KAIZEN_HOME, { recursive: true });
  const body: Record<string, unknown> = {};
  if (harnessRef) body.default_harness = harnessRef;
  writeFileSync(KAIZEN_HOME_CONFIG, JSON.stringify(body, null, 2) + "\n", "utf8");

  if (harnessRef) {
    console.log(`Created ~/.kaizen/kaizen.json with default_harness=${harnessRef}`);
  } else {
    console.log(
      `Created ~/.kaizen/kaizen.json.\n` +
      `Pass --harness on each run, or add 'default_harness' to the file.`,
    );
  }
  process.exit(0);
}
```

Also delete the now-unused `DEFAULT_PLUGINS` constant (lines 80–96). The inline plugin list it contained was the source of #34; nothing references it after this change. Run `bun run typecheck` to confirm no callers remain before deleting.

- [ ] **Step 3: Update `--help` output**

Still in `src/cli.ts`, find the help text block (around line 103). Update the `init` line from:
```
  init [--global]                       scaffold kaizen.json (project or ~/.kaizen/)
```
to:
```
  init --global [--harness <ref>]       scaffold ~/.kaizen/kaizen.json
```

- [ ] **Step 4: Update init tests**

Open whatever test files exercise `kaizen init`. Update them to:
- Assert that `kaizen init` without `--global` exits non-zero with the project-config-not-supported message.
- Assert that `kaizen init --global` writes `~/.kaizen/kaizen.json` (using `KAIZEN_HOME_OVERRIDE` for isolation).
- Assert that `kaizen init --global --harness X` produces `{"default_harness": "X"}`.

If no test file covers this today, create `src/cli-init.test.ts` with at least the three cases above. Use `Bun.spawn` or direct import of the subcommand logic (if it's extractable); simplest approach is a subprocess-level test that invokes `bun src/cli.ts init ...` with `KAIZEN_HOME_OVERRIDE` set to a tmpdir.

- [ ] **Step 5: Run tests**

Run: `bun test src/cli-init.test.ts` (or the existing file).
Expected: PASS.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli-init.test.ts
# ... plus any other touched test files ...
git commit -m "feat(init): rewrite kaizen init as --global-only (#34)"
```

---

## Task 8: Reproduce #34 and verify the fix

**Files:**
- Create: `src/core/issue-34.test.ts` (integration-style regression test)

- [ ] **Step 1: Write the regression test**

Create `src/core/issue-34.test.ts`:

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let cwdBackup: string;
let homeBackup: string | undefined;

beforeEach(() => {
  cwdBackup = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "kaizen-issue-34-"));
  process.chdir(dir);
  homeBackup = process.env.KAIZEN_HOME_OVERRIDE;
  process.env.KAIZEN_HOME_OVERRIDE = join(dir, "home");
  mkdirSync(process.env.KAIZEN_HOME_OVERRIDE, { recursive: true });
});

afterEach(() => {
  process.chdir(cwdBackup);
  if (homeBackup === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
  else process.env.KAIZEN_HOME_OVERRIDE = homeBackup;
  rmSync(dir, { recursive: true, force: true });
});

test("issue #34: local .kaizen/kaizen.json cannot clobber --harness plugin list", async () => {
  // Set up a project-local kaizen.json that (under the old behavior) would
  // silently replace the harness's plugins array.
  mkdirSync(".kaizen", { recursive: true });
  writeFileSync(".kaizen/kaizen.json", JSON.stringify({
    plugins: ["evil/injected@0.0.0"],
  }), "utf8");

  // Build a minimal local-path harness with a known plugin list.
  const harnessDir = join(dir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, "kaizen.json"), JSON.stringify({
    plugins: ["official/core-cli@0.1.0"],
  }), "utf8");

  // Call resolveConfig explicitly — this is the function whose old behavior
  // was buggy.
  const { resolveConfig } = await import("./config.js");
  const cfg = resolveConfig({ harness: "./harness" });

  expect(cfg.plugins).toEqual(["official/core-cli@0.1.0"]);
  // The "evil/injected" ref from project-local config must NOT appear.
  expect(JSON.stringify(cfg)).not.toContain("evil/injected");
});
```

- [ ] **Step 2: Run the test**

Run: `bun test src/core/issue-34.test.ts`
Expected: PASS (the preceding tasks have already removed the clobber path; this is a regression guard).

- [ ] **Step 3: Commit**

```bash
git add src/core/issue-34.test.ts
git commit -m "test(config): regression test for #34 harness-plugin-clobber"
```

---

## Task 9: Update documentation

**Files:**
- Create: `docs/concepts/configuration.md`
- Modify: `docs/concepts/harnesses.md`
- Modify: `docs/guides/plugin-authoring.md`

- [ ] **Step 1: Create `docs/concepts/configuration.md`**

Create the file with:

````markdown
# Configuration

Kaizen has exactly one user-editable config file: `~/.kaizen/kaizen.json`.

## Schema

```json
{
  "default_harness": "official/core-shell@1.0.0",
  "plugin_config": {
    "gitlab":   { "base_url": "https://gitlab.mycompany.com", "username": "alice" },
    "core-cli": { "clis": ["docker", "kubectl"] }
  },
  "marketplaces": [
    { "id": "official", "url": "https://github.com/CraightonH/kaizen-marketplace.git" }
  ]
}
```

### Fields

- **`default_harness`** *(optional, string)* — harness ref used when `--harness` is not passed on the CLI.
- **`plugin_config`** *(optional, object)* — per-plugin config overrides, keyed by plugin name.
- **`marketplaces`** *(optional, array)* — registered marketplaces. Managed by `kaizen marketplace add/remove`.
- **`marketplaceUpdateTTL`** *(optional, number)* — background marketplace refresh interval in seconds.

Any other top-level key is a validation error.

## Effective plugin config

For each plugin `P` in the active harness:

```
effective_config(P) = { ...plugin_declared_defaults, ...harness_defaults, ...user_plugin_config }
```

User `plugin_config[P]` wins over harness defaults. Harness defaults win over the plugin's own declared defaults.

## Choosing a harness

The active harness is selected by:

1. `--harness <ref>` on the CLI
2. `default_harness` in `~/.kaizen/kaizen.json`
3. Otherwise, kaizen refuses to start.

## What moved

Project-level kaizen config (`.kaizen/kaizen.json` overlay and root `kaizen.json`) is no longer supported. If you had one, move its `extends` value to `default_harness` in `~/.kaizen/kaizen.json`. If it had per-plugin config overrides, move those under `plugin_config` in the same file. Per-project config scoping will be revisited in a future release.
````

- [ ] **Step 2: Update `docs/concepts/harnesses.md`**

Remove any section describing the project-level overlay or `extends` semantics. Add a link to `docs/concepts/configuration.md` for how user config interacts with the harness.

Read the file first, then edit. Preserve everything that describes harness *authoring* — only cut the overlay/project-config discussion.

- [ ] **Step 3: Update `docs/guides/plugin-authoring.md`**

Add a short section titled "Plugin config keys" (or extend an existing one) documenting that plugin authors should enumerate the keys their plugin reads so users know what to put under `plugin_config.<plugin>` in `~/.kaizen/kaizen.json`.

- [ ] **Step 4: Commit**

```bash
git add docs/concepts/configuration.md docs/concepts/harnesses.md docs/guides/plugin-authoring.md
git commit -m "docs: document ~/.kaizen/kaizen.json single-config model (#34)"
```

---

## Task 10: Final verification

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: clean, no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 3: Integration smoke test**

Run: `bun test --integration` (the `test:integration` script exists in package.json).
Expected: all pass. If any fail due to project-config assumptions, update them.

- [ ] **Step 4: Manual smoke — the original #34 repro**

```bash
# Build
bun run build

# Create a fake project with legacy project config
mkdir -p /tmp/kaizen-34-smoke && cd /tmp/kaizen-34-smoke
mkdir -p .kaizen
echo '{"plugins":["evil/injected@0.0.0"]}' > .kaizen/kaizen.json

# Run with explicit harness — should warn about stale config and ignore it
./path/to/kaizen --harness official/core-shell@<available-version> --help

# Expected:
#  - Warning printed: "Found .kaizen/kaizen.json. Project-level config is no longer supported..."
#  - Help runs normally; no plugin consent prompt for "evil/injected"
```

- [ ] **Step 5: Run `kaizen:update-docs` skill**

Per `CLAUDE.md`, run the kaizen docs-update skill on this branch before wrapping up.

- [ ] **Step 6: Final commit if any loose ends**

If any typecheck/test fixes accumulated, commit them:

```bash
git add -u
git commit -m "chore(config): cleanup after #34 simplification"
```

---

## Acceptance checklist

Before declaring done, all of these must be true:

- [ ] `bun run typecheck` passes.
- [ ] `bun test` passes.
- [ ] `bun test --integration` passes.
- [ ] `src/core/config.ts` no longer exports `mergeConfigs`, `findProjectConfig`, `loadKaizenConfig`, `PROJECT_CONFIG`, or `LEGACY_CONFIG`.
- [ ] `KaizenGlobalConfig` in `src/types/plugin.ts` uses `default_harness` and `plugin_config` (not `defaultHarness` / `defaults`).
- [ ] `mergePluginConfig` spreads arguments in the order `declaration → harness → user` (user wins).
- [ ] `loadKaizenGlobalConfig` rejects top-level `plugins`, `extends`, and unknown keys.
- [ ] `kaizen init` without `--global` errors out; `kaizen init --global [--harness X]` writes the new schema.
- [ ] Running kaizen in a cwd with `.kaizen/kaizen.json` prints the deprecation warning and does not merge that file into config.
- [ ] `src/core/issue-34.test.ts` passes (regression guard).
- [ ] `docs/concepts/configuration.md` exists.
- [ ] Running `kaizen:update-docs` reports no drift.
