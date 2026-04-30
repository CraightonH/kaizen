# Sandbox Env Allow-list Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carve an OS-infrastructure env-var allow-list around the permission enforcer's `env.get` check so trusted-tier plugins can read `process.env.PATH` (and friends) needed by Node/Bun stdlib calls like `child_process.spawn`, while preserving the proxy's secret-isolation guarantees for everything else.

**Architecture:** Allow-list is data, not code. A `DEFAULT_ENV_ALLOWLIST` ships in `src/core/env-allowlist.ts` and supports exact names plus trailing-`*` prefixes. The permission enforcer takes an optional `envAllowList` constructor param; `evaluate()` short-circuits `env.get` checks when the name matches. Resolution at bootstrap: harness `env_allowlist` (if present) → user `defaults.env_allowlist` (if present) → built-in default.

**Tech Stack:** TypeScript, Bun runtime, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-04-30-sandbox-env-allowlist-design.md`

---

## File Structure

**New files:**
- `src/core/env-allowlist.ts` — default list, `envAllowed()` matcher, `validateEnvAllowList()` schema check.
- `src/core/env-allowlist.test.ts` — unit tests for matcher and validator.

**Modified files:**
- `src/types/plugin.ts` — add `env_allowlist?: string[]` to `KaizenDefaults` and to `KaizenConfig`.
- `src/core/permission-enforcer.ts` — accept `envAllowList` option; consult allow-list in `evaluate()` for `env.get`.
- `src/core/permission-enforcer.test.ts` — extend coverage for allow-list interactions across tiers.
- `src/core/kaizen-config.ts` — validate `defaults.env_allowlist` on load; reject invalid entries.
- `src/core/kaizen-config.test.ts` — config-load coverage.
- `src/core/index.ts` — resolve allow-list from harness/user/default precedence; pass to enforcer.
- `src/core/sandbox-bootstrap.test.ts` (or new test if absent) — proxy passthrough behavior under the allow-list.
- `docs/guides/plugin-authoring.md` — replace incorrect "globals are not filtered" paragraph.
- `docs/concepts/security.md` — extend env-proxy section; update troubleshooting note.
- `docs/concepts/configuration.md` — document `defaults.env_allowlist` and per-harness `env_allowlist`.

Each file owns one responsibility. The allow-list module is small and isolated; the enforcer change is one branch in `evaluate()`; the proxy itself does not change.

---

## Task 1: Create `env-allowlist.ts` matcher

**Files:**
- Create: `src/core/env-allowlist.ts`
- Test: `src/core/env-allowlist.test.ts`

The matcher takes an allow-list and a name, returns whether the name is allowed. Each entry is either an exact name or a trailing-`*` prefix.

- [ ] **Step 1: Write the failing tests**

Create `src/core/env-allowlist.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { envAllowed, DEFAULT_ENV_ALLOWLIST } from "./env-allowlist.js";

