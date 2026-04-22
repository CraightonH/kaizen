# Documentation Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `docs/` into a navigable concepts/guides/reference hierarchy, delete obsolete files, fill identified coverage gaps, and add a `kaizen:update-docs` skill + CLAUDE.md mandate to prevent future drift.

**Architecture:** Flat `docs/` replaced by a three-layer hierarchy (concepts, guides, reference) anchored by a `docs/README.md` that doubles as a plugin-author journey checklist and coverage gap detector. A new `kaizen:update-docs` skill enforces doc updates at feature completion.

**Tech Stack:** Markdown, `.claude/skills/` skill directory convention (each skill is a directory containing `SKILL.md`)

---

## File Map

**Create:**
- `docs/README.md` — journey checklist + full index
- `docs/concepts/platform.md` — from DESIGN.md (why/what)
- `docs/concepts/architecture.md` — from docs/architecture.md (pruned)
- `docs/concepts/plugin-model.md` — merged from plugin-api.md + plugin-loading.md (conceptual layer only)
- `docs/concepts/security.md` — from docs/plugin-security.md
- `docs/concepts/harnesses.md` — from docs/harnesses.md (accuracy-reviewed)
- `docs/guides/plugin-authoring.md` — primary guide, assembled from multiple sources + new content
- `docs/guides/marketplace-authoring.md` — new
- `docs/guides/contributing.md` — from CONTRIBUTING.md + contributing-plugins.md
- `docs/reference/plugin-api.md` — reference layer from existing plugin-api.md
- `docs/reference/host-api.md` — new, from src/host-api.ts
- `docs/reference/plugin-standards.md` — from docs/plugin-standards.md
- `docs/reference/plugin-secrets.md` — from docs/plugin-secrets.md
- `.claude/skills/kaizen:update-docs/SKILL.md` — new skill

**Modify:**
- `CONTRIBUTING.md` — replace body with one-liner pointing to docs/guides/contributing.md
- `CLAUDE.md` — add kaizen:update-docs mandate

**Delete:**
- `DESIGN.md`
- `docs/adversarial-review.md`
- `docs/plugin-migration-capability-registry.md`
- `docs/plugin-api.md` (replaced by split into concepts/plugin-model.md + reference/plugin-api.md)
- `docs/plugin-loading.md` (absorbed into concepts/plugin-model.md)
- `docs/plugin-security.md` (moved to concepts/security.md)
- `docs/harnesses.md` (moved to concepts/harnesses.md)
- `docs/architecture.md` (moved to concepts/architecture.md)
- `docs/plugin-standards.md` (moved to reference/)
- `docs/plugin-secrets.md` (moved to reference/)
- `docs/contributing-plugins.md` (content absorbed into guides/contributing.md and guides/plugin-authoring.md)

---

## Task 1: Write docs/README.md (journey checklist + index)

This is first priority. Writing it reveals every coverage gap immediately — any journey step with no valid link is a documented hole.

**Files:**
- Create: `docs/README.md`

- [ ] **Step 1: Create docs/README.md**

Write the following content exactly. The anchor links (`#scaffold`, `#tools`, etc.) will be valid once Task 5 creates the guide with those headings.

```markdown
# kaizen docs

kaizen is a plugin loader, event bus, permissioned host API, and resolver for
building LLM harnesses from composable plugins. The binary ships with zero
plugins — everything is a plugin.

## Plugin Author Journey

If you're building a plugin or marketplace, work through these in order:

1. [What is a plugin and what can it do?](concepts/plugin-model.md)
2. [How do I scaffold a new plugin?](guides/plugin-authoring.md#scaffold)
3. [How do I register tools?](guides/plugin-authoring.md#tools)
4. [How do I use the host API (secrets, config, events)?](reference/host-api.md)
5. [How do I declare capabilities and dependencies?](concepts/plugin-model.md#capabilities)
6. [How do I test my plugin locally?](guides/plugin-authoring.md#testing)
7. [How do I validate it?](guides/plugin-authoring.md#validate)
8. [How do I publish to a marketplace?](guides/marketplace-authoring.md)

A link that leads to a missing or incomplete section is a known documentation
gap. Open an issue or check `docs/superpowers/specs/` for in-progress work.

## Index

### Concepts
- [Platform](concepts/platform.md) — why kaizen exists and what it is
- [Architecture](concepts/architecture.md) — kernel model, event bus, registry
- [Plugin Model](concepts/plugin-model.md) — what plugins are and how they load
- [Security](concepts/security.md) — plugin security model and permission tiers
- [Harnesses](concepts/harnesses.md) — sharing pre-configured plugin stacks

### Guides
- [Plugin Authoring](guides/plugin-authoring.md) — build a plugin from scratch
- [Marketplace Authoring](guides/marketplace-authoring.md) — publish a marketplace
- [Contributing to Core](guides/contributing.md) — contribute to kaizen itself

### Reference
- [Plugin API](reference/plugin-api.md) — types, manifest schema, exported API
- [Host API](reference/host-api.md) — APIs plugins call into kaizen
- [Plugin Standards](reference/plugin-standards.md) — required rules and guidelines
- [Plugin Secrets](reference/plugin-secrets.md) — secret provider interface
```

