# Rename `lifecycle` → `driver` (driver-plugin sense)

**Date:** 2026-04-21
**Issue:** #22
**Status:** Approved

---

## Context

The platform contract calls the plugin that receives `start()` the **session driver**. However, the manifest flag, internal variables, error messages, plugin name, and much of the docs still use **lifecycle** — a holdover from earlier drafts. This rename brings the code vocabulary into alignment with the concept as it is actually documented.

Generic lifecycle language ("plugin lifecycle", "valid at any lifecycle state") is **not** changed — only driver-plugin-sense usages.

---

## Scope boundary

**Renamed:** anything identifying the one plugin that drives a kaizen session.

**Untouched:**
- Generic lifecycle terminology in docs and comments
- `docs/superpowers/` — historical archive, no changes
- Any other plugin concept

---

## TypeScript changes (`kaizen` repo)

### `src/types/plugin.ts`

| Old | New |
|-----|-----|
| `lifecycle?: boolean` on `KaizenPlugin` | `driver?: boolean` |
| JSDoc on the field | Updated to use "driver" terminology |
| Example event string `"core-lifecycle:tool:before"` | `"core-driver:tool:before"` |

### `src/core/plugin-manager.ts`

| Old | New |
|-----|-----|
| `plugin.lifecycle === true` | `plugin.driver === true` |
| `lifecyclePluginNames` | `driverNames` |
| `lifecycleName` | `driverName` |
| `lifecycleProvider` | `driver` |
| `initialize(): Promise<{ lifecycleProvider }>` | `initialize(): Promise<{ driver }>` |
| `"No lifecycle plugin found. A plugin with 'lifecycle: true' must be loaded."` | `"No driver plugin found. A plugin with 'driver: true' must be loaded."` |
| `"Multiple lifecycle plugins loaded: ..."` | `"Multiple driver plugins loaded: ..."` |
| `"A harness may have exactly one plugin with 'lifecycle: true'."` | `"A harness may have exactly one plugin with 'driver: true'."` |
| `"declares 'lifecycle: true' but does not export a start() function"` | `"declares 'driver: true' but does not export a start() function"` |

### `src/core/index.ts`

| Old | New |
|-----|-----|
| `lifecycleProvider` (variable, destructuring, all usages) | `driver` |
| `lifecycleConfig` | `driverConfig` |

### `src/cli.ts`

| Old | New |
|-----|-----|
| `"official/core-lifecycle@0.1.0"` | `"official/core-driver@0.1.0"` |

---

## Test changes (`kaizen` repo)

### `src/core/plugin-manager.test.ts`

- Fixture plugin name `"core-lifecycle"` → `"core-driver"`
- Fixture plugin name `"fixture-lifecycle"` → `"fixture-driver"`
- Fixture spec field `lifecycle?: boolean` → `driver?: boolean`
- Variable `lifecycleProvider` → `driver`
- Error message assertions updated to match new strings
- Test description strings updated ("lifecycle plugin" → "driver plugin", `lifecycle:true` → `driver:true`)

### `src/core/manifest-synthesizer.test.ts`

- Event string `"core-lifecycle:tool:before"` → `"core-driver:tool:before"`

### `src/core/plugin-hash.test.ts`

- Event string `"core-lifecycle:tool:before"` → `"core-driver:tool:before"`

### Other test files

- `capability-registry.test.ts`, `orchestration.test.ts`, `harness-marketplace.test.ts`, `permission-enforcer.test.ts`, `uac-renderer.test.ts` — search for driver-sense lifecycle usages and update.

---

## Docs changes (`kaizen` repo)

Affected files: `docs/concepts/architecture.md`, `docs/concepts/platform.md`, `docs/concepts/plugin-model.md`, `docs/concepts/harnesses.md`, `docs/concepts/security.md`, `docs/guides/plugin-authoring.md`, `docs/guides/contributing.md`, `docs/core-internals.md`.

Changes:
- `lifecycle: true` flag references → `driver: true`
- Plugin name `core-lifecycle` → `core-driver`
- Variable name `lifecycleProvider` in prose → `driver`
- Event strings `"core-lifecycle:*"` → `"core-driver:*"`
- kaizen.json examples updated to use `core-driver` as the config key

Generic lifecycle language ("plugin lifecycle", "lifecycle state", "lifecycle hooks") is left as-is.

---

## `kaizen-official-plugins` repo (coordinated PR)

Merged immediately after the kaizen PR lands.

- Directory `core-lifecycle/` → `core-driver/`
- Plugin default export: `lifecycle: true` → `driver: true`
- Plugin `name` field: `"core-lifecycle"` → `"core-driver"`
- Any event subscriptions referencing `"core-lifecycle:*"` → `"core-driver:*"`

---

## Breaking change

`lifecycle: true` on a plugin's default export stops resolving. Every plugin that used to declare `lifecycle: true` must be updated to `driver: true` before it will be recognized as the session driver, producing a fatal startup error otherwise.

Blast radius is contained: no public release exists and the only consumer is `kaizen-official-plugins`, updated in the coordinated PR.

---

## Order of operations

1. Land #21 (registry refactor) first — independent, no conflicts expected.
2. Open kaizen rename PR (this spec).
3. Open `kaizen-official-plugins` PR simultaneously, targeting the kaizen commit that introduces `driver: true`.
4. Merge kaizen PR, then merge plugins PR.
