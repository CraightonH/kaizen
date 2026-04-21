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

If a changed file does not match any row, identify which doc covers that area
and include it anyway.

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
- Add sections for new behavior — keep concise; link to reference docs
  rather than repeating type definitions
- If a fix requires substantive new content you cannot confidently write
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
