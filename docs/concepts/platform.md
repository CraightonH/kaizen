# The kaizen Platform

*Read when: you want to understand why kaizen exists, what it is, and the constraints it operates under.*

kaizen is a platform for building, sharing, and composing LLM harnesses. It is
**not itself a harness** — it is the kernel that harnesses run on. The binary
ships with zero plugins. Everything visible in a running session (the session
loop, the terminal, the LLM executor, the tools) is a plugin.

## Problem Statement

LLM coding agents are locked to single providers and extend only via MCP —
which requires writing a full server process. The prior solution to "any CLI
as an LLM tool" shrank the problem, but not the scope: it only solved tool
wrapping for one lifecycle shape.

A **harness** is the combination of tools the LLM can call and lifecycle
behavior that decides how the session runs. Simple harnesses wrap a few CLIs.
Complex harnesses add custom tools, mutate LLM behavior, encode domain
knowledge, and replace the session loop entirely. Today they are hand-rolled
per-project.

kaizen expands the scope: it is a platform where harnesses are a first-class
artifact built from composable plugin primitives — and shareable with one
command.

### The north star example

Someone publishes a kaizen harness for Godot game development — it registers
Godot CLI tools, sets up project-specific context, hooks into tool results to
post-process output. Another developer installs it with one command and has a
domain-specific LLM assistant in minutes. The developer who built the Godot
harness encodes their workflow once. Everyone else benefits.

This is VS Code extensions for LLM assistants, without the IDE.

## What kaizen is

kaizen is a **kernel**. Core does exactly three things:

1. **Plugin loader** — resolve plugins, topologically sort them by their
   declared dependencies, call each plugin's `setup()`.
2. **Event bus** — plugins define and subscribe to events. No events are
   hardcoded in core.
3. **Primitives** — tool execution, executor registration, UI registration.
   Core has no session loop, no UI, no tools, no LLM.

After all plugins initialize, core calls `start(ctx)` on the single plugin
that declared itself the **session driver** (`lifecycle: true`). That plugin
owns the session from that point forward. Core never sees another frame.

The unit of sharing is the **harness** — a `kaizen.json` file listing a
plugin stack and per-plugin config. The unit of functionality is the
**plugin** — an addressable package installed via a marketplace.

## What Makes This Cool

The unit of sharing is the harness, not a config file fragment and not a
whole framework. A harness is a `kaizen.json` shared by URL or path. Install
it, and kaizen wires everything — tools, lifecycle hooks, session config —
automatically.

Because every layer is a plugin, every layer is replaceable. A non-LLM
executor (shell wrappers, mocks), a web UI, a fully autonomous headless
lifecycle — each is a plugin swap, not a core fork.

## Constraints

These are hard constraints. Anything proposed for core that breaks one of
them is out of scope.

- **Language/runtime.** TypeScript, Bun. Ships as a standalone binary via
  GitHub Releases (`bun build --compile`). No Node.js or Bun required on the
  user's machine. `npm install -g kaizen` also works as a secondary install
  path for Node users.
- **Open source.** MIT.
- **Zero config from the user's perspective** for the default use case.
- **Core is minimal.** Plugin loader + event bus + tool primitives. No
  session loop, no UI, no tools, no LLM — all are plugins. Core exposes
  primitives; plugins compose them.
- **Exactly one session driver.** Exactly one loaded plugin must declare
  `lifecycle: true`. Zero or more than one is a fatal startup error. This is
  the sole plugin-to-core contract; everything else is plugin-to-plugin and
  modeled as capabilities.
- **Security:** destructive command guards and similar policy belong in
  plugins. Core has no opinion on tool safety.
- **Backward compatibility:** the Phase 1 `kaizen add <cli>` / `kaizen run`
  UX is preserved, powered by built-in plugins and transparent to the user.
- **Ships with zero plugins.** First-party plugins and harnesses live in a
  separate repo (`kaizen-official-plugins`), installed through the
  marketplace.

## Why a kernel, not a framework

Three approaches were considered:

- **Fixed lifecycle, plugins extend it.** Simpler core, less powerful — the
  loop and UI can't be replaced.
- **Middleware pipeline.** Flexible but plugin ordering bugs are subtle.
- **Full kernel — everything is a plugin.** ← chosen.

With the kernel model, any layer is replaceable without touching core.
Someone building a fully autonomous harness, a web UI, or a non-LLM
shell-based agent replaces the relevant plugin; core never changes. The
built-in plugins prove the API before any third party writes one: if a
noop plugin requires a change to core types, the API is coupled to the
built-ins and must be fixed.

## Audience

Two primary audiences read this documentation:

1. **Core contributors** — understanding kaizen internals. Read
   `concepts/architecture.md` next, then `core-internals.md`.
2. **Plugin and marketplace authors** — building against kaizen's APIs.
   Read `concepts/plugin-model.md` next, then the reference docs.

## Further reading

- [`architecture.md`](./architecture.md) — the kernel structure in detail.
- [`plugin-model.md`](./plugin-model.md) — what plugins are, how they load,
  and the capability model.
- [`harnesses.md`](./harnesses.md) — the shareable configuration artifact.
- [`security.md`](./security.md) — the plugin permission tiers.
