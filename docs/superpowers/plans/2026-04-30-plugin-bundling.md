# Plugin Bundling at Marketplace Install Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle every marketplace plugin install into a self-contained `dist/index.js` via `bun build`, drop `node_modules/`, and load that bundle in preference to the raw entry. Fixes loading of plugins with runtime deps or JSX entries from the compiled `kaizen` binary.

**Architecture:** Extend `installPlugin` (in `src/core/plugin-installer.ts`) with a new `bundlePlugin` post-step that runs unconditionally after `installDeps` for marketplace sources. On bundle success, remove `node_modules/` and any bun lockfile. On any failure, mirror the existing rollback (remove target dir, throw with stderr). Loader (`loadPluginFromMarketplaceInstall` in `src/core/plugin-manager.ts`) prefers `dist/index.js` if present, otherwise falls back to today's `pkg.module ?? pkg.main ?? "index.js"` resolution. Authors declare bundle-time externals via a new `pkg.kaizen.bundleExternals: string[]` field — kaizen doesn't curate the list.

**Tech Stack:** TypeScript, Bun (runtime + bundler), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-04-30-plugin-bundling-design.md`

---

## File Structure

**New files:**
- None.

**Modified files:**
- `src/core/plugin-installer.ts` — add `bundlePlugin` helper; call it from `installPlugin` after `installDeps`; export a test seam (`bundlePluginForTesting`).
- `src/core/plugin-installer.test.ts` — new `describe("bundlePlugin")` block + integration cases for `installPlugin` covering bundle success, externals, deps-free uniform path, bundle failure rollback, malformed `pkg.kaizen`.
- `src/core/plugin-manager.ts` — `loadPluginFromMarketplaceInstall`: prefer `<dir>/dist/index.js`, fall back to current entry resolution.
- `src/core/plugin-manager.test.ts` — new cases for the loader preference + fallback.
- `docs/guides/plugin-authoring.md` — document automatic bundling, the `kaizen.bundleExternals` field with the `react-devtools-core` example, dynamic-import constraint, local-path plugins not bundled.
- `README.md` — extend the runtime-deps note (if present) to mention bundling and the reinstall-after-upgrade guidance.

Each file keeps one responsibility. `plugin-installer.ts` will grow modestly (one helper + one call site). The bundling helper lives next to `installDeps` because both are install-time post-steps that share the bun-resolver and the same rollback shape.

---

## Task 1: Read and validate `kaizen.bundleExternals` from package.json

**Files:**
- Modify: `src/core/plugin-installer.ts` (add helper)
- Test: `src/core/plugin-installer.test.ts` (add describe block)

A small pure helper that reads a parsed `package.json` object and returns the `string[]` of bundle externals, treating any malformed shape as "no externals". This keeps the I/O-free logic separately testable.

- [ ] **Step 1: Write the failing test**

Append to `src/core/plugin-installer.test.ts`:

```typescript
import { readBundleExternalsForTesting } from "./plugin-installer.js";

