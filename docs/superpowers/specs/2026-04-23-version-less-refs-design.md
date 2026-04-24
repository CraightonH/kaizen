# Version-less Harness and Plugin Refs

**Issue:** [#49](https://github.com/CraightonH/kaizen/issues/49)
**Date:** 2026-04-23
**Status:** Approved

## Summary

Allow omitting `@<version>` from harness refs and plugin refs inside harness
`kaizen.json` files. A version-less ref resolves to the latest version available
in the marketplace catalog. If the entry is not installed, it is auto-installed
silently.

## Current State

`parseRef` and `resolveRef` already handle version-less refs — `version` is
optional in `ParsedRef`, and `pickLatestSemver` fires when no version is given.

**Harness refs** (`--harness official/core-shell` or `defaults.harness:
"official/core-shell"`) already work end-to-end. `materializeHarnessRef` calls
`parseRef` → `resolveRef` → `installHarness`, none of which require a version.

**Plugin refs inside harness `kaizen.json`** are blocked. `bootstrap.ts:71-73`
throws if `version` is absent:

```ts
if (!version) {
  throw new Error(`harness plugin ref '${refStr}' must include an explicit version`);
}
```

In addition, approximately 10 places in source and docs document the ref format
as `<marketplace>/<name>@<version>` (version required).

## Design Decisions

**Resolution strategy:** latest from marketplace catalog, via the existing
`pickLatestSemver` path. No new resolution logic needed.

**Auto-install:** silent. If the entry is not installed, resolve from catalog
and install without prompting. Specifying a ref is sufficient expression of
intent.

**No auto-update:** this feature does not add any auto-update behavior.
`kaizen update` remains the explicit upgrade path. Marketplace catalog refreshes
already run in the background on a TTL; that is unchanged.

**Lockfile:** no changes. The lockfile tracks plugin permission consent keyed by
plugin name + version + hash. A version bump in the harness triggers a hash
change, which already causes re-consent. No harness-level version tracking is
needed.

**Scope:** both harness refs and plugin refs inside `kaizen.json`. Symmetry is
intentional — version-less means "give me latest now; pin when you need
stability."

**Shorthand plugin refs remain rejected.** A plugin ref like `timestamps`
(no marketplace prefix) inside a harness `kaizen.json` is still an error.
Marketplace qualification (`official/timestamps`) is required; only the
`@version` suffix becomes optional.

## Changes Required

### 1. `src/core/bootstrap.ts` — remove the version guard

Delete lines 71-73:

```ts
// REMOVE:
if (!version) {
  throw new Error(`harness plugin ref '${refStr}' must include an explicit version`);
}
```

When `version` is `undefined`, `runUnifiedInstall` is called with the
version-less ref string (e.g. `official/timestamps`). The install path already
calls `resolveRef`, which picks latest and proceeds.

### 2. Error messages and docs — update ref format notation

Replace `<marketplace>/<name>@<version>` with `<marketplace>/<name>[@<version>]`
(brackets indicate optional) in:

| File | Location |
|------|----------|
| `src/core/bootstrap.ts` | shorthand error message (line 54) |
| `src/core/config.ts` | fatal error messages (lines 65, 71, 131) |
| `src/cli.ts` | help text and fatal message (lines 100, 517, 518, 602) |
| `src/core/plugin-manager.ts` | comment and error (lines 139, 160) |
| `src/types/plugin.ts` | JSDoc comment (line 239) |
| `docs/concepts/harnesses.md` | ref format descriptions (lines 22, 56, 102, 116) |
| `docs/guides/marketplace-authoring.md` | ref format (lines 19, 111) |

### 3. Tests

- Add `bootstrap.ts` test: version-less plugin ref resolves and installs without error.
- Add `bootstrap.ts` test: shorthand (no marketplace prefix) still throws.
- Update any existing tests that assert version is required in plugin refs.

## Out of Scope

- Bare shorthand plugin refs (`timestamps` without marketplace prefix) — still rejected.
- Any new auto-update or version-drift behavior.
- Changes to the lockfile schema.
- Changes to `kaizen update`.
