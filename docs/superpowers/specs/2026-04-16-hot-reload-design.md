# Plugin Hot-Reload Design

*Date: 2026-04-16*

## Goal

Enable plugins to be loaded, unloaded, and reloaded at runtime without restarting
a session. Motivated by the Meta-Harness pattern: the LLM identifies a missing
capability, writes a plugin, loads it, and has it available immediately within the
same session.

## Decisions

- **Turn boundary reload:** reloads apply after the current turn completes, before
  the next `channel.receive()`. No mid-turn disruption.
- **LLM trigger:** the LLM calls a tool (`kaizen_reload_plugin`) to queue a reload.
  Any plugin may also call `ctx.pluginManager.queueReload()` programmatically.
- **PluginManager is a core primitive:** instantiated by `bootstrap()`, not a
  plugin. Always present. Not replaceable (but the LLM-facing tool surface is).
- **LLM tool surface is a plugin:** `core-plugin-manager` registers the reload
  tools. Drop or replace it to change what the LLM can do with plugins.
- **Role swapping:** API is designed to support it; enforcement is deferred.
  `load()` and `unload()` work on role-providing plugins — behavior for
  active roles is documented but not constrained by core.
- **Graceful failure:** a failed reload leaves the plugin unloaded. The session
  continues. Required-role provider failure warns loudly but does not crash.

---

## Architecture

### PluginManager (`src/core/plugin-manager.ts`)

New class. Absorbs the resolution, topo-sort, and setup logic currently in
`src/core/loader.ts`. Adds hot-reload on top.

```
PluginManager
  initialize(config, builtins)   startup path — replaces loadPlugins()
  load(name)                     resolve → setup → register
  unload(name)                   deregister from all registries → mark unloaded
  reload(name)                   unload + load immediately (used by drain)
  queueReload(name)              add to pendingReloads set
  drainPendingReloads()          process queue; called by lifecycle between turns
  list()                         return PluginEntry[] of all known plugins
```

### Registry changes

All five registries add `deregisterByPlugin(pluginName: string)`:

- `ToolRegistry` — removes tools registered by that plugin
- `EventBus` — removes event handlers subscribed by that plugin
- `ServiceRegistry` — removes services registered by that plugin
- `ExecutorRegistry` — removes executor if registered by that plugin
- `UiRegistry` — removes UI provider if registered by that plugin

### Per-plugin state for re-initialization

`createPluginContext` gains a per-plugin state getter (separate from global
`CoreState`). Guards on `registerTool`, `on`, `defineEvent`, etc. check
plugin-local state. During reload, plugin-local state is set to `INITIALIZING`
while `setup()` runs; global state stays `RUNNING`.

---

## Data Flow

### Startup (unchanged from author perspective)

```
bootstrap()
  → PluginManager.initialize(config, builtins)
      resolve → topo-sort → setup() each plugin    [INITIALIZING]
      role validation
      state = READY
  → lifecycle.start(ctx)                            [RUNNING]
      loop:
        receive → executor.send() → tool calls → send response
        → ctx.runtime.pluginManager.drainPendingReloads()
```

### Reload flow

```
LLM calls kaizen_reload_plugin({ name: "my-plugin" })
  → ctx.pluginManager.queueReload("my-plugin")
  → tool returns { ok: true, output: "queued for reload at next turn boundary" }

Turn completes → core-lifecycle calls drainPendingReloads()
  → unload "my-plugin":
      deregisterByPlugin("my-plugin") on each registry
  → load "my-plugin":
      resolvePlugin("my-plugin")           re-reads from disk
      validate deps still satisfied
      setup(ctx) with plugin-local state = INITIALIZING
      plugin-local state → READY
  → pendingReloads.clear()

Next turn begins with new plugin active
```

### Failed reload

```
unload succeeds → load fails
  → plugin stays unloaded, status = "failed"
  → warn logged; session continues
  → if plugin provided a required role: warn loudly, do not crash
```

---

## API Contracts

### `PluginContext` additions

```typescript
interface PluginContext {
  pluginManager: {
    load(name: string): Promise<void>;
    unload(name: string): Promise<void>;
    reload(name: string): Promise<void>;   // immediate
    queueReload(name: string): void;       // deferred to turn boundary
    list(): PluginEntry[];
  };
}

interface PluginEntry {
  name: string;
  apiVersion: string;
  provides: string[];
  status: "loaded" | "unloaded" | "failed";
}
```

### `RuntimeContext` additions

```typescript
interface RuntimeContext {
  // existing: executor, ui, tools
  pluginManager: {
    drainPendingReloads(): Promise<void>;
  };
}
```

### Lifecycle plugin contract (updated)

A conformant lifecycle plugin must:
1. Call `ctx.runtime.executor.send()` to interact with the LLM
2. Call `ctx.runtime.ui.accept()` to receive user input
3. *(optional, documented)* Call `ctx.runtime.pluginManager.drainPendingReloads()`
   between turns to support hot-reload

Omitting #3 is valid — reloads queue silently and never drain. `core-lifecycle`
implements all three as the reference implementation.

### `core-plugin-manager` tool surface

| Tool | Args | Behavior |
|------|------|----------|
| `kaizen_reload_plugin` | `{ name: string }` | Queues reload |
| `kaizen_load_plugin` | `{ name: string }` | Queues load |
| `kaizen_unload_plugin` | `{ name: string }` | Queues unload |

All three are `destructive: true` — `core-cli` prompts the user before execution.

---

## Testing

`PluginManager` is unit-tested with stub registries. Key cases:

- Load a plugin with a satisfied dependency — succeeds
- Reload a plugin — tools/events/services replaced, not duplicated
- Failed reload after successful unload — session continues, status = `"failed"`
- `drainPendingReloads()` with empty queue — no-op
- `core-plugin-manager` tools have `destructive: true`

---

## Migration

No breaking changes to plugin authors. `KaizenPlugin` interface is unchanged.
`setup()` contract is unchanged.

| File | Change |
|------|--------|
| `src/core/plugin-manager.ts` | New — absorbs `loader.ts`, adds hot-reload |
| `src/core/loader.ts` | Removed — logic moved to `plugin-manager.ts` |
| `src/core/index.ts` | Construct `PluginManager`; wire `drainPendingReloads` on `ctx.runtime` |
| `src/core/context.ts` | Add `pluginManager` to `PluginContext`; per-plugin state getter |
| `src/core/tool-registry.ts` | Add `deregisterByPlugin()` |
| `src/core/event-bus.ts` | Add `deregisterByPlugin()` |
| `src/core/service-registry.ts` | Add `deregisterByPlugin()` |
| `src/core/executor-registry.ts` | Add `deregisterByPlugin()` |
| `src/core/ui-registry.ts` | Add `deregisterByPlugin()` |
| `plugins/core-lifecycle/` | Call `drainPendingReloads()` between turns |
| `plugins/core-plugin-manager/` | New plugin — LLM-facing management tools |
| `src/types/plugin.ts` | Add `PluginEntry`, update `PluginContext`, `RuntimeContext` |
