# Extract Plugins from Kaizen Binary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every first-party plugin from the `kaizen-code` binary into
a dedicated `kaizen-sh/kaizen-plugins` repository. Publish the official
marketplace catalog. Remove the embedding path from `kaizen-code` entirely
— after this plan, the binary ships with zero plugins and every plugin
reaches a user through the Spec 1 marketplace install path.

**Spec:** `docs/superpowers/specs/2026-04-18-builtin-plugins-repo-decoupling-design.md`

**Prerequisites:**
- **Spec 1 (marketplace) fully shipped.** Specifically its plan tasks that
  deliver marketplace add/update/install CLI, the install layout under
  `~/.kaizen/marketplaces/<id>/`, `src/core/kaizen-config.ts`, and the
  dynamic plugin loader wired in `src/cli.ts`. Without the loader live,
  removing static imports breaks the binary.
- **Spec 3 (scaffolder + standards) recommended.** Migrated plugins should
  pass `kaizen plugin validate`.
- **Spec 2 (unified config + core-secrets) optional.** If Spec 2 is merged
  first, `core-secrets` joins the initial migration. Otherwise Spec 2's
  plan adds it to `kaizen-plugins` later.

---

## Phase 1 — Set Up `kaizen-sh/kaizen-plugins`

### Task 1: Create the repo

- [ ] **Step 1: Create the repository**

Create `kaizen-sh/kaizen-plugins` under the project's GitHub org. MIT license.

- [ ] **Step 2: Initial directory layout**

```
kaizen-plugins/
├── .kaizen/
│   └── marketplace.json      # empty entries[] initially
├── plugins/
├── harnesses/
├── package.json              # workspace root
└── README.md
```

Workspace root `package.json`:
```json
{
  "name": "kaizen-plugins-workspace",
  "private": true,
  "workspaces": ["plugins/*"]
}
```

Empty initial catalog:
```json
{
  "version": "1.0.0",
  "name": "kaizen-official",
  "description": "Official kaizen plugins and harnesses.",
  "url": "https://github.com/kaizen-sh/kaizen-plugins.git",
  "entries": []
}
```

- [ ] **Step 3: README**

Cover: what the repo is, how to add the official marketplace
(`kaizen marketplace add official https://github.com/kaizen-sh/kaizen-plugins.git`),
how to contribute a plugin/harness, link to `docs/plugin-standards.md` in
`kaizen-code`.

---

## Phase 2 — Add `kaizen/types` Export in kaizen-code

### Task 2: Publish public plugin types from the kaizen package

- [ ] **Step 1: Declare `./types` in `package.json#exports`**

In `kaizen-code/package.json`:
```json
{
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/types/plugin.ts"
  }
}
```

- [ ] **Step 2: Verify the export surface**

`src/types/plugin.ts` should re-export everything plugins need
(`KaizenPlugin`, context types, event types, capability types). If
anything plugin-facing currently lives under other internal paths, move or
re-export.

- [ ] **Step 3: Smoke-test from outside**

In a scratch directory, `bun add ../kaizen-code` and
`import type { KaizenPlugin } from "kaizen/types"`. Confirm resolution.

---

## Phase 3 — Migrate Plugins

### Task 3: Copy and update each plugin

Plugins to migrate (copy in this order to minimize cross-plugin breakage):
1. `core-events`
2. `core-lifecycle`
3. `core-ui-terminal`
4. `core-cli`
5. `core-plugin-manager`
6. `core-executor-debug`
7. `core-executor-shell`
8. `core-executor-anthropic`
9. `core-executor-openai`
10. `timestamps` (renamed from `kaizen-plugin-timestamps`)
11. `core-secrets` — only if Spec 2 is merged before this task; otherwise
    skip and let Spec 2's plan add it.

For each plugin:

- [ ] **Step A: Copy source to `plugins/<name>/`**

Copy `kaizen-code/plugins/<name>/` → `kaizen-plugins/plugins/<name>/`.
Rename `kaizen-plugin-timestamps/` → `timestamps/`.

- [ ] **Step B: Fix imports**

Replace:
```typescript
import type { KaizenPlugin } from "../../src/types/plugin.js";
import { EVENTS } from "../core-events/index.js";
```
with:
```typescript
import type { KaizenPlugin } from "kaizen/types";
import { EVENTS } from "core-events";
```

- [ ] **Step C: Update `package.json`**

