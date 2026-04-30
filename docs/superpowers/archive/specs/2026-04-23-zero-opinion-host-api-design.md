# Zero-Opinion Host API

**Issue:** [#43](https://github.com/CraightonH/kaizen/issues/43) (closes), [#42](https://github.com/CraightonH/kaizen/issues/42) (closes as a side effect)

## Goal

Kaizen core holds exactly one opinion: one plugin is the session driver and
receives `start()`. Everything else belongs to plugins. Today the host API
still leaks pre-ServiceRegistry role language and baked-in runtime conveniences
that violate that contract. This change finishes the cut.

After this change, `src/host-api.ts` exports only the plugin contract itself
(`KaizenPlugin`, `PluginContext`, permissions, services, marketplace types) plus
`PLUGIN_API_VERSION`. No LLM runtime, no stdin helper, no `Executor` / `UiChannel`
shapes. The Vercel AI SDK dependencies leave `package.json`.

## Changes

### 1. Add a `stop()` lifecycle hook

`KaizenPlugin` gains an optional `stop?(ctx: PluginContext): Promise<void>`.
`PluginManager.unload()` awaits it before deregistering events, services, and
permissions. `runHarness` unloads all plugins in a `finally` block after
`driver.start()` returns.

This is load-bearing for the rest of the change. Any plugin that opens a
process-wide resource (readline on stdin, network listeners, timers, file
watchers) needs a symmetric teardown point. The lifecycle today is
`setup()` → optional `start()` → nothing, which is why
[#42](https://github.com/CraightonH/kaizen/issues/42) exists: core's
module-level readline interface is never closed because nothing in the
contract says "clean up."

Adding `stop()` also makes `unload()` honest. It already claims to unload a
plugin, but without calling plugin code it can only undo what core tracked —
not what the plugin itself allocated.

### 2. Delete stale role types from `src/types/plugin.ts`

The following types have zero references in kaizen core and zero references in
`kaizen-official-plugins`. They are direct artifacts of the pre-ServiceRegistry
era when core enumerated plugin roles:

- `UiChannel`
- `UiProvider`
- `UserMessage`
- `AgentMessage`
- `Executor`

Delete them and their re-exports from `src/host-api.ts`.

### 3. Remove `createLLMRuntime` and LLM primitive types from core

`createLLMRuntime` in `src/core/llm.ts` is a baked-in opinion that "core knows
how to talk to LLMs." The function itself, the AI SDK imports, and the
primitive types it uses (`Message`, `MessageRole`, `ToolDefinition`,
`ToolResult`, `ToolCall`, `LLMResponse`, `LLMStreamChunk`) all leave core.

Nothing in `kaizen-official-plugins` imports `createLLMRuntime` or any of
these types today, so the blast radius is limited to the core codebase and
its tests.

Concretely:
- Delete `src/core/llm.ts`.
- Delete the LLM primitive types from `src/types/plugin.ts`.
- Drop `createLLMRuntime` from `hostApi` in `src/host-api.ts` and its type
  re-exports.
- Remove `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai` from `package.json`.
- Delete or update any core tests that exercised `createLLMRuntime`.

Downstream consumers that want an LLM runtime implement one in a plugin and
expose it as a service with a contract of their own choosing. Core has no
opinion on message shape, tool shape, or provider shape.

### 4. Remove `readStdinLine` from the host API

`readStdinLine` in `src/core/stdin.ts` is a coordination singleton — one
readline interface shared across plugins so they don't fight over stdin. It
is not a sandbox boundary: `process.stdin` is not intercepted (README "Honest
limits"), and `readline` / `node:readline` are not in the forbidden-imports
set. Any TRUSTED plugin today could import readline directly; the sandbox
would not stop it.

The coordination value only makes sense if core is prescribing "plugins read
stdin this way," which is exactly the kind of opinion this change removes.

Concretely:
- Delete `src/core/stdin.ts`.
- Drop `readStdinLine` from `hostApi` and its export in `src/host-api.ts`.
- CLI commands (`src/commands/install.ts`, `src/commands/marketplace-create.ts`,
  `src/commands/plugin-create.ts`, `src/commands/config.ts`) run as the kaizen
  binary itself, not as sandboxed plugin code. They keep using `process.stdin`
  directly; if they want line-reading, they carry their own small readline
  helper colocated with the CLI layer (not in `core/`).

This intentionally leaves a gap: any plugin that wants to read stdin has to
implement it itself, and plugin authors coordinate by making one plugin own
stdin and expose it as a service. That gap will be recorded as a follow-up
issue in `kaizen-official-plugins` so whichever official plugin needs it can
pick it up. Kaizen core has no need to prescribe where that lands.

### 5. Final shape of `src/host-api.ts`

Runtime exports:

- `PLUGIN_API_VERSION`

Type-only exports (the plugin contract):

- `KaizenPlugin`, `KaizenConfig`, `KaizenGlobalConfig`
- `PluginContext`
- `PluginPermissions`, `PermissionTier`, `PermissionOp`
- `PluginServices`, `ServiceSpec`, `EventHandler`
- `PluginConfigDeclaration`, `SecretRef`, `StructuredSecretRef`, `SecretsContext`
- `MarketplaceCatalog`, `MarketplaceEntry`, `MarketplacePluginEntry`,
  `MarketplaceHarnessEntry`, `MarketplaceRef`, `PluginSource`,
  `PluginVersionEntry`, `HarnessVersionEntry`
- `PluginManagerPublicApi`, `PluginManagerLifecycleApi`, `PluginEntry`
- `JsonSchema`
- `CtxFs`, `CtxNet`, `CtxExec`, `CtxIo`, `ExecOpts`, `ExecResult`
- `SecretProvider`

That is the whole API surface. No executor shape, no LLM shape, no UI shape,
no stdin helper.

## Breaking changes

This is a breaking change for any downstream that imports from `kaizen/types`:

- Removed runtime exports: `createLLMRuntime`, `readStdinLine`.
- Removed type exports: `UiChannel`, `UiProvider`, `UserMessage`, `AgentMessage`,
  `Executor`, `Message`, `MessageRole`, `ToolDefinition`, `ToolResult`,
  `ToolCall`, `LLMResponse`, `LLMStreamChunk`.

Known consumer in the ecosystem: `kaizen-official-plugins/plugins/driver`
imports `readStdinLine`. It will need a coordinated update (driver picks up
stdin ownership, or consumes a new stdin-provider plugin) in the same
release wave.

`PLUGIN_API_VERSION` bumps to `3` because the plugin contract surface changed
and existing plugins compiled against `2` may fail to import removed symbols.

## Testing

- `src/core/plugin-manager.test.ts` — add cases for `stop()`: called on
  unload, awaited, errors logged but do not block deregistration; unload
  still succeeds if a plugin has no `stop()`.
- `runHarness` integration test — verify all loaded plugins are unloaded
  after `driver.start()` returns; verify `stop()` is called.
- Regression for [#42](https://github.com/CraightonH/kaizen/issues/42):
  a minimal harness where the driver plugin owns an open resource (mock
  readline or a timer) exits cleanly when `start()` returns under a TTY-like
  condition.
- Remove `src/core/llm.test.ts` (if present) and any host-api tests that
  assert `createLLMRuntime` / `readStdinLine` re-exports.
- `src/core/host-api-register.test.ts` — update to cover the new, smaller
  runtime surface.

## Non-goals

- Designing a canonical LLM-runtime plugin or stdin-provider plugin. Those
  live in `kaizen-official-plugins` and will be raised there as separate
  issues. This design only removes what core shouldn't own.
- Hardening stdin. `process.stdin` remains un-intercepted; `readline`
  remains importable. If kaizen later decides to gate these, that is a
  separate security-tier conversation.
- Changing `PluginContext`'s permission-enforced I/O surface
  (`ctx.fs` / `ctx.net` / `ctx.exec` / `ctx.secrets`). Those are *how*
  permissions are enforced, not domain opinions about what plugins do.