describe("envAllowed", () => {
  it("matches exact names case-sensitively", () => {
    expect(envAllowed(["PATH"], "PATH")).toBe(true);
    expect(envAllowed(["PATH"], "PATHS")).toBe(false);
    expect(envAllowed(["PATH"], "path")).toBe(false);
    expect(envAllowed(["PATH"], "OTHER")).toBe(false);
  });

  it("matches prefix entries with trailing *", () => {
    expect(envAllowed(["LC_*"], "LC_ALL")).toBe(true);
    expect(envAllowed(["LC_*"], "LC_CTYPE")).toBe(true);
    expect(envAllowed(["LC_*"], "LC")).toBe(false);          // prefix is "LC_"
    expect(envAllowed(["LC_*"], "MYLC_FOO")).toBe(false);    // not a prefix match
  });

  it("supports mixed exact + prefix entries", () => {
    expect(envAllowed(["PATH", "LC_*"], "PATH")).toBe(true);
    expect(envAllowed(["PATH", "LC_*"], "LC_ALL")).toBe(true);
    expect(envAllowed(["PATH", "LC_*"], "OTHER")).toBe(false);
  });

  it("empty list matches nothing", () => {
    expect(envAllowed([], "PATH")).toBe(false);
    expect(envAllowed([], "")).toBe(false);
  });

  it("default list contains expected entries", () => {
    expect(DEFAULT_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("HOME");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("LC_*");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("TMPDIR");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/env-allowlist.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement matcher and default list**

Create `src/core/env-allowlist.ts`:

```typescript
/**
 * OS-infrastructure env vars that bypass tier-based env.get gating.
 * Plugins of any tier can read these. Override via:
 *   ~/.kaizen/kaizen.json   defaults.env_allowlist
 *   harness  kaizen.json    env_allowlist
 *
 * Each entry is either an exact name (e.g. "PATH") or a trailing-`*`
 * prefix (e.g. "LC_*"). No other glob syntax is supported.
 */
export const DEFAULT_ENV_ALLOWLIST: string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLUMNS",
  "LINES",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PWD",
  "OLDPWD",
];

/** Returns true iff `name` matches any entry in `allowList`. */
export function envAllowed(allowList: string[], name: string): boolean {
  for (const entry of allowList) {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      if (prefix.length > 0 && name.startsWith(prefix)) return true;
    } else if (entry === name) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/env-allowlist.test.ts`
Expected: PASS for all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/env-allowlist.ts src/core/env-allowlist.test.ts
git commit -m "feat(sandbox): add env allow-list module with default list"
```

---

## Task 2: Add `validateEnvAllowList`

**Files:**
- Modify: `src/core/env-allowlist.ts`
- Modify: `src/core/env-allowlist.test.ts`

Schema validator used at config-load time. Returns the validated array; throws with the offending entry on invalid input.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/env-allowlist.test.ts`:

```typescript
import { validateEnvAllowList } from "./env-allowlist.js";

describe("validateEnvAllowList", () => {
  const src = "test.json: defaults.env_allowlist";

  it("accepts an empty array", () => {
    expect(validateEnvAllowList([], src)).toEqual([]);
  });

  it("accepts exact-name entries", () => {
    expect(validateEnvAllowList(["PATH", "HOME"], src)).toEqual(["PATH", "HOME"]);
  });

  it("accepts trailing-* prefix entries", () => {
    expect(validateEnvAllowList(["LC_*", "PATH"], src)).toEqual(["LC_*", "PATH"]);
  });

  it("rejects non-array input", () => {
    expect(() => validateEnvAllowList("PATH", src)).toThrow(/must be an array/);
    expect(() => validateEnvAllowList({}, src)).toThrow(/must be an array/);
    expect(() => validateEnvAllowList(null, src)).toThrow(/must be an array/);
  });

  it("rejects non-string entries", () => {
    expect(() => validateEnvAllowList([42], src)).toThrow(/test\.json: defaults\.env_allowlist/);
    expect(() => validateEnvAllowList([null], src)).toThrow(/non-empty string/);
  });

  it("rejects empty-string entries", () => {
    expect(() => validateEnvAllowList([""], src)).toThrow(/non-empty string/);
  });

  it("rejects entries containing whitespace", () => {
    expect(() => validateEnvAllowList(["FOO BAR"], src)).toThrow(/whitespace/);
    expect(() => validateEnvAllowList(["FOO\t"], src)).toThrow(/whitespace/);
  });

  it("rejects entries with * not at end", () => {
    expect(() => validateEnvAllowList(["*FOO"], src)).toThrow(/\*FOO/);
    expect(() => validateEnvAllowList(["FOO*BAR"], src)).toThrow(/FOO\*BAR/);
  });

  it("rejects entries with multiple *", () => {
    expect(() => validateEnvAllowList(["FOO**"], src)).toThrow(/FOO\*\*/);
    expect(() => validateEnvAllowList(["*FOO*"], src)).toThrow(/\*FOO\*/);
  });

  it("rejects bare * (would be empty prefix)", () => {
    expect(() => validateEnvAllowList(["*"], src)).toThrow(/empty prefix/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/env-allowlist.test.ts`
Expected: FAIL — `validateEnvAllowList` not exported.

- [ ] **Step 3: Implement the validator**

Append to `src/core/env-allowlist.ts`:

```typescript
/**
 * Validate an env-allowlist value loaded from config. Returns the array
 * unchanged on success; throws an Error with the offending entry on failure.
 *
 * `source` is included in error messages (e.g. "~/.kaizen/kaizen.json: defaults.env_allowlist").
 */
export function validateEnvAllowList(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: must be an array of strings.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${source}: each entry must be a non-empty string (got ${JSON.stringify(entry)}).`);
    }
    if (/\s/.test(entry)) {
      throw new Error(`${source}: entry "${entry}" contains whitespace.`);
    }
    const stars = (entry.match(/\*/g) ?? []).length;
    if (stars > 1) {
      throw new Error(
        `${source}: invalid entry "${entry}" — only one trailing '*' allowed (e.g. "LC_*").`,
      );
    }
    if (stars === 1 && !entry.endsWith("*")) {
      throw new Error(
        `${source}: invalid entry "${entry}" — '*' may only appear as the trailing character (e.g. "LC_*").`,
      );
    }
    if (entry === "*") {
      throw new Error(`${source}: invalid entry "*" — empty prefix not allowed.`);
    }
  }
  return value as string[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/env-allowlist.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/env-allowlist.ts src/core/env-allowlist.test.ts
git commit -m "feat(sandbox): add env allow-list validator"
```

---

## Task 3: Add `env_allowlist` to type definitions

**Files:**
- Modify: `src/types/plugin.ts`

Extend `KaizenDefaults` (user-level) and `KaizenConfig` (harness-level) with an optional `env_allowlist` field.

- [ ] **Step 1: Modify `KaizenDefaults`**

In `src/types/plugin.ts`, find:

```typescript
export interface KaizenDefaults {
  /** Harness ref used when --harness is not passed on the CLI. */
  harness?: string;
  /** Per-plugin config overrides. Keyed by plugin name. Values are plugin-specific objects. */
  plugin_config?: Record<string, Record<string, unknown>>;
}
```

Replace with:

```typescript
export interface KaizenDefaults {
  /** Harness ref used when --harness is not passed on the CLI. */
  harness?: string;
  /** Per-plugin config overrides. Keyed by plugin name. Values are plugin-specific objects. */
  plugin_config?: Record<string, Record<string, unknown>>;
  /**
   * Env vars that bypass tier-based env.get gating, regardless of plugin tier.
   * Entries are exact names ("PATH") or trailing-* prefixes ("LC_*").
   * If absent, the built-in DEFAULT_ENV_ALLOWLIST is used. An explicit []
   * means "no allow-list; gate everything."
   */
  env_allowlist?: string[];
}
```

- [ ] **Step 2: Modify `KaizenConfig`**

Find:

```typescript
export interface KaizenConfig {
  /** Canonical refs (`<marketplace>/<name>[@<version>]`) or legacy bare npm names. */
  plugins: string[];
  /** ... */
  extends?: string;
  /** Informational marketplaces a harness expects; consumed by --harness bootstrap. */
  marketplaces?: MarketplaceRef[];
  [pluginName: string]: unknown;
}
```

Add the field above the index signature:

```typescript
export interface KaizenConfig {
  /** Canonical refs (`<marketplace>/<name>[@<version>]`) or legacy bare npm names. */
  plugins: string[];
  /** ... */
  extends?: string;
  /** Informational marketplaces a harness expects; consumed by --harness bootstrap. */
  marketplaces?: MarketplaceRef[];
  /**
   * Per-harness env allow-list. Same syntax as KaizenDefaults.env_allowlist.
   * If present, takes precedence over the user-level value at runtime.
   */
  env_allowlist?: string[];
  [pluginName: string]: unknown;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/plugin.ts
git commit -m "feat(types): add env_allowlist to KaizenDefaults and KaizenConfig"
```

---

## Task 4: Wire allow-list into `PermissionEnforcer`

**Files:**
- Modify: `src/core/permission-enforcer.ts`
- Modify: `src/core/permission-enforcer.test.ts`

Constructor accepts `envAllowList: string[]` (default `DEFAULT_ENV_ALLOWLIST`). The `env.get` branch in `evaluate()` short-circuits on a match.

- [ ] **Step 1: Write the failing test**

Append to `src/core/permission-enforcer.test.ts`:

```typescript
import { DEFAULT_ENV_ALLOWLIST } from "./env-allowlist.js";

describe("PermissionEnforcer — env allow-list", () => {
  it("trusted plugin: allow-listed env permitted", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "trusted" });
    expect(() =>
      e.check("p", { kind: "env.get", name: "PATH" }),
    ).not.toThrow();
  });

  it("trusted plugin: non-allow-listed env denied", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "trusted" });
    expect(() =>
      e.check("p", { kind: "env.get", name: "AWS_SECRET" }),
    ).toThrow(/tier 'trusted' permits no external ops/);
  });

  it("trusted plugin + empty allow-list: PATH denied", () => {
    const e = new PermissionEnforcer({ mode: "enforce", envAllowList: [] });
    e.register("p", { tier: "trusted" });
    expect(() =>
      e.check("p", { kind: "env.get", name: "PATH" }),
    ).toThrow(/tier 'trusted' permits no external ops/);
  });

  it("scoped plugin: declared env grants still permitted", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "scoped", env: ["DB_URL"] });
    expect(() => e.check("p", { kind: "env.get", name: "DB_URL" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "PATH" })).not.toThrow(); // allow-list
    expect(() => e.check("p", { kind: "env.get", name: "OTHER" })).toThrow(/not in env grants/);
  });

  it("scoped plugin + custom allow-list replaces default", () => {
    const e = new PermissionEnforcer({ mode: "enforce", envAllowList: ["MY_*"] });
    e.register("p", { tier: "scoped" });
    expect(() => e.check("p", { kind: "env.get", name: "MY_FOO" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "PATH" })).toThrow(/not in env grants/);
  });

  it("unscoped plugin: all env permitted regardless of allow-list", () => {
    const e = new PermissionEnforcer({ mode: "enforce", envAllowList: [] });
    e.register("p", { tier: "unscoped" });
    expect(() => e.check("p", { kind: "env.get", name: "PATH" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "AWS_SECRET" })).not.toThrow();
  });

  it("default constructor uses DEFAULT_ENV_ALLOWLIST", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "trusted" });
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
      expect(() => e.check("p", { kind: "env.get", name })).not.toThrow();
    }
    // LC_* prefix
    expect(() => e.check("p", { kind: "env.get", name: "LC_ALL" })).not.toThrow();
    expect(DEFAULT_ENV_ALLOWLIST).toContain("LC_*"); // sanity
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/permission-enforcer.test.ts -t "env allow-list"`
Expected: FAIL — `envAllowList` is not a constructor option; checks against PATH on trusted tier currently throw.

- [ ] **Step 3: Modify the enforcer**

In `src/core/permission-enforcer.ts`:

1. Add the import at the top:
   ```typescript
   import { DEFAULT_ENV_ALLOWLIST, envAllowed } from "./env-allowlist.js";
   ```

2. Add the field on the class:
   ```typescript
   export class PermissionEnforcer {
     private mode: EnforcerMode;
     private readonly envAllowList: string[];
     private readonly manifests = new Map<string, PluginPermissions>();
     // ... existing fields
   ```

3. Update the constructor:
   ```typescript
   constructor(opts: { mode: EnforcerMode; envAllowList?: string[] }) {
     this.mode = opts.mode;
     this.envAllowList = opts.envAllowList ?? DEFAULT_ENV_ALLOWLIST;
   }
   ```

4. In `evaluate()`, find the `env.get` case:

   Existing:
   ```typescript
   case "env.get":
     return (m.env ?? []).includes(op.name) ? null : `env var '${op.name}' not in env grants`;
   ```

   The trusted-tier branch above this already returns a denial string before this case is reached. We need the allow-list to short-circuit *both* the trusted denial and the scoped grant check. Restructure:

   At the top of `evaluate()`, after the `tier === "unscoped"` early-return and the `import` case but BEFORE the `if (tier === "trusted")` line, insert:

   ```typescript
   // Allow-listed env reads bypass tier checks entirely.
   if (op.kind === "env.get" && envAllowed(this.envAllowList, op.name)) return null;
   ```

   The existing tier-trusted check and the `env.get` case in the scoped switch both stay as-is. Allow-listed names never reach them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/permission-enforcer.test.ts`
Expected: all tests PASS, including the new env-allow-list group and the existing tier tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-enforcer.ts src/core/permission-enforcer.test.ts
git commit -m "feat(enforcer): consult env allow-list before tier checks"
```

---

## Task 5: Validate `defaults.env_allowlist` on global config load

**Files:**
- Modify: `src/core/kaizen-config.ts`
- Modify: `src/core/kaizen-config.test.ts`

Loader rejects invalid entries; accepts valid entries unchanged; treats absent and `[]` as distinct.

- [ ] **Step 1: Write the failing test**

Append to `src/core/kaizen-config.test.ts` (or wherever `loadKaizenGlobalConfig` is tested — locate it first):

```typescript
import { loadKaizenGlobalConfig } from "./kaizen-config.js";

describe("loadKaizenGlobalConfig — env_allowlist", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kz-cfg-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  function writeCfg(obj: unknown) {
    writeFileSync(join(home, "kaizen.json"), JSON.stringify(obj));
  }

  it("absent env_allowlist is left undefined", async () => {
    writeCfg({ defaults: { harness: "official/x@1.0.0" } });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.defaults?.env_allowlist).toBeUndefined();
  });

  it("valid env_allowlist passes through", async () => {
    writeCfg({ defaults: { env_allowlist: ["PATH", "LC_*"] } });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.defaults?.env_allowlist).toEqual(["PATH", "LC_*"]);
  });

  it("empty array is preserved (not normalized to undefined)", async () => {
    writeCfg({ defaults: { env_allowlist: [] } });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.defaults?.env_allowlist).toEqual([]);
  });

  it("invalid entry rejected with offender named", async () => {
    writeCfg({ defaults: { env_allowlist: ["FOO*BAR"] } });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/FOO\*BAR/);
  });

  it("non-array rejected", async () => {
    writeCfg({ defaults: { env_allowlist: "PATH" } });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/must be an array/);
  });
});
```

(If the existing test file does not import `mkdtempSync`, `tmpdir`, etc., add them. Verify against the file's existing import block.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/kaizen-config.test.ts -t "env_allowlist"`
Expected: FAIL — `env_allowlist` is currently rejected as an unknown key under `defaults`.