- [ ] **Step 2: Commit**

```bash
git add docs/README.md
git commit -m "docs(index): add README with plugin author journey and index"
```

---

## Task 2: Delete obsolete files

**Files:**
- Delete: all files listed in the "Delete" section of the File Map above

- [ ] **Step 1: Delete obsolete root and docs files**

```bash
trash DESIGN.md
trash docs/adversarial-review.md
trash docs/plugin-migration-capability-registry.md
trash docs/contributing-plugins.md
```

- [ ] **Step 2: Verify deletions**

```bash
ls docs/
```

Expected: `architecture.md  core-internals.md  harnesses.md  plugin-api.md  plugin-loading.md  plugin-secrets.md  plugin-security.md  plugin-standards.md  README.md  superpowers`

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "docs(cleanup): delete obsolete and migrated-away files"
```

---

## Task 3: Migrate concepts layer

Build `docs/concepts/` from existing docs. Each file is a move+prune, not a rewrite from scratch.

**Files:**
- Create: `docs/concepts/platform.md`, `docs/concepts/architecture.md`, `docs/concepts/plugin-model.md`, `docs/concepts/security.md`, `docs/concepts/harnesses.md`

- [ ] **Step 1: Create docs/concepts/platform.md from DESIGN.md**

Read `DESIGN.md` (it still exists in git at this point — use `git show HEAD~1:DESIGN.md` if already deleted). Extract these sections into `docs/concepts/platform.md`:
- Problem Statement
- What Makes This Cool
- Constraints
- High-level: what kaizen is (kernel model, not a harness)

Strip: approval history, role terminology annotations, session-context notes, executor-as-plugin architecture details (those belong in architecture.md), anything referencing `provides`/`depends` (deprecated).

Target length: 150–250 lines. If it's growing beyond that, you're including too much detail.

The file should answer: "Why does kaizen exist, what is it, and what are its hard constraints?" in plain prose a new contributor can read in 5 minutes.

- [ ] **Step 2: Create docs/concepts/architecture.md from docs/architecture.md**

Read `docs/architecture.md`. Copy it to `docs/concepts/architecture.md`. Then prune:
- Remove any references to "role" as a capability mechanism (deprecated, replaced by owner-qualified capabilities)
- Remove any references to `provides`/`depends` as the capability API
- Keep: kernel model, event bus, plugin registry, startup sequence, the three things core does

- [ ] **Step 3: Create docs/concepts/plugin-model.md by merging plugin-api.md + plugin-loading.md**

Read `docs/plugin-api.md` and `docs/plugin-loading.md`. Extract the **conceptual** content into `docs/concepts/plugin-model.md`. Leave the **reference** content (type signatures, exact method names, schema fields) for Task 4's `docs/reference/plugin-api.md`.

Structure for `docs/concepts/plugin-model.md`:
```markdown
# Plugin Model

*Read when: you want to understand what a plugin is before building one.*

## What is a plugin

[Explain KaizenPlugin shape at a conceptual level — name, version, permissions,
capabilities, setup() — without quoting every type field]

## How plugins load

[From plugin-loading.md: resolution → install → consent → setup order.
Keep it high-level — exact loader mechanics belong in core-internals.md]

## Capabilities and dependencies {#capabilities}

[Owner-qualified capabilities, cardinality (one/many), how consumes/provides
declares dependencies. This answers journey step 5.]

## Plugin lifecycle

[setup(), event handlers, teardown. When each fires.]

## Permission tiers

