# Host API Type Cleanup — Design

**Issue:** [#18](https://github.com/CraightonH/kaizen/issues/18)
**Date:** 2026-04-21
**Status:** Draft

## 1. Goal & scope

Resolve the two host-API type discrepancies flagged in issue #18 by deleting dead code. `CtxSecrets` and `CtxLog` are defined in `src/core/plugin-ctx-io.ts` and built by `createCtxIo`, but neither reaches `PluginContext`. The runtime surface uses `SecretsContext` (from `createSecretsContext`) and a flat `log(msg: string)` closure wired in `src/core/context.ts`. The "two shapes" documented in `docs/reference/host-api.md` are really one runtime shape plus one unused type per field.

### Non-goals

- No change to `SecretsContext` behavior or shape.
- No change to `ctx.log(msg)` behavior or shape.
- No introduction of structured logging. That is a future feature, not cleanup; it will get its own spec when there is demand.

## 2. Root cause

Traceable to two prior plans:

- `docs/superpowers/plans/2026-04-17-plugin-sandboxing-enforcer-core.md` introduced `CtxSecrets` (sync, env-backed `{get, has}`) and `CtxLog` (structured `{debug, info, warn, error}`) in `createCtxIo` and wired both into `PluginContext`. It explicitly deferred the structured-log decision to "Plan 3", with no tracking issue.
- `docs/superpowers/plans/2026-04-18-unified-plugin-config.md` replaced `ctx.secrets` with the async `SecretsContext` from `createSecretsContext`, but did not retire the old `CtxSecrets` type, its construction in `createCtxIo`, or its re-export.

The "Plan 3" follow-up for `CtxLog` never happened, so `io.log` has been dead code since its introduction. Result: both fields have a live runtime shape and a dead parallel shape.

## 3. Changes

### `src/core/plugin-ctx-io.ts`

- Delete the `CtxSecrets` interface.
- Delete the `CtxLog` interface.
- Remove `secrets` and `log` from the `CtxIo` interface.
- Remove the `io.secrets` and `io.log` constructions from `createCtxIo`. The function returns `{ fs, net, exec }` only.

### `src/types/plugin.ts`

- Update the re-export at line 21 to drop `CtxSecrets` and `CtxLog`. Final re-export: `CtxFs, CtxNet, CtxExec, CtxIo, ExecOpts, ExecResult`.

### `src/host-api.ts`

- Update the re-export at line 71 to drop `CtxSecrets` and `CtxLog`, matching the cleaned-up surface in `src/types/plugin.ts`.

### `src/core/plugin-ctx-io.test.ts`

- Remove any test cases exercising `io.secrets` or `io.log`. Keep fs/net/exec coverage unchanged.

### `docs/reference/host-api.md`

- Remove the `CtxSecrets` and `CtxLog` sections.
- Document `ctx.secrets` solely as `SecretsContext` (`{ get, refresh }`, async, provider-backed).
- Document `ctx.log` solely as `(msg: string) => void`.

### Downstream

Run `kaizen:update-docs` before finishing the branch to refresh any additional docs that reference the removed types.

## 4. Risk

- `CtxSecrets` and `CtxLog` are re-exported from `src/types/plugin.ts`, so they are technically part of the public plugin-facing type surface. Any external importer breaks on upgrade. This is acceptable because neither type was ever wired into `PluginContext`, so no plugin could have consumed them via `ctx.*`. External direct imports of the type names are the only failure mode and are expected to be zero or negligible.
- The `env.get` permission check embedded in `io.secrets.get` is deleted along with it. There are no consumers (the field was never plumbed into `ctx`), so removing the check has no runtime effect.

## 5. Testing

- `bun test` passes after dead-code test removal.
- No new tests are required. The change is pure deletion with no behavior change on any live code path.

## 6. Rollout

1. Land the implementation on `kaizen`.
2. Before finishing the development branch, run `kaizen:update-docs` per project convention.
3. No cross-repo coordination required. `kaizen-official-plugins` does not import `CtxSecrets` or `CtxLog` as types (verified by the fact that `io.secrets`/`io.log` were never wired to `PluginContext`, so plugins have no path to them).