- [ ] **Step 3: Update the loader**

In `src/core/kaizen-config.ts`:

1. Add import at the top:
   ```typescript
   import { validateEnvAllowList } from "./env-allowlist.js";
   ```

2. Update the allowed-keys set:
   ```typescript
   const ALLOWED_DEFAULTS_KEYS = new Set(["harness", "plugin_config", "env_allowlist"]);
   ```

3. After the existing `defaults.plugin_config` validation block (around line 115), add:

   ```typescript
   if (defaults.env_allowlist !== undefined) {
     validateEnvAllowList(defaults.env_allowlist, `${path}: defaults.env_allowlist`);
   }
   ```

   The validator throws on invalid input; the call has no return-value usage because the parsed object is returned as-is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/kaizen-config.test.ts`
Expected: all tests PASS, including new env_allowlist tests and existing config tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/kaizen-config.ts src/core/kaizen-config.test.ts
git commit -m "feat(config): accept and validate defaults.env_allowlist"
```

---

## Task 6: Validate harness-level `env_allowlist`

**Files:**
- Modify: wherever harness `kaizen.json` is loaded/validated. Locate via `grep -rn "resolveHarness\|kaizen.json" src --include="*.ts" | grep -iv test`. Likely candidates: `src/core/harness-marketplace.ts`, `src/core/config.ts`, or `src/core/kaizen-config.ts`. Read the resolver entry point referenced from `src/cli.ts:423` (`resolveHarnessOrFatal`) to find the right file.