[trusted / scoped / unscoped — what each can access]
```

- [ ] **Step 4: Create docs/concepts/security.md from docs/plugin-security.md**

```bash
cp docs/plugin-security.md docs/concepts/security.md
```

Then edit the heading from "Plugin Security Model" to "Security Model" and update the `*Read when*` hint to:

```
*Read when: writing a plugin, reviewing someone else's, or auditing kaizen core permissions.*
```

- [ ] **Step 5: Create docs/concepts/harnesses.md from docs/harnesses.md**

Read `docs/harnesses.md`. Copy to `docs/concepts/harnesses.md`. Review for accuracy against the current harness model:
- Harnesses are `kaizen.json` files (a plugin list + per-plugin config) shared by URL or path
- They are **not** npm packages (the old model)
- Verify no references to the old npm-package harness model remain; remove any that exist

- [ ] **Step 6: Delete the originals**

```bash
trash docs/architecture.md
trash docs/plugin-api.md
trash docs/plugin-loading.md
trash docs/plugin-security.md
trash docs/harnesses.md
```

- [ ] **Step 7: Commit**

```bash
git add docs/concepts/ && git add -u
git commit -m "docs(concepts): add concepts layer from migrated and merged sources"
```

---

## Task 4: Build reference layer

**Files:**
- Create: `docs/reference/plugin-api.md`, `docs/reference/host-api.md`, `docs/reference/plugin-standards.md`, `docs/reference/plugin-secrets.md`

- [ ] **Step 1: Create docs/reference/plugin-api.md from docs/plugin-api.md (reference content only)**

Read `docs/plugin-api.md` (now deleted from disk, available via `git show HEAD~1:docs/plugin-api.md`). Extract the **reference** content: type definitions, manifest field descriptions, exact method signatures, schema examples. This should read like an API reference, not a tutorial.

Minimum sections:
```markdown
# Plugin API Reference

*Read when: you need exact type signatures, manifest field names, or method definitions.*

## KaizenPlugin manifest

[All fields: name, version, permissions, capabilities, config, setup. Exact types.]

## PluginContext (setup argument)

[Fields available in setup(ctx): host, config, emit, register, etc.]

## Tool definition

[ToolDefinition shape: name, description, inputSchema, handler signature]

## Events

[Built-in event names, payload types, when each fires]
```

- [ ] **Step 2: Create docs/reference/host-api.md from src/host-api.ts**

Read `src/host-api.ts` — this is the authoritative contract. Also read `src/core/plugin-ctx-io.ts` for the context APIs. Structure:

```markdown
# Host API Reference

*Read when: writing a plugin that needs secrets, config, the event bus, or LLM access.*

Plugins access kaizen's runtime via `import "kaizen/types"`. The following
are available at runtime (not just as types).

## Runtime values

### ServiceToken
[What it is, when to use it]

### SecretsProviderToken
[What it is, when to use it]

### createLLMRuntime
[Signature, what it returns, when to use]

### readStdinLine
[Signature, use case]

### PLUGIN_API_VERSION
[What it is]

## Context APIs (PluginContext)

These are provided to your plugin's `setup(ctx)` function.

### ctx.fs (CtxFs)
[Available methods, permission requirements]

### ctx.net (CtxNet)
[Available methods, permission requirements]

### ctx.secrets (CtxSecrets)
[Available methods — this is how plugins read secrets]

### ctx.exec (CtxExec)
[Available methods, permission requirements]

### ctx.log (CtxLog)
[Available methods]

### ctx.io (CtxIo)
[Available methods — stdin/stdout for session IO]

## Type-only exports

[Brief note: KaizenPlugin, PluginContext, ToolDefinition, etc. are available
as TypeScript types only — not runtime values. Full list from src/host-api.ts.]
```

Fill each section by reading the implementation in `src/core/plugin-ctx-io.ts` and the types in `src/types/plugin.ts`.

- [ ] **Step 3: Move plugin-standards.md and plugin-secrets.md**

```bash
cp docs/plugin-standards.md docs/reference/plugin-standards.md
cp docs/plugin-secrets.md docs/reference/plugin-secrets.md
trash docs/plugin-standards.md
trash docs/plugin-secrets.md
```

- [ ] **Step 4: Verify reference layer**

```bash
ls docs/reference/
```

Expected: `host-api.md  plugin-api.md  plugin-secrets.md  plugin-standards.md`

- [ ] **Step 5: Commit**

```bash
git add docs/reference/ && git add -u
git commit -m "docs(reference): add reference layer with host-api.md and migrated files"
```

---

## Task 5: Write guides

The guides answer "how do I do X" — procedural, step-by-step, with examples. These are the most likely to have coverage gaps.

**Files:**
- Create: `docs/guides/plugin-authoring.md`, `docs/guides/marketplace-authoring.md`, `docs/guides/contributing.md`

- [ ] **Step 1: Create docs/guides/plugin-authoring.md**

This is the primary guide. It must answer journey steps 2, 3, 6, and 7. Use `docs/contributing-plugins.md` (via git history: `git show HEAD~2:docs/contributing-plugins.md`) and `docs/reference/plugin-standards.md` as source material. Fill gaps by reading `src/` directly.

Required sections and headings (use these exact heading IDs — README.md anchors to them):

```markdown
# Plugin Authoring Guide

