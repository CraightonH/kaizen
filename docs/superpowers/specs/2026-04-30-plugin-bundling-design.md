# Plugin bundling at marketplace install time

**Status:** Draft
**Date:** 2026-04-30
**Refs:** #66 (plugin runtime deps), the live bug behind this spec — `kaizen --harness official/claude-wrapper` fails to load `claude-tui@0.2.0` from the compiled binary with `Cannot find package 'ink'` despite `bun install --production` having succeeded.

## Problem

The shipped `kaizen` is a `bun build --compile` standalone binary. Its runtime cannot:

1. Resolve external `node_modules/` when dynamically importing an arbitrary external file path. Even though the runtime-dep work in #66 puts `ink` on disk under `~/.kaizen/marketplaces/.../claude-tui@0.2.0/node_modules/ink`, dynamic `import()` of `index.tsx` from the compiled binary fails with `Cannot find package 'ink'`.
2. Transform JSX or TypeScript for dynamically-imported files. Even a deps-free `.tsx` plugin entry fails to load with `Cannot find module 'react/jsx-dev-runtime'`.

Both behaviors were verified with minimal reproductions in `bun 1.3.13`. Running the same code through uncompiled `bun src/cli.ts` succeeds because the dev runtime walks `node_modules/` and applies transforms.

## Goals

- `kaizen --harness official/claude-wrapper` (and any other marketplace harness with plugins that have runtime deps and/or JSX entries) succeeds from the shipped compiled binary.
- Plugin authors do not need to ship build artifacts in their git repos.
- The mechanism is opaque to end users — nothing new to learn, nothing new to run.
- Install/update/uninstall continue to behave intuitively. No new commands.
- No kaizen-maintained allow-lists or known-package registries.

## Non-goals

- Bundling local-path plugins (`./path/to/plugin`). Those remain a dev-only escape hatch and continue to load the raw entry. If a local-path plugin has runtime deps or JSX, it must be run via uncompiled `bun src/cli.ts`. This will be documented.
- Migrating already-installed plugins on the user's disk. The user reinstalls (`kaizen install …`) when they upgrade kaizen. `installPlugin` is already idempotent (line 13: `rmSync(target, { recursive: true, force: true })`).
- A `kaizen plugin rebuild` or `--rebuild-all` command. Reinstall covers it.
- Hot reload, watch mode, or any dev-loop optimization for installed plugins. Marketplace installs are immutable until the next `install`.

## Design

### Behavior

When `installPlugin(marketplaceId, name, version, source)` runs against a marketplace source (`file`, `tarball`, or `npm`):