Apply the same `validateEnvAllowList` call when a harness `kaizen.json` is parsed.

- [ ] **Step 1: Identify the harness loader**

Run: `grep -n "resolveHarnessOrFatal\|loadHarnessConfig\|readFileSync.*kaizen.json" src --include="*.ts" -r | grep -v test | head`

Read the resolver implementation. Find the point at which the harness JSON is parsed into a `KaizenConfig` (the function returning `{ kaizenJsonPath, config }` invoked from `src/cli.ts:423`).

- [ ] **Step 2: Write the failing test**

Add a test in the same file as that function's existing tests (or its sibling `*.test.ts`). The test should:

```typescript
// Pseudocode — adjust to match the actual loader's signature.
it("rejects invalid env_allowlist in harness kaizen.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "kz-h-"));
  writeFileSync(join(dir, "kaizen.json"), JSON.stringify({
    plugins: [],
    env_allowlist: ["BAD*ENTRY"],
  }));
  expect(() => loadHarnessConfig(join(dir, "kaizen.json"))).toThrow(/BAD\*ENTRY/);
});

it("accepts valid env_allowlist in harness kaizen.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "kz-h-"));
  writeFileSync(join(dir, "kaizen.json"), JSON.stringify({
    plugins: [],
    env_allowlist: ["PATH", "LC_*"],
  }));
  const cfg = loadHarnessConfig(join(dir, "kaizen.json"));
  expect(cfg.env_allowlist).toEqual(["PATH", "LC_*"]);
});
```

