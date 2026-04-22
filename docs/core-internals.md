# Core Internals

*Read when: contributing to `src/core/`, debugging startup failures, or understanding
how the plugin loader, event bus, or registry implementations work.*

## Module map

```
src/core/
  index.ts            bootstrap() — public entry point
  loader.ts           Plugin resolution, topo-sort, setup() orchestration
  event-bus.ts        EventBus implementation
  service-registry.ts     ServiceRegistry — string-keyed define/provide/consume/use
  context.ts          createPluginContext() — state-checked facade
  config.ts           kaizen.json loading, harness resolution, merging
  errors.ts           fatal / warn / debug
  llm.ts              Vercel AI SDK adapter
  stdin.ts            Shared readline queue
```

## bootstrap()

`src/core/index.ts` is the single public entry point for the runtime:

```typescript
await bootstrap(kaizenConfig, lockfilePath);
```

`lockfilePath` is required — callers derive it from the resolved harness's
`kaizen.json` path via `deriveLockfilePath(harnessJsonPath)` in
`src/core/lockfile-path.ts`. There is no `process.cwd()` fallback and no
environment-variable override.

1. Creates `EventBus`, `ServiceRegistry`.
2. Calls `loadPlugins()` → returns `{ driver, state }`.
3. Creates a `PluginContext` for the driver plugin.
4. Sets state to `RUNNING`.
5. Calls `driver.start(ctx)` — control passes to the driver plugin.
6. Sets state to `CLOSED` in a `finally` block.

All plugins are resolved from canonical marketplace refs or local paths — the
core binary ships with no built-in plugins.

## Plugin loader (`plugin-manager.ts`)

### Resolution order

For each plugin name in `config.plugins`:
1. If `name` parses as a canonical marketplace ref
   (`<marketplace>/<name>@<version>`), load from
   `~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/` via absolute-path
   `import()`. Entry point comes from `package.json` (`module` or `main`).
2. If `name` starts with `./`, `../`, or `/`, treat as a local path.
3. Otherwise: fail with a helpful error.

There is no `node_modules` involvement, no `npm`/`bun` global lookup, and no
bare-name authored-plugin fallback.

### Topological sort

Implemented with Kahn's algorithm. `depends[]` entries are resolved to plugin
names (via role→plugin lookup) before building the adjacency graph. Missing
dependencies are warned about but do not abort the sort. Cycles → fatal error.

### setup() error handling

If a plugin that provides a **required role** throws from `setup()`:
- Fatal: surface the original error with plugin name and role.

If a plugin that provides no required role throws:
- Log the error, skip the plugin, continue loading others.

"Required role" = any role that appears in another loaded plugin's `depends[]`.

### Role validation

Runs after all `setup()` calls complete. For every role in any plugin's
`depends[]`: exactly one loaded plugin must provide it. Zero or two+ → fatal.

### Unclaimed config keys

After role validation, core warns on any `kaizen.json` key that no loaded plugin
claimed as its config namespace. Helps catch typos in plugin names.

## EventBus (`event-bus.ts`)

```typescript
bus.defineEvent("tool:before");       // advisory; suppresses unknown-event warnings
bus.on("tool:before", handler);       // subscribe
await bus.emit("tool:before", ctx);   // fires all handlers serially, returns results[]
```

`emit()` always runs every registered handler, even if an early handler throws or
returns a non-void value. Handler errors are caught, logged to stderr, and
execution continues with the next handler.

The return value of `emit()` is an array of every handler's return value,
including `undefined`. The driver plugin inspects this array to implement
short-circuit logic (e.g. skip `execute()` if any handler returns a `ToolResult`).

Calling `on()` or `defineEvent()` outside the `INITIALIZING` state throws because
`createPluginContext()` wraps both calls with `assertInitializing()`.

## ServiceRegistry (`service-registry.ts`)

