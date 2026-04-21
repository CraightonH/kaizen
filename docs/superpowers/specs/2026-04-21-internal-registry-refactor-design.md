# Internal Registry Refactor — Design

**Issue:** [#21](https://github.com/CraightonH/kaizen/issues/21)
**Date:** 2026-04-21
**Status:** Draft

## 1. Goal & scope

Collapse `UIRegistry`, `ExecutorRegistry`, and `ToolRegistry` into `CapabilityRegistry`. Remove core's knowledge of UI, executor, and tool as distinct concepts. Align the implementation with the platform contract: **core holds one opinion — the lifecycle driver hand-off — and everything else is plugin-to-plugin.**

The specialized registries are pre-`CapabilityRegistry` holdovers. `CapabilityRegistry` already models everything they provide (named providers, cardinality rules, lookup by name), so the specialized registries are duplication from the era when "roles" were a first-class concept.

### Non-goals

- Changing `CapabilityRegistry`'s behavior (validation semantics, lookup, registration payload) beyond the deletions described here.
- Defining or implementing an LLM tool-calling runtime. Tool-calling moves to a future broker plugin; this spec only removes tools from core.
- Auto-deriving JSON Schemas from TypeScript types.

## 2. Architecture after the refactor

### Core owns

- `CapabilityRegistry` — named providers, cardinality rules, provides/consumes validation, lookup by name.
- `PluginContext.registerService(Token, impl)` — the one registration primitive for implementations.
- `PluginContext.registerCapability(decl)` — capability declaration (unchanged).
- Lifecycle hand-off: identify the `lifecycle: true` plugin, call its `start()`.

### Core does not own

- Any concept of "executor", "UI", or "tool".
- Typed registry accessors for those concepts.
- `registerUi()` / `registerExecutor()` / `registerTool()` on `PluginContext`.
- Well-known capability names. Core enshrines zero strings.

### Plugins own

- **Driver plugin (`core-lifecycle`):** defines whatever naming convention it wants to consume (e.g. `kaizen.ui`, `kaizen.executor`), documents it, resolves those names at runtime via `CapabilityRegistry`. Owns typed helpers over the registry for its own internal use. Plugins that want to be consumed by this driver conform to its documented names.
- **Executor plugins:** declare a capability with the name the driver expects; register their implementation via `registerService`; when an LLM tool-calling ecosystem exists, consume a broker plugin to enumerate and dispatch tools.
- **UI plugins:** declare a capability with the name the driver expects; register their implementation via `registerService`.
- **Tool broker (`core-tools`, future):** owns the tool concept entirely. Exposes a capability whose API lets other plugins register tools and lets executors enumerate/dispatch them. Not part of this spec's scope; lands when tool-calling is reintroduced.

### Why core doesn't enshrine capability names

A prior draft had `core-lifecycle` document well-known names like `kaizen.ui` that core itself referenced. That was the same violation wearing a string: if core depends on the name `kaizen.ui`, core holds an opinion about UI. The fix is that driver plugins define their own naming conventions. A different driver plugin (e.g., a batch runner or alternative harness) can use entirely different names and structure, and core is indifferent.

## 3. Capability shape

Unchanged from the current `CapabilityRegistry` spec. Capability declarations consist of a name, optional `provides`/`consumes` edges, and an associated service implementation registered separately via `registerService`. No new fields are added.

## 4. PluginContext surface changes

### Removed

- `ctx.registerUi(impl)`
- `ctx.registerExecutor(impl)`
- `ctx.registerTool(...)`

### Retained (unchanged)

- `ctx.registerService(Token, impl)` — DI registration
- `ctx.registerCapability(decl)` — capability declaration

### Runtime surface (`ctx.runtime`)

- Removed: `runtime.ui`, `runtime.executors`, `runtime.tools`.
- Retained: `runtime.capabilities` (the `CapabilityRegistry` lookup surface).

## 5. Migration & affected code

### In `kaizen` (this repo)

- Delete `src/core/ui-registry.ts` (and tests).
- Delete `src/core/executor-registry.ts` (and tests).
- Delete `src/core/tool-registry.ts` (and tests).
- Remove `registerUi`, `registerExecutor`, `registerTool` from `PluginContext` and its type definition.
- Remove `runtime.ui`, `runtime.executors`, `runtime.tools` from the runtime surface exposed to plugins.
- Update `bootstrap.ts` / `context.ts` to stop instantiating the deleted registries.

### In `kaizen-official-plugins`

- **`core-lifecycle`:** replace `ctx.runtime.executors.getFirst()` and `ctx.runtime.ui.getFirst()` with internal helpers over `ctx.runtime.capabilities`, consuming the well-known names core-lifecycle documents for its ecosystem. Typed accessors live inside this plugin, not on `runtime`.
- **Executor plugins** (`core-executor-anthropic`, `core-executor-openai`, `core-executor-debug`, `core-executor-shell`): replace `ctx.registerExecutor(impl)` with `ctx.registerService(ExecutorToken, impl)` plus a `ctx.registerCapability(...)` declaration providing the name core-lifecycle consumes.
- **`core-ui-terminal`:** replace `ctx.registerUi(impl)` with the same pattern — `registerService` + capability declaration under the name core-lifecycle consumes.
- **Tool broker plugin:** deferred. Not required for this refactor to land. Tool support is removed from core; when tool-calling is reintroduced, it lands in a new `core-tools` broker plugin with its own spec.

### Cross-repo coordination

This is a breaking change to the plugin-authoring surface. The kaizen PR and the kaizen-official-plugins PR must land together, or kaizen merges first with a version bump and the plugins repo updates immediately after. No intermediate state is compatible.

## 6. Testing

- Delete the tests for the removed registries (`ui-registry.test.ts`, `executor-registry.test.ts`, `tool-registry.test.ts`).
- `CapabilityRegistry` tests unchanged — no behavior change.
- Add an integration test in `src/core/integration/` that loads a driver plugin consuming a UI-named capability and an executor-named capability, verifies resolution via `CapabilityRegistry` lookup, and verifies a fatal error when cardinality is violated (two providers of a cardinality-1 name).
- On the official-plugins side, update existing integration tests to use the new registration shape and confirm plugin load + driver hand-off still work end to end.

## 7. Rollout

1. Land kaizen PR (this spec's implementation) with cross-repo note in the PR description.
2. Simultaneously land the kaizen-official-plugins PR updating all four executor plugins, the terminal UI plugin, and core-lifecycle.
3. Before finishing the development branch, run `kaizen:update-docs` to refresh any docs affected by the behavior/API change.
4. Follow-on work: [#22](https://github.com/CraightonH/kaizen/issues/22) (driver rename) and a separate spec for the `core-tools` broker plugin when tool-calling is reintroduced.
