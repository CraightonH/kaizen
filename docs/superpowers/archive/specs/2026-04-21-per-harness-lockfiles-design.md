# Per-Harness Lockfiles

**Status:** Approved
**Date:** 2026-04-21
**Issue:** https://github.com/CraightonH/kaizen/issues/27

## Problem

`src/core/index.ts:58` anchors the lockfile at `process.cwd()/kaizen.permissions.lock`. A single repo can only operate one harness's consent scope: run two harnesses with different plugin sets in the same project and they share one permission record, so one harness's consents leak into the other.

## Scope

### In scope

- Per-harness lockfiles: each harness owns its own `permissions.lock` alongside its `kaizen.json`.
- Remove the global repo-root `kaizen.permissions.lock` and the `KAIZEN_LOCKFILE_OVERRIDE` env var.
- Require a named harness — bare root `kaizen.json` is no longer a supported entry point.
- Preserve `permissions.lock` on marketplace harness re-materialization.

### Out of scope

- **Content-hash tamper detection.** The issue proposed restoring content-hash verification. We intentionally drop that. Tier-grant hash remains the only lockfile hash; grant changes trigger re-consent; plugin code changes under unchanged grants are not detected. Rationale: permission-grant identity is the meaningful security boundary; logic changes within the same grants don't escalate capability.
- **Backwards compatibility / migration.** Greenfield project with no existing adoption.
- **Changes to consent-flow comparison logic.** The existing tier-grant hash compare already re-prompts on mismatch.

## Lockfile Paths

Co-located with the harness's `kaizen.json`:

| Harness source | Harness dir | Lockfile |
|---|---|---|
| Local (project) | `.kaizen/harnesses/<name>/` | `.kaizen/harnesses/<name>/permissions.lock` |
| Local (home) | `~/.kaizen/harnesses/<name>/` | `~/.kaizen/harnesses/<name>/permissions.lock` |
| Marketplace | `~/.kaizen/marketplaces/<id>/harnesses/<name>/` | `~/.kaizen/marketplaces/<id>/harnesses/<name>/permissions.lock` |

**Derivation rule:** `lockfilePath = dirname(resolvedHarnessJsonPath) + "/permissions.lock"`. One line, applied wherever harness resolution happens.

## Entry-Point Rules

- `kaizen --harness <ref-or-path>` resolves to one of the three rows above.
- `extends` in a local `kaizen.json` accepts the same forms recursively; the outer `kaizen.json` must itself live in a named harness directory.
- Bare `./kaizen.json` at repo root with no `--harness` and no `extends` → fail with a clear error: "kaizen requires a named harness; see docs/concepts/harnesses.md." The error message must list the three valid entry-point forms.

## Lockfile Schema

Unchanged from today:

```yaml
schemaVersion: 1
plugins:
  <plugin-name>:
    version: <semver>
    hash: sha256:<canonicalTierGrantHash>   # permissions-grant identity
    tier: <trusted|restricted|...>
    consentedAt: <iso8601>
    consentedBy: <user>
    permissions: { ... }
```

Runtime compare stays as-is: `canonicalTierGrantHash(currentPermissions) !== lockfile.plugins[name].hash` → re-consent. Only the file's location and scope change.

## Code Changes

### Harness resolver

Wherever `--harness` / `extends` is parsed today, return a descriptor including at minimum `{ kaizenJsonPath: string }`. Caller derives `lockfilePath` from `dirname(kaizenJsonPath)`.

### `src/core/index.ts`

- Drop `KAIZEN_LOCKFILE_OVERRIDE` and the `join(process.cwd(), "kaizen.permissions.lock")` fallback at line 58.
- Accept `lockfilePath` from caller (via `RunHarnessOpts` / `initializePluginSystem` args); `process.cwd()` is no longer a valid source.
- If no harness is resolvable at entry, fail fast with the "named harness required" error.

### Lockfile consumer signatures

`bootstrap`, `plugin-consent`, `plugin-review`, `install`, `uninstall` continue to take `lockfilePath: string`. The CLI entry points change — they resolve the harness first, derive the path, pass it down. Consumers do not learn about harnesses; they still just read/write the path they're handed.

### Marketplace re-materialization

Wherever marketplace harness fetch writes the dir, add a "preserve `permissions.lock` if present" rule: stage into a temp dir, copy-move artifact files, never delete `permissions.lock`. Single-file preservation. The existing consent-flow still re-prompts when re-materialization changes a plugin's grants, because the preserved lockfile's tier-grant hash will no longer match.

### Tests

- Remove the `KAIZEN_LOCKFILE_OVERRIDE` workaround (introduced in 223f413) from `orchestration.test.ts`, `driver-capability-resolution.test.ts`, `plugin-manager.test.ts`.
- Integration tests needing lockfile isolation point `--harness` at a tmpdir harness; lockfile lands there naturally.
- New tests:
  - Harness resolver derives the expected `permissions.lock` path for each of the three harness sources.
  - Two harnesses in one repo (`.kaizen/harnesses/a/`, `.kaizen/harnesses/b/`) with different plugin sets → independent lockfiles; consenting in one doesn't affect the other.
  - Bare root `kaizen.json` with no `--harness` → fails with the "named harness required" error.
  - Marketplace re-materialization preserves an existing `permissions.lock` byte-for-byte.

### Docs (live, non-frozen)

- `README.md:120` — replace "Consent is persisted in `kaizen.permissions.lock` at the repo root" with per-harness lockfile description; link to `docs/concepts/harnesses.md`.
- `.gitignore:8` — update comment; `permissions.lock` files now live under `.kaizen/harnesses/<name>/`, still committed.
- `docs/concepts/security.md:95` — update path description (per-harness, still committed, still the security record).
- `docs/concepts/plugin-model.md:52` — update inline path reference.
- `docs/concepts/harnesses.md` — add "State files" subsection describing `permissions.lock` co-location and the marketplace re-materialization preservation rule.

Historical `docs/superpowers/plans/*` and `docs/superpowers/specs/*` are frozen artifacts and are not updated.

## Risks

- **Plugin shared across harnesses re-prompts per harness.** Two harnesses using the same plugin with the same grants each prompt separately. Acceptable — per-harness scoping is the goal — but name it so it isn't a surprise.
- **Marketplace re-materialization regression silently wipes consent.** Mitigated by the dedicated re-materialization preservation test.
- **Harness-less invocation error must be actionable.** First-run ergonomics: error message must link to docs and list the three valid forms.
