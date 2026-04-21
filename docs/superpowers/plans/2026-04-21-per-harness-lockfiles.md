# Per-Harness Lockfiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the lockfile from repo-root `kaizen.permissions.lock` to a per-harness `permissions.lock` co-located with each harness's `kaizen.json`, require a named harness for all entry points, and remove the `KAIZEN_LOCKFILE_OVERRIDE` env var.

**Architecture:** A new harness resolver returns `{ kaizenJsonPath, config }`. The CLI derives `lockfilePath = dirname(kaizenJsonPath) + "/permissions.lock"` and threads it into all lockfile consumers. Lockfile consumer signatures stay `lockfilePath: string` — only CLI entry points change. `installHarness` already preserves `permissions.lock` (writes only `kaizen.json`); add a regression test. Spec: `docs/superpowers/specs/2026-04-21-per-harness-lockfiles-design.md`.

**Tech Stack:** TypeScript, Bun, existing YAML lockfile format (unchanged schema).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/lockfile-path.ts` (new) | Single `deriveLockfilePath(harnessJsonPath)` helper |
| `src/core/config.ts` (modify) | Add `resolveHarness()` returning `{ kaizenJsonPath, config }`; have `resolveConfig` delegate. Require named harness — error when none resolvable. |
| `src/core/index.ts` (modify) | Drop `KAIZEN_LOCKFILE_OVERRIDE` and `process.cwd()` fallback; require `lockfilePath` from caller via `RunHarnessOpts` / `initializePluginSystem` args. |
| `src/cli.ts` (modify) | Resolve harness, derive lockfile path, replace all `join(process.cwd(), "kaizen.permissions.lock")` sites. |
| `src/core/plugin-installer.ts` (modify, minor) | Document/enforce `installHarness` preserving `permissions.lock`. |
| `src/core/lockfile-path.test.ts` (new) | Unit tests for the path derivation helper. |
| `src/core/config.test.ts` or new `config-harness.test.ts` | Tests for `resolveHarness()` across three sources + error paths. |
| `tests/integration/marketplace.integration.test.ts` (modify) | Add re-materialization-preserves-`permissions.lock` test. |
| `tests/integration/per-harness-lockfiles.integration.test.ts` (new) | Two harnesses in one repo → independent lockfiles. |
| `src/core/orchestration.test.ts`, `src/core/integration/driver-capability-resolution.test.ts`, `src/core/plugin-manager.test.ts` (modify) | Remove `KAIZEN_LOCKFILE_OVERRIDE`; use tmpdir harness. |
| `src/core/bootstrap.test.ts`, `src/commands/{install,update,uninstall,plugin-consent,plugin-review,plugin-audit}.test.ts` (modify) | Update test lockfile paths from repo-root to per-harness tmpdir. |
| `README.md`, `.gitignore`, `docs/concepts/security.md`, `docs/concepts/plugin-model.md`, `docs/concepts/harnesses.md` (modify) | Update live doc references; add "State files" subsection in harnesses.md. |

---

## Task 1: Lockfile Path Helper

**Files:**
- Create: `src/core/lockfile-path.ts`
- Test: `src/core/lockfile-path.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/lockfile-path.test.ts
import { describe, test, expect } from "bun:test";
import { deriveLockfilePath } from "./lockfile-path.js";

