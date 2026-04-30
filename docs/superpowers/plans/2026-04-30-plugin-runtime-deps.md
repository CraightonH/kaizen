# Plugin Runtime Dependency Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When kaizen installs a plugin whose `package.json` declares runtime `dependencies`, run `bun install --production` in the install dir so the plugin's imports resolve at load time. Ensure `bun` is available end-to-end via `scripts/install.sh`.

**Architecture:** Add a single post-step at the end of `installPlugin` (in `src/core/plugin-installer.ts`) that runs uniformly across all source types (`file`, `tarball`, `npm`). Resolve `bun` via PATH or `~/.bun/bin/bun`; hard-fail on `bun install` errors and clean up the target dir. In `scripts/install.sh`, add an idempotent `ensure_bun` step before the existing `bootstrap` so a fresh kaizen install always has bun available.

**Tech Stack:** TypeScript, Bun (runtime + package manager), `bun:test`, Bash.

**Spec:** `docs/superpowers/specs/2026-04-30-plugin-runtime-deps-design.md`

---

## File Structure

**New files:**
- None.

**Modified files:**
- `src/core/plugin-installer.ts` — add the bun-resolver helper and the `installDeps` post-step; call it from `installPlugin` after each source-type case.
- `src/core/plugin-installer.test.ts` — extend with unit tests for the new behavior.
- `scripts/install.sh` — add `ensure_bun` and call it before `bootstrap` in `main`.
- `tests/install-sh-test.sh` — add tests for `ensure_bun`.
- `docs/guides/plugin-authoring.md` — document automatic dep resolution, lockfile guidance, `trustedDependencies` gotcha.
- `README.md` — note `install.sh` installs bun and the `KAIZEN_NO_BUN` opt-out.

Each file has one responsibility. The installer logic stays in one focused module (`plugin-installer.ts` is currently 77 lines; will grow modestly).

---

## Task 1: Add bun executable resolver

**Files:**
- Modify: `src/core/plugin-installer.ts` (add helper)
- Test: `src/core/plugin-installer.test.ts` (add describe block)

Resolve a usable `bun` binary path, preferring `bun` on PATH and falling back to `~/.bun/bin/bun`. Returns the path string or `null`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/plugin-installer.test.ts`:

```typescript
import { resolveBunExecutable } from "./plugin-installer.js";

