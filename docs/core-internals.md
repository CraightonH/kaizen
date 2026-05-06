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
  config.ts           Harness kaizen.json loading and resolution (global user config is in kaizen-config.ts)
  errors.ts           fatal / warn / debug
```

Core ships with no LLM adapter and no shared stdin queue — both used to live
here and have been removed. Plugins that want those capabilities publish
them as services; consumer plugins obtain them via `ctx.useService`.

## bootstrap()

`src/core/index.ts` is the single public entry point for the runtime:

```typescript
await bootstrap(kaizenConfig, lockfilePath, harness?);
```

`lockfilePath` is required — callers derive it from the resolved harness's
`kaizen.json` path via `deriveLockfilePath(harnessJsonPath)` in
`src/core/lockfile-path.ts`. There is no `process.cwd()` fallback and no
environment-variable override.

`harness` is optional and supplies raw identity metadata that surfaces on
every plugin's `ctx.harness` (see
[`reference/plugin-api.md`](reference/plugin-api.md#plugincontext-setup-argument)).
Both inner fields are individually optional; omit the arg entirely (default
`{}`) when no metadata is known:

```typescript
await bootstrap(kaizenConfig, lockfilePath, {
  jsonPath: harnessJsonPath,           // absolute path to the resolved kaizen.json
  ref: userSuppliedRef,                // user-facing ref string (e.g. "official/openai-compatible@1.2.3")
});
```

`bootstrap()` is a convenience wrapper around `runHarness(opts)`. Embedders
that need to inject a `PermissionEnforcer` should call `runHarness` directly:

```typescript
await runHarness({ kaizenConfig, lockfilePath, harness, enforcer });
```

1. Creates `EventBus`, `ServiceRegistry`.
2. Calls `loadPlugins()` → returns `{ driver, state }`.
3. Creates a `PluginContext` for the driver plugin (populates `ctx.harness`).
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
including `undefined`. The driver plugin (or any other emitter) inspects
this array to implement short-circuit logic — for example, letting a
`tool:before` handler preempt execution by returning a result object.

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

## Config system

Kaizen has two distinct config layers; each lives in a separate module.

### User global config (`kaizen-config.ts`)

`~/.kaizen/kaizen.json` — the only user-editable config file. Schema:

```json
{
  "defaults": { "harness": "<ref>", "plugin_config": { "<plugin>": { ... } } },
  "marketplaces": [ ... ],
  "marketplaceUpdateTTL": 900
}
```

`loadKaizenGlobalConfig()` validates the schema strictly: `plugins`, `extends`, `default_harness`, `plugin_config` at top level, or any unknown key, is a fatal error. See [`docs/concepts/configuration.md`](concepts/configuration.md) for the full schema and migration notes.

### Harness config and resolution (`config.ts`)

Every invocation must resolve to a harness. The active harness is chosen by:
1. `--harness` on the CLI
2. `defaults.harness` in `~/.kaizen/kaizen.json`

`resolveHarness(nameOrPath)` returns `{ kaizenJsonPath, config }`. It tries,
in order:

1. Project-scoped bare name → `.kaizen/harnesses/<name>/kaizen.json`
2. Home-scoped bare name → `~/.kaizen/harnesses/<name>/kaizen.json`
3. Explicit local path (`./`, `../`, `/`) → the `kaizen.json` at that path
4. Raw URL → rejected (use a marketplace ref instead)

Marketplace refs (`<id>/<name>@<version>`) are handled upstream in
`src/core/kaizen-config.ts` by `materializeHarnessRef`, which installs the
harness into `~/.kaizen/marketplaces/<id>/harnesses/<name>/` before passing
the resulting absolute path to `resolveHarness`.

### Effective plugin config (`config-merge.ts`)

For each plugin `P` in the active harness:

```
effective_config(P) = { ...plugin_declared_defaults, ...harness_defaults, ...user_plugin_config }
```

`defaults.plugin_config[P]` from `~/.kaizen/kaizen.json` wins over harness defaults. Harness defaults win over the plugin's own declared defaults.

### Per-harness lockfile path

Callers (CLI entry points) derive the lockfile path from the resolved
harness via `deriveLockfilePath(kaizenJsonPath)` — `permissions.lock` sits
next to the harness's `kaizen.json`. See
[docs/concepts/harnesses.md](concepts/harnesses.md#state-files) for path
patterns and the re-materialization preservation rule.

## Plugin unload and `stop()`

`PluginManager.unloadAll()` walks loaded plugins in reverse insertion order
(consumers before providers) and, for each, invokes the optional
`plugin.stop(ctx)` hook before the manager deregisters that plugin's
events, services, and permissions. `stop()` runs inside `runInPluginScope`
so the same `ctx` used during `setup`/`start` is still valid — permissions
are live and services can still be `use`d.

Errors thrown from `stop()` are caught, logged as warnings, and do not
block deregistration of the rest of the plugin. `runHarness` calls
`unloadAll()` in its `finally` block (before `auditLog.flush()`), so a
normal shutdown always gives each plugin a chance to release its
resources. This is the symmetric half of the `setup`/`start` lifecycle and
the correct place to close readlines, unsubscribe listeners, stop timers,
dispose file watchers, and so on.
