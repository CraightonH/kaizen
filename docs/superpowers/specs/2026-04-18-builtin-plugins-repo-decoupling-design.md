# Design: Built-in Plugins Repo Decoupling

Date: 2026-04-18
Status: APPROVED
Related:
- `docs/architecture.md` (current built-in plugin layout)
- `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md` (Spec 1 — marketplace format this leverages)
- `docs/plugin-loading.md` (binary loading internals)

---

## Problem Statement

All built-in plugins (`core-events`, `core-lifecycle`, `core-ui-terminal`, etc.) live
in the main kaizen monorepo under `plugins/`. This has several downsides:

- Plugin authors and contributors must clone the entire kaizen repo to work on a plugin.
- Plugin versioning is coupled to the kaizen release cycle — a fix to
  `kaizen-plugin-timestamps` requires a kaizen release.
- The official built-in plugins are a poor reference for third-party authors because
  they depend on relative imports (`../../src/types/plugin.js`) that don't apply
  to installed packages.
- There is no "official marketplace" that third-party authors can reference as the
  canonical `kaizen-plugin` collection.

This design decouples the built-in plugins into a dedicated repository (or set of
repositories) and establishes an official kaizen marketplace — the first instance
of the marketplace format defined in Spec 1.

---

## Design Philosophy

- **Keep binary startup unchanged.** The compiled binary still embeds the default
  plugin stack. Users with no network access, no global npm install, and no
  `kaizen.json` get a working kaizen. The decoupling is source-level; the
  binary-level embedding is preserved.
- **The official marketplace is the reference implementation.** It validates the
  Spec 1 marketplace format in production and provides a concrete example for
  third-party marketplace authors.
- **Plugins evolve independently.** Once decoupled, a plugin can cut its own release
  without gating on the kaizen core release cycle.

---

## Scope

### In Scope

- Proposal for the new `kaizen-plugins` repository structure.
- Official marketplace catalog at `.kaizen/marketplace.json` in the new repo.
- Changes to the kaizen build process to pull plugin sources from the new repo.
- Migration guide for existing built-in plugins (relative imports → package imports).
- Documentation updates (`docs/architecture.md`, `docs/plugin-loading.md`).

### Out of Scope

- Changing the binary embedding strategy (plugins remain compiled in).
- Moving `core-events`, `core-lifecycle`, etc. to fully independent repos — a single
  `kaizen-plugins` monorepo is sufficient for v1.
