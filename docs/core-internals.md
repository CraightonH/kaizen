# Core Internals

*Read when: contributing to `src/core/`, debugging startup failures, or understanding
how the plugin loader, event bus, or registry implementations work.*

## Module map

```
src/core/
  index.ts            bootstrap() — public entry point
  loader.ts           Plugin resolution, topo-sort, setup() orchestration
  event-bus.ts        EventBus implementation
  tool-registry.ts    ToolRegistry (ajv validation, execute wrapper)
  executor-registry.ts ExecutorRegistry (singleton executor slot)
  ui-registry.ts      UiRegistry (singleton UI provider slot)
  context.ts          createPluginContext() — state-checked facade
  config.ts           kaizen.json loading, harness resolution, merging
  errors.ts           fatal / warn / debug
  llm.ts              Vercel AI SDK adapter
  stdin.ts            Shared readline queue
```

## bootstrap()

`src/core/index.ts` is the single public entry point for the runtime:

```typescript
await bootstrap(kaizenConfig, builtins);
```

1. Creates `EventBus`, `ToolRegistry`, `ExecutorRegistry`, `UiRegistry`.
2. Calls `loadPlugins()` → returns `{ lifecycleProvider, state }`.
3. Creates a `PluginContext` for the lifecycle provider.
4. Sets state to `RUNNING`.
5. Calls `lifecycleProvider.start(ctx)` — control passes to the lifecycle plugin.
6. Sets state to `CLOSED` in a `finally` block.

`builtins` is a `Record<string, KaizenPlugin>` populated by the CLI entrypoint
with statically-imported plugins. The loader checks builtins first before
attempting npm resolution, which allows the compiled binary to serve built-in
plugins without filesystem resolution.

## Plugin loader (`loader.ts`)

### Resolution order

For each plugin name in `config.plugins`:
1. Check `builtins[name]` — statically-imported built-in.
2. `createRequire(process.execPath).resolve(name, { paths: RESOLVE_PATHS })`.

`RESOLVE_PATHS` = `[bunGlobalRoot, npmGlobalRoot, cwd/node_modules]`.

Anchoring to `process.execPath` (not `import.meta.url`) is required for compiled
Bun binaries. See `docs/plugin-loading.md` for the full story.

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
including `undefined`. The lifecycle plugin inspects this array to implement
short-circuit logic (e.g. skip `execute()` if any handler returns a `ToolResult`).

Calling `on()` or `defineEvent()` outside the `INITIALIZING` state throws because
`createPluginContext()` wraps both calls with `assertInitializing()`.

## ToolRegistry (`tool-registry.ts`)

- `register(tool, pluginName)` — first registration wins; duplicates warn.
- `list()` — returns all registered tools as `ToolDefinition[]`.
- `execute(name, args)` — validates args via ajv, calls `tool.execute(args)`,
  wraps uncaught exceptions as `{ ok: false, error }`.

ajv is compiled with `{ coerceTypes: false, strict: false }`. Tool schemas can
use any valid JSON Schema.

## ExecutorRegistry + UiRegistry

Both are singleton slots: exactly one plugin may register, after which further
registrations throw. `get()` throws if called before registration (which cannot
happen at runtime since role validation ensures a provider exists before `start()`
is called).

## PluginContext (`context.ts`)

`createPluginContext()` returns an object that:
- Wraps `EventBus`, `ToolRegistry`, `ExecutorRegistry`, `UiRegistry`.
- Guards `registerTool`, `defineEvent`, `on`, `registerExecutor`, `registerUi`
  with `assertInitializing()` — all throw after `setup()` returns.
- Exposes `runtime.executor`, `runtime.ui`, `runtime.tools` via lazy getters
  that call `registry.get()` (throws if nothing registered yet).
- Prefixes all `log()` output with the plugin name.

Each plugin gets its own context instance with its own config slice.

## Config system (`config.ts`)

### Loading order (highest → lowest priority)
1. CLI flags (`--harness`, `--config`, `--allow-destructive`)
2. Local `kaizen.json` in the current directory
3. Harness `kaizen.json` (from `extends` or `--harness`)

### Harness resolution

`--harness` and `extends` accept:
1. **Built-in short name** → `<kaizen-repo>/harnesses/<name>/kaizen.json`
2. **Local path** → `./path/to/kaizen.json` or `./path/to/folder/` (reads `kaizen.json` inside)
3. **URL** → fetched at startup (TODO: implement in `config.ts`)

### Config merge

Local overlays harness:
- `plugins` array: local wins entirely if present.
- Plugin config objects: shallow merge, local wins on key conflicts.
- `extends`: consumed during resolution, not passed to plugins.

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

## Adding a new built-in plugin

1. Create `plugins/<name>/index.ts` and `plugins/<name>/package.json`.
2. Import it statically in `src/cli.ts` and add it to the `builtins` map.
3. If it introduces new config keys, add defaults to `kaizen init` in `src/cli.ts`
   and to the `core-anthropic` harness in `harnesses/core-anthropic/kaizen.json`.
4. Add it to the `plugins` array of whichever harnesses should include it.