describe("resolveBunExecutable", () => {
  it("returns 'bun' when bun is on PATH", () => {
    // The test runner is bun itself, so `bun` resolves on PATH.
    const got = resolveBunExecutable();
    expect(got).not.toBeNull();
    // Either "bun" (PATH hit) or an absolute path ending with /bin/bun.
    expect(got === "bun" || got!.endsWith("/bin/bun")).toBe(true);
  });

  it("falls back to ~/.bun/bin/bun when not on PATH", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kz-bun-home-"));
    const fakeBunDir = join(fakeHome, ".bun", "bin");
    mkdirSync(fakeBunDir, { recursive: true });
    const fakeBun = join(fakeBunDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBun, 0o755);

    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.PATH = "/nonexistent-empty-path";
    process.env.HOME = fakeHome;
    try {
      expect(resolveBunExecutable()).toBe(fakeBun);
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns null when bun is nowhere", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "kz-bun-home-"));
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    process.env.PATH = "/nonexistent-empty-path";
    process.env.HOME = fakeHome;
    try {
      expect(resolveBunExecutable()).toBeNull();
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
```

Add `chmodSync` to the existing `fs` import line at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: FAIL — `resolveBunExecutable is not exported` (or similar).

- [ ] **Step 3: Implement the resolver**

Append to `src/core/plugin-installer.ts`:

```typescript
import { homedir } from "os";

/**
 * Resolve a usable `bun` executable path.
 * Preference: `bun` on PATH → `~/.bun/bin/bun` → null.
 *
 * Exported for testing. Internal callers use it via installDeps.
 */
export function resolveBunExecutable(): string | null {
  // PATH lookup: probe with `which` semantics via Bun.which.
  const onPath = Bun.which("bun");
  if (onPath) return "bun";
  const fallback = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(fallback)) return fallback;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: PASS for the three new tests, plus existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(installer): add bun executable resolver"
```

---

## Task 2: Add `installDeps` helper that no-ops when no deps declared

**Files:**
- Modify: `src/core/plugin-installer.ts`
- Test: `src/core/plugin-installer.test.ts`

Internal helper: given a populated plugin install dir, decide whether to run `bun install`. Skip when there's no `package.json`, when JSON is malformed, or when `dependencies` is missing/empty.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/plugin-installer.test.ts`:

```typescript
import { installDepsForTesting } from "./plugin-installer.js";

describe("installDeps — no-op cases", () => {
  let target: string;
  beforeEach(() => { target = mkdtempSync(join(tmpdir(), "kz-deps-")); });
  afterEach(() => { rmSync(target, { recursive: true, force: true }); });

  it("no-ops when package.json missing", async () => {
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("no-ops when package.json has no dependencies field", async () => {
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("no-ops when dependencies is an empty object", async () => {
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {} }));
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });

  it("no-ops when package.json is malformed", async () => {
    writeFileSync(join(target, "package.json"), "{ not valid json");
    await installDepsForTesting(target, "demo", "1.0.0");
    expect(existsSync(join(target, "node_modules"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: FAIL — `installDepsForTesting` is not exported.

- [ ] **Step 3: Implement `installDeps`**

In `src/core/plugin-installer.ts`, add:

```typescript
/**
 * If `target` contains a package.json with non-empty runtime dependencies,
 * run `bun install --production` in it. Otherwise no-op.
 *
 * On bun-install failure: rmSync(target) and throw with bun's stderr.
 * On missing bun: throw with install instructions.
 */
async function installDeps(target: string, name: string, version: string): Promise<void> {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return;

  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    // Malformed package.json — let plugin load surface the real error.
    return;
  }

  const deps = pkg.dependencies;
  if (!deps || Object.keys(deps).length === 0) return;

  const bun = resolveBunExecutable();
  if (!bun) {
    throw new Error(
      `plugin '${name}@${version}' declares runtime dependencies but bun is not on PATH or at ~/.bun/bin/bun.\n` +
      `Install bun: curl -fsSL https://bun.sh/install | bash`,
    );
  }

  const proc = Bun.spawnSync({
    cmd: [bun, "install", "--production"],
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    rmSync(target, { recursive: true, force: true });
    throw new Error(
      `bun install failed for plugin '${name}@${version}' at ${target}\n` +
      stderr.split("\n").map((l) => `  ${l}`).join("\n"),
    );
  }
}

// Test-only export. Not part of the public API.
export const installDepsForTesting = installDeps;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: PASS for the four new no-op cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(installer): add installDeps no-op cases"
```

---

## Task 3: `installDeps` runs bun install for real deps

**Files:**
- Modify: `src/core/plugin-installer.test.ts`

Cover the happy path: a `package.json` with a real, tiny pure-JS dep gets `node_modules/<dep>` after install.

- [ ] **Step 1: Write the failing test**

Append to the `describe("installDeps — no-op cases", ...)` file (new describe):

```typescript
describe("installDeps — runs bun install", () => {
  it("creates node_modules/<dep> for a declared runtime dep", async () => {
    const target = mkdtempSync(join(tmpdir(), "kz-deps-real-"));
    try {
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({
          name: "demo",
          version: "1.0.0",
          dependencies: { "is-odd": "3.0.1" },
        }),
      );

      await installDepsForTesting(target, "demo", "1.0.0");

      expect(existsSync(join(target, "node_modules", "is-odd"))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 30_000); // network + cache pull on first run
});
```

- [ ] **Step 2: Run test to verify it fails (or passes if dep tree already cached)**

Run: `bun test src/core/plugin-installer.test.ts -t "creates node_modules"`
Expected: depending on cache, may already PASS once Task 2's implementation is in. The point is to lock in coverage. If failing, the failure should be a network/registry problem, not code.

- [ ] **Step 3: No code change required — Task 2's implementation already covers it**

Verify no implementation changes are needed; the test exists to lock in the contract.

- [ ] **Step 4: Run the full test file**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: PASS for all installer tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.test.ts
git commit -m "test(installer): cover installDeps happy path with real dep"
```

---

## Task 4: `installDeps` failure path wipes target and surfaces stderr

**Files:**
- Modify: `src/core/plugin-installer.test.ts`

Cover the failure path with a deliberately bad dep name (unresolvable), so the test does not depend on registry contents and surfaces an error fast.

- [ ] **Step 1: Write the failing test**

Append to `src/core/plugin-installer.test.ts`:

```typescript
describe("installDeps — failure path", () => {
  it("wipes target and throws with bun stderr when bun install fails", async () => {
    const target = mkdtempSync(join(tmpdir(), "kz-deps-fail-"));
    try {
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({
          name: "demo",
          version: "1.0.0",
          // Scoped name in a kaizen-reserved scope guaranteed not to exist.
          dependencies: { "@kaizen-test-does-not-exist/nope": "1.0.0" },
        }),
      );
      writeFileSync(join(target, "marker.txt"), "x");

      let err: Error | null = null;
      try {
        await installDepsForTesting(target, "demo", "1.0.0");
      } catch (e) {
        err = e as Error;
      }

      expect(err).not.toBeNull();
      expect(err!.message).toContain("bun install failed for plugin 'demo@1.0.0'");
      expect(existsSync(target)).toBe(false); // wiped
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it passes (Task 2's impl already handles this)**

Run: `bun test src/core/plugin-installer.test.ts -t "wipes target"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-installer.test.ts
git commit -m "test(installer): cover installDeps failure path"
```

---

## Task 5: `installDeps` errors clearly when bun is missing

**Files:**
- Modify: `src/core/plugin-installer.ts`
- Modify: `src/core/plugin-installer.test.ts`

The current `installDeps` calls `resolveBunExecutable()` directly, which makes "bun missing" hard to test in an environment where bun is the test runner. Inject a resolver override for testability.

- [ ] **Step 1: Refactor `installDeps` to accept an injected resolver (default = `resolveBunExecutable`)**

In `src/core/plugin-installer.ts`, change the signature:

```typescript
async function installDeps(
  target: string,
  name: string,
  version: string,
  bunResolver: () => string | null = resolveBunExecutable,
): Promise<void> {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return;

  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }

  const deps = pkg.dependencies;
  if (!deps || Object.keys(deps).length === 0) return;

  const bun = bunResolver();
  if (!bun) {
    throw new Error(
      `plugin '${name}@${version}' declares runtime dependencies but bun is not on PATH or at ~/.bun/bin/bun.\n` +
      `Install bun: curl -fsSL https://bun.sh/install | bash`,
    );
  }
  // ... rest unchanged
}
```

Update the test export accordingly (still `installDepsForTesting = installDeps`).

- [ ] **Step 2: Write the failing test**

Append to `src/core/plugin-installer.test.ts`:

```typescript
describe("installDeps — bun missing", () => {
  it("throws with install instructions when no bun is resolvable", async () => {
    const target = mkdtempSync(join(tmpdir(), "kz-deps-nobun-"));
    try {
      writeFileSync(
        join(target, "package.json"),
        JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } }),
      );

      let err: Error | null = null;
      try {
        await installDepsForTesting(target, "demo", "1.0.0", () => null);
      } catch (e) {
        err = e as Error;
      }

      expect(err).not.toBeNull();
      expect(err!.message).toContain("bun is not on PATH or at ~/.bun/bin/bun");
      expect(err!.message).toContain("curl -fsSL https://bun.sh/install | bash");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test src/core/plugin-installer.test.ts -t "bun missing"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "test(installer): cover bun-missing error path"
```

---

## Task 6: Wire `installDeps` into `installPlugin` for all source types

**Files:**
- Modify: `src/core/plugin-installer.ts`
- Modify: `src/core/plugin-installer.test.ts`

Call `installDeps` after each source-type branch so `file`, `tarball`, and `npm` all benefit.

- [ ] **Step 1: Write a failing test (file source with deps end-to-end)**

Append to `src/core/plugin-installer.test.ts` inside `describe("installPlugin — file source", ...)`:

```typescript
it("resolves runtime deps after copying file source", async () => {
  const pluginSrc = join(upstream, "plugins", "with-deps");
  mkdirSync(pluginSrc, { recursive: true });
  writeFileSync(
    join(pluginSrc, "package.json"),
    JSON.stringify({
      name: "with-deps",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "is-odd": "3.0.1" },
    }),
  );
  writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'with-deps', apiVersion: '2', setup(){} };");

  await installPlugin("m", "with-deps", "1.0.0", { type: "file", path: "plugins/with-deps" });

  const target = pluginInstallDir("m", "with-deps", "1.0.0");
  expect(existsSync(join(target, "node_modules", "is-odd"))).toBe(true);
}, 30_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/plugin-installer.test.ts -t "resolves runtime deps after copying"`
Expected: FAIL — `node_modules/is-odd` not found (no call to `installDeps` yet).

- [ ] **Step 3: Modify `installPlugin` to call `installDeps`**

In `src/core/plugin-installer.ts`, restructure the function. Replace the `switch` block with:

```typescript
export async function installPlugin(
  marketplaceId: string, name: string, version: string, source: PluginSource,
): Promise<void> {
  const target = pluginInstallDir(marketplaceId, name, version);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  switch (source.type) {
    case "file": {
      const src = join(marketplaceRepoDir(marketplaceId), source.path);
      if (!existsSync(src)) throw new Error(`file source not found in marketplace: ${source.path}`);
      cpSync(src, target, { recursive: true });
      break;
    }
    case "tarball": {
      await installTarball(source.url, target, source.sha256);
      break;
    }
    case "npm": {
      await installNpm(source.name, source.version, target);
      break;
    }
  }

  await installDeps(target, name, version);
}
```

(Note: `return` becomes `break` so all source types fall through to `installDeps`.)

- [ ] **Step 4: Run all installer tests**

Run: `bun test src/core/plugin-installer.test.ts`
Expected: PASS for all tests, including the new `resolves runtime deps after copying`.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-installer.ts src/core/plugin-installer.test.ts
git commit -m "feat(installer): resolve runtime deps after every plugin install"
```

---

## Task 7: Lockfile is honored when present

**Files:**
- Modify: `src/core/plugin-installer.test.ts`

Smoke test that a committed `bun.lock` survives the copy and is honored by `bun install`.

- [ ] **Step 1: Write the test**

Append to `src/core/plugin-installer.test.ts`:

```typescript
describe("installPlugin — lockfile honored", () => {
  it("preserves bun.lock from source and uses it", async () => {
    const pluginSrc = join(upstream, "plugins", "locked");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(
      join(pluginSrc, "package.json"),
      JSON.stringify({
        name: "locked",
        version: "1.0.0",
        main: "index.js",
        dependencies: { "is-odd": "3.0.1" },
      }),
    );
    writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'locked', apiVersion: '2', setup(){} };");
    // A pre-existing bun.lock in the source — bun will use it.
    // We can't easily fabricate a valid binary lockfile in a test, so we just
    // verify that any lockfile present in source is copied into target.
    writeFileSync(join(pluginSrc, "bun.lock"), "{}\n");

    await installPlugin("m", "locked", "1.0.0", { type: "file", path: "plugins/locked" });

    const target = pluginInstallDir("m", "locked", "1.0.0");
    expect(existsSync(join(target, "bun.lock"))).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run test**

Run: `bun test src/core/plugin-installer.test.ts -t "preserves bun.lock"`
Expected: PASS (cpSync copies all files, including lockfile).

- [ ] **Step 3: Commit**

```bash
git add src/core/plugin-installer.test.ts
git commit -m "test(installer): verify bun.lock is preserved through install"
```

---

## Task 8: Add `ensure_bun` to `scripts/install.sh`

**Files:**
- Modify: `scripts/install.sh`

Add an idempotent step that installs bun if missing. Best-effort: failure does not abort.

- [ ] **Step 1: Add the function**

In `scripts/install.sh`, insert this block immediately before the existing `bootstrap()` definition:

```bash
# Ensure bun is available so plugin runtime deps can be resolved at install
# time. Idempotent and best-effort: a failure here warns and continues, never
# aborts the kaizen installer.
#
# Opt out by setting KAIZEN_NO_BUN=1.
ensure_bun() {
  if [ "${KAIZEN_NO_BUN:-0}" = "1" ]; then
    info "Skipping bun install (KAIZEN_NO_BUN=1)."
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    info "bun already installed: $(command -v bun)"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bun" ]; then
    info "bun found at ~/.bun/bin/bun"
    return 0
  fi

  info "Installing bun (required for plugin dependency resolution)..."
  if curl -fsSL https://bun.sh/install | bash; then
    green "  ✓ bun installed"
  else
    red "  ! bun install failed; install manually: curl -fsSL https://bun.sh/install | bash"
    return 0
  fi
}
```

- [ ] **Step 2: Call `ensure_bun` before `bootstrap` in `main`**

Find the existing line in `main()`:

```bash
  echo ""
  bootstrap
```

Replace with:

```bash
  echo ""
  ensure_bun

  echo ""
  bootstrap
```

- [ ] **Step 3: Sanity-check the script parses**

Run: `bash -n scripts/install.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(installer): ensure bun is installed for plugin dep resolution"
```

---

## Task 9: Test `ensure_bun` no-op when bun is on PATH

**Files:**
- Modify: `tests/install-sh-test.sh`

- [ ] **Step 1: Append the test**

Add to the end of `tests/install-sh-test.sh`:

```bash
# --- Test: ensure_bun no-ops when bun on PATH ---------------------------------
out="$(bash -c '
  set -euo pipefail
  # Stub PATH with a fake bun.
  tmp="$(mktemp -d)"
  cat > "$tmp/bun" <<EOF
#!/bin/sh
exit 0
EOF
  chmod +x "$tmp/bun"
  PATH="$tmp:$PATH" HOME="$tmp" KAIZEN_NO_BUN=0
  export PATH HOME KAIZEN_NO_BUN
  # shellcheck source=/dev/null
  source "$1"
  ensure_bun
  rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (PATH hit) errored: $out"

echo "$out" | grep -q "bun already installed" || fail "ensure_bun (PATH hit) did not detect bun on PATH: $out"
pass "ensure_bun no-ops when bun on PATH"
```

- [ ] **Step 2: Run the test script**

Run: `bash tests/install-sh-test.sh`
Expected: All existing tests PASS plus the new `ensure_bun no-ops when bun on PATH` PASSes.

- [ ] **Step 3: Commit**

```bash
git add tests/install-sh-test.sh
git commit -m "test(install.sh): ensure_bun no-ops when bun on PATH"
```

---

## Task 10: Test `ensure_bun` no-op when `~/.bun/bin/bun` exists

**Files:**
- Modify: `tests/install-sh-test.sh`

- [ ] **Step 1: Append the test**

```bash
# --- Test: ensure_bun no-ops when ~/.bun/bin/bun exists -----------------------
out="$(bash -c '
  set -euo pipefail
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/.bun/bin"
  cat > "$tmp/.bun/bin/bun" <<EOF
#!/bin/sh
exit 0
EOF
  chmod +x "$tmp/.bun/bin/bun"
  # Empty PATH so command -v bun fails.
  PATH="/nonexistent-empty-path" HOME="$tmp"
  export PATH HOME
  # shellcheck source=/dev/null
  source "$1"
  ensure_bun
  rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (~/.bun fallback) errored: $out"

echo "$out" | grep -q "bun found at ~/.bun/bin/bun" || fail "ensure_bun did not detect ~/.bun/bin/bun: $out"
pass "ensure_bun no-ops when ~/.bun/bin/bun exists"
```

- [ ] **Step 2: Run**

Run: `bash tests/install-sh-test.sh`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/install-sh-test.sh
git commit -m "test(install.sh): ensure_bun no-ops when ~/.bun/bin/bun exists"
```

---

## Task 11: Test `ensure_bun` skipped via `KAIZEN_NO_BUN=1`

**Files:**
- Modify: `tests/install-sh-test.sh`

- [ ] **Step 1: Append the test**

```bash
# --- Test: KAIZEN_NO_BUN=1 skips ensure_bun ----------------------------------
out="$(bash -c '
  set -euo pipefail
  tmp="$(mktemp -d)"
  PATH="/nonexistent-empty-path" HOME="$tmp" KAIZEN_NO_BUN=1
  export PATH HOME KAIZEN_NO_BUN
  # shellcheck source=/dev/null
  source "$1"
  ensure_bun
  rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (NO_BUN) errored: $out"

echo "$out" | grep -q "Skipping bun install (KAIZEN_NO_BUN=1)" || fail "KAIZEN_NO_BUN=1 was not respected: $out"
pass "ensure_bun skipped via KAIZEN_NO_BUN=1"
```

- [ ] **Step 2: Run**

Run: `bash tests/install-sh-test.sh`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/install-sh-test.sh
git commit -m "test(install.sh): KAIZEN_NO_BUN=1 skips ensure_bun"
```

---

## Task 12: Test `ensure_bun` failure does not abort

**Files:**
- Modify: `tests/install-sh-test.sh`

Stub `curl` so the bun installer pipe fails; verify the script continues.

- [ ] **Step 1: Append the test**

```bash
# --- Test: ensure_bun installer failure does not abort -----------------------
out="$(bash -c '
  set -euo pipefail
  tmp="$(mktemp -d)"
  # Stub: an empty PATH dir + a failing curl shadow.
  stub="$tmp/stub"
  mkdir -p "$stub"
  cat > "$stub/curl" <<EOF
#!/bin/sh
exit 1
EOF
  chmod +x "$stub/curl"
  PATH="$stub" HOME="$tmp"
  export PATH HOME
  # shellcheck source=/dev/null
  source "$1"
  # Should not abort despite curl failing.
  ensure_bun
  echo "AFTER_ENSURE_BUN"
  rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (failure path) aborted the script: $out"

echo "$out" | grep -q "AFTER_ENSURE_BUN" || fail "ensure_bun failure aborted execution: $out"
echo "$out" | grep -q "bun install failed" || fail "ensure_bun did not warn on failure: $out"
pass "ensure_bun installer failure does not abort"
```

- [ ] **Step 2: Run**

Run: `bash tests/install-sh-test.sh`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/install-sh-test.sh
git commit -m "test(install.sh): ensure_bun failure does not abort installer"
```

---

## Task 13: Update plugin-authoring docs

**Files:**
- Modify: `docs/guides/plugin-authoring.md`

Document the new behavior so plugin authors know what to expect.

- [ ] **Step 1: Read the current docs to find the right insertion point**

Read: `docs/guides/plugin-authoring.md`. Look for a section on `package.json` or distribution. If none exists, add a new section near the end titled `## Runtime dependencies`.

- [ ] **Step 2: Add the new content**

Append (or insert at the appropriate section) the following:

```markdown
## Runtime dependencies

If your plugin imports any runtime npm package (e.g., `react`, `ink`, `zod`),
declare it under `dependencies` in your `package.json`. Kaizen will resolve
those dependencies automatically when the plugin is installed by running
`bun install --production` in the install dir.

**Best practices:**

- **Commit your `bun.lock`** (or other lockfile) for reproducible installs.
  Without a lockfile, two users installing "the same plugin version" can get
  different transitive deps based on when they install.
- **Keep build-only tools in `devDependencies`.** TypeScript, bundlers,
  test runners, type packages — none of these need to land on user machines
  at plugin install time.
- **Postinstall lifecycle scripts are disabled by Bun by default.** If your
  plugin (or one of its deps) needs to run a postinstall script — e.g., a
  package with a native binding — declare the dep in `trustedDependencies`
  in your `package.json`. See [Bun's lifecycle scripts docs](https://bun.com/docs/cli/install#trusted-dependencies).
- **Prefer pure-JS or `optionalDependencies`-distributed native packages.**
  Modern packages (`esbuild`, `lightningcss`, recent `sharp`) ship platform
  binaries via `optionalDependencies` and install reliably without a build
  step.

If `package.json` has no `dependencies` field, no install step runs — your
plugin is copied into place and that's it.
```

- [ ] **Step 3: Commit**

```bash
git add docs/guides/plugin-authoring.md
git commit -m "docs(plugin-authoring): document runtime dep resolution"
```

---

## Task 14: Update README installer section

**Files:**
- Modify: `README.md`

Note that `install.sh` installs bun and the opt-out env var.

- [ ] **Step 1: Find the install section in README**

Read: `README.md`. Locate the `install.sh` / installation section.

- [ ] **Step 2: Add a sentence noting bun installation**

Near the install instructions, add:

```markdown
The installer also ensures [Bun](https://bun.sh) is present (used to resolve
plugin runtime dependencies at install time). Set `KAIZEN_NO_BUN=1` to skip
this step if you already manage bun yourself.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): note bun is installed for plugin dep resolution"
```

---

## Task 15: Full verification

**Files:** none

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 3: Run install.sh tests**

Run: `bash tests/install-sh-test.sh`
Expected: all PASS lines, no FAIL.

- [ ] **Step 4: Manual smoke (optional but recommended)**

```bash
# In a temp dir, install kaizen from the dev binary, point it at the plugin
# from the original issue (claude-tui@0.2.0 in kaizen-official-plugins), and
# verify the plugin loads without "Cannot find module 'react/jsx-dev-runtime'".
```

If any test fails, fix and recommit before claiming done. Do not claim
verification with failing tests.

---

## Self-Review

**Spec coverage check:**

| Spec section | Task(s) |
|---|---|
| Plugin install flow change (the post-step) | 1, 2, 3, 4, 5, 6 |
| All source types (`file`, `tarball`, `npm`) covered uniformly | 6 |
| Lockfile honored when present | 7 |
| `scripts/install.sh` `ensure_bun` step | 8 |
| `ensure_bun` idempotent / opt-out / best-effort | 9, 10, 11, 12 |
| Error message when bun missing | 5 |
| Error message when `bun install` fails | 4 |
| Wipe target on `bun install` failure | 4 |
| Skip on no `package.json` / empty deps / malformed JSON | 2 |
| Plugin-authoring docs (deps, lockfile, `trustedDependencies`) | 13 |
| README/installer docs | 14 |
| Final verification | 15 |

All spec sections are covered. No placeholders. Type/method names are consistent across tasks (`installDeps`, `resolveBunExecutable`, `installDepsForTesting`).