describe("deriveLockfilePath", () => {
  test("returns sibling permissions.lock for a kaizen.json path", () => {
    expect(deriveLockfilePath("/foo/bar/kaizen.json")).toBe("/foo/bar/permissions.lock");
  });

  test("works for marketplace harness paths", () => {
    const p = "/home/u/.kaizen/marketplaces/official/harnesses/core-debug/kaizen.json";
    expect(deriveLockfilePath(p))
      .toBe("/home/u/.kaizen/marketplaces/official/harnesses/core-debug/permissions.lock");
  });

  test("works for project-scoped harness paths", () => {
    expect(deriveLockfilePath(".kaizen/harnesses/dev/kaizen.json"))
      .toBe(".kaizen/harnesses/dev/permissions.lock");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/lockfile-path.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/lockfile-path.ts
import { dirname, join } from "path";

/**
 * Derive the per-harness lockfile path from a harness's kaizen.json path.
 * Lockfile lives alongside kaizen.json: `<harness-dir>/permissions.lock`.
 */
export function deriveLockfilePath(kaizenJsonPath: string): string {
  return join(dirname(kaizenJsonPath), "permissions.lock");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/lockfile-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lockfile-path.ts src/core/lockfile-path.test.ts
git commit -m "feat(core): add deriveLockfilePath helper"
```

---

## Task 2: resolveHarness — Three Sources

**Files:**
- Modify: `src/core/config.ts` (add `resolveHarness`, export `ResolvedHarness` type)
- Test: `src/core/config-harness.test.ts` (new)

**Context:** `loadHarnessConfig(nameOrPath)` in `src/core/config.ts:34-65` already handles project, home, and explicit-path sources but returns only the parsed config, losing the path. We need a sibling function that returns both the path and the config.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/config-harness.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveHarness } from "./config.js";

let tmp: string;
let cwdOrig: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kz-resolve-"));
  cwdOrig = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdOrig);
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveHarness", () => {
  test("resolves a project-scoped bare name", () => {
    const dir = join(tmp, ".kaizen", "harnesses", "dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: [] }));
    const resolved = resolveHarness("dev");
    expect(resolved.kaizenJsonPath).toBe(join(".kaizen", "harnesses", "dev", "kaizen.json"));
    expect(Array.isArray(resolved.config.plugins)).toBe(true);
  });

  test("resolves an explicit absolute path", () => {
    const dir = join(tmp, "hx");
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, "kaizen.json");
    writeFileSync(jsonPath, JSON.stringify({ plugins: [] }));
    const resolved = resolveHarness(jsonPath);
    expect(resolved.kaizenJsonPath).toBe(jsonPath);
  });

  test("resolves a relative path to a directory", () => {
    const dir = join(tmp, "hrel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: [] }));
    const resolved = resolveHarness("./hrel");
    // Should be the normalized kaizen.json path
    expect(resolved.kaizenJsonPath.endsWith("hrel/kaizen.json")).toBe(true);
  });

  test("rejects URL", () => {
    expect(() => resolveHarness("https://example.com/kaizen.json")).toThrow();
  });

  test("reports helpful error when not found", () => {
    expect(() => resolveHarness("nonexistent-harness")).toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/config-harness.test.ts`
Expected: FAIL (`resolveHarness` not exported).

- [ ] **Step 3: Add resolveHarness to src/core/config.ts**

Add near the existing `loadHarnessConfig`:

```typescript
// src/core/config.ts — add these exports
export interface ResolvedHarness {
  kaizenJsonPath: string;
  config: KaizenConfig;
}

/**
 * Resolve a harness name-or-path to both its kaizen.json location and parsed config.
 * Callers derive the lockfile path from `dirname(kaizenJsonPath) + "/permissions.lock"`.
 */
export function resolveHarness(nameOrPath: string): ResolvedHarness {
  const projectHarness = join(PROJECT_HARNESSES, nameOrPath, "kaizen.json");
  if (existsSync(projectHarness)) {
    return { kaizenJsonPath: projectHarness, config: parseAndValidateHarness(projectHarness, nameOrPath) };
  }

  const homeHarness = join(KAIZEN_HOME_HARNESSES, nameOrPath, "kaizen.json");
  if (existsSync(homeHarness)) {
    return { kaizenJsonPath: homeHarness, config: parseAndValidateHarness(homeHarness, nameOrPath) };
  }

  if (nameOrPath.startsWith("./") || nameOrPath.startsWith("/") || nameOrPath.startsWith("../")) {
    const filePath = nameOrPath.endsWith(".json") ? nameOrPath : join(nameOrPath, "kaizen.json");
    if (!existsSync(filePath)) fatal(`Harness not found at path: ${filePath}`);
    return { kaizenJsonPath: filePath, config: parseAndValidateHarness(filePath, nameOrPath) };
  }

  if (nameOrPath.startsWith("http://") || nameOrPath.startsWith("https://")) {
    fatal(
      `URL harnesses are not supported.\n` +
      `Publish the harness in a marketplace and reference it as '<marketplace>/<name>@<version>'.`,
    );
  }

  fatal(
    `Harness '${nameOrPath}' not found.\n` +
    `  Marketplace:    kaizen install <marketplace>/${nameOrPath}@<version>\n` +
    `  Project-scoped: .kaizen/harnesses/${nameOrPath}/kaizen.json\n` +
    `  Global:         ~/.kaizen/harnesses/${nameOrPath}/kaizen.json\n` +
    `  Path:           ./path/to/kaizen.json`,
  );
}
```

Refactor the existing `loadHarnessConfig` to delegate:

```typescript
export function loadHarnessConfig(nameOrPath: string): KaizenConfig {
  return resolveHarness(nameOrPath).config;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/config-harness.test.ts src/core/config.test.ts`
Expected: PASS (new file); existing `config.test.ts` still passes because `loadHarnessConfig` behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/config-harness.test.ts
git commit -m "feat(core): add resolveHarness returning path and config"
```

---

## Task 3: Require Named Harness at Resolution

**Files:**
- Modify: `src/core/config.ts` — tighten `resolveConfig` to require a harness
- Test: `src/core/config-harness.test.ts` (extend)

**Context:** Today `resolveConfig` falls back to `.kaizen/kaizen.json`, root `kaizen.json`, or `~/.kaizen/kaizen.json` without requiring a harness. Per the spec, every invocation must resolve to a named harness via `--harness` or `extends`. If neither is present, error.

- [ ] **Step 1: Add failing test**

Append to `src/core/config-harness.test.ts`:

```typescript
import { resolveConfig } from "./config.js";

describe("resolveConfig — named harness required", () => {
  test("errors when no --harness and no extends in config", () => {
    mkdirSync(join(tmp, ".kaizen"), { recursive: true });
    writeFileSync(join(tmp, ".kaizen", "kaizen.json"), JSON.stringify({ plugins: [] }));
    expect(() => resolveConfig({})).toThrow(/named harness required/i);
  });

  test("succeeds with --harness", () => {
    const dir = join(tmp, ".kaizen", "harnesses", "dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: ["a"] }));
    const cfg = resolveConfig({ harness: "dev" });
    expect(cfg.plugins).toEqual(["a"]);
  });

  test("succeeds when local config has extends", () => {
    const h = join(tmp, ".kaizen", "harnesses", "base");
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "kaizen.json"), JSON.stringify({ plugins: ["x"] }));
    mkdirSync(join(tmp, ".kaizen"), { recursive: true });
    writeFileSync(join(tmp, ".kaizen", "kaizen.json"), JSON.stringify({ extends: "base" }));
    const cfg = resolveConfig({});
    expect(cfg.plugins).toEqual(["x"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/config-harness.test.ts`
Expected: "errors when no --harness and no extends" FAILS (today resolveConfig accepts the bare config).

- [ ] **Step 3: Modify resolveConfig to require a harness**

In `src/core/config.ts`, replace the body of `resolveConfig` so every branch that previously returned a bare local/global config now errors unless a harness (via `--harness` or `extends`) is present. Keep the helpful "no config found" message and add a second variant for "config found but no harness":

```typescript
export function resolveConfig(opts: {
  harness?: string;
  configPath?: string;
  extendsOverride?: string;
}): KaizenConfig {
  const { harness, configPath, extendsOverride } = opts;
  const explicitPath = configPath ?? null;
  const projectConfigPath = explicitPath ?? findProjectConfig();

  if (harness) {
    const harnessConfig = loadHarnessConfig(harness);
    if (projectConfigPath) {
      const localConfig = loadKaizenConfig(projectConfigPath);
      if (localConfig.extends && localConfig.extends !== harness) {
        warn(`--harness ${harness} overrides extends '${localConfig.extends}' in config.`);
      }
      return mergeConfigs(harnessConfig, localConfig);
    }
    return harnessConfig;
  }

  if (projectConfigPath) {
    const localConfig = loadKaizenConfig(projectConfigPath);
    const ext = extendsOverride ?? localConfig.extends;
    if (!ext) {
      fatal(
        `A named harness is required.\n` +
        `Found ${projectConfigPath} but no --harness flag and no 'extends' field.\n` +
        `See docs/concepts/harnesses.md. Valid forms:\n` +
        `  kaizen --harness <marketplace>/<name>@<version>\n` +
        `  kaizen --harness ./path/to/harness/\n` +
        `  Add "extends": "<harness-ref>" to ${projectConfigPath}`,
      );
    }
    return mergeConfigs(loadHarnessConfig(ext), localConfig);
  }

  if (existsSync(KAIZEN_HOME_CONFIG)) {
    const globalConfig = loadKaizenConfig(KAIZEN_HOME_CONFIG);
    const ext = extendsOverride ?? globalConfig.extends;
    if (!ext) {
      fatal(
        `A named harness is required.\n` +
        `Found ${KAIZEN_HOME_CONFIG} but no --harness flag and no 'extends' field.\n` +
        `See docs/concepts/harnesses.md.`,
      );
    }
    return mergeConfigs(loadHarnessConfig(ext), globalConfig);
  }

  fatal(
    `No config found.\n` +
    `  Harness (required): kaizen --harness <marketplace>/<name>@<version>\n` +
    `  Project config:     kaizen init\n` +
    `  Global config:      kaizen init --global`,
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/core/config-harness.test.ts src/core/config.test.ts`
Expected: the new "errors when no --harness and no extends" test passes. Existing `config.test.ts` tests that relied on bare-config behavior will likely fail — if so, update them to add `--harness` or `extends`, matching the new contract. Do this inline before committing.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/config-harness.test.ts src/core/config.test.ts
git commit -m "feat(core): require named harness at config resolution"
```

---

## Task 4: Core Bootstrap — Drop KAIZEN_LOCKFILE_OVERRIDE and cwd Fallback

**Files:**
- Modify: `src/core/index.ts:55-65`

**Context:** `src/core/index.ts:58` currently does `process.env["KAIZEN_LOCKFILE_OVERRIDE"] ?? join(process.cwd(), "kaizen.permissions.lock")`. This must become a required parameter from the caller.

- [ ] **Step 1: Write the failing test**

Create or append to `src/core/bootstrap.test.ts` (or appropriate existing test):

```typescript
// Add this test
test("initializePluginSystem requires lockfilePath in opts", async () => {
  // Tests that the signature no longer silently falls back to cwd.
  // The exact call here depends on the existing test scaffolding — mirror
  // an existing successful initializePluginSystem call, but assert that
  // omitting lockfilePath throws a clear error.
});
```

NOTE: because the current signature uses positional defaults, this test requires the signature change in step 3 before it can be written meaningfully. Write it after step 3 if easier; alternatively, verify via TypeScript: `bun run tsc` should fail for callers that omit `lockfilePath` once the signature is required.

- [ ] **Step 2: Change `initializePluginSystem` signature**

Modify `src/core/index.ts`:

```typescript
export interface InitializePluginSystemOpts {
  lockfilePath: string;
  injectedEnforcer?: PermissionEnforcer;
}

export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  opts: InitializePluginSystemOpts,
): Promise<InitializedSystem> {
  const { lockfilePath, injectedEnforcer } = opts;
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

  const manager = new PluginManager(
    kaizenConfig,
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
  lockfilePath: string;
  enforcer?: PermissionEnforcer;
}

export async function runHarness(opts: RunHarnessOpts): Promise<void> {
  const { kaizenConfig, lockfilePath, enforcer: injectedEnforcer } = opts;
  const init: InitializePluginSystemOpts = {
    lockfilePath,
    ...(injectedEnforcer !== undefined ? { injectedEnforcer } : {}),
  };
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
  } finally {
    await auditLog.flush();
  }
}

export async function bootstrap(kaizenConfig: KaizenConfig, lockfilePath: string): Promise<void> {
  return runHarness({ kaizenConfig, lockfilePath });
}
```

Delete every reference to `KAIZEN_LOCKFILE_OVERRIDE` in this file and repo-wide (`bun x rg KAIZEN_LOCKFILE_OVERRIDE src/` should return nothing after this task).

- [ ] **Step 3: Run typecheck to find broken callers**

Run: `bun run tsc --noEmit`
Expected: failures pointing at every caller of `initializePluginSystem`, `runHarness`, `bootstrap`. Record the list; fix each in this task or subsequent tasks (cli.ts is Task 5; test scaffolding is Task 8+).

- [ ] **Step 4: Fix internal callers in core (non-CLI, non-test)**

Update any `src/core/*` callers to pass `lockfilePath` explicitly. Don't modify `src/cli.ts` or tests yet — those are their own tasks.

- [ ] **Step 5: Run tests**

Run: `bun test src/core/`
Expected: typechecks pass; unit tests inside `src/core/` either pass or fail with obvious "missing lockfilePath" errors. Leave failing tests for Task 8.

- [ ] **Step 6: Commit**

```bash
git add src/core/index.ts src/core/
git commit -m "refactor(core): require lockfilePath in initializePluginSystem/runHarness/bootstrap"
```

---

## Task 5: CLI Wiring — Derive Per-Harness Lockfile Path

**Files:**
- Modify: `src/cli.ts` — every `join(process.cwd(), "kaizen.permissions.lock")` site

**Context:** Six call sites today:
- Line 254: `install` subcommand
- Line 272: `uninstall` subcommand
- Line 288: `update` subcommand
- Line 303: `plugin` subcommand (`lockfilePath` local)
- Line 497: `bootstrapMissingPlugins` in the run path
- Final `bootstrap(kaizenConfig)` call at line 526

After resolving the harness, derive `lockfilePath` once and reuse.

- [ ] **Step 1: Add a shared helper in cli.ts**

Near the top of `src/cli.ts`, add an import and a small helper:

```typescript
import { deriveLockfilePath } from "./core/lockfile-path.js";
import { resolveHarness } from "./core/config.js";
```

Inside the run path, after resolving `harnessArg` / `extendsOverride`, compute the resolved harness's path:

```typescript
// After harnessArg / extendsOverride are computed, before resolveConfig:
function resolveHarnessJsonPath(opts: { harness?: string; extendsOverride?: string; configPath?: string }): string {
  if (opts.harness) return resolveHarness(opts.harness).kaizenJsonPath;
  if (opts.extendsOverride) return resolveHarness(opts.extendsOverride).kaizenJsonPath;
  // Fallback: read extends out of the local config and resolve it.
  const activePath = opts.configPath ?? findProjectConfig() ??
    (existsSync(KAIZEN_HOME_CONFIG) ? KAIZEN_HOME_CONFIG : null);
  if (activePath) {
    try {
      const raw = JSON.parse(readFileSync(activePath, "utf8")) as { extends?: unknown };
      if (typeof raw.extends === "string") return resolveHarness(raw.extends).kaizenJsonPath;
    } catch { /* resolveConfig will raise the right error */ }
  }
  fatal("kaizen requires a named harness; see docs/concepts/harnesses.md");
}
```

- [ ] **Step 2: Replace all repo-root lockfile paths in `run` path**

Around line 487–500:

```typescript
const harnessJsonPath = resolveHarnessJsonPath({
  ...(harnessArg !== undefined ? { harness: harnessArg } : {}),
  ...(extendsOverride !== undefined ? { extendsOverride } : {}),
  ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
});
const lockfilePath = deriveLockfilePath(harnessJsonPath);

const kaizenConfig = resolveConfig({
  ...(harnessArg !== undefined ? { harness: harnessArg } : {}),
  ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
  ...(extendsOverride !== undefined ? { extendsOverride } : {}),
});

if ((kaizenConfig.marketplaces as unknown[])?.length || ((kaizenConfig.plugins as string[] | undefined) ?? []).some((p: string) => p.includes("/"))) {
  const { bootstrapMissingPlugins } = await import("./core/bootstrap.js");
  await bootstrapMissingPlugins(kaizenConfig, {
    lockfilePath,
    trustLockfile, nonInteractive, allowUnscoped: allowUnscopedFlag,
  });
}

// ...

await bootstrap(kaizenConfig, lockfilePath);
```

- [ ] **Step 3: Replace subcommand lockfile paths**

For each of `install`, `uninstall`, `update`, and `plugin` subcommands, do the same harness resolution (these subcommands don't always take `--harness`, so most use the "read extends from local config or error" branch). For `install` (line 247) and `uninstall` (line 265), the ref being installed is a plugin ref, not a harness ref — the lockfile still belongs to whichever harness the current invocation targets. Derive it via `resolveHarnessJsonPath(...)` against the same args set as the run path:

```typescript
// install example at line 247
if (subcommand === "install") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  if (!ref) { /* usage */ }
  const harnessJsonPath = resolveHarnessJsonPath({});
  const lockfilePath = deriveLockfilePath(harnessJsonPath);
  const { runUnifiedInstall } = await import("./commands/install.js");
  const code = await runUnifiedInstall({
    ref, lockfilePath,
    allowUnscoped: rest.includes("--allow-unscoped"),
    nonInteractive: rest.includes("--non-interactive"),
  });
  process.exit(code);
}
```

Apply the same pattern to `uninstall`, `update`, and `plugin` (line 303).

- [ ] **Step 4: Run typecheck and basic CLI smoke**

Run: `bun run tsc --noEmit`
Expected: PASS.

Set up a tmp harness and smoke-test:

```bash
mkdir -p /tmp/kz-smoke/.kaizen/harnesses/test
echo '{"plugins":[]}' > /tmp/kz-smoke/.kaizen/harnesses/test/kaizen.json
cd /tmp/kz-smoke
bun /Users/chancock/git/kaizen/src/cli.ts --harness test plugin audit
```

Expected: runs; if a `permissions.lock` gets created, it lands at `/tmp/kz-smoke/.kaizen/harnesses/test/permissions.lock`, not at repo root.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): derive per-harness lockfile path"
```

---

## Task 6: Marketplace Re-Materialization Preservation

**Files:**
- Modify: `src/core/plugin-installer.ts:33-42`
- Test: `tests/integration/marketplace.integration.test.ts`

**Context:** `installHarness` currently writes `kaizen.json` into the target dir without removing other files. That means an existing `permissions.lock` is already preserved. This task locks in that behavior with an explicit contract and a regression test, and guards against a future refactor that might add `rmSync(target)`.

- [ ] **Step 1: Add failing test**

Append to `tests/integration/marketplace.integration.test.ts` (or create a new focused file):

```typescript
test("installHarness preserves an existing permissions.lock on re-materialization", async () => {
  // Arrange: install the harness once, write a fake lockfile, re-install,
  // then assert the lockfile survived byte-for-byte.
  const { installHarness } = await import("../../src/core/plugin-installer.js");
  const { harnessInstallDir } = await import("../../src/core/kaizen-config.js");

  // Point KAIZEN_HOME at a tmpdir (reuse whatever fixture pattern this file uses).
  // ... marketplace setup to supply a harness source file "harness/kaizen.json" ...

  await installHarness("fixture-mp", "hx", "harness");
  const lockPath = join(harnessInstallDir("fixture-mp", "hx"), "permissions.lock");
  writeFileSync(lockPath, "schemaVersion: 1\nplugins: {}\n");
  const before = readFileSync(lockPath);

  // Re-materialize.
  await installHarness("fixture-mp", "hx", "harness");

  expect(existsSync(lockPath)).toBe(true);
  expect(readFileSync(lockPath).equals(before)).toBe(true);
});
```

If the test file already has fixture helpers for marketplace setup, mirror them. If not, read the existing tests in the file first to find the pattern.

- [ ] **Step 2: Run test**

Run: `bun test tests/integration/marketplace.integration.test.ts`
Expected: PASS (since current `installHarness` doesn't clobber). The test now protects the behavior.

- [ ] **Step 3: Add an explicit contract comment**

Modify `src/core/plugin-installer.ts:33-42`:

```typescript
/**
 * Materialize a marketplace harness's kaizen.json into
 * `~/.kaizen/marketplaces/<id>/harnesses/<name>/`.
 *
 * Preservation contract: this function MUST NOT remove other files in the
 * target directory. The per-harness `permissions.lock` lives here and must
 * survive re-materialization (plugin grant changes still trigger re-consent
 * via the tier-grant hash comparison in consent-flow). Do not add
 * rmSync(target) here.
 */
export async function installHarness(
  marketplaceId: string, name: string, pathInRepo: string,
): Promise<void> {
  const src = join(marketplaceRepoDir(marketplaceId), pathInRepo);
  if (!existsSync(src)) throw new Error(`harness source not found in marketplace: ${pathInRepo}`);
  const target = harnessInstallDir(marketplaceId, name);
  mkdirSync(target, { recursive: true });
  const raw = readFileSync(src);
  writeFileSync(join(target, "kaizen.json"), raw);
}
```

- [ ] **Step 4: Run the test again**

Run: `bun test tests/integration/marketplace.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts tests/integration/marketplace.integration.test.ts
git commit -m "test(marketplace): pin permissions.lock preservation on re-materialization"
```

---

## Task 7: Remove KAIZEN_LOCKFILE_OVERRIDE From Tests

**Files:**
- Modify: `src/core/orchestration.test.ts`, `src/core/integration/driver-capability-resolution.test.ts`, `src/core/plugin-manager.test.ts` — any test using `KAIZEN_LOCKFILE_OVERRIDE`

- [ ] **Step 1: Find all usages**

Run: `bun x rg KAIZEN_LOCKFILE_OVERRIDE`
Expected: handful of test files. Record the list.

- [ ] **Step 2: For each test, swap to a tmpdir harness**

Pattern replacement:

```typescript
// BEFORE
const lockDir = mkdtempSync(join(tmpdir(), "kz-lock-"));
const lockfilePath = join(lockDir, "kaizen.permissions.lock");
process.env["KAIZEN_LOCKFILE_OVERRIDE"] = lockfilePath;

// AFTER
const harnessDir = mkdtempSync(join(tmpdir(), "kz-harness-"));
writeFileSync(join(harnessDir, "kaizen.json"), JSON.stringify({ plugins: [] }));
const lockfilePath = join(harnessDir, "permissions.lock");
// pass lockfilePath directly to initializePluginSystem / runHarness / command under test
```

Delete the env var set/unset and any `delete process.env["KAIZEN_LOCKFILE_OVERRIDE"]` lines.

- [ ] **Step 3: Run tests**

Run: `bun test src/core/orchestration.test.ts src/core/integration/driver-capability-resolution.test.ts src/core/plugin-manager.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify env var is gone repo-wide**

Run: `bun x rg KAIZEN_LOCKFILE_OVERRIDE`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestration.test.ts src/core/integration/driver-capability-resolution.test.ts src/core/plugin-manager.test.ts
git commit -m "test(core): drop KAIZEN_LOCKFILE_OVERRIDE, use tmpdir harness"
```

---

## Task 8: Update Remaining Test Lockfile Paths

**Files:**
- Modify: `src/core/bootstrap.test.ts`, `src/commands/install.test.ts`, `src/commands/update.test.ts`, `src/commands/uninstall.test.ts`, and any other test using a repo-root-style lockfile path

- [ ] **Step 1: Find usages**

Run: `bun x rg 'kaizen\.permissions\.lock' src/ tests/`
Expected: references from tests. Record.

- [ ] **Step 2: Replace with per-harness tmpdir paths**

Same pattern as Task 7: create a tmp directory, drop a minimal `kaizen.json`, use `<tmp>/permissions.lock`. Most command tests already take a `lockfilePath` argument — just change the string passed in.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: PASS across the board.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: move command/bootstrap test lockfiles under per-harness tmpdirs"
```

---

## Task 9: Per-Harness Isolation Integration Test

**Files:**
- Create: `tests/integration/per-harness-lockfiles.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deriveLockfilePath } from "../../src/core/lockfile-path.js";
import { resolveHarness } from "../../src/core/config.js";

describe("per-harness lockfile isolation", () => {
  test("two harnesses in one repo get independent lockfile paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "kz-two-"));
    const cwdOrig = process.cwd();
    process.chdir(repo);
    try {
      const a = join(repo, ".kaizen", "harnesses", "a");
      const b = join(repo, ".kaizen", "harnesses", "b");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, "kaizen.json"), JSON.stringify({ plugins: ["p1"] }));
      writeFileSync(join(b, "kaizen.json"), JSON.stringify({ plugins: ["p2"] }));

      const lockA = deriveLockfilePath(resolveHarness("a").kaizenJsonPath);
      const lockB = deriveLockfilePath(resolveHarness("b").kaizenJsonPath);

      expect(lockA).not.toBe(lockB);
      expect(lockA.endsWith("/.kaizen/harnesses/a/permissions.lock")).toBe(true);
      expect(lockB.endsWith("/.kaizen/harnesses/b/permissions.lock")).toBe(true);

      // Writing one does not affect the other.
      writeFileSync(lockA, "A");
      writeFileSync(lockB, "B");
      expect(readFileSync(lockA, "utf8")).toBe("A");
      expect(readFileSync(lockB, "utf8")).toBe("B");
      expect(existsSync(join(repo, "kaizen.permissions.lock"))).toBe(false);
    } finally {
      process.chdir(cwdOrig);
    }
  });
});
```

- [ ] **Step 2: Run test**

Run: `bun test tests/integration/per-harness-lockfiles.integration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/per-harness-lockfiles.integration.test.ts
git commit -m "test(integration): per-harness lockfile isolation"
```

---

## Task 10: Docs Updates

**Files:**
- Modify: `README.md:120`, `.gitignore:8`, `docs/concepts/security.md:95`, `docs/concepts/plugin-model.md:52`, `docs/concepts/harnesses.md`

- [ ] **Step 1: Update README.md**

Replace the block around line 120:

```markdown
Consent is persisted in `permissions.lock` next to each harness's `kaizen.json`
(`.kaizen/harnesses/<name>/permissions.lock`, `~/.kaizen/harnesses/<name>/permissions.lock`,
or `~/.kaizen/marketplaces/<id>/harnesses/<name>/permissions.lock`). **Commit project-scoped
lockfiles** — they are the security record. See `docs/concepts/harnesses.md`.
```

- [ ] **Step 2: Update .gitignore**

Change the comment at line 8:

```gitignore
# Sandbox runtime artifacts (commit .kaizen/harnesses/*/permissions.lock — each is a security record)
```

- [ ] **Step 3: Update docs/concepts/security.md:95**

Replace "to `kaizen.permissions.lock` at the repo root — **commit this file**..." with a per-harness description pointing at the three path patterns. Keep the "commit it, reviewers approve changes like code" framing.

- [ ] **Step 4: Update docs/concepts/plugin-model.md:52**

Replace "persist in `kaizen.permissions.lock`" with "persist in the harness's `permissions.lock` (see `docs/concepts/harnesses.md`)".

- [ ] **Step 5: Add State files subsection to docs/concepts/harnesses.md**

Append before "Discovery":

```markdown
## State files

Each harness carries its own `permissions.lock` sitting next to its `kaizen.json`:

- `.kaizen/harnesses/<name>/permissions.lock` (project)
- `~/.kaizen/harnesses/<name>/permissions.lock` (home)
- `~/.kaizen/marketplaces/<id>/harnesses/<name>/permissions.lock` (marketplace)

The lockfile records the consented tier and grants for each plugin in the harness.
Commit project-scoped lockfiles — they are the security record reviewed like code.

**Re-materialization preserves consent.** When a marketplace harness is re-fetched
(`kaizen marketplace update`), `permissions.lock` is preserved. If the re-fetched
`kaizen.json` changes a plugin's permissions, runtime re-prompts for consent on
next run because the tier-grant hash no longer matches.

**Multiple harnesses, one project.** Two harnesses in the same repo keep
independent consent records — consenting in one does not grant consent in the
other.

**A named harness is required.** `kaizen` without `--harness` and without an
`extends` entry in `.kaizen/kaizen.json` is an error. Use one of the three
entry-point forms above.
```

- [ ] **Step 6: Verify docs render**

Run: `bun x rg 'kaizen\.permissions\.lock' README.md .gitignore docs/concepts/`
Expected: no matches (all live doc references updated).

- [ ] **Step 7: Commit**

```bash
git add README.md .gitignore docs/concepts/security.md docs/concepts/plugin-model.md docs/concepts/harnesses.md
git commit -m "docs: per-harness lockfiles"
```

---

## Task 11: Full Verification

- [ ] **Step 1: Typecheck**

Run: `bun run tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS.

- [ ] **Step 3: Repo-wide sanity grep**

Run: `bun x rg 'KAIZEN_LOCKFILE_OVERRIDE|kaizen\.permissions\.lock' src/ tests/ README.md .gitignore docs/concepts/`
Expected: no matches (historical `docs/superpowers/` artifacts excluded intentionally).

- [ ] **Step 4: Run the end-to-end smoke**

```bash
mkdir -p /tmp/kz-e2e/.kaizen/harnesses/demo
cat > /tmp/kz-e2e/.kaizen/harnesses/demo/kaizen.json <<'JSON'
{"plugins":[]}
JSON
cd /tmp/kz-e2e
bun /Users/chancock/git/kaizen/src/cli.ts --harness demo plugin audit
ls .kaizen/harnesses/demo/
```

Expected: command runs; `.kaizen/harnesses/demo/` contains `kaizen.json` (and possibly `permissions.lock` if audit produced one). No `kaizen.permissions.lock` at repo root.

Also verify the error path:

```bash
mkdir -p /tmp/kz-err/.kaizen
echo '{"plugins":[]}' > /tmp/kz-err/.kaizen/kaizen.json
cd /tmp/kz-err
bun /Users/chancock/git/kaizen/src/cli.ts --harness nonexistent 2>&1 | head -5
```

Expected: clear "Harness '...' not found" error with the three valid forms listed.

```bash
cd /tmp/kz-err
bun /Users/chancock/git/kaizen/src/cli.ts 2>&1 | head -5
```

Expected: clear "A named harness is required" error pointing at `docs/concepts/harnesses.md`.

- [ ] **Step 5: Final commit (if anything stray was fixed)**

```bash
git status
# If clean, skip. Otherwise:
git add -A
git commit -m "chore: final cleanup for per-harness lockfiles"
```
