# Plugin runtime dependency resolution

**Issue:** [#65 — Marketplace install does not resolve plugin runtime dependencies](https://github.com/CraightonH/kaizen/issues/65)
**Date:** 2026-04-30
**Status:** Approved (brainstorm complete, ready for implementation plan)

## Problem

When a plugin declares runtime `dependencies` in its `package.json`, the kaizen
marketplace install copies the plugin source into
`~/.kaizen/marketplaces/<m>/plugins/<name>@<version>/` but does not resolve
those deps. At plugin load time Bun fails to resolve the imports because there
is no `node_modules` at or above the install path.

Repro: `claude-tui@0.2.0` declares `ink`, `ink-spinner`, and `react` as runtime
deps. Loading the plugin fails with:

```
ResolveMessage: Cannot find module 'react/jsx-dev-runtime'
```

…which cascades into a misleading `Plugin(s) [claude-driver] consumes undefined
service 'claude-tui:channel'` error four steps removed from the real cause.

All existing official plugins ship only `devDependencies`, so the gap was
hidden until the first plugin with real runtime deps tried to load.

## Goal

When kaizen installs a plugin from any source (`file`, `tarball`, `npm`), if
the plugin declares runtime npm dependencies, kaizen resolves them via
`bun install --production` so the plugin's imports load successfully. The
installer (`scripts/install.sh`) ensures `bun` is present so this is reliable
end-to-end on a fresh machine.

## Non-goals

- Hoisting deps into a marketplace-shared `node_modules`.
- Pre-bundled plugin artifacts as a contract (plugins remain unbundled source).
- Lockfile policy enforcement (we honor whatever the author committed).
- A dep cache strategy beyond Bun's existing global cache.
- A `--skip-deps` escape hatch (YAGNI; revisit if airgapped install becomes a real ask).
- Dev-time plugin workflows (e.g., `kaizen plugin link`) — unaffected.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Approach | Per-plugin `bun install --production` at install time | Smallest change; matches Bun's per-plugin model; works uniformly across source types; no kaizen-owned resolution layer. |
| Package manager | `bun` only | kaizen already requires Bun; one assumed runtime end-to-end; no detection branching. |
| When to install | Only when `package.json` exists *and* has a non-empty `dependencies` object | Avoids no-op `bun install` calls on the existing zero-dep official plugins. |
| Failure mode | Hard fail; wipe target; surface bun's stderr | A plugin with unresolved deps is broken on arrival; failing at install gives an actionable error instead of a misleading load-time cascade. |
| Reinstall behavior | Wipe and re-resolve every install | Matches the existing "every install is fresh" contract; bun's global cache makes the second run cheap. |
| Lockfile handling | Honor whatever the author committed (`bun.lock`, `package-lock.json`, etc.) | Standard Bun behavior; documents "commit your lockfile" as best practice without enforcing it. |
| Bun availability — installer | `scripts/install.sh` runs bun's official installer if bun is missing | Single point of responsibility for bootstrap; idempotent. |
| Bun availability — runtime | At `kaizen install` time: prefer `bun` on PATH, fall back to `~/.bun/bin/bun`, else error with install instructions | Handles the common "first shell after install.sh, PATH not refreshed" case without making kaizen a package-manager installer. |

## Design

### Plugin install flow (`src/core/plugin-installer.ts`)

After the source-specific copy/extract step in `installPlugin` (the three
existing `case` branches), add a single post-step that runs uniformly for all
source types:

```
1. Source materialized at `target` (existing logic — unchanged).
2. If `target/package.json` exists, parses, and has a non-empty `dependencies` object:
   a. Resolve a bun executable: `bun` on PATH → fallback `~/.bun/bin/bun`.
      If neither resolves, throw with install instructions.
   b. Run `bun install --production` with cwd=target, capturing stdout/stderr.
   c. On non-zero exit: rmSync(target, { recursive: true, force: true }), throw
      with bun's stderr included.
3. Otherwise (no package.json, malformed JSON, or empty/absent `dependencies`),
   no-op.
```

A small internal helper resolves the bun executable. Not exported.

### `scripts/install.sh` change

Add an `ensure_bun` step that runs *before* `bootstrap` (the existing step that
adds the official marketplace and installs the default harness — which now may
pull plugins with runtime deps).

```
ensure_bun:
  if KAIZEN_NO_BUN=1: info "Skipping bun install (KAIZEN_NO_BUN=1)"; return 0
  if `bun` on PATH: info "bun already installed"; return 0
  if `~/.bun/bin/bun` exists: info "bun found at ~/.bun/bin/bun"; return 0
  info "Installing bun (required for plugin dependency resolution)..."
  if curl -fsSL https://bun.sh/install | bash:
    green "  ✓ bun installed"
  else:
    red "  ! bun install failed; install manually: curl -fsSL https://bun.sh/install | bash"
    return 0  # best-effort; do not abort
```

- Idempotent.
- Best-effort, matching the existing `bootstrap()` convention. A bun-install
  failure does not abort the kaizen installer.
- `KAIZEN_NO_BUN=1` opt-out (mirroring `KAIZEN_NO_BOOTSTRAP`).
- Bun's installer modifies the user's shell profile to add `~/.bun/bin` to
  PATH. kaizen does not touch shell profiles itself.

### Error messages

**Bun missing at `kaizen install` time:**
```
error: plugin '<name>@<version>' declares runtime dependencies but bun is not
on PATH or at ~/.bun/bin/bun.
Install bun: curl -fsSL https://bun.sh/install | bash
```

**`bun install` non-zero exit:**
```
error: bun install failed for plugin '<name>@<version>' at <target>
<bun's stderr, indented>
```
Target dir is removed so the half-installed plugin doesn't linger.

**Malformed `package.json`:** treat as "no deps" — debug log and skip. A
plugin with broken JSON is the author's bug; the plugin will fail at load
with a clearer error than kaizen could produce.

## Testing

### Unit tests (`src/core/plugin-installer.test.ts`, extending existing)

1. `file` source with `package.json` containing real `dependencies` → after install, `target/node_modules/<dep>` exists.
2. `file` source with `package.json` and empty/missing `dependencies` → no `node_modules` created, no bun call (assert via spy).
3. `file` source with no `package.json` → no `node_modules`, no bun call.
4. `bun install` failure path (use a deliberately bad dep name to avoid network) → `target` is removed, error includes bun's stderr.
5. Bun missing path → stub the resolver to return null; assert error message includes the install command.
6. `tarball` and `npm` source variants → one test each confirming the post-step runs uniformly.

Tests that actually exercise `bun install` against the registry use a tiny pure-JS dep to keep network/cache footprint minimal. Failure-path tests do not hit the network.

### Installer tests (`scripts/install.test.sh` or sourced helpers)

- `ensure_bun` no-ops when `bun` is on a stubbed PATH.
- `ensure_bun` no-ops when `~/.bun/bin/bun` exists (set `HOME` to a temp dir with a stub binary).
- `KAIZEN_NO_BUN=1` skips the step.
- Failure of the bun installer (simulate via stubbed `curl` that exits non-zero) does not abort the script.

## Documentation

To be landed alongside the code via `kaizen:update-docs`:

- Plugin-authoring page:
  - "Runtime deps in `package.json` are resolved automatically at install time via `bun install --production`."
  - "Commit your `bun.lock` (or other lockfile) for reproducible installs."
  - "Postinstall lifecycle scripts are disabled by Bun by default. If your plugin needs one (e.g., a native binding), declare the dep in `trustedDependencies` in your `package.json`."
  - Recommend keeping build-only tools in `devDependencies` so they're not pulled at install time.
- Installer/README docs:
  - `install.sh` installs bun as part of setup; `KAIZEN_NO_BUN=1` opts out.
  - `kaizen install` requires bun on PATH or at `~/.bun/bin/bun`.

## Risks & open questions

- **Postinstall trust gotcha.** Bun disables lifecycle scripts by default. Plugin authors hitting this will get a non-obvious failure mode. Mitigation: documented in the authoring page; bun's own error output usually points to `trustedDependencies`.
- **Network requirement at install time.** Plugins with deps require network access to the npm registry on first install (cached thereafter via Bun's global cache). Acceptable; airgapped install is out of scope.
- **Per-plugin disk duplication.** Each plugin gets its own `node_modules`. Acceptable for now; hoisting is a layered optimization if it becomes a real cost.