```json
{
  "name": "<plugin-name>",
  "version": "0.1.0",
  "description": "<description>",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "keywords": ["kaizen-plugin"],
  "peerDependencies": {
    "kaizen": "*"
  }
}
```

List cross-plugin peer deps (e.g. `core-lifecycle` peers
`"core-events": "*"`).

Executors (`core-executor-anthropic`, `core-executor-openai`, etc.) are
copied **as-is**. Spec 2's plan Phase 9 reshapes them to `config.schema`
+ `config.secrets` later.

- [ ] **Step D: Tests**

Ensure `index.test.ts` exists. Use `makeCtx()` from the Spec 3 scaffold
template. At minimum: metadata + setup smoke test.

- [ ] **Step E: README**

Plugin name, description, config table (if any), permissions,
capabilities (provides/consumes).

- [ ] **Step F: Validate**

```bash
kaizen plugin validate plugins/<name>
```
Fix errors before moving to the next plugin.

---

## Phase 4 — Migrate Harnesses

### Task 4: Copy and rewrite harness files

- [ ] **Step 1: Copy harness files to `harnesses/*.json`**

Flatten `harnesses/<name>/kaizen.json` → `harnesses/<name>.json` if the
source uses the directory form.

- [ ] **Step 2: Rewrite plugin refs to canonical form**

In each harness file, every plugin ref becomes
`official/<name>@<version>`:
```json
{
  "plugins": [
    "official/core-events@0.1.0",
    "official/core-lifecycle@0.1.0",
    "official/core-ui-terminal@0.1.0",
    "official/core-executor-anthropic@0.1.0"
  ]
}
```

No bare names in shipped harnesses.

- [ ] **Step 3: Validate**

Harness JSON schema check; refs resolve against the catalog written in
Phase 5.

---

## Phase 5 — Write Official Catalog

### Task 5: Populate `.kaizen/marketplace.json`

- [ ] **Step 1: Plugin entries**

For each migrated plugin:
```json
{
  "kind": "plugin",
  "name": "core-events",
  "description": "Default event vocabulary for kaizen sessions.",
  "categories": ["core"],
  "versions": [
    {
      "version": "0.1.0",
      "source": { "type": "file", "path": "plugins/core-events" },
      "minKaizenVersion": "<current-kaizen-version>"
    }
  ]
}
```

