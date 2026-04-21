# kaizen Architecture

*Read when: you want to understand how core is structured before contributing to it.*

## Overview

kaizen is a **kernel-model platform** for LLM harnesses. Core does three things:
load plugins, run an event bus, and wire a service/capability registry. Everything
else — the session loop, terminal UI, CLI tools, and the LLM itself — is a plugin.

```
┌─────────────────────────────────────────────────────┐
│  kaizen core                                        │
│  ┌──────────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ plugin loader│  │ event bus │  │  capability/ │ │
│  │  topo-sort   │  │ on/emit   │  │  service reg │ │
│  └──────────────┘  └───────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────┘
        │ loads
        ▼
┌───────────────────────────────────────────────────────────┐
│  Default plugin stack (first-party, installed separately) │
│                                                           │
│  core-events          defines event vocabulary            │
│  core-executor-*      wraps LLM / shell / debug           │
│  core-ui-terminal     stdin/stdout I/O                    │
│  core-cli             CLI introspection + tool runner     │
│  core-lifecycle       session loop (lifecycle: true)      │
└───────────────────────────────────────────────────────────┘
```

## The three things core does

1. **Plugin loader.** Resolve plugin refs, topologically sort by declared
   dependencies, call `setup(ctx)` on each plugin.
2. **Event bus.** `defineEvent`, `on`, `emit`. Core defines no events —
   plugins do.
3. **Service and capability registries.** `registerService` / `getService` for
   typed DI; `defineCapability` for named provider declarations with cardinality
   rules. Core has no session loop of its own; after initialization it hands
   control to the single plugin that declared `lifecycle: true`.

## Startup sequence

```
kaizen run
  │
  ├─ INITIALIZING
  │   ├─ parse kaizen.json
  │   ├─ resolve + topo-sort plugins by depends[]
  │   ├─ for each plugin: setup(ctx)
  │   │   └─ registerService / defineCapability / defineEvent / on
  │   └─ capability validation (cardinality, exactly-one-driver check)
  │
  ├─ READY → core calls lifecycle.start(ctx)
  │
  └─ RUNNING (driven by the session-driver plugin)
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

## The session driver

Exactly one loaded plugin must declare `lifecycle: true` on its default
export. After `bootstrap()` returns, core calls `start()` on that plugin.
Zero or more than one driver is a fatal startup error. This is the sole
plugin-to-core contract; everything else (executor implementations, UI
providers, tool dispatch) is plugin-to-plugin and modeled via the capability
and service registries.

## State machine

```
INITIALIZING → READY → RUNNING → CLOSED
```

`registerService`, `defineCapability`, `defineEvent`, and `on` are only valid
during `INITIALIZING` (inside `setup()`). Calling them after `setup()` returns
throws.

## Plugin initialization order

Plugins are topologically sorted by their declared dependencies before
`setup()` is called. A plugin that depends on `core-lifecycle` is guaranteed
to initialize after it. Event handler registration order follows
initialization order, so a plugin's `tool:before` handler runs after its
dependency's handler.

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
    loader.ts          Plugin resolution, topo-sort, capability validation, setup()
    event-bus.ts       EventBus: defineEvent / on / emit
    capability-registry.ts  CapabilityRegistry: define / validate cardinality
    service-registry.ts     ServiceRegistry: register / get typed implementations
    context.ts         createPluginContext() — the PluginContext handed to each plugin
    config.ts          Config loading, harness resolution, config merging
    errors.ts          fatal / warn / debug helpers
    llm.ts             Vercel AI SDK adapter (Anthropic + OpenAI-compatible)
    stdin.ts           Shared readline queue (avoids competing readers)
  types/
    plugin.ts          Public plugin API types — the contract for plugin authors

scripts/
  install.sh           One-liner installer (downloads binary + seeds official marketplace)
  dev-setup.sh         From-source dev: seed the sibling kaizen-official-plugins repo
```

First-party plugins and harnesses live in a separate repo:
[kaizen-official-plugins](https://github.com/CraightonH/kaizen-official-plugins).

### Runtime layout

```
~/.kaizen/                   Global kaizen home (created by install.sh or kaizen init --global)
  kaizen.json                Default config — used when no project config found
  marketplaces/              Per-marketplace install trees (see "Install tree" below)
  harnesses/                 Authored harnesses, resolved by bare name

<project>/
  .kaizen/                   Project-local config (like .vscode/)
    kaizen.json              Project config — extends a harness or defines full plugin stack
    harnesses/               Project-local authored harnesses
```

Plugins installed from marketplaces live under
`~/.kaizen/marketplaces/<id>/plugins/`. Harnesses installed from marketplaces
live under `~/.kaizen/marketplaces/<id>/harnesses/`. The top-level
`~/.kaizen/harnesses/` (and `.kaizen/harnesses/`) are reserved for *authored*
harnesses — ones the user writes by hand.

### Plugin resolution order

1. **Canonical marketplace ref** (`<marketplace>/<name>@<version>`):
   `~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/`, loaded by absolute
   path.
2. **Local path** (`./`, `../`, or `/`): loaded directly.

There is no `node_modules` fallback, no `npm`/`bun` global resolution, and no
bare-name authored-plugin fallback — publish plugins to a marketplace or
reference them by local path.

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