describe("readBundleExternals", () => {
  it("returns [] when kaizen field is missing", () => {
    expect(readBundleExternalsForTesting({ name: "x", version: "1" })).toEqual([]);
  });

  it("returns [] when kaizen.bundleExternals is missing", () => {
    expect(readBundleExternalsForTesting({ kaizen: {} })).toEqual([]);
  });

  it("returns the array verbatim when well-formed", () => {
    expect(readBundleExternalsForTesting({
      kaizen: { bundleExternals: ["react-devtools-core", "fsevents"] },
    })).toEqual(["react-devtools-core", "fsevents"]);
  });

  it("returns [] when kaizen is not an object", () => {
    expect(readBundleExternalsForTesting({ kaizen: "nope" })).toEqual([]);
    expect(readBundleExternalsForTesting({ kaizen: null })).toEqual([]);
    expect(readBundleExternalsForTesting({ kaizen: ["a"] })).toEqual([]);
  });

  it("returns [] when bundleExternals is not an array", () => {
    expect(readBundleExternalsForTesting({ kaizen: { bundleExternals: "react" } })).toEqual([]);
    expect(readBundleExternalsForTesting({ kaizen: { bundleExternals: { a: 1 } } })).toEqual([]);
  });

  it("filters non-string entries", () => {
    expect(readBundleExternalsForTesting({
      kaizen: { bundleExternals: ["ok", 42, null, "also-ok"] },
    })).toEqual(["ok", "also-ok"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/plugin-installer.test.ts -t "readBundleExternals"`
Expected: FAIL — `readBundleExternalsForTesting` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `src/core/plugin-installer.ts` (above `installDeps`):

```typescript
function readBundleExternals(pkg: unknown): string[] {
  if (typeof pkg !== "object" || pkg === null) return [];
  const kz = (pkg as Record<string, unknown>)["kaizen"];
  if (typeof kz !== "object" || kz === null || Array.isArray(kz)) return [];
  const list = (kz as Record<string, unknown>)["bundleExternals"];
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === "string");
}

// Test-only export. Not part of the public API.
export const readBundleExternalsForTesting = readBundleExternals;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/plugin-installer.test.ts -t "readBundleExternals"`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(installer): read kaizen.bundleExternals from package.json"
```

---

## Task 2: Implement `bundlePlugin` post-install step

**Files:**
- Modify: `src/core/plugin-installer.ts`
- Test: `src/core/plugin-installer.test.ts`

Implement the bundling step as an isolated function so unit tests can drive it directly without going through `installPlugin`. Signature mirrors `installDeps`: `bundlePlugin(target, name, version, bunResolver?)`. Behavior:

- If no `package.json` at `target`: no-op.
- If `package.json` is malformed JSON: no-op (mirror `installDeps`).
- Resolve the entry via `pkg.module ?? pkg.main ?? "index.js"`.
- Resolve `bun`; if missing, throw the same error message shape as `installDeps`.
- Spawn `bun build --target=bun --outfile=<target>/dist/index.js [--external X]... <target>/<entry>`.
- On non-zero exit: `rmSync(target)` and throw with bun's stderr.
- On success: `rmSync(<target>/node_modules)`, `rmSync(<target>/bun.lockb)`, `rmSync(<target>/bun.lock)` (all `force: true`).

- [ ] **Step 1: Write the success-case test (deps-free, no externals)**

Append to `src/core/plugin-installer.test.ts`:

```typescript
import { bundlePluginForTesting } from "./plugin-installer.js";

describe("bundlePlugin", () => {
  let target: string;
  beforeEach(() => {
    target = mkdtempSync(join(tmpdir(), "kz-bundle-"));
  });
  afterEach(() => {
    rmSync(target, { recursive: true, force: true });
  });

  it("produces dist/index.js for a deps-free plugin and removes node_modules/lockfiles", async () => {
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "trivial", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(target, "index.js"),
      "export default { name: 'trivial', apiVersion: '2', setup(){} };",
    );
    // Pretend a previous installDeps left these behind.
    mkdirSync(join(target, "node_modules"), { recursive: true });
    writeFileSync(join(target, "node_modules", "marker"), "");
    writeFileSync(join(target, "bun.lock"), "{}\n");

    await bundlePluginForTesting(target, "trivial", "1.0.0");

    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(existsSync(join(target, "bun.lock"))).toBe(false);
    // Source survives.
    expect(existsSync(join(target, "index.js"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/plugin-installer.test.ts -t "bundlePlugin"`
Expected: FAIL — `bundlePluginForTesting` is not exported.

- [ ] **Step 3: Implement `bundlePlugin`**

Add to `src/core/plugin-installer.ts` below `installDeps`:

```typescript
async function bundlePlugin(
  target: string,
  name: string,
  version: string,
  bunResolver: () => string | null = resolveBunExecutable,
): Promise<void> {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return;

  let pkg: { main?: string; module?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }

  const entry = pkg.module ?? pkg.main ?? "index.js";
  const entryPath = join(target, entry);
  const outFile = join(target, "dist", "index.js");
  const externals = readBundleExternals(pkg);

  const bun = bunResolver();
  if (!bun) {
    throw new Error(
      `plugin '${name}@${version}' could not be bundled: bun is not on PATH or at ~/.bun/bin/bun.\n` +
      `Install bun: curl -fsSL https://bun.sh/install | bash`,
    );
  }

  const cmd = [bun, "build", "--target=bun", `--outfile=${outFile}`];
  for (const ext of externals) cmd.push("--external", ext);
  cmd.push(entryPath);

  const proc = Bun.spawnSync({ cmd, cwd: target, stdout: "pipe", stderr: "pipe" });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    rmSync(target, { recursive: true, force: true });
    throw new Error(
      `bun build failed for plugin '${name}@${version}' at ${target}\n` +
      stderr.split("\n").map((l) => `  ${l}`).join("\n"),
    );
  }

  rmSync(join(target, "node_modules"), { recursive: true, force: true });
  rmSync(join(target, "bun.lockb"), { force: true });
  rmSync(join(target, "bun.lock"), { force: true });
}

// Test-only export. Not part of the public API.
export const bundlePluginForTesting = bundlePlugin;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/plugin-installer.test.ts -t "bundlePlugin"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(installer): bundle plugin entry into dist/index.js after install"
```

---

## Task 3: `bundlePlugin` failure rolls back the target dir

**Files:**
- Test: `src/core/plugin-installer.test.ts`

Verify that a malformed entry (syntax error in source) causes `bun build` to fail, the target dir is removed, and the thrown message includes bun's stderr.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("bundlePlugin", ...)` block:

```typescript
it("rolls back target and includes stderr when bun build fails", async () => {
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({ name: "broken", version: "1.0.0", type: "module", main: "index.js" }),
  );
  // Syntax error: unterminated string.
  writeFileSync(join(target, "index.js"), "export default { broken: 'oops");

  await expect(bundlePluginForTesting(target, "broken", "1.0.0")).rejects.toThrow(/bun build failed/);
  expect(existsSync(target)).toBe(false);
}, 30_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/plugin-installer.test.ts -t "rolls back target"`
Expected: PASS already (rollback is implemented in Task 2). If FAIL, fix Task 2's implementation before continuing.

> Note: this is a regression-coverage test for the rollback path written in Task 2. If Task 2 was implemented correctly the test passes immediately; the test still belongs in the plan to lock the behavior.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-installer.test.ts
git commit -m "test(installer): bundle failure rolls back target dir"
```

---

## Task 4: `bundlePlugin` passes externals to bun build

**Files:**
- Test: `src/core/plugin-installer.test.ts`

Verify externals reach the `bun build` command line. The cleanest way to assert this without inspecting argv: use a fake bun executable that records its arguments to a file, then point `bunResolver` at it.

- [ ] **Step 1: Write the failing test**

Append inside the `describe("bundlePlugin", ...)` block:

```typescript
it("passes kaizen.bundleExternals as --external flags to bun build", async () => {
  // Fake bun executable that records argv and writes a stub bundle.
  const fakeBun = join(target, "fake-bun.sh");
  const argLog = join(target, "args.log");
  writeFileSync(
    fakeBun,
    `#!/bin/sh
echo "$@" > ${JSON.stringify(argLog)}
# argv: build --target=bun --outfile=<...> [--external X]... <entry>
# Find --outfile=<path> and create the file.
for a in "$@"; do
  case "$a" in
    --outfile=*)
      out="\${a#--outfile=}"
      mkdir -p "$(dirname "$out")"
      echo "// stub" > "$out"
      ;;
  esac
done
exit 0
`,
  );
  chmodSync(fakeBun, 0o755);

  writeFileSync(
    join(target, "package.json"),
    JSON.stringify({
      name: "with-ext",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      kaizen: { bundleExternals: ["react-devtools-core", "fsevents"] },
    }),
  );
  writeFileSync(join(target, "index.js"), "export default { name: 'x', apiVersion: '2', setup(){} };");

  await bundlePluginForTesting(target, "with-ext", "1.0.0", () => fakeBun);

  const argv = readFileSync(argLog, "utf8");
  expect(argv).toContain("--external react-devtools-core");
  expect(argv).toContain("--external fsevents");
  expect(argv).toContain("--target=bun");
  expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/core/plugin-installer.test.ts -t "passes kaizen.bundleExternals"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-installer.test.ts
git commit -m "test(installer): bundle externals are forwarded to bun build"
```

---

## Task 5: Wire `bundlePlugin` into `installPlugin`

**Files:**
- Modify: `src/core/plugin-installer.ts`
- Test: `src/core/plugin-installer.test.ts`

Call `bundlePlugin` after `installDeps` in `installPlugin`, so all marketplace source types (`file`, `tarball`, `npm`) get bundled.

- [ ] **Step 1: Write the failing integration test**

Append a new `describe` block in `src/core/plugin-installer.test.ts`:

```typescript
describe("installPlugin — bundling", () => {
  it("produces dist/index.js and removes node_modules after a deps-free file install", async () => {
    const pluginSrc = join(upstream, "plugins", "trivial");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({ name: "trivial", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(pluginSrc, "index.js"),
      "export default { name: 'trivial', apiVersion: '2', setup(){} };",
    );

    await installPlugin("m", "trivial", "1.0.0", { type: "file", path: "plugins/trivial" });

    const target = pluginInstallDir("m", "trivial", "1.0.0");
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(existsSync(join(target, "index.js"))).toBe(true);
    expect(existsSync(join(target, "package.json"))).toBe(true);
  }, 30_000);

  it("produces dist/index.js and removes node_modules after a with-deps file install", async () => {
    const pluginSrc = join(upstream, "plugins", "with-deps");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({
        name: "with-deps",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        dependencies: { "is-odd": "3.0.1" },
      }),
    );
    writeFileSync(
      join(pluginSrc, "index.js"),
      "import isOdd from 'is-odd'; export default { name: 'with-deps', apiVersion: '2', setup(){ isOdd(1); } };",
    );

    await installPlugin("m", "with-deps", "1.0.0", { type: "file", path: "plugins/with-deps" });

    const target = pluginInstallDir("m", "with-deps", "1.0.0");
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/plugin-installer.test.ts -t "installPlugin — bundling"`
Expected: FAIL — `dist/index.js` does not exist (bundling not wired in).

- [ ] **Step 3: Wire bundlePlugin into installPlugin**

In `src/core/plugin-installer.ts`, change the body of `installPlugin`:

```typescript
  await installDeps(target, name, version);
  await bundlePlugin(target, name, version);
```

(Insert the `bundlePlugin` call as the last line of `installPlugin`, after `installDeps`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: PASS for the new cases AND all pre-existing `installPlugin` tests. (Pre-existing tests assert the source files survive; bundling does not touch source files.)

> If a pre-existing test asserts `node_modules/<pkg>` exists after install (e.g., the "resolves runtime deps after copying file source" case at `plugin-installer.test.ts:40`), update it to assert `dist/index.js` exists instead. The post-bundle disk layout removes `node_modules/`.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(installer): bundle plugin after install"
```

---

## Task 6: Update existing `installDeps` test that asserts node_modules survival

**Files:**
- Modify: `src/core/plugin-installer.test.ts` (existing case at line ~40)

The pre-existing "resolves runtime deps after copying file source" test asserts `node_modules/is-odd` exists after `installPlugin`. Post-bundle that's no longer true. Replace the assertion with a `dist/index.js` check.

- [ ] **Step 1: Update the assertion**

In `src/core/plugin-installer.test.ts`, replace:

```typescript
    expect(existsSync(join(target, "node_modules", "is-odd"))).toBe(true);
```

with:

```typescript
    expect(existsSync(join(target, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(target, "node_modules"))).toBe(false);
```

If this assertion was already covered by the new Task 5 cases, delete the old test instead of duplicating coverage. (Prefer deletion when the old test no longer carries unique signal.)

- [ ] **Step 2: Run tests**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-installer.test.ts
git commit -m "test(installer): update legacy installDeps test for post-bundle layout"
```

---

## Task 7: Loader prefers `dist/index.js`, falls back to package.json entry

**Files:**
- Modify: `src/core/plugin-manager.ts` (function `loadPluginFromMarketplaceInstall`, lines 109-134)
- Test: `src/core/plugin-manager.test.ts`

Change the loader to check for `<dir>/dist/index.js` first; fall back to today's `pkg.module ?? pkg.main ?? "index.js"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/plugin-manager.test.ts` (or create the file if it doesn't exist; if creating, mirror the imports/setup pattern from `plugin-installer.test.ts`):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pluginInstallDir } from "./kaizen-config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-pm-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("loadPluginFromMarketplaceInstall — bundle preference", () => {
  // Use the public reload() / list pluginManager surface, OR — preferred — export a
  // test seam from plugin-manager.ts that loads a single marketplace install by id.
  // The simplest seam: export `loadPluginFromMarketplaceInstallForTesting`.

  it("prefers dist/index.js when present, ignores raw entry", async () => {
    const target = pluginInstallDir("m", "preferbundle", "1.0.0");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "preferbundle", version: "1.0.0", type: "module", main: "index.js" }),
    );
    // Raw entry exports a sentinel that should NOT be loaded.
    writeFileSync(
      join(target, "index.js"),
      "export default { name: 'WRONG', apiVersion: '2', setup(){} };",
    );
    // Bundle exports the correct sentinel.
    mkdirSync(join(target, "dist"));
    writeFileSync(
      join(target, "dist", "index.js"),
      "export default { name: 'preferbundle', apiVersion: '2', setup(){} };",
    );

    const { loadPluginFromMarketplaceInstallForTesting } = await import("./plugin-manager.js");
    const loaded = await loadPluginFromMarketplaceInstallForTesting("m", "preferbundle", "1.0.0", "preferbundle");
    expect(loaded?.plugin.name).toBe("preferbundle");
    expect(loaded?.resolvedPath).toContain(`dist${require("path").sep}index.js`);
  });

  it("falls back to pkg.module/pkg.main when no dist/index.js", async () => {
    const target = pluginInstallDir("m", "fallback", "1.0.0");
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, "package.json"),
      JSON.stringify({ name: "fallback", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(
      join(target, "index.js"),
      "export default { name: 'fallback', apiVersion: '2', setup(){} };",
    );

    const { loadPluginFromMarketplaceInstallForTesting } = await import("./plugin-manager.js");
    const loaded = await loadPluginFromMarketplaceInstallForTesting("m", "fallback", "1.0.0", "fallback");
    expect(loaded?.plugin.name).toBe("fallback");
    expect(loaded?.resolvedPath).toMatch(/index\.js$/);
    expect(loaded?.resolvedPath).not.toContain("dist");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/plugin-manager.test.ts -t "bundle preference"`
Expected: FAIL — `loadPluginFromMarketplaceInstallForTesting` is not exported and the loader does not prefer `dist/index.js`.

- [ ] **Step 3: Update the loader**

In `src/core/plugin-manager.ts`, replace the body of `loadPluginFromMarketplaceInstall` (lines 109-134):

```typescript
async function loadPluginFromMarketplaceInstall(
  marketplaceId: string, pluginName: string, version: string, displayName: string,
): Promise<LoadedPlugin | null> {
  const dir = pluginInstallDir(marketplaceId, pluginName, version);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;

  // Prefer the bundled output produced by installPlugin(). Falls through to the
  // raw entry for two cases: pre-bundle-era installs on disk, and uncompiled
  // `bun src/cli.ts` against a freshly checked-out plugin without a build step.
  const bundlePath = join(dir, "dist", "index.js");
  let abs: string;
  if (existsSync(bundlePath)) {
    abs = bundlePath;
  } else {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string; module?: string };
    const entry = pkg.module ?? pkg.main ?? "index.js";
    abs = join(dir, entry);
  }

  try {
    const mod = (await import(abs)) as { default?: unknown };
    const plugin = mod.default;
    if (
      typeof plugin !== "object" || plugin === null ||
      typeof (plugin as Record<string, unknown>)["name"] !== "string" ||
      typeof (plugin as Record<string, unknown>)["setup"] !== "function"
    ) {
      warn(`Plugin '${displayName}' at ${abs} does not export a valid KaizenPlugin. Skipping.`);
      return null;
    }
    return { plugin: plugin as KaizenPlugin, resolvedPath: abs };
  } catch (err) {
    warn(`Failed to load plugin at '${abs}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Test-only export. Not part of the public API.
export const loadPluginFromMarketplaceInstallForTesting = loadPluginFromMarketplaceInstall;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/plugin-manager.test.ts -t "bundle preference"`
Expected: PASS for both cases.

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts src/core/plugin-manager.test.ts
git commit -m "feat(loader): prefer dist/index.js for marketplace plugin loads"
```

---

## Task 8: End-to-end verification with the live failing plugin

**Files:** none (manual verification — produces evidence to attach to the PR description).

The original bug: `kaizen --harness official/claude-wrapper` fails with `Cannot find package 'ink'` from the compiled binary while loading `claude-tui@0.2.0`. Verify the fix manually before the docs task.

- [ ] **Step 1: Build the compiled binary**

Run: `bun run build` (or whatever the project's compile command is — check `package.json` scripts).
Expected: succeeds, produces a standalone `kaizen` binary.

- [ ] **Step 2: Reinstall the affected plugin**

Run: `./<binary-path> install official/claude-tui` (or whatever marketplace+plugin pair reproduces the original bug).
Expected: install succeeds; `~/.kaizen/marketplaces/<id>/plugins/claude-tui@0.2.0/dist/index.js` exists; `node_modules/` does not.

- [ ] **Step 3: Run the harness that previously failed**

Run: `./<binary-path> --harness official/claude-wrapper`
Expected: launches without `Cannot find package 'ink'` or `Cannot find module 'react/jsx-dev-runtime'`. Note any new errors and decide whether to fix here or file separately.

- [ ] **Step 4: No commit; record outcome in PR description.**

If verification fails, return to Task 2/5/7 — the most likely culprits are an unhandled `--external` in the bundle (if `claude-tui` triggers `react-devtools-core` and the plugin has not yet declared it in `kaizen.bundleExternals`) or a JSX entry that needs the bundler to be invoked with the right entry path. Investigate before continuing to docs.

---

## Task 9: Document plugin-author guidance

**Files:**
- Modify: `docs/guides/plugin-authoring.md`
- Modify: `README.md` (only if the runtime-deps section already mentions `bun install`; otherwise skip)

- [ ] **Step 1: Update `docs/guides/plugin-authoring.md`**

Add a new section near the existing runtime-deps section. Suggested heading: `## Bundling`. Content to include:

```markdown
## Bundling

When kaizen installs a marketplace plugin, it runs `bun install --production`
(if needed) and then `bun build --target=bun` to produce
`<install-dir>/dist/index.js`. The loader prefers this bundle over your raw
entry, so plugins ship runnable from the compiled `kaizen` binary even when
they have runtime dependencies or a JSX/TSX entry.

After a successful build, kaizen removes `node_modules/` and any bun lockfile
from the install directory. Source files (`package.json`, README, `index.tsx`,
etc.) stay on disk for inspection.

### Externals: `kaizen.bundleExternals`

Some packages should not be inlined into the bundle — typically transitive
optional or platform-specific deps that `bun build` can't (or shouldn't)
resolve. Declare them in your `package.json`:

```json
{
  "name": "claude-tui",
  "version": "0.2.0",
  "type": "module",
  "main": "index.tsx",
  "dependencies": { "ink": "^7.0.1", "react": "^19.2.0" },
  "kaizen": {
    "bundleExternals": ["react-devtools-core"]
  }
}
```

Each entry is passed verbatim to `bun build --external`. Kaizen does not
curate this list — you're responsible for it.

### Constraints

- Avoid eval'd or string-concatenated dynamic imports of bare specifiers.
  `import("./foo.js")` and `import(varHoldingAbsolutePath)` work;
  `` import(`some-pkg-${version}`) `` will not bundle.
- Local-path plugins (`./path/to/plugin`) are NOT bundled. They load via the
  raw entry, which only works under uncompiled `bun src/cli.ts`. Use local-path
  plugins for development only; publish to a marketplace for production.
- If kaizen ≤ 0.3.2 installed the plugin previously, run `kaizen install <name>`
  again to regenerate the bundle layout.
```

- [ ] **Step 2: Update `README.md` if applicable**

Open `README.md`, search for any mention of `bun install` or "runtime dependencies". If present, append one sentence:

> After `bun install`, kaizen runs `bun build` to produce `dist/index.js`; the loader prefers the bundle so plugins work from the compiled binary.

If `README.md` does not mention runtime deps at all, skip this step.

- [ ] **Step 3: Run docs link check (if the project has one)**

Run: `bun run docs:check` or equivalent (check `package.json` scripts).
Expected: PASS, or NO-OP if no docs check exists.

- [ ] **Step 4: Commit**

```bash
git add docs/guides/plugin-authoring.md README.md
git commit -m "docs: document plugin bundling and kaizen.bundleExternals"
```

---

## Task 10: Run the full test suite and lint/typecheck

**Files:** none (verification).

- [ ] **Step 1: Type check**

Run: `bun run typecheck` (or the project's TS check; consult `package.json`).
Expected: PASS.

- [ ] **Step 2: Full tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 3: If anything fails, fix in place and re-run.**

No commit at this step unless fixes were made; the prior task commits should already represent the work.

---

## Notes for the implementer

- Don't curate or massage the `kaizen.bundleExternals` list. If an author writes a typo, that's their bug. v1 doesn't surface diagnostics for malformed `pkg.kaizen` (spec confirms).
- `bundlePlugin` runs unconditionally for marketplace installs — including deps-free plugins — because a uniform load path is worth more than the ~few-ms cost on a trivial plugin.
- `installHarness` is unaffected. Bundling is plugin-only.
- Local-path plugins (loaded via `loadPluginFromPath`) are out of scope. Don't add bundling there.
- Don't refactor `installDeps` and `bundlePlugin` into a shared abstraction — they're similar but small, and a shared helper would obscure the per-step rollback semantics. Two focused functions are clearer than one parameterized one.
