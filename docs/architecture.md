# kaizen Architecture

## Overview

kaizen is a **kernel-model platform** for LLM harnesses. Core does three things:
load plugins, run an event bus, and expose tool/executor primitives. Everything
else — the session loop, terminal UI, CLI tools, and the LLM itself — is a plugin.

```
┌─────────────────────────────────────────────────────┐
│  kaizen core                                        │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ plugin loader│  │ event bus │  │  tool/exec   │ │
│  │  topo-sort   │  │ on/emit   │  │  registries  │ │
│  └──────────────┘  └───────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────┘
        │ loads
        ▼
┌───────────────────────────────────────────────────────────┐
│  Default plugin stack (all ship with kaizen)              │
│                                                           │
│  core-events          defines event vocabulary            │
│  core-executor-*      wraps LLM / shell / debug           │
│  core-ui-terminal     stdin/stdout I/O                    │
│  core-cli             CLI introspection + tool runner     │
│  core-lifecycle       session loop                        │
└───────────────────────────────────────────────────────────┘
```

## Lifecycle

```
kaizen run
  │
  ├─ INITIALIZING
  │   ├─ parse kaizen.json
  │   ├─ resolve + topo-sort plugins by depends[]
  │   ├─ for each plugin: setup(ctx)
  │   │   └─ registerTool / defineEvent / on / registerExecutor / registerUi
  │   └─ role validation (exactly one provider per required role)
  │
  ├─ READY → core calls lifecycle.start(ctx)
  │
  └─ RUNNING (driven by core-lifecycle)
      ├─ emit session:start
      └─ loop:
          ├─ UI channel: receive() → user message
          ├─ executor.send(history, tools) → LLMResponse
          ├─ for each tool call:
          │   ├─ emit tool:before
          │   ├─ tools.execute(name, args)
          │   └─ emit tool:after
          ├─ emit session:response
          └─ UI channel: send(text)
      └─ emit session:end → CLOSED
```

## Roles

Roles decouple plugins from specific implementations. A plugin declares what it
provides and what it needs:

```typescript
{
  provides: ["lifecycle"],  // I fulfill the lifecycle role
  depends: ["executor"],    // I need exactly one executor plugin to be loaded
}
```

Core enforces: for every role appearing in any plugin's `depends[]`, exactly one
loaded plugin must `provide[]` it. Zero or two+ providers → fatal startup error.

Default roles:

| Role | Provider | Consumer |
|------|----------|----------|
| `events` | `core-events` | `core-lifecycle`, `core-cli` |
| `executor` | `core-executor-*` | `core-lifecycle` |
| `ui` | `core-ui-terminal` | `core-lifecycle` |
| `lifecycle` | `core-lifecycle` | *(core itself calls `start()`)* |

## State machine

```
INITIALIZING → READY → RUNNING → CLOSED
```

`registerTool`, `defineEvent`, `on`, `registerExecutor`, `registerUi` are only
valid during `INITIALIZING` (inside `setup()`). Calling them after returns throws.

## Plugin initialization order

Plugins are topologically sorted by `depends[]` before `setup()` is called. A
plugin that depends on role `lifecycle` is guaranteed to initialize after the
lifecycle provider. Event handler registration order follows initialization order,
so a plugin's `tool:before` handler runs after its dependency's handler.

## Event system

Events are defined by plugins via `ctx.defineEvent(name)` during `setup()`. Core
defines no events — `core-events` defines the default vocabulary. `ctx.emit()`
runs all handlers serially and returns an array of all return values.

**Key invariant:** `emit()` always runs every handler. Short-circuit logic
(e.g. skipping tool execution if a `tool:before` handler returns a `ToolResult`)
is the caller's responsibility, not the event bus's.

## File layout

```
src/
  cli.ts               CLI entrypoint — arg routing + bootstrap
  commands/
    manage.ts          Management commands (apply, install, plugin *)
  core/
    index.ts           bootstrap() — wires everything and calls lifecycle.start()
    loader.ts          Plugin resolution, topo-sort, role validation, setup()
    event-bus.ts       EventBus: defineEvent / on / emit
    tool-registry.ts   ToolRegistry: register / list / execute (with ajv validation)
    executor-registry.ts  ExecutorRegistry: register / get
    ui-registry.ts     UiRegistry: register / get
    context.ts         createPluginContext() — the PluginContext handed to each plugin
    config.ts          kaizen.json loading, harness resolution, config merging
    errors.ts          fatal / warn / debug helpers
    llm.ts             Vercel AI SDK adapter (Anthropic + OpenAI-compatible)
    stdin.ts           Shared readline queue (avoids competing readers)
  types/
    plugin.ts          Public plugin API types — the contract for plugin authors
  spike/
    loader-probe.ts    Day-0 spike: verified createRequire from compiled binary

plugins/               Built-in plugins (bundled into binary)
  core-events/
  core-executor-anthropic/
  core-executor-debug/
  core-executor-openai/
  core-executor-shell/
  core-lifecycle/
  core-ui-terminal/
  core-cli/
  kaizen-plugin-timestamps/

harnesses/             Built-in harnesses (bundled configs)
  core-anthropic/      Full default stack (Anthropic LLM)
  core-debug/          Debug executor (echoes messages, prints events)
  core-shell/          Shell executor (bash passthrough)

docs/
  architecture.md      ← this file
  plugin-api.md        Plugin authoring guide
  harnesses.md         Harness authoring + usage
  core-internals.md    Core internals for contributors
  plugin-loading.md    How plugin resolution works from a compiled binary
```