Substitute the actual loader function name discovered in Step 1.

- [ ] **Step 3: Run tests to verify they fail**

Run the new tests with `bun test <path-to-test-file>`.
Expected: FAIL — invalid entries are silently accepted today.

- [ ] **Step 4: Add validation in the harness loader**

In the file identified in Step 1, after `JSON.parse` of the harness `kaizen.json`, before returning the config object, insert:

```typescript
import { validateEnvAllowList } from "./env-allowlist.js";

// ... inside the loader, after parsing JSON into `cfg`:
if (cfg.env_allowlist !== undefined) {
  validateEnvAllowList(cfg.env_allowlist, `${kaizenJsonPath}: env_allowlist`);
}
```

(Adjust the import path and field-access syntax to match the loader.)

- [ ] **Step 5: Run tests to verify they pass**

Run the new tests.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add <modified files>
git commit -m "feat(config): validate harness env_allowlist on load"
```

---

## Task 7: Resolve allow-list at bootstrap

**Files:**
- Modify: `src/core/index.ts`
- Modify: `src/core/index.test.ts` (or `bootstrap.test.ts` — locate the existing tests for `initializePluginSystem`)

Compute the effective allow-list at the point `PermissionEnforcer` is constructed in `initializePluginSystem`. Precedence: harness `env_allowlist` (if present, including `[]`) → user `defaults.env_allowlist` (if present, including `[]`) → `DEFAULT_ENV_ALLOWLIST`.

- [ ] **Step 1: Inspect existing wiring**

Read `src/core/index.ts` lines 30-70 to confirm where the enforcer is constructed and what config objects are in scope.

- [ ] **Step 2: Write the failing test**

In `src/core/index.test.ts` (or wherever `initializePluginSystem` is exercised today; locate via `grep -rn "initializePluginSystem" src --include="*.test.ts"`), add:

```typescript
it("uses default env_allowlist when neither user nor harness specifies one", async () => {
  // Set up a minimal harness config + global config with no env_allowlist.
  // After init, e.check on a trusted plugin for PATH must not throw.
  // (Detail filled per the existing test scaffolding in this file.)
});

it("user defaults.env_allowlist overrides default when harness has none", async () => {
  // Configure user with ["MY_*"]; harness omits env_allowlist.
  // env.get("MY_FOO") permitted; env.get("PATH") denied for trusted plugin.
});

it("harness env_allowlist beats user env_allowlist", async () => {
  // Configure user ["A_*"]; harness ["B_*"]. Effective list is ["B_*"].
});

it("explicit empty harness env_allowlist disables passthrough", async () => {
  // Harness env_allowlist: []. env.get("PATH") denied for trusted plugin.
});
```

Use the existing test patterns in the file for setting up `KaizenConfig` and `KaizenGlobalConfig` fixtures. Each test calls `initializePluginSystem(...)` and then probes `enforcer.check(...)` from the returned system, or via an `injectedEnforcer` workaround if the API doesn't expose the enforcer directly. If the existing tests show how to assert on enforcer behavior, follow that pattern; otherwise inject a custom enforcer in the opts to assert resolution at the call site instead.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/core/index.test.ts -t "env_allowlist"` (or the relevant file).
Expected: FAIL — current code constructs `new PermissionEnforcer({ mode })` with no allow-list option.