*Read when: you are writing a kaizen plugin.*

## Prerequisites

- Node.js 18+ or Bun 1.0+
- kaizen installed (`curl ... | bash` or built from source)
- Familiarity with TypeScript

## Scaffold {#scaffold}

```bash
kaizen plugin create path/to/my-plugin
```

[Describe what the scaffolder generates: directory structure, package.json,
index.ts with KaizenPlugin export, test file. If kaizen plugin create isn't
implemented yet, note that and describe manual scaffold.]

## Anatomy of a plugin

[Show the minimal KaizenPlugin object. Explain each required field.
Reference docs/reference/plugin-api.md for full type details.]

## Registering tools {#tools}

[Show how to add a ToolDefinition in setup(ctx). Include a complete working
example: a tool that takes a string argument and returns a string result.
Exact types from src/types/plugin.ts.]

## Using the host API

[Brief intro, point to docs/reference/host-api.md for full reference.
Show one concrete example: reading a secret in setup().]

## Testing {#testing}

[How to write a test for a plugin. Show a minimal test that:
1. Imports the plugin default export
2. Calls setup() with a mock ctx
3. Asserts the plugin registered a tool
Point to existing fixture plugins in tests/ for reference.]

## Validate {#validate}

```bash
kaizen plugin validate path/to/my-plugin
```

[What validate checks. Common validation errors and fixes.]

## Publish to a marketplace

See [Marketplace Authoring](marketplace-authoring.md).
```

- [ ] **Step 2: Create docs/guides/marketplace-authoring.md**

Read `src/` for marketplace CLI commands and `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md` for design context. Structure:

```markdown
# Marketplace Authoring Guide

*Read when: you want to publish a marketplace so others can install your plugins.*

## What is a marketplace

[A directory (local or remote) that kaizen resolves plugin references against.
Structure: catalog JSON + plugin/harness tarballs or references.]

## Scaffold

```bash
kaizen marketplace create path/to/my-marketplace
```

[What the scaffolder generates.]

## Catalog format

[Describe MarketplaceCatalog and MarketplaceEntry shapes from kaizen/types.
Show a minimal catalog.json example with one plugin entry.]

## Validate

```bash
kaizen marketplace validate path/to/my-marketplace
```

## Publish

[How to share: URL, local path, or git remote. How consumers reference it:
`kaizen --harness my-marketplace/my-plugin@1.0.0`]

## Versioning

[Semver. How to release a new version without breaking existing consumers.]
```

- [ ] **Step 3: Create docs/guides/contributing.md**

Source: current `CONTRIBUTING.md` (root) and `git show HEAD~2:docs/contributing-plugins.md` section on contributing to core. Structure:

```markdown
# Contributing to kaizen

*Read when: you want to contribute to kaizen core (this repo).*

## Setup

[Dev setup: clone, bun install, scripts/dev-setup.sh, etc.]

## Running tests

[bun test or equivalent. How to run a single test file.]

## Project structure

[Brief tour: src/core/, src/types/, plugins/, tests/, scripts/]

## Submitting a PR

[Branch naming, commit conventions (Conventional Commits), PR checklist]

## Coding standards

[Key standards: TypeScript strict, file size limits, test requirements]
```

- [ ] **Step 4: Commit**

```bash
git add docs/guides/
git commit -m "docs(guides): add plugin-authoring, marketplace-authoring, contributing guides"
```

---

## Task 6: Update root CONTRIBUTING.md

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Replace CONTRIBUTING.md with a redirect**

```bash
cat > CONTRIBUTING.md << 'EOF'
# Contributing

See [docs/guides/contributing.md](docs/guides/contributing.md).
EOF
```

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs(contributing): redirect root CONTRIBUTING.md to docs/guides/"
```

---

## Task 7: Write kaizen:update-docs skill

**Files:**
- Create: `.claude/skills/kaizen:update-docs/SKILL.md`

- [ ] **Step 1: Create the skill directory and SKILL.md**

```bash
mkdir -p .claude/skills/kaizen:update-docs
```

Write `.claude/skills/kaizen:update-docs/SKILL.md`:

