# Built-in Plugins Repo Decoupling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the built-in plugins from the main kaizen monorepo into a
dedicated `kaizen-sh/kaizen-plugins` repository. Establish the official kaizen
marketplace. After this plan, plugins have their own release cadence, authors have
a canonical reference repo, and `kaizen marketplace add` works with the official
catalog.

**Spec:** `docs/superpowers/specs/2026-04-18-builtin-plugins-repo-decoupling-design.md`

**Prerequisites:**
- Spec 1 (marketplace) must be shipped — the new repo emits a `marketplace.json`
  in the format Spec 1 defines, and the `kaizen marketplace add` command must exist.
- Spec 3 (scaffolder + standards) is recommended before starting — scaffolded
  plugins in the new repo should pass `kaizen plugin validate`.

---

## Phase 1 — Set Up New Repository

### Task 1: Create `kaizen-sh/kaizen-plugins` repo

- [ ] **Step 1: Create the repository**

Create `kaizen-sh/kaizen-plugins` (or equivalent under the project's GitHub org).
Initialize with MIT license and a README stub.

- [ ] **Step 2: Set up directory structure**

```
kaizen-plugins/
├── .kaizen/
│   └── marketplace.json
├── plugins/
├── harnesses/
├── README.md
└── package.json    # optional workspace root
```

- [ ] **Step 3: Write initial `README.md`**

Explain:
- What this repo is (official kaizen plugins + marketplace catalog).
- How to add the official marketplace: `kaizen marketplace add <url>`.
- How to contribute a plugin.
- How to contribute a harness.
- Link to `docs/plugin-standards.md` in the main kaizen repo.

---

## Phase 2 — Migrate Plugins

### Task 2: Copy and update each built-in plugin

For each of the following plugins, complete all steps. Work through them one at a
time to avoid merge conflicts.

**Plugins to migrate:**
- `core-events`
- `core-executor-anthropic`
- `core-executor-openai`
- `core-executor-debug`
- `core-executor-shell`
- `core-ui-terminal`
- `core-cli`
- `core-lifecycle`
- `core-plugin-manager`
- `kaizen-plugin-timestamps`

For each plugin:

- [ ] **Step A: Copy source to `plugins/<name>/`**

Copy `plugins/<name>/` from the main kaizen repo to `plugins/<name>/` in the new
repo.

- [ ] **Step B: Fix imports**

Replace relative imports:
```typescript
// Before
import type { KaizenPlugin } from "../../src/types/plugin.js";
import { EVENTS } from "../core-events/index.js";

// After
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
  "peerDependencies": { "kaizen": "*" },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step D: Add/update tests**

Ensure `index.test.ts` exists. Add minimal test (metadata + setup runs) if absent.
Use `makeCtx()` pattern from the scaffold template.

- [ ] **Step E: Add `README.md`**

At minimum: plugin name, description, installation, configuration table (if any),
permissions, capabilities.

- [ ] **Step F: Run `kaizen plugin validate plugins/<name>`**

Fix any validation errors before moving to the next plugin.

---

## Phase 3 — Migrate Harnesses

### Task 3: Copy harness files

- [ ] **Step 1: Copy `harnesses/core-anthropic/kaizen.json` → `harnesses/core-anthropic.json`**

Flatten from `harnesses/<name>/kaizen.json` to `harnesses/<name>.json` in the new
repo (a harness is a single file, not a directory).

- [ ] **Step 2: Copy `harnesses/core-debug.json` and `harnesses/core-shell.json`**

Same pattern.

- [ ] **Step 3: Update plugin refs in harnesses**

Harness files should use canonical refs. For built-in plugins that remain compiled
into the binary, bare names (`"core-events"`) are fine. Once Spec 1 is shipped,
harnesses in the marketplace repo can optionally use fully-qualified refs
(`"official/core-events@2.0.0"`).

---

## Phase 4 — Write Official Marketplace Catalog

### Task 4: Write `.kaizen/marketplace.json`

- [ ] **Step 1: Add all migrated plugins to the catalog**

For each plugin in Phase 2, add an entry:

```json
{
  "name": "core-events",
  "description": "Default event vocabulary for kaizen sessions.",
  "categories": ["core"],
  "versions": [
    {
      "version": "0.1.0",
      "source": { "type": "file", "path": "plugins/core-events" }
    }
  ]
}
```

Initially use `file` sources (the plugins live in this repo). Once plugins are
published to npm separately, switch entries to `npm` sources.

- [ ] **Step 2: Add harness entries**

```json
{
  "name": "core-anthropic",
  "description": "Default Anthropic LLM harness.",
  "categories": ["harness"],
  "versions": [
    { "version": "1.0.0", "path": "harnesses/core-anthropic.json" }
  ]
}
```

- [ ] **Step 3: Run `kaizen marketplace validate .`**

Fix any validation errors.

---

## Phase 5 — Update Build in Main Repo

### Task 5: Update kaizen build to use new repo

- [ ] **Step 1: Add `kaizen-plugins` as a dependency or workspace**

In the main kaizen repo's `package.json`:
```json
{
  "workspaces": ["plugins/*"]
}
```

Point workspace entries at the new repo via git dependency or by checking it out
as a sibling directory in CI:
```json
{
  "dependencies": {
    "core-events": "github:kaizen-sh/kaizen-plugins#HEAD:plugins/core-events"
  }
}
```

Or (simpler for development): keep `plugins/*` as local workspace entries that
are symlinked to the checked-out `kaizen-plugins` repo during development.

- [ ] **Step 2: Verify `bun build --compile` still works**

Run the full binary build. Confirm all static imports in `src/cli.ts` resolve.

- [ ] **Step 3: Update `src/cli.ts` static imports if needed**

If import paths change (e.g., from workspace-relative to package name), update.

---

## Phase 6 — Official Marketplace Bootstrap in `kaizen init`

### Task 6: Pre-add official marketplace in new installs

- [ ] **Step 1: Update `kaizen init --global`**

When creating `~/.kaizen/kaizen.json`, pre-populate the `marketplaces` array:

```json
{
  "marketplaces": [
    {
      "id": "official",
      "url": "https://github.com/kaizen-sh/kaizen-plugins.git"
    }
  ]
}
```

- [ ] **Step 2: Run `kaizen marketplace update official` in `kaizen init --global`**

Fetches the catalog on first install so `kaizen marketplace browse` works immediately.

---

## Phase 7 — Remove Old `plugins/` from Main Repo

### Task 7: Cleanup (do last, after build verified)

- [ ] **Step 1: Verify build and all tests pass with new repo**

Run full test suite from a clean checkout. No references to old `plugins/` paths.

- [ ] **Step 2: Delete `plugins/` directory from main kaizen repo**

```bash
git rm -r plugins/
```

- [ ] **Step 3: Delete `harnesses/` directory from main kaizen repo** (if harnesses
  migrated fully to new repo and no longer needed here).

- [ ] **Step 4: Update `docs/architecture.md`**

Change "Directory structure" section:
- Remove `plugins/` entry.
- Add reference to `kaizen-sh/kaizen-plugins` repo.
- Update plugin resolution order to mention official marketplace.

- [ ] **Step 5: Update `docs/plugin-loading.md`**

Update "Development workflow for plugin authors" to reference the new repo as the
reference implementation.

- [ ] **Step 6: Update `docs/plugin-api.md`**

Change import examples from relative paths to `kaizen/types`.

---

## Phase 8 — Documentation

### Task 8: Docs

- [ ] **Step 1: Write `docs/contributing-plugins.md`**

Guide for contributing to `kaizen-sh/kaizen-plugins`:
- How to add a new plugin (copy scaffold, add to catalog, open PR).
- Standards requirements (link to `docs/plugin-standards.md`).
- How to publish a plugin to npm (future — note it's not required; `file` sources work).
- How to add a harness.

- [ ] **Step 2: Update `README.md`**

Add official marketplace to the "Installation and discovery" section.
Update the built-in plugin list to reflect they're now in `kaizen-sh/kaizen-plugins`.
