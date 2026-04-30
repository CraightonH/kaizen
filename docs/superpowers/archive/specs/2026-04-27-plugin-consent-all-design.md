# Design: `kaizen plugin consent --all`

**Date:** 2026-04-27
**Status:** Approved

## Problem

`kaizen plugin consent <name>` consents a single plugin. In CI or fresh-environment setup,
you need to pre-consent every plugin in a harness before running it non-interactively.
There is currently no way to do this in one command — you'd have to enumerate every plugin
ref manually. `kaizen --harness <ref>` handles interactive first-run consent, but has no
non-interactive equivalent for bulk pre-consent.

## Solution

Add `--all` flag to `kaizen plugin consent`:

```
kaizen plugin consent --all [--harness <ref>]
```

Iterates every plugin declared in the harness, consents each one non-interactively, and
prints a full summary. Scoped and unscoped plugins are both granted automatically — the
deliberate use of `--all` is sufficient signal that the operator has reviewed the harness.
No additional flags required.

`--harness` resolution follows the same order as single-plugin consent: explicit flag →
`defaults.harness` in `~/.kaizen/kaizen.json`.

## Consent Model Change

`ConsentInput` gains `allowScoped: boolean`. `decideConsent` updated:

- `tier === "scoped"` + `!interactive` + `allowScoped` → `accept-and-record` (was always `refuse`)
- All other paths unchanged

`--all` passes `allowScoped: true` and `allowUnscoped: true`. Single-plugin
`plugin consent <name>` does not pass `allowScoped`, preserving existing behavior
(single-plugin non-interactive scoped consent still refuses — you must run interactively
or use `--all`).

## Execution Flow

1. Resolve harness (flag → global default), read `harness.plugins[]`
2. For each plugin ref:
   - **Local-path** (`./`, `../`, `/`): skip, record as `skipped (local-path)` — no
     marketplace hash to verify
   - **Marketplace/npm ref**: run `runUnifiedInstall` with
     `nonInteractive: true, allowScoped: true, allowUnscoped: true`
   - Capture outcome: `consented`, `already-consented`, or `refused`
3. Print summary (see Output below)
4. Exit `0` if all plugins are `consented` or `already-consented`; `1` if any `refused`

## Output

```
plugin consent --all  (harness: ./kaizen.json)

  ✓ consented      my-marketplace/session-driver@1.2.0   (scoped)
  ✓ consented      my-marketplace/ui-plugin@0.4.1        (unscoped)
  ○ already        my-marketplace/secrets-plugin@2.0.0   (trusted)
  - skipped        ./local-dev-plugin                    (local-path)

4 plugins: 2 consented, 1 already consented, 1 skipped.
```

On refusal (should not occur with `--all` unless there is a hash/permissions mismatch in
the lockfile):

```
  ✗ refused        my-marketplace/bad-plugin@0.1.0       (scoped)
    reason: plugin 'bad-plugin' hash differs from lockfile. Run 'kaizen plugin consent bad-plugin --harness ...' to re-consent.
```

## Files Changed

| File | Change |
|------|--------|
| `src/core/consent-flow.ts` | Add `allowScoped` to `ConsentInput`; update `decideConsent` scoped branch |
| `src/commands/install.ts` | Thread `allowScoped` through `runUnifiedInstall` and `InstallArgs` |
| `src/commands/plugin-consent-all.ts` | New file — harness walk, summary renderer, `runPluginConsentAll` |
| `src/cli.ts` | Detect `--all` in `plugin consent` handler; delegate to `runPluginConsentAll` |

## Tests

- **Unit — `src/core/consent-flow.test.ts`:** add cases for
  `scoped + nonInteractive + allowScoped: true → accept-and-record` and
  `scoped + nonInteractive + allowScoped: false → refuse` (regression guard)
- **Unit — `src/commands/plugin-consent-all.test.ts`:** mock harness with mixed tiers
  (trusted, scoped, unscoped, local-path); verify summary rows and exit codes for
  all-consented, already-consented, and refused scenarios

## Out of Scope

- `--allow-scoped` as a standalone flag on `plugin consent <name>` — deliberate. Bulk
  pre-consent via `--all` is the intended non-interactive scoped path.
- Partial consent (consent only some plugins from a harness) — use single-plugin
  `plugin consent <name>` for that.