- [ ] **Step 4: Modify `initializePluginSystem`**

In `src/core/index.ts`, locate the block:

```typescript
let enforcer: PermissionEnforcer;
if (injectedEnforcer) {
  enforcer = injectedEnforcer;
} else {
  const mode = (process.env["KAIZEN_SANDBOX_MODE"] as EnforcerMode | undefined) ?? "enforce";
  enforcer = new PermissionEnforcer({ mode });
  initializeSandbox(enforcer);
}
```

Replace with:

```typescript
let enforcer: PermissionEnforcer;
if (injectedEnforcer) {
  enforcer = injectedEnforcer;
} else {
  const mode = (process.env["KAIZEN_SANDBOX_MODE"] as EnforcerMode | undefined) ?? "enforce";
  const envAllowList = await resolveEnvAllowList(kaizenConfig);
  enforcer = new PermissionEnforcer({ mode, envAllowList });
  initializeSandbox(enforcer);
}
```

Add a helper near the top of `src/core/index.ts` (or in a new file `src/core/resolve-env-allowlist.ts` if you prefer isolation; the spec allows either):

```typescript
import { DEFAULT_ENV_ALLOWLIST } from "./env-allowlist.js";
import { loadKaizenGlobalConfig } from "./kaizen-config.js";

async function resolveEnvAllowList(harnessConfig: KaizenConfig): Promise<string[]> {
  // Harness wins if explicitly set (including []).
  if (harnessConfig.env_allowlist !== undefined) return harnessConfig.env_allowlist;
  // Otherwise, user defaults.
  const global = await loadKaizenGlobalConfig();
  if (global.defaults?.env_allowlist !== undefined) return global.defaults.env_allowlist;
  // Otherwise, built-in default.
  return DEFAULT_ENV_ALLOWLIST;
}
```

Adjust the existing imports at the top of `index.ts` to include `KaizenConfig` if not already imported.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/core/index.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/index.ts src/core/index.test.ts
git commit -m "feat(bootstrap): resolve env allow-list with harness>user>default precedence"
```

---

## Task 8: End-to-end proxy behavior under allow-list

**Files:**
- Modify: `src/core/sandbox-bootstrap.test.ts` (or create if absent — check first via `ls src/core/sandbox-bootstrap.test.ts 2>/dev/null`)

Verify the proxy's `get`, `has`, and `ownKeys` traps respect the allow-list end-to-end (no proxy code change is needed; this confirms the enforcer-level change reaches the proxy correctly).

- [ ] **Step 1: Confirm or create the test file**

Run: `ls src/core/sandbox-bootstrap.test.ts 2>/dev/null && echo EXISTS || echo MISSING`

If MISSING, create it with the standard `bun:test` boilerplate. If EXISTS, append to it.

- [ ] **Step 2: Write the test**

Add (or create file with) the following:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initializeSandbox, restoreSandboxForTesting } from "./sandbox-bootstrap.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { setCurrentPluginForTesting, clearCurrentPluginForTesting } from "./plugin-scope.js";

describe("sandbox proxy + env allow-list", () => {
  let enforcer: PermissionEnforcer;

  beforeEach(() => {
    enforcer = new PermissionEnforcer({ mode: "enforce" }); // default allow-list
    enforcer.register("p", { tier: "trusted" });
    initializeSandbox(enforcer);
    process.env.PATH ??= "/usr/bin";
    process.env.AWS_TEST_SECRET = "shh";
    setCurrentPluginForTesting("p");
  });
  afterEach(() => {
    clearCurrentPluginForTesting();
    delete process.env.AWS_TEST_SECRET;
    restoreSandboxForTesting();
  });

  it("trusted plugin reads allow-listed PATH", () => {
    expect(typeof process.env.PATH).toBe("string");
    expect(process.env.PATH!.length).toBeGreaterThan(0);
  });

  it("trusted plugin sees undefined for non-allow-listed secret", () => {
    expect(process.env.AWS_TEST_SECRET).toBeUndefined();
  });

  it("'in' check respects allow-list", () => {
    expect("PATH" in process.env).toBe(true);
    expect("AWS_TEST_SECRET" in process.env).toBe(false);
  });

  it("Object.keys excludes non-allow-listed secret", () => {
    const keys = Object.keys(process.env);
    expect(keys).toContain("PATH");
    expect(keys).not.toContain("AWS_TEST_SECRET");
  });
});
```

If `setCurrentPluginForTesting` / `clearCurrentPluginForTesting` / `restoreSandboxForTesting` exports do not exist, locate the equivalent test helpers in `src/core/plugin-scope.ts` and `src/core/sandbox-bootstrap.ts` (the existing `restoreSandboxForTesting` is referenced in line 88 of `sandbox-bootstrap.ts`). Substitute the real names.

- [ ] **Step 3: Run tests**

