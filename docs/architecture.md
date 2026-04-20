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

## Directory structure

### Repo layout

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
    config.ts          Config loading, harness resolution, config merging
    errors.ts          fatal / warn / debug helpers
    llm.ts             Vercel AI SDK adapter (Anthropic + OpenAI-compatible)
    stdin.ts           Shared readline queue (avoids competing readers)
  types/
    plugin.ts          Public plugin API types — the contract for plugin authors

plugins/               Built-in plugins (workspace packages, compiled into binary)
  core-events/
  core-executor-anthropic/
  core-executor-debug/
  core-executor-shell/
  core-lifecycle/
  core-ui-terminal/
  core-cli/
  kaizen-plugin-timestamps/

harnesses/             Built-in harnesses (JSON, bundled into binary via static import)
  core-anthropic/      Full default stack (Anthropic LLM)
  core-debug/          Debug executor (echoes messages, prints events)
  core-shell/          Shell executor (bash passthrough)

scripts/
  install.sh           One-liner installer (downloads binary + runs kaizen init --global)
```

### Runtime layout

```
~/.kaizen/                   Global kaizen home (created by install.sh or kaizen init --global)
  kaizen.json                Default config — used when no project config found
  node_modules/              Plugins installed via kaizen plugin install
  plugins/                   Locally authored / extracted plugins (require-able directories)
  harnesses/                 Custom harnesses (folders containing kaizen.json)

<project>/
  .kaizen/                   Project-local config (like .vscode/)
    kaizen.json              Project config — extends a harness or defines full plugin stack
    node_modules/            Plugins installed with kaizen plugin install --local (future)
    plugins/                 Project-local authored plugins
    harnesses/               Project-local harnesses
```

### Plugin resolution order

1. Built-in (compiled into binary)
2. `.kaizen/plugins/<name>/` — project-scoped authored plugin
3. `~/.kaizen/plugins/<name>/` — global authored plugin
4. `.kaizen/node_modules/<name>` — project npm-installed plugin
5. `~/.kaizen/node_modules/<name>` — globally npm-installed plugin (`kaizen plugin install`)
6. Standard npm resolution (bun global, npm global, `./node_modules`)

## Marketplaces & plugin resolution

Kaizen uses a federated git-backed marketplace model for third-party plugins.

### Install tree

All marketplace data lives under `~/.kaizen/` (or `$KAIZEN_HOME_OVERRIDE` in tests):

```
~/.kaizen/
  kaizen.json                              # global config (KaizenGlobalConfig)
  marketplaces/
    <id>/
      repo/                                # git clone (or symlink for local dev)
        .kaizen/marketplace.json           # MarketplaceCatalog
        plugins/<name>/                    # plugin source files
        harnesses/<name>.json              # harness source files
      plugins/
        <name>@<version>/                  # installed plugin bits
          package.json
          index.mjs
      harnesses/
        <name>/
          kaizen.json                      # installed harness config
```

All paths are computed by `src/core/kaizen-config.ts` — never hardcode `~/.kaizen/...` or concatenate path fragments manually elsewhere.

### Ref forms

| Form | Example | Notes |
|------|---------|-------|
| Marketplace-qualified | `official/timestamps@1.2.3` | Explicit marketplace + version |
| Shorthand | `timestamps@1.2.3` | Resolves across all marketplaces; errors if ambiguous |
| Legacy npm | `kaizen-plugin-timestamps` | Deprecated; resolves against `official` |

**Rejected forms:** raw URLs (`https://...`), local paths (`./`, `/`, `../`), scoped npm (`@scope/pkg`).

### Third-party plugin loading

Marketplace plugins are imported by **absolute path** from their install directory — there is no `node_modules` involvement. `src/core/plugin-loader.ts` reads `package.json` for the entry point and calls dynamic `import(absolutePath)`.

### Key modules

| Module | Responsibility |
|--------|---------------|
| `src/core/kaizen-config.ts` | All `~/.kaizen/` path helpers; global config I/O |
| `src/core/marketplace.ts` | git clone/pull, catalog read/validate, background refresh |
| `src/core/ref-resolver.ts` | Parse and resolve plugin refs against catalogs |
| `src/core/plugin-installer.ts` | Materialize plugin bits (file/tarball/npm sources) |
| `src/core/plugin-loader.ts` | Import marketplace plugins by absolute path |
| `src/core/bootstrap.ts` | Auto-add marketplaces + install plugins for `--harness` |
