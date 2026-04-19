# Design: Extract Plugins from Kaizen Binary

Date: 2026-04-18
Status: DRAFT
Related:
- `docs/architecture.md` (current built-in plugin layout)
- `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md` (Spec 1 — marketplace format + install layout + runtime loader)
- `docs/superpowers/specs/2026-04-18-unified-plugin-config-design.md` (Spec 2 — config schema, secrets, `core-secrets` plugin)
- `docs/superpowers/specs/2026-04-18-plugin-scaffolder-standards-design.md` (Spec 3 — scaffold templates + standards)
- `docs/plugin-loading.md` (binary loading internals)

---

## Problem Statement

Today, all first-party plugins (`core-events`, `core-lifecycle`, `core-ui-terminal`,
`core-executor-anthropic`, `core-executor-openai`, `core-executor-debug`,
`core-executor-shell`, `core-cli`, `core-plugin-manager`, `kaizen-plugin-timestamps`)
live in the main kaizen monorepo under `plugins/` and are compiled into the binary
via static imports in `src/cli.ts`. This has several downsides:

- Plugin authors and contributors must clone the entire kaizen repo to work on a plugin.
- Plugin versioning is coupled to the kaizen release cycle — a fix to
  `timestamps` requires a full kaizen release.
- First-party plugins are a poor reference for third-party authors: they use
  relative imports (`../../src/types/plugin.js`) that don't apply to installed
  packages, and they never exercise the marketplace install/load path.
- There is no "official marketplace" that third-party authors can reference as
  the canonical collection of kaizen plugins.
- Bundling plugins in the binary creates two classes of plugins (embedded vs.
  marketplace-installed) with different resolution rules — a maintenance tax.

Spec 1 introduced the marketplace format, install layout, and dynamic plugin
loader (`src/core/plugin-loader.ts`, `import(pluginInstallDir(id, name, ver))`).
With that machinery in place, the binary no longer needs to embed plugins. This
spec finishes the decoupling: extracts first-party plugins into a dedicated
`kaizen-sh/kaizen-plugins` repository, publishes the official marketplace, and
removes all plugin source from the kaizen-code repo. After this work, the binary
ships with zero plugins; every plugin is installed from a marketplace.

---

## Design Philosophy

- **No embedded plugins.** The binary ships no plugin code. Every plugin reaches
  a user only through a marketplace install. This collapses the "embedded vs.
  installed" duality and makes the marketplace path the only path.
- **Installer owns first-run experience.** Packaging installers (brew, tarball,
  etc.) are responsible for a working first-run kaizen: seeding the official
  marketplace and pre-installing a default plugin set + harness. Out of scope
  for this spec and for `kaizen-code`.
- **The official marketplace is the reference implementation.** It validates
  the Spec 1 marketplace format in production and provides a concrete example
  for third-party marketplace authors.
- **Plugins evolve independently.** Once decoupled, a plugin can cut its own
  release without gating on the kaizen core release cycle. `minKaizenVersion`
  on catalog entries keeps compatibility explicit.
- **Spec 4 is a switch-flip, not a reimplementation.** The dynamic loader and
  install machinery are owned by Spec 1's plan. This spec does two things only:
  (a) extract the source to a new repo, (b) delete the embedding path from
  `kaizen-code`.

---

## Scope

### In Scope

- New `kaizen-sh/kaizen-plugins` repository and its initial layout.
- Official marketplace catalog (`.kaizen/marketplace.json`) at the root of that
  repo, following the Spec 1 `entries[]` format.
- Migration of every plugin currently in `plugins/*` — including `core-secrets`
  (new in Spec 2) — to the new repo with package imports (`kaizen/types`) in
  place of relative imports.
- Migration of harness files in `harnesses/*` to the new repo.
- Removing the `plugins/` and `harnesses/` directories and all plugin-related
  static imports from the `kaizen-code` repo.
- Dev-time workflow: how contributors run kaizen from source against a local
  marketplace (no special-case embedding for dev).