Pick `<current-kaizen-version>` as the kaizen version that first ships
with the loader live (i.e. the release that merges Spec 1's plan). Bare
semver; no range operators.

- [ ] **Step 2: Harness entries**

```json
{
  "kind": "harness",
  "name": "core-anthropic",
  "description": "Default Anthropic LLM harness.",
  "categories": ["harness"],
  "versions": [
    {
      "version": "1.0.0",
      "path": "harnesses/core-anthropic.json",
      "minKaizenVersion": "<current-kaizen-version>"
    }
  ]
}
```

- [ ] **Step 3: Validate**

```bash
kaizen marketplace validate .
```

Check: names unique across kinds, every version has `minKaizenVersion`,
harness paths resolve.

---

## Phase 6 — Remove Embedding from kaizen-code

**Prerequisite check:** Spec 1's plan tasks delivering the dynamic loader
(`src/core/plugin-loader.ts`) and the `src/cli.ts` wiring must be merged.
Confirm by inspecting `src/cli.ts` — it should already be loading plugins
from installed marketplaces; static imports should be redundant.

### Task 6: Delete static plugin imports

- [ ] **Step 1: Remove `import <plugin> from "<plugin>"` lines in `src/cli.ts`**

Delete every static plugin import. Delete any hard-coded
`builtinPlugins = [...]` array or equivalent.

- [ ] **Step 2: Remove the embedded-vs-installed branch in the resolver**

Any code that distinguished "embedded" (workspace/static) from
"installed" (marketplace) plugins collapses into the installed-only
path.

- [ ] **Step 3: Delete `plugins/` directory**

```bash
git rm -r plugins/
```

- [ ] **Step 4: Delete `harnesses/` directory**

```bash
git rm -r harnesses/
```

- [ ] **Step 5: Remove `plugins/*` workspace entries from root `package.json`**

- [ ] **Step 6: Build and smoke test**

```bash
bun install
bun build --compile
```

Against an empty `~/.kaizen/`, the binary must produce the documented
first-run error (no marketplaces / no harness), not a silent boot.

### Task 7: Inline test fixtures

- [ ] **Step 1: Create `test/fixtures/plugins/*`**

Minimal plugins exercising: event emit/consume, capability provides/consumes,
setup/teardown, session wiring. Each fixture is a single file with
metadata + trivial logic.

- [ ] **Step 2: Test-only fixture marketplace**

Unit tests set up a temporary `~/.kaizen/` (or a test-scoped config dir),
add a file-URL marketplace pointing at `test/fixtures/plugins`, and
install the fixtures through the standard path.

- [ ] **Step 3: Rewrite existing unit tests that imported plugin modules
  directly**

Any test that did `import coreEvents from "core-events"` or
`import { X } from "../../plugins/core-events"` switches to the fixture
approach.

### Task 8: Integration tests against real `kaizen-plugins`

- [ ] **Step 1: Pinning strategy**

CI checks out `kaizen-sh/kaizen-plugins` at a pinned SHA (tracked in a
file under `test/integration/pinned-plugins-sha`). Bump the SHA
deliberately.

- [ ] **Step 2: Integration harness setup**

Before running integration tests, CI seeds a test `~/.kaizen/` with a
`file://` marketplace at the checkout and installs the needed plugins +
harness.

- [ ] **Step 3: E2E smoke test**

Boot kaizen with the full official harness; run a short session; assert
no errors, expected events fire.

### Task 9: Dev-setup helper script

- [ ] **Step 1: `scripts/dev-setup.sh`**

Idempotent script that:
1. Checks for a sibling `../kaizen-plugins` checkout; prints clone
   instructions if missing.
2. Adds a `dev` marketplace pointing at the checkout (if absent).
3. Installs the default set of plugins + a harness.

The script uses only the public `kaizen marketplace` and `kaizen install`
commands. No dev-only code path in the binary.

- [ ] **Step 2: Document in CONTRIBUTING.md**

Short section: "Running kaizen from source." Cover clone, dev-setup,
`kaizen run`.

---

## Phase 7 — Documentation

### Task 10: Update kaizen-code docs

- [ ] **Step 1: `docs/architecture.md`**

Remove "Directory structure: plugins/" section. Add: "Plugins live in
`kaizen-sh/kaizen-plugins` and are installed via the marketplace." Update
plugin resolution order — there is now one path: marketplace install.

- [ ] **Step 2: `docs/plugin-loading.md`**

Rewrite around marketplace-only loading. Remove any "embedded plugins"
sections. Describe the loader flow: harness → ref → install-dir →
dynamic import.

- [ ] **Step 3: `docs/plugin-api.md`**

Import examples use `kaizen/types`. Remove references to relative
imports into `../../src/`.

- [ ] **Step 4: New `docs/contributing-plugins.md`**

Guide for contributing to `kaizen-sh/kaizen-plugins`:
- Scaffold a plugin (link Spec 3).
- Add the plugin to `.kaizen/marketplace.json`.
- Open a PR.
- Standards link.
- Adding a harness (same shape).

- [ ] **Step 5: Update `README.md` in kaizen-code**

Note: binary ships with no plugins; installer seeds the official
marketplace; from-source contributors use `scripts/dev-setup.sh`.

---

## Phase 8 — Release Coordination

### Task 11: Coordinate cut with installer work

- [ ] **Step 1: Notify installer owners**

Signal to the installer/packaging layer that a kaizen release without
embedded plugins is coming. They are responsible for the first-run
experience: pre-seed `official` marketplace, pre-install a default
plugin set, install a default harness. Out of scope here, but the cut
must not land in a user-facing release before installers are ready.

- [ ] **Step 2: Pre-release check**

Before tagging the kaizen-code release that drops embedding, verify:
- `kaizen-plugins` repo has a tagged release whose catalog `minKaizenVersion`
  ≤ the upcoming kaizen version.
- An installer path exists that a user can follow to a working first run.

- [ ] **Step 3: Release**

Tag, release, communicate. Installer teams flip their seeding to the
new catalog on their own cadence.

---

## Rollback

If the release-without-embedding surfaces a blocking issue:

1. Revert Task 6 commits in `kaizen-code` (restores static imports and
   `plugins/` directory).
2. Re-tag the prior-behavior release.
3. `kaizen-plugins` repo is unaffected — it remains the source of truth
   for plugin source; the next attempt re-applies Task 6 after the fix.

No database or on-disk state migration is involved; rollback is
source-level only.