Run: `bun test src/core/sandbox-bootstrap.test.ts`
Expected: all four tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/sandbox-bootstrap.test.ts
git commit -m "test(sandbox): proxy passthrough under env allow-list"
```

---

## Task 9: Integration smoke — trusted plugin spawns a binary

**Files:**
- Locate an existing integration test under `tests/integration/` or write a focused one. Run `ls tests/integration/` and identify the closest existing test to extend.

A trusted-tier plugin calls `child_process.spawn` for a binary that exists on PATH. With the allow-list active, `process.env.PATH` is visible and the spawn succeeds.

- [ ] **Step 1: Locate the right test surface**

Run: `ls tests/integration/ && grep -rln "trusted\|tier\|spawn" tests/ --include="*.ts" 2>/dev/null | head`

Identify whether an existing trusted-tier plugin fixture or test already exists. If yes, extend it. If no, this task may be deferred to a follow-up; mark this task complete after the unit tests in Tasks 4 and 8 cover the behavior. The unit tests already exercise the allow-list end to end at the enforcer + proxy layer.

- [ ] **Step 2: If an existing integration scaffold exists, add the spawn case**

Use a portable binary always present on macOS and Linux runners: `/usr/bin/true` or `echo`. Confirm the test runner has access:

```typescript
import { spawnSync } from "child_process";

// inside a trusted plugin's setup():
const result = spawnSync("echo", ["ok"], { env: process.env });
expect(result.status).toBe(0);
expect(result.stdout.toString()).toContain("ok");
```

- [ ] **Step 3: If no scaffold exists, document the deferral**

Add a one-line note in the plan's status (or in a follow-up issue): "Integration smoke deferred; unit coverage in tasks 4 and 8 exercises the bug end-to-end at the enforcer + proxy layer."

- [ ] **Step 4: Commit (if a test was added)**

```bash
git add <changed files>
git commit -m "test(integration): trusted plugin spawn succeeds under env allow-list"
```

---

## Task 10: Update `docs/guides/plugin-authoring.md`

**Files:**
- Modify: `docs/guides/plugin-authoring.md` (lines 385-391)

Replace the incorrect "globals are not filtered" paragraph.

- [ ] **Step 1: Read the current paragraph**

Read: `docs/guides/plugin-authoring.md` lines 380-395 to confirm exact wording.

- [ ] **Step 2: Replace the blockquote**

Find:

```
> **What the sandbox enforces today:** The enforcer gates module imports and
> calls made through `ctx.fs` / `ctx.net` / `ctx.exec`. It does **not** filter
> Node.js globals. `process.cwd()`, `process.env`, `process.platform`,
> `os.homedir()`, and similar ambient values are accessible to plugins of any
> tier. `tier` currently signals intent and controls which `ctx.*` grants are
> available — it is not a hard runtime cap on globals. A future release may
> tighten this; for now, treat global access as unrestricted.
```

Replace with:

```
> **What the sandbox enforces today:** The enforcer gates module imports,
> calls through `ctx.fs` / `ctx.net` / `ctx.exec`, and reads from
> `process.env`. A built-in allow-list of OS-infrastructure variables —
> `PATH`, `HOME`, `USER`, locale (`LC_*`, `LANG`), tmpdirs (`TMPDIR`,
> `TEMP`, `TMP`), and similar — passes through under any tier so that
> stdlib calls such as `child_process.spawn`, `os.homedir()`, and
> `os.tmpdir()` work without elevating tiers. Variables outside the
> allow-list follow tier rules: `unscoped` reads anything, `scoped` reads
> names declared in `env: [...]`, `trusted` reads only allow-listed
> names.
>
> Override the allow-list via `defaults.env_allowlist` in
> `~/.kaizen/kaizen.json` (user-level) or `env_allowlist` in a harness's
> `kaizen.json` (harness-level; takes precedence). An explicit `[]` means
> "gate everything; no passthrough." Entries are exact names (`"PATH"`)
> or trailing-`*` prefixes (`"LC_*"`).
>
> `process.cwd()`, `process.platform`, `os.platform()`, and similar
> non-env globals are not filtered.
```

- [ ] **Step 3: Verify rendering**

Skim the diff for stray formatting issues. No code execution needed.

- [ ] **Step 4: Commit**

```bash
git add docs/guides/plugin-authoring.md
git commit -m "docs(plugin-authoring): correct sandbox-enforcement description"
```

---

## Task 11: Update `docs/concepts/security.md`

**Files:**
- Modify: `docs/concepts/security.md`

Extend the env-proxy section and the troubleshooting note.

- [ ] **Step 1: Locate the env-proxy section and the troubleshooting note**

Read: `docs/concepts/security.md`. Find the line `process.env.X | Declare env: ["X"]...` (around line 70) and the troubleshooting block around line 111 (`process.env.X returns undefined unexpectedly`).

- [ ] **Step 2: Update the env row**

Find a line like:

```
| `process.env.X` | Declare `env: ["X"]` and read `process.env.X` normally (proxy enforces the grant) |
```

Update to:

```
| `process.env.X` | OS-infrastructure vars (PATH, HOME, locale, tmpdirs, …) pass through under any tier via a built-in allow-list. For other vars, declare `env: ["X"]` (scoped tier) and read `process.env.X` normally (proxy enforces the grant). Override the allow-list with `defaults.env_allowlist` (user) or `env_allowlist` (harness). |
```

- [ ] **Step 3: Update the troubleshooting note**

Find the paragraph beginning `**"process.env.X returns undefined unexpectedly."**` and update it to:

```
**"`process.env.X` returns `undefined` unexpectedly."** The env proxy hides
variables you have not declared and that are not in the active allow-list.
For OS-infrastructure variables (`PATH`, `HOME`, locale, tmpdirs, …) this
is unexpected and means your active allow-list does not include the name —
check `defaults.env_allowlist` in `~/.kaizen/kaizen.json` and the harness's
`env_allowlist`. For application/secret variables, add the name to your
plugin's `env: [...]` grants and re-load.
```

- [ ] **Step 4: Commit**

```bash
git add docs/concepts/security.md
git commit -m "docs(security): describe env allow-list and overrides"
```

---

## Task 12: Document config keys

**Files:**
- Modify: `docs/concepts/configuration.md`

Document `defaults.env_allowlist` (user-level) and per-harness `env_allowlist`.

- [ ] **Step 1: Locate the configuration reference**

Read: `docs/concepts/configuration.md`. Find the section that documents `defaults.harness` and `defaults.plugin_config` (the existing user-level `defaults.*` documentation).

- [ ] **Step 2: Add an `env_allowlist` subsection**

Insert under the `defaults` section:

```markdown
### `defaults.env_allowlist` (optional)

