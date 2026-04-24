# Plugin Model

*Read when: you want to understand what a plugin is before building one.*

This document explains plugins conceptually — what they are, how they load,
how they declare services, and the permission tiers they can pick. For
exact type signatures and field-level reference, see
[`../reference/plugin-api.md`](../reference/plugin-api.md).

## Authoring decision matrix {#decision-matrix}

Four mechanisms, four decision points:

| If you need… | Use | Permission |
|---|---|---|
| A type, class, constant, or helper the platform itself provides | `import from "kaizen/types"` (host API) | n/a — platform surface |
| A type, class, or constant from another plugin's public contract | `import type { X } from "<marketplace>/<plugin>/public"` — types only, erased at build | n/a — no runtime coupling |
| Another plugin to do work and return a result | `ctx.provideService("name", impl)` / `ctx.useService<T>("name")` | None. Risk lives with the provider |
| To announce that something happened and let others react or transform it | `ctx.defineEvent("name")` / `ctx.emit(...)` / `ctx.on("other:name", handler)` | Subscribing requires declared `events.subscribe` grant |

Rules of thumb:

- **Services are for pull** ("give me X"); **events are for push** ("X happened").
- A plugin that emits events doesn't know or care who subscribes.
- A plugin that provides a service expects consumers to know it exists.
- Types always come from static `import type`. A consumer can use a service without seeing its types (at the cost of `unknown`).
- Host API is for things **every** plugin would want. When two plugins share something, it's a service, not a host-API addition.

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
- **`services`** — what this plugin provides and consumes in the
  service registry. See [Services and dependencies](#services).
- **`setup(ctx)`** — the one method core calls. Plugins define and provide
  services (`ctx.defineService`, `ctx.provideService`), declare consumption
  intent (`ctx.consumeService`), and subscribe to events — all during
  `setup()`. Anything registered after `setup()` returns will throw.

A plugin may additionally declare `driver: true` to become the session
driver (see below), and may provide a `config` section describing the config
schema and secret keys it accepts.

## How plugins load

kaizen ships with zero plugins. Every plugin — including the first-party
core stack — reaches a session through the **marketplace install path**.

The high-level sequence when you run `kaizen --harness <something>`:

1. **Resolution.** Each plugin ref in `kaizen.json` is either a canonical
   `<marketplace>/<name>[@<version>]` or a legacy bare name. Canonical refs
   resolve against installed marketplace trees under
   `~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/`; legacy names fall
   back through authored-plugin and npm directories.
2. **Install.** If a referenced plugin version isn't on disk yet, the
   installer materializes it from its source (file, tarball, or npm) into
   the marketplace install tree.
3. **Consent.** Before a new plugin runs, kaizen reads its declared
   permissions and either accepts silently (TRUSTED), prompts with a grant
   list (SCOPED), or requires typed confirmation (UNSCOPED). Decisions
   persist in the harness's `permissions.lock` (see `docs/concepts/harnesses.md`).
4. **Setup.** Plugins are topologically sorted by their declared dependencies
   and each `setup(ctx)` runs in order. After all `setup()` calls complete,
   core validates that every consumed service has a provider, then calls
   `start(ctx)` on the single session driver.

Exact loader mechanics — the compiled-binary `createRequire` anchor, package
shape requirements, the dep-resolution walk for plugin-internal imports —
live in [`core-internals.md`](../core-internals.md).

## Services and dependencies {#services}

Plugins don't reach into each other directly. They interact through the
**service registry**: named, typed interfaces that plugins define, provide,
and consume.

### Owner-qualified names

Every service name is qualified by the plugin that defined it:
`<owner-plugin>:<name>`. For example, `core-events:service` is owned by
`core-events`; only `core-events` may provide an implementation for it. This
rule prevents namespace hijacking — one plugin cannot declare itself the
provider of another plugin's service.

### One provider per service

Every service is **cardinality "one"**: exactly one provider permitted. A
second `provideService` call for the same name is a fatal startup error.
Multiple distinct services with different names (`core-terminal-ui:ui`,
`core-web-ui:ui`) let multiple implementations coexist; consumers pick
the specific name they need. Consumers are unlimited — any number of plugins
may call `useService` for the same name.

Core enforces after all `setup()` calls: missing providers and consumed-but-
undefined services are fatal.

### Declaring dependencies

A plugin declares what it wires into via `services.consumes` and what it
offers via `services.provides`. Topo-sort uses these declarations to
guarantee that providers initialize before consumers, so a consumer can call
`ctx.consumeService(...)` inside its own `setup()` safely.

```ts
services: {
  provides: ["my-plugin:thing"],
  consumes: ["core-events:service"],
}
```

Consumers should declare every service they actually use; undeclared
consumption works today by coincidence of load order and will break the
moment the order changes.

## Plugin lifecycle

Four moments matter for a plugin author:

- **`setup(ctx)`** — runs once during `INITIALIZING`. The only time you can
  call `defineService`, `provideService`, `consumeService`, `defineEvent`, or
  `on`. Do all wiring here; subscribe to events for everything that needs to
  react later.
- **Event handlers** — registered via `ctx.on(name, handler)` during
  `setup()`. Core invokes them serially during `RUNNING`. Handler order
  follows initialization order (so a consumer's handler runs after its
  dependency's handler). If a handler throws, core logs and continues.
- **`start(ctx)`** — runs once, on the single session driver (the plugin
  that declared `driver: true`). Core calls it after `READY`. The driver
  owns the session from that point forward and shapes it entirely via
  services it consumes from other plugins — reading user input, calling an
  LLM, iterating tool calls, emitting lifecycle events, closing.
- **`stop(ctx)`** — optional. Runs during unload, before the plugin's
  events, services, and permissions are deregistered. It is the symmetric
  half of `setup`/`start`: close anything you opened (readline interfaces,
  listeners, timers, file watchers, sockets). Runs inside
  `runInPluginScope`, so `ctx` permissions still work. Errors are warned
  but do not block deregistration.

  `runHarness` calls `PluginManager.unloadAll()` in its `finally` block,
  invoking `stop()` on every loaded plugin in reverse insertion order
  (consumers before providers) so a consumer can still call a provider's
  service during its own shutdown.

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
`ctx.on`) instead. (`ctx.secrets` is also available but is access-scoped by the
plugin's `config.secrets` declaration, not by `permissions`.) Global `fetch` is wrapped, so SDK code
that calls fetch internally is still checked against your `net.connect`
grant.

For the full set of grants, the observe-mode workflow that synthesizes a
proposed manifest, the consent lockfile format, and threat-model limits,
see [`security.md`](./security.md).
