# Plugin Model

*Read when: you want to understand what a plugin is before building one.*

This document explains plugins conceptually — what they are, how they load,
how they declare capabilities, and the permission tiers they can pick. For
exact type signatures and field-level reference, see
[`../reference/plugin-api.md`](../reference/plugin-api.md).

## What is a plugin

A kaizen plugin is a self-contained, installable package with a default
export shaped like a `KaizenPlugin`. A plugin declares five things about
itself:

- **`name`** — a kebab-case identifier. Must match the plugin's config key in
  `kaizen.json`.
- **`apiVersion`** — the kaizen plugin API version the plugin targets. Core
  warns on major-version mismatch.
- **`permissions`** — the security tier (`trusted`, `scoped`, `unscoped`)
  and, if SCOPED, the enumerated grants the plugin needs (filesystem paths,
  hosts, env vars, event subscriptions). See [Permission tiers](#permission-tiers).
- **`capabilities`** — what this plugin provides and consumes in the
  capability registry. See [Capabilities and dependencies](#capabilities).
- **`setup(ctx)`** — the one method core calls. Plugins register tools,
  subscribe to events, register an executor / UI, and register services —
  all during `setup()`. Anything registered after `setup()` returns will
  throw.

A plugin may additionally declare `lifecycle: true` to become the session
driver (see below), and may provide a `config` section describing the config
schema and secret keys it accepts.

## How plugins load

kaizen ships with zero plugins. Every plugin — including the first-party
core stack — reaches a session through the **marketplace install path**.

The high-level sequence when you run `kaizen --harness <something>`:

1. **Resolution.** Each plugin ref in `kaizen.json` is either a canonical
   `<marketplace>/<name>@<version>` or a legacy bare name. Canonical refs
   resolve against installed marketplace trees under
   `~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/`; legacy names fall
   back through authored-plugin and npm directories.
2. **Install.** If a referenced plugin version isn't on disk yet, the
   installer materializes it from its source (file, tarball, or npm) into
   the marketplace install tree.
3. **Consent.** Before a new plugin runs, kaizen reads its declared
   permissions and either accepts silently (TRUSTED), prompts with a grant
   list (SCOPED), or requires typed confirmation (UNSCOPED). Decisions
   persist in `kaizen.permissions.lock`.
4. **Setup.** Plugins are topologically sorted by their declared dependencies
   and each `setup(ctx)` runs in order. After all `setup()` calls complete,
   core validates capability cardinality and then calls `start(ctx)` on the
   single session driver.

Exact loader mechanics — the compiled-binary `createRequire` anchor, package
shape requirements, the dep-resolution walk for plugin-internal imports —
live in [`core-internals.md`](../core-internals.md).

## Capabilities and dependencies {#capabilities}

Plugins don't reach into each other directly. They interact through the
**capability registry**: named, typed interfaces that plugins own, provide,
and consume.

### Owner-qualified names

Every capability name is qualified by the plugin that defined it:
`<owner-plugin>:<name>`. For example, `core-events:service` is owned by
`core-events`; only `core-events` may register a provider for it. This rule
prevents namespace hijacking — one plugin cannot declare itself the provider
of another plugin's capability.

### Cardinality

Each capability is either `one` (exactly one provider must be loaded when
any plugin consumes it) or `many` (any number of providers, consumers
receive all of them). Core enforces cardinality after all `setup()` calls:
missing or over-subscribed `one` capabilities are fatal startup errors.

### Declaring dependencies

A plugin declares what it wires into via `capabilities.consumes` and what it
offers via `capabilities.provides`. Topo-sort uses these declarations to
guarantee that providers initialize before consumers, so a consumer can call
`ctx.getService(...)` inside its own `setup()`.

```ts
capabilities: {
  provides: ["my-plugin:thing"],
  consumes: ["core-events:service"],
}
```

Consumers should declare every capability they actually read; undeclared
consumption works today by coincidence of load order and will break the
moment the order changes.

## Plugin lifecycle

Three moments matter for a plugin author:

- **`setup(ctx)`** — runs once during `INITIALIZING`. The only time you can
  call `registerTool`, `defineEvent`, `on`, `registerExecutor`, `registerUi`,
  or `registerService`. Do all wiring here; subscribe to events for
  everything that needs to react later.
- **Event handlers** — registered via `ctx.on(name, handler)` during
  `setup()`. Core invokes them serially during `RUNNING`. Handler order
  follows initialization order (so a consumer's handler runs after its
  dependency's handler). If a handler throws, core logs and continues.
- **`start(ctx)`** — runs once, on the single session driver (the plugin
  that declared `lifecycle: true`). Core calls it after `READY`. The driver
  owns the session from that point forward: it reads from UI channels, calls
  the executor, iterates tool calls, emits lifecycle events, and eventually
  closes.

There is no separate `teardown()` hook today. Cleanup belongs in a
`session:end` handler (or whatever the session driver exposes as a close
event).

## Permission tiers

Plugins run in-process and can reach everything Node can — unless they
declare what they need. Every plugin picks a tier.

| Tier | What it can touch | Install UX |
|------|-------------------|------------|
| **trusted** | Only `ctx.*`. No filesystem, network, env, exec, or cross-plugin event subscription. | Silent |
| **scoped** | External resources you enumerate: fs paths, hosts, env vars, binaries, event subscriptions. | UAC shows grant list |
| **unscoped** | Raw Node access. Runs the user shell, dynamic spawn, native modules. | Typed confirmation required |

Default to TRUSTED. Escalate only when a real need appears.

The enforcer checks every external op at runtime. Non-UNSCOPED plugins
cannot `require("node:fs")` or `require("node:child_process")` — the require
patch refuses. Use the context surface (`ctx.fs`, `ctx.net`, `ctx.exec`,
`ctx.secrets`, `ctx.on`) instead. Global `fetch` is wrapped, so SDK code
that calls fetch internally is still checked against your `net.connect`
grant.

For the full set of grants, the observe-mode workflow that synthesizes a
proposed manifest, the consent lockfile format, and threat-model limits,
see [`security.md`](./security.md).