1. Materialize source into the install dir (existing).
2. If `package.json` declares non-empty `dependencies`, run `bun install --production` (existing, from #66).
3. **New:** unconditionally run `bun build` to produce `<install-dir>/dist/index.js`.
4. **New:** on bundle success, `rmSync(<install-dir>/node_modules)`. Source files (`index.tsx`, `package.json`, README, etc.) stay on disk for inspection and debugging.
5. On any step's failure: `rmSync(<install-dir>)` and throw with the underlying tool's stderr. Mirrors the existing failure handling for `bun install` (`plugin-installer.ts:143-150`).

Bundling runs unconditionally for marketplace installs — even for plugins with zero deps and no JSX — so the loader has a single load path. The bundle for a trivial plugin is essentially a copy of the source; the latency cost is negligible (`bun build` of a small file is a few milliseconds).

### Build command

```
bun build \
  --target=bun \
  --outfile=<install-dir>/dist/index.js \
  [--external <each entry of pkg.kaizen.bundleExternals>] \
  <install-dir>/<entry>
```

`<entry>` is resolved the same way the loader resolves it today: `pkg.module ?? pkg.main ?? "index.js"` (`plugin-manager.ts:76,116`).

`--target=bun` matches the runtime that loads the bundle. The output is plain ESM that any `bun` (compiled or not) can `import()` without further resolution.

### Externals manifest field

Plugin authors declare bundle-time externals in their `package.json` under a new top-level `kaizen` namespace:

```json
{
  "name": "claude-tui",
  "version": "0.2.0",
  "type": "module",
  "exports": { ".": "./index.tsx" },
  "keywords": ["kaizen-plugin"],
  "dependencies": { "ink": "^7.0.1", "ink-spinner": "^5.0.0", "react": "^19.2.0" },
  "kaizen": {
    "bundleExternals": ["react-devtools-core"]
  }
}
```

- Type: `string[]`. Missing or empty = no externals.
- Each entry is passed verbatim to `bun build --external <entry>`.
- Kaizen does not interpret, validate, or curate the list. Mechanism, not policy.
- Authors use this when a transitive dep is conditionally imported by something they depend on (the `react-devtools-core`-from-`ink` case). Their own `optionalDependencies` are NOT auto-externalized — if the author wants something externalized, they list it here. One rule, one place.

This establishes the `kaizen.*` namespace in plugin `package.json`. It is the first kaizen-specific package.json field; future plugin-side static metadata (anything kaizen needs to read before importing the entry) goes here too.

### Loader

`loadPluginFromMarketplaceInstall` in `plugin-manager.ts` changes its entry resolution:

```
prefer <install-dir>/dist/index.js if present
fall back to existing pkg.module ?? pkg.main ?? "index.js"
```

The fallback covers two cases:
- Uncompiled `bun src/cli.ts` runs against a freshly checked-out plugin during development or in tests. No bundle, but it works because uncompiled bun resolves `node_modules/` and transforms JSX natively.
- Pre-bundle-era installs on disk. They keep working as well as they did before (i.e., not at all on the compiled binary, fine on uncompiled bun). Reinstall fixes them.

### Failure modes

| Step | Failure | Behavior |
|------|---------|----------|
| `bun install --production` | non-zero exit | Existing: `rmSync(target)`, throw with stderr. |
| `bun build` | non-zero exit | New: `rmSync(target)`, throw with stderr. |
| `bun build` | unresolvable transitive optional dep | Throws as above. Author adds the package to `kaizen.bundleExternals` and republishes. |
| `bun` not on PATH or `~/.bun/bin/bun` | resolver returns `null` | Existing: throw with install instructions. Same path covers build. |
| Plugin has no `package.json` | install and build steps both skipped | Plugin loads via fallback resolution. (Out of scope to bundle. `installDeps` already no-ops in this case at `plugin-installer.ts:115`; the new build step honors the same precondition.) |

### Disk layout (post-install)

```
~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/
  package.json          (kept; loader reads it for fallback)
  README.md             (kept)
  index.tsx             (kept; source for inspection)
  ui/                   (kept)
  state/                (kept)
  dist/
    index.js            (the bundle; loader prefers this)
  # node_modules/       (removed after successful build)
  # bun.lockb           (removed with node_modules — bun's lockfile is also gone)
```

A separate `bun.lock` or `bun.lockb` produced by `bun install --production` is deleted with `node_modules/` since it has no consumer after the bundle exists.

### Plugin-author constraints

Documented in `docs/guides/plugin-authoring.md`:

- Avoid eval'd or string-concatenated dynamic imports of bare specifiers. `import("./foo.js")` and `import(varHoldingAbsolutePath)` are fine; `import("some-pkg-" + version)` won't bundle.
- If a dependency conditionally imports a package you do not want bundled (commonly devtools / debug helpers / platform-specific shims), list that package in `kaizen.bundleExternals`.

## Components touched

| File | Change |
|------|--------|
| `src/core/plugin-installer.ts` | After `installDeps`, add a bundling step. On success, remove `node_modules/`. On failure, mirror existing rollback. New helper to read `kaizen.bundleExternals`. |
| `src/core/plugin-installer.test.ts` | New cases (see Tests). |
| `src/core/plugin-manager.ts` | `loadPluginFromMarketplaceInstall`: prefer `dist/index.js` when present; fall back to current logic. |
| `docs/guides/plugin-authoring.md` | Document automatic bundling, the `kaizen.bundleExternals` field with the `react-devtools-core` example, dynamic-import constraint, and that local-path plugins are not bundled. |
| `README.md` | If the runtime-deps section mentions `bun install`, extend to mention bundling. Otherwise no change. |

## Tests

New cases in `src/core/plugin-installer.test.ts`:

- Bundle success: after install, `dist/index.js` exists, `node_modules/` is gone, source files remain.
- Bundle success with externals: `bun build` is invoked with `--external` flags matching `pkg.kaizen.bundleExternals`.
- Bundle success for a deps-free plugin: still produces `dist/index.js` (uniform path).
- Bundle failure rolls back: target dir is removed, error message includes bun's stderr.
- Missing `bun` executable: same error path as today.
- Malformed `pkg.kaizen` (e.g., not an object, or `bundleExternals` not an array): treated as no externals, no error. (Authors don't get a helpful diagnostic; that's acceptable for v1.)

Existing tests for `installDeps` (`bun install --production`) stay. New tests cover ordering: build runs after install.

A small loader test in `src/core/plugin-manager.test.ts` verifies that `dist/index.js` is preferred over the package.json entry when both exist, and that the fallback path still works when only the entry is present.

## Backwards-compat & rollout

- New marketplace installs after this lands get the bundled layout.
- Existing installs (no `dist/index.js`) load via the fallback path. They keep their pre-bundle behavior — broken in compiled binary, fine in uncompiled bun — until the user reinstalls.
- Release notes for the version: "If you have plugins from kaizen ≤ 0.3.2 and you're running the compiled binary, run `kaizen install <plugin>` to rebuild them with the new bundle layout."
- One known plugin in the wild today (`claude-tui`) is affected. Reinstalling it picks up the fix.

## Open questions

None. Decisions captured above:
- Marketplace-only scope.
- Strict failure on bundle errors; no kaizen-maintained externals list.
- Bundle alongside source; drop `node_modules/`.
- Top-level `kaizen.bundleExternals` in `package.json`.
- Bundle unconditionally for uniform load path.
- No migration tooling; reinstall handles it.