- CI/CD for publishing plugins to npm (left to the new repo's own setup).
- Removing the `plugins/` directory from the main repo immediately — migration is
  phased.

---

## Target Repository: `kaizen-sh/kaizen-plugins`

A new git repository following the conventional marketplace layout:

```
kaizen-plugins/
├── .kaizen/
│   └── marketplace.json          ← official marketplace catalog
├── plugins/
│   ├── core-events/
│   │   ├── package.json          ← standalone: name "core-events", no relative imports
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
│   └── kaizen-plugin-timestamps/
├── harnesses/
│   ├── core-anthropic.json
│   ├── core-debug.json
│   └── core-shell.json
└── README.md
```

### Official Marketplace Catalog (`.kaizen/marketplace.json`)

```json
{
  "version": "1.0.0",
  "name": "kaizen-official",
  "description": "Official kaizen plugins and harnesses.",
  "url": "https://github.com/kaizen-sh/kaizen-plugins.git",
  "plugins": [
    {
      "name": "core-events",
      "description": "Default event vocabulary for kaizen sessions.",
      "categories": ["core"],
      "versions": [
        {
          "version": "2.0.0",
          "source": { "type": "npm", "name": "kaizen-core-events", "version": "2.0.0" }
        }
      ]
    },
    {
      "name": "kaizen-plugin-timestamps",
      "description": "Prepends ISO timestamps to user messages and agent responses.",
      "categories": ["tool"],
      "versions": [
        {
          "version": "0.1.0",
          "source": { "type": "file", "path": "plugins/kaizen-plugin-timestamps" }
        }
      ]
    }
  ],
  "harnesses": [
    {
      "name": "core-anthropic",
      "description": "Default Anthropic LLM harness.",
      "categories": ["harness"],
      "versions": [
        {
          "version": "1.0.0",
          "path": "harnesses/core-anthropic.json"
        }
      ]
    }
  ]
}
```

---

## Plugin Migration: Relative Imports → Package Imports

Current plugins use relative imports to access core types:

```typescript
// Current (in plugins/core-events/index.ts)
import type { KaizenPlugin } from "../../src/types/plugin.js";
```

After decoupling, plugins import from the published kaizen package:

```typescript
// After decoupling
import type { KaizenPlugin } from "kaizen/types";
```

This requires:
1. `kaizen/types` export path declared in kaizen's `package.json` exports map.
2. The `kaizen` package published to npm (or the new repo's plugins use `kaizen` as a
   peer dependency resolved from the binary's install location).

**Package.json changes for each plugin:**
```json
{
  "peerDependencies": {
    "kaizen": "*"
  }
}
```

---

## Build Process Changes

The kaizen binary currently embeds plugins via static imports in `src/cli.ts`:

```typescript
import coreEvents from "core-events";
import coreLifecycle from "core-lifecycle";
// ...
```

After decoupling, these imports still work — the plugins are still npm packages,
just sourced from a different repo. The build CI:

1. Checks out `kaizen-sh/kaizen-plugins` (pinned to a tag or SHA).
2. Runs `bun install` in each `plugins/<name>` directory (for any plugin-level deps).
3. Runs `bun build --compile` on the main kaizen repo — the static imports resolve
   from the checked-out plugin directories (via workspace or path overrides in
   `package.json`).

**Option A (recommended): npm workspace.**
The kaizen repo's `package.json` lists `kaizen-plugins` as a workspace or the plugins
as local workspace packages. `bun install` at the repo root resolves them.

**Option B: npm publish first.**
Plugins are published to npm before the kaizen binary is built. The build pulls from
the npm registry. Slower CI; stronger guarantee that the binary matches published npm.

**Recommendation: Option A for development builds; Option B for release builds.**

---

## Phased Migration

### Phase 1 — New repo + catalog (no breakage)

1. Create `kaizen-sh/kaizen-plugins` with the layout above.
2. Copy plugin source from `plugins/*` in the main repo.
3. Update relative imports to `kaizen/types`.
4. Add `package.json` peer dependencies.
5. Publish the `.kaizen/marketplace.json` catalog.
6. The main repo's `plugins/` directory remains; both copies exist temporarily.

### Phase 2 — Switch build to use new repo

1. Update kaizen build CI to pull from `kaizen-sh/kaizen-plugins`.
2. Verify binary still builds and all tests pass.
3. Delete `plugins/` from the main kaizen repo.
4. Update `docs/architecture.md` to reflect the new layout.

### Phase 3 — Official marketplace declared

1. `kaizen init --global` pre-adds the official marketplace:
   ```json
   { "id": "official", "url": "https://github.com/kaizen-sh/kaizen-plugins.git" }
   ```
2. `kaizen marketplace list` shows the official marketplace on fresh installs.
3. `kaizen install official/kaizen-plugin-timestamps` works.

---

## Documentation Updates

- `docs/architecture.md` — update "Directory structure" to reference `kaizen-plugins`
  repo; update plugin resolution order to mention official marketplace.
- `docs/plugin-loading.md` — update "Development workflow" to reference the new repo.
- `docs/plugin-api.md` — update import path examples to `kaizen/types`.
- New `docs/contributing-plugins.md` — guide for contributing to `kaizen-plugins`.

---

## Testing

| Area | Approach |
|------|----------|
| Plugin import paths | Each plugin in new repo builds without errors |
| Catalog validity | `kaizen marketplace validate .` passes on new repo |
| Binary build | End-to-end: binary compiles, `kaizen run` starts, built-ins load |
| Official marketplace | `kaizen marketplace add <url>` + `kaizen install official/timestamps` |
| Backward compat | Existing harnesses with bare `core-events` etc. still resolve |

---

## Future Work

- **Independent plugin releases.** Once decoupled, each plugin can have its own
  semantic version and release cadence. npm publish automation via GitHub Actions in
  the `kaizen-plugins` repo.
- **Plugin signing (Trust Model C).** When publisher signing lands, the official
  marketplace is the first candidate for signing — all `kaizen-sh` org plugins signed
  with the org cert.
- **Community plugins repo.** A separate `kaizen-sh/kaizen-community-plugins`
  marketplace following the same format, for community-contributed plugins that meet
  a quality bar but are not official.