- Test-fixture strategy: tiny inline fixture plugins for kaizen-code's own
  unit tests; integration/e2e tests point at a real `kaizen-plugins` checkout.
- Documentation updates (`docs/architecture.md`, `docs/plugin-loading.md`,
  `docs/plugin-api.md`).

### Out of Scope

- The dynamic plugin loader itself (`src/core/plugin-loader.ts`,
  `loadPluginFromInstallDir`) — owned by Spec 1's plan.
- The marketplace install path and `pluginInstallDir`/`harnessInstallDir`
  helpers — owned by Spec 1.
- Installer / packaging work (pre-seeding the official marketplace, installing
  a default plugin set, shipping a default harness on first run) — owned by
  the installer, not kaizen-code.
- Reshaping executor plugins to the Spec 2 `config.schema` + `config.secrets`
  pattern — owned by Spec 2's plan Phase 9. This spec copies executors as-is;
  Spec 2 reshapes them afterwards in the new repo.
- npm publishing of plugins — catalog entries use `file` sources initially.
  Switching to `npm` sources is future work, driven by the new repo's own CI.
- Splitting first-party plugins into independent repos — a single
  `kaizen-plugins` monorepo is sufficient for v1.
- Plugin signing (Trust Model C) — future work.

---

## Prerequisites

- **Spec 1 (marketplace) must be fully shipped.** Specifically, the spec-1 plan
  must have delivered: marketplace add/update/install commands, the install
  layout under `~/.kaizen/marketplaces/<id>/`, the `core/kaizen-config.ts`
  path-owning module, the dynamic plugin loader (`loadPluginFromInstallDir`),
  and the `src/cli.ts` wiring that loads plugins from installed marketplaces.
  Without the loader in place, removing static imports breaks the binary.
- **Spec 3 (scaffolder + standards) is recommended.** Migrated plugins should
  pass `kaizen plugin validate`. If Spec 3 is not yet merged when Spec 4 lands,
  any validator gaps are noted as follow-ups.
- **Spec 2 (unified config + core-secrets) is optional.** If Spec 2 is merged
  first, `core-secrets` is included in the initial migration list. If Spec 4
  ships first, `core-secrets` is added to the repo later by Spec 2's plan.

---

## Target Repository: `kaizen-sh/kaizen-plugins`

A new git repository with the following layout:

```
kaizen-plugins/
├── .kaizen/
│   └── marketplace.json           ← official marketplace catalog (Spec 1 format)
├── plugins/
│   ├── core-events/
│   │   ├── package.json
│   │   ├── index.ts
│   │   ├── index.test.ts
│   │   └── README.md
│   ├── core-lifecycle/
│   ├── core-ui-terminal/
│   ├── core-executor-anthropic/
│   ├── core-executor-openai/
│   ├── core-executor-debug/
│   ├── core-executor-shell/
│   ├── core-cli/
│   ├── core-plugin-manager/
│   ├── core-secrets/              ← new (Spec 2); added when Spec 2 lands
│   └── timestamps/                ← renamed from kaizen-plugin-timestamps
├── harnesses/
│   ├── core-anthropic.json
│   ├── core-debug.json
│   └── core-shell.json
├── package.json                   ← workspace root
└── README.md
```

### Official Marketplace Catalog (`.kaizen/marketplace.json`)

Spec 1 catalog format: flat `entries[]` with `kind` tags; names unique across
kinds; every version declares `minKaizenVersion` as a bare semver enforced
install-time.