- `define(name, ownerPlugin, spec)` — declares a service. `name` must be
  prefixed with the owning plugin's name (e.g. `core-driver:executor`).
  Duplicate definitions by the same plugin warn; a different plugin claiming an
  already-owned name is a fatal error.
- `provide(name, pluginName, impl)` — registers the implementation. Only valid
  during `INITIALIZING`. Throws if the service was not defined first, or if a
  provider is already registered (cardinality-one enforcement).
- `consume(name, pluginName)` — records consumer intent for topo-sort and
  post-init validation. Valid only during `INITIALIZING`.
- `use(name)` — returns the registered implementation by reference. Valid in
  any state after `INITIALIZING` completes. Throws if no provider is registered.
- `validateAll()` — run after all `setup()` calls. Fatal if any consumed service
  has no provider, or if any defined service has zero providers.

## PluginContext (`context.ts`)

`createPluginContext()` returns an object that:
- Wraps `EventBus`, `ServiceRegistry`.
- Guards `defineService`, `provideService`, `consumeService`, `defineEvent`,
  and `on` with `assertInitializing()` — all throw after `setup()` returns.
- Guards `useService` with an `assertRunning()` check — throws during
  `INITIALIZING` when providers may not have registered yet.
- Exposes `runtime.pluginManager` for hot-reload support
  (`drainPendingReloads()`).
- Prefixes all `log()` output with the plugin name.

Each plugin gets its own context instance with its own config slice.

## Config system (`config.ts`)

### Named harness required

Every invocation must resolve to a named harness, via `--harness` on the CLI
or an `extends` field in the local / global `kaizen.json`. A bare
`kaizen.json` with neither is an error:

```
A named harness is required.
See docs/concepts/harnesses.md.
```

### Harness resolution

`resolveHarness(nameOrPath)` returns `{ kaizenJsonPath, config }`. It tries,
in order:

1. Project-scoped bare name → `.kaizen/harnesses/<name>/kaizen.json`
2. Home-scoped bare name → `~/.kaizen/harnesses/<name>/kaizen.json`
3. Explicit local path (`./`, `../`, `/`) → the kaizen.json at that path
4. Raw URL → rejected (use a marketplace ref instead)

Marketplace refs (`<id>/<name>@<version>`) are handled upstream in
`src/core/kaizen-config.ts` by `materializeHarnessRef`, which installs the
harness into `~/.kaizen/marketplaces/<id>/harnesses/<name>/` before passing
the resulting absolute path to `resolveHarness`.

### Config merge

Local overlays harness:
- `plugins` array: local wins entirely if present.
- Plugin config objects: shallow merge, local wins on key conflicts.
- `extends`: consumed during resolution, not passed to plugins.

### Per-harness lockfile path

Callers (CLI entry points) derive the lockfile path from the resolved
harness via `deriveLockfilePath(kaizenJsonPath)` — `permissions.lock` sits
next to the harness's `kaizen.json`. See
[docs/concepts/harnesses.md](concepts/harnesses.md#state-files) for path
patterns and the re-materialization preservation rule.

## LLM adapter (`llm.ts`)

`createLLMRuntime(config)` returns an `Executor` backed by the Vercel AI SDK.
Supports Anthropic and any OpenAI-compatible endpoint via adapter selection.

Message conversion (`toAiSdkMessages`):
- `system`/`user` → direct passthrough
- `assistant` with tool_calls → multipart content with `tool-call` parts
- `tool` → `tool-result` content (AI SDK v6 shape)

Tool conversion (`toAiSdkTools`):
- Uses `dynamicTool({ description, inputSchema: jsonSchema(params) })`
- The AI SDK never calls `execute()` — kaizen's `ToolRegistry` handles execution

## stdin (`stdin.ts`)

A single shared readline interface for the process. Both `core-ui-terminal` and
`core-executor-debug` import `readStdinLine()` from here. This prevents two
readline instances from fighting over stdin. The queue delivers lines FIFO to
whichever caller is waiting.

`core-cli`'s destructive-guard confirmation prompt also uses `readStdinLine()`.