```markdown
---
name: kaizen:update-docs
description: Update kaizen docs after feature completion. Run before superpowers:finishing-a-development-branch on any branch that changes behavior or API surface.
---

# kaizen:update-docs

Run this skill when a feature branch is complete, before invoking
`superpowers:finishing-a-development-branch`. It audits docs against the
branch diff and patches what has drifted.

Skip this skill only for: chore/fix PRs with no behavior change, internal
refactors with no externally visible change. If in doubt, run it anyway — it
exits early when there's nothing to do.

## Step 1: Identify what changed

```bash
git diff master...HEAD --name-only
```

Map changed files to affected docs using this table:

| Changed area | Affected docs |
|---|---|
| `src/core/` | `docs/concepts/architecture.md`, `docs/reference/plugin-api.md` |
| `src/types/plugin.ts` | `docs/reference/plugin-api.md`, `docs/concepts/plugin-model.md` |
| `src/host-api.ts` | `docs/reference/host-api.md` |
| `src/core/plugin-ctx-io.ts` | `docs/reference/host-api.md` |
| CLI commands | `docs/guides/plugin-authoring.md`, `docs/guides/marketplace-authoring.md` |
| Plugin lifecycle | `docs/concepts/plugin-model.md`, `docs/guides/plugin-authoring.md` |
| Marketplace / registry | `docs/guides/marketplace-authoring.md` |
| Security / permissions | `docs/concepts/security.md`, `docs/reference/plugin-standards.md` |

If a changed file doesn't match any row, think about which doc covers that
area and include it anyway.

## Step 2: Audit each affected doc

For each affected doc:
1. Read the doc
2. Read the relevant source files
3. Flag: type names, method names, CLI flags, or behavior descriptions that
   no longer match source
4. Flag: sections about features that no longer exist
5. Flag: missing sections for new behavior introduced by this branch

For context on intent behind a change, check:
`docs/superpowers/specs/` for the relevant spec file.

## Step 3: Patch the docs

Fix all flagged items. Rules:
- Update type/method names to match current source
- Remove sections for removed features
- Add sections for new behavior — keep them concise; link to reference docs
  rather than repeating type definitions
- If a fix requires substantive new content you can't confidently write
  (e.g., a new guide section for an undocumented feature), write a stub
  with a `<!-- TODO: expand -->` comment and note it in the commit message

## Step 4: Verify the plugin author journey

Open `docs/README.md`. For each item in the Plugin Author Journey checklist:
- Does the linked doc exist?
- Does the linked doc actually answer the question?
- Does the answer reflect current code?

Fix any gap. A missing link is a gap — add a stub rather than leave a
broken link.

## Step 5: Commit

```bash
git add docs/
git commit -m "docs(<area>): update for <feature>"
```

Where `<area>` is the primary docs layer touched (concepts, reference, guides)
and `<feature>` matches the feature name from the branch or PR title.

If multiple layers were touched:
```bash
git commit -m "docs: update concepts and reference for <feature>"
```
```

- [ ] **Step 2: Verify skill file is readable**

```bash
head -5 .claude/skills/kaizen:update-docs/SKILL.md
```

Expected: frontmatter starting with `---`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/kaizen:update-docs/
git commit -m "feat(skills): add kaizen:update-docs skill for post-feature doc maintenance"
```

---

## Task 8: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the doc mandate to CLAUDE.md**

Read `CLAUDE.md`. Find the section most relevant to workflow steps or finishing work. Add the following block — if there's no obvious section, add it near the top under its own heading:

```markdown
## Documentation

Before invoking `superpowers:finishing-a-development-branch`, run `kaizen:update-docs`.
This is mandatory for any branch that changes behavior, API surface, or CLI commands.
Skip only for chore/fix PRs with no externally visible change.
```

- [ ] **Step 2: Verify**

```bash
grep -n "kaizen:update-docs" CLAUDE.md
```

Expected: two lines matching (the skill name appears in the mandate text).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): mandate kaizen:update-docs before finishing branches"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task that covers it |
|---|---|
| docs/README.md with journey checklist | Task 1 |
| Delete obsolete files (DESIGN.md, adversarial-review, migration guide) | Task 2 |
| concepts/ layer (platform, architecture, plugin-model, security, harnesses) | Task 3 |
| reference/ layer (plugin-api, host-api, standards, secrets) | Task 4 |
| guides/ layer (plugin-authoring, marketplace-authoring, contributing) | Task 5 |
| Root CONTRIBUTING.md redirect | Task 6 |
| kaizen:update-docs skill | Task 7 |
| CLAUDE.md mandate | Task 8 |
| Journey checklist gap detection | Tasks 1 + 7 (skill checks it on every run) |
| Feature-completion trigger (not per-PR) | Task 7 skill + Task 8 CLAUDE.md |

All spec requirements are covered.

**Placeholder scan:** Task 5 notes that plugin scaffolding may not be fully implemented — the plan instructs the implementer to verify and note gaps honestly rather than fabricate. This is intentional, not a placeholder.

**Type consistency:** No cross-task type references that could drift — each task is self-contained content work.