```json
{
  "version": "1.0.0",
  "name": "kaizen-official",
  "description": "Official kaizen plugins and harnesses.",
  "url": "https://github.com/kaizen-sh/kaizen-plugins.git",
  "entries": [
    {
      "kind": "plugin",
      "name": "core-events",
      "description": "Default event vocabulary for kaizen sessions.",
      "categories": ["core"],
      "versions": [
        {
          "version": "0.1.0",
          "source": { "type": "file", "path": "plugins/core-events" },
          "minKaizenVersion": "0.5.0"
        }
      ]
    },
    {
      "kind": "plugin",
      "name": "timestamps",
      "description": "Prepends ISO timestamps to user messages and agent responses.",
      "categories": ["tool"],
      "versions": [
        {
          "version": "0.1.0",
          "source": { "type": "file", "path": "plugins/timestamps" },
          "minKaizenVersion": "0.5.0"
        }
      ]
    },
    {
      "kind": "harness",
      "name": "core-anthropic",
      "description": "Default Anthropic LLM harness.",
      "categories": ["harness"],
      "versions": [
        {
          "version": "1.0.0",
          "path": "harnesses/core-anthropic.json",
          "minKaizenVersion": "0.5.0"
        }
      ]
    }
  ]
}
```

Notes:
- Names are unique across kinds — a plugin and a harness cannot share a name.
- Catalog entry for the legacy `kaizen-plugin-timestamps` package is named
  `timestamps`. Spec 1's resolution-time deprecation shim auto-rewrites bare
  `kaizen-plugin-<name>` inputs to `<name>` against the `official` marketplace
  for one release, then hard-errors.
- Initial catalog uses `file` sources; entries live in the same repo. Switching
  to `npm` sources is future work.

---

## Harness Files: Canonical Refs

Spec 1 requires on-disk harness files to reference plugins with fully-qualified
canonical refs (`<marketplace-id>/<name>@<version>`). Since every plugin is now
marketplace-installed, harnesses in the official repo reference them
accordingly:

```json
{
  "plugins": [
    "official/core-events@0.1.0",
    "official/core-lifecycle@0.1.0",
    "official/core-ui-terminal@0.1.0",
    "official/core-executor-anthropic@0.1.0",
    "official/core-cli@0.1.0",
    "official/core-plugin-manager@0.1.0"
  ]
}
```

No bare-name refs in shipped harness files. Bare names are accepted only at CLI
input; canonicalized before any file write.

---

## Plugin Migration: Relative Imports → Package Imports

Current plugins use relative imports to access core types:

```typescript
// Current (in plugins/core-events/index.ts)
import type { KaizenPlugin } from "../../src/types/plugin.js";
```

After migration, plugins import from the `kaizen` package:

```typescript
// After migration
import type { KaizenPlugin } from "kaizen/types";
```

This requires `kaizen/types` to be declared in the kaizen package's `exports`
map. Adding that export is part of this spec.

Each plugin's `package.json` declares `kaizen` as a peer dependency:

```json
{
  "name": "<plugin-name>",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "peerDependencies": { "kaizen": "*" }
}
```

Cross-plugin imports (e.g. `core-lifecycle` importing `EVENTS` from
`core-events`) become package imports (`import { EVENTS } from "core-events"`)
and are listed as peer dependencies. At runtime these resolve through the
loader's absolute-path import of the dependent plugin — not via `node_modules`.

---

## Removing the Embedding Path in kaizen-code

The binary currently embeds plugins via static imports in `src/cli.ts`:

```typescript
import coreEvents from "core-events";
import coreLifecycle from "core-lifecycle";
// …
const plugins = [coreEvents, coreLifecycle, /* … */];
```

After Spec 1's plan ships the dynamic loader, these static imports are
redundant. This spec removes them and all fallback paths that referenced
embedded plugins:

- Delete every `import <plugin> from "<plugin>"` line in `src/cli.ts`.
- Delete any `const builtinPlugins = [...]` or equivalent hard-coded list.
- Delete `plugins/` and `harnesses/` from the `kaizen-code` repo.
- Remove `plugins/*` workspace entries from the root `package.json`.
- Add the `kaizen/types` export path to `package.json` `exports`.
- Remove any code path in the plugin resolver that distinguished "embedded"
  from "installed" plugins — there is only one path now.