Array of env-var names that bypass tier-based env.get gating, regardless
of plugin tier. Each entry is an exact name (`"PATH"`) or a trailing-`*`
prefix (`"LC_*"`). If absent, kaizen ships a sensible default covering
PATH, HOME, USER, locale, tmpdirs, and similar OS-infrastructure
variables — see `src/core/env-allowlist.ts`.

An explicit empty array `[]` is a valid override meaning "no
passthrough; gate everything per tier rules." Distinguishable from
absent.

A harness's `kaizen.json` may also set `env_allowlist` at top level. The
harness value takes precedence over this user-level value when both are
set. Resolution order:

1. Harness `env_allowlist` (if present, including `[]`)
2. User `defaults.env_allowlist` (if present, including `[]`)
3. Built-in `DEFAULT_ENV_ALLOWLIST`

Invalid entries (multiple `*`, `*` not at end, whitespace, empty
strings) cause kaizen to fail at config load with the offending entry
named.

Example (user config):

​```json
{
  "defaults": {
    "harness": "official/claude-wrapper",
    "env_allowlist": ["PATH", "HOME", "LC_*", "MY_TOOL_*"]
  }
}
​```

Example (harness `kaizen.json`, strict mode):

​```json
{
  "plugins": ["official/example@1.0.0"],
  "env_allowlist": []
}
​```
```

(Replace the `​```` characters above with backticks; they are zero-width-space-separated to keep the JSON code blocks intact in this plan file. When inserting into the actual docs, use plain triple backticks.)

- [ ] **Step 3: Commit**

```bash
git add docs/concepts/configuration.md
git commit -m "docs(configuration): document env_allowlist user and harness keys"
```

---

## Task 13: Full verification

**Files:** none

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 3: Manual smoke (optional)**

Build and try the original repro from issue #64: a trusted-tier plugin that spawns a binary on PATH. Confirm `Executable not found in $PATH` no longer fires under default config.

If any test fails, fix and recommit before claiming done. Do not claim verification with failing tests.

---

## Self-Review

**Spec coverage check:**

| Spec section / requirement | Task(s) |
|---|---|
| Allow-list module + default list | 1 |
| Allow-list validator (exact/prefix syntax, error on invalid) | 2 |
| Type changes for `KaizenDefaults` and `KaizenConfig` | 3 |
| Enforcer consults allow-list in `evaluate()` for `env.get` | 4 |
| User config validates `defaults.env_allowlist` on load | 5 |
| Harness config validates `env_allowlist` on load | 6 |
| Resolution precedence harness > user > default | 7 |
| Distinguish absent from explicit `[]` | 5, 7 |
| Proxy `get` / `has` / `ownKeys` reflect allow-list | 8 |
| Trusted-tier behavior change covered (PATH passes, AWS_* denied) | 4, 8 |
| Scoped-tier explicit grants still work | 4 |
| Unscoped tier unaffected | 4 |
| Doc: plugin-authoring correction | 10 |
| Doc: security.md proxy explanation + troubleshooting | 11 |
| Doc: configuration.md key reference | 12 |
| Final verification | 13 |
| Integration smoke (deferred-OK if scaffold absent) | 9 |

All spec sections covered. No placeholders. Type/method names consistent: `envAllowed`, `validateEnvAllowList`, `DEFAULT_ENV_ALLOWLIST`, `envAllowList` (constructor option), `env_allowlist` (config key in JSON, snake_case for consistency with existing `plugin_config`).