After this change, a fresh kaizen binary run against an empty `~/.kaizen/`
produces a plain error ("no marketplaces configured" or "no harness
installed") rather than silently booting a default plugin set. Providing a
working first-run experience is the installer's job.

---

## Dev-Time Workflow

Running `kaizen-code` from source still needs plugins to load. With no
embedding, dev mode goes through the same marketplace path as production.

### Recommended Contributor Setup

1. Clone `kaizen-sh/kaizen-plugins` as a sibling directory to `kaizen-code`.
2. Point a local marketplace at the checkout:
   ```
   kaizen marketplace add dev file://../kaizen-plugins
   ```
   Or seed `~/.kaizen/kaizen.json` with the entry manually.
3. Install the plugins/harness you need:
   ```
   kaizen install dev/core-events
   kaizen install dev/core-lifecycle
   kaizen install dev/core-ui-terminal
   kaizen install dev/core-executor-debug
   kaizen harness install dev/core-debug
   ```
4. Run kaizen normally — plugins load from
   `~/.kaizen/marketplaces/dev/plugins/<name>@<version>/`.

A helper script in `kaizen-code` (`scripts/dev-setup.sh`) automates steps 1–3
for contributors. It is convenience, not infrastructure: the mechanism is the
standard marketplace path, not a dev-only code path in the binary.

### No Dev-Only Code Paths

`kaizen-code` does not special-case source-tree development. There is no
`NODE_ENV=development` branch that re-enables embedding, no `--dev-plugins`
flag that bypasses the loader, no workspace-resolution shortcut. Dev mode
exercises the same install + load path as production, which is the point.

---

## Test Fixtures

With plugins extracted, kaizen-code's tests can no longer import plugin
implementations directly. Two test tiers:

### Unit Tests (inline fixtures)

Under `test/fixtures/plugins/*`, the kaizen-code repo ships tiny
throwaway plugins used only by its own unit tests — minimal implementations
that exercise harness loading, session wiring, event dispatch, etc. These
fixtures are:

- Loaded through the standard marketplace path via a test-only fixture
  marketplace.
- Never published; not part of any user-facing marketplace.
- Intentionally minimal — they do not claim to represent real-world plugin
  behavior.

### Integration / E2E Tests

Integration and end-to-end tests in `kaizen-code` check out the real
`kaizen-sh/kaizen-plugins` repository (pinned to a tag or SHA) and run
kaizen against it through the standard marketplace path. This is the tier
that validates real-world plugin behavior.

CI runs both tiers. Pinning strategy (tag vs. SHA vs. HEAD) is an
implementation detail for the plan.

---

## Component Architecture

| Component | Owner | Role |
|---|---|---|
| `src/cli.ts` static plugin imports | kaizen-code (removed here) | Deleted in this spec |
| `src/core/plugin-loader.ts` | Spec 1 plan (already shipped) | Dynamic import from install dir |
| `src/core/kaizen-config.ts` | Spec 1 (already shipped) | Owns `~/.kaizen/` path helpers |
| `package.json#exports["./types"]` | kaizen-code (added here) | Public types entry for plugins |
| `plugins/` directory | kaizen-code (removed here) | Deleted |
| `harnesses/` directory | kaizen-code (removed here) | Deleted |
| `kaizen-plugins` repository | new | First-party plugin source + catalog |
| `.kaizen/marketplace.json` (in new repo) | new | Official catalog |
| Pre-seeding official marketplace | installer (out of scope) | — |
| First-run plugin/harness install | installer (out of scope) | — |

---

## Error Handling

- **Binary runs with empty `~/.kaizen/`:** kaizen exits with a clear message
  pointing at `kaizen marketplace add` and `kaizen install`. No silent
  fallback to any default plugin set.
- **Harness references a plugin not installed:** Spec 1's loader surfaces
  "plugin `<ref>` not installed — run `kaizen install <ref>`". Unchanged.
- **`minKaizenVersion` check fails at install:** Spec 1's install path raises
  `KaizenVersionTooOldError`. Unchanged.
- **Contributor runs kaizen from source with no dev marketplace configured:**
  Same empty-`~/.kaizen/` error. The contributor guide surfaces
  `scripts/dev-setup.sh`.

---

## Testing

| Area | Approach |
|---|---|
| Plugin builds in new repo | Each plugin's `bun test` passes after import migration |
| Cross-plugin imports | `core-lifecycle` imports `EVENTS` from `core-events` via package import; resolves at runtime through the loader |
| Catalog validity | `kaizen marketplace validate .` passes on `kaizen-plugins` repo |
| Binary build | `bun build --compile` succeeds with no `plugins/` directory |
| Empty first-run | Fresh binary against empty `~/.kaizen/` produces the documented error |
| Dev-setup script | From a clean `kaizen-code` + sibling `kaizen-plugins` checkout, `scripts/dev-setup.sh` + `kaizen run` boots |
| Unit tests with fixtures | Inline fixture plugins exercise harness/session/loader wiring |
| Integration tests | Real `kaizen-plugins` checkout drives e2e scenarios |
| Canonical refs in harnesses | Shipped harness files use `official/<name>@<version>` — no bare names |

---

## Migration

### Phase 1 — Set up `kaizen-sh/kaizen-plugins`

Create the repo with the layout above. Workspace `package.json` at the root.
Initial empty `.kaizen/marketplace.json`. README stub.

### Phase 2 — Migrate plugins

Copy each plugin from `kaizen-code/plugins/*` to the new repo's
`plugins/*`. Fix imports (`kaizen/types`, package imports across plugins).
Add `package.json` peer deps. Ensure tests pass. Rename
`kaizen-plugin-timestamps` → `timestamps`.

Plugins to migrate:
- `core-events`
- `core-lifecycle`
- `core-ui-terminal`
- `core-cli`
- `core-plugin-manager`
- `core-executor-anthropic`
- `core-executor-openai`
- `core-executor-debug`
- `core-executor-shell`
- `timestamps` (was `kaizen-plugin-timestamps`)
- `core-secrets` — only if Spec 2 is merged before this phase; otherwise
  added by Spec 2's plan later.

Executors are copied as-is; Spec 2's plan Phase 9 reshapes them to the
`config.schema` + `config.secrets` pattern later.

### Phase 3 — Migrate harnesses

Copy harness JSON files. Rewrite plugin refs to canonical
`official/<name>@<version>`.

### Phase 4 — Write official catalog

Populate `.kaizen/marketplace.json` with `entries[]` for every migrated
plugin + harness. Every version declares `minKaizenVersion`. Run
`kaizen marketplace validate .`.

### Phase 5 — Add `kaizen/types` export in kaizen-code

Declare the `./types` export in the root `package.json`. Verify a sample
plugin in the new repo compiles against it.

### Phase 6 — Remove embedding from kaizen-code

- Delete every static plugin import in `src/cli.ts`.
- Delete `plugins/` and `harnesses/` directories.
- Remove `plugins/*` workspace entries from root `package.json`.
- Remove any "embedded vs. installed" branch in the resolver.
- Add inline test fixtures under `test/fixtures/plugins/*`.
- Wire integration tests to a sibling `kaizen-plugins` checkout.
- Add `scripts/dev-setup.sh` for contributors.

### Phase 7 — Documentation

- `docs/architecture.md` — remove "Directory structure: plugins/", add the
  new repo + marketplace flow.
- `docs/plugin-loading.md` — document marketplace-only loading; no
  embedding.
- `docs/plugin-api.md` — import examples use `kaizen/types`.
- New `docs/contributing-plugins.md` — guide for contributing to
  `kaizen-sh/kaizen-plugins`.
- Update contributor README in kaizen-code with the dev-setup flow.

---

## Future Work

- **Independent plugin releases.** Per-plugin semver, npm publish automation
  in the `kaizen-plugins` repo, catalog entries shift from `file` to `npm`
  sources.
- **Plugin signing (Trust Model C).** Official plugins signed with the
  `kaizen-sh` org cert.
- **Community plugins repo.** `kaizen-sh/kaizen-community-plugins`
  marketplace with a quality bar but not "official".
- **Retire the `kaizen-plugin-*` deprecation shim.** One release after Spec 1
  ships it, remove the shim and require marketplace-qualified refs.
