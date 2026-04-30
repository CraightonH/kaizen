# Design: `onReady` plugin lifecycle hook

**Date:** 2026-04-29
**Status:** Implemented
**Issue:** [#63](https://github.com/CraightonH/kaizen/issues/63)

## Problem

Kaizen gates plugin APIs by lifecycle phase:

- `setup()` runs in `READY`. `ctx.on()`, `ctx.defineService()`, `ctx.provideService()`,
  and `ctx.consumeService()` are setup-only.
- `useService()` is `RUNNING`-only. Calling it in `setup()` throws.
- `start()` runs in `RUNNING` — but core only invokes it on the single plugin with
  `driver: true` (`src/core/plugin-manager.ts:452`).
- `stop()` is invoked on every plugin during `unloadAll()`
  (`src/core/plugin-manager.ts:549`).

The result is a one-row gap in the lifecycle:

| Phase | Hook | Called on |
| --- | --- | --- |
| `READY` | `setup()` | every plugin |
| `RUNNING` (entry) | `start()` | **driver only** |
| `RUNNING` → `CLOSED` | `stop()` | every plugin |

A non-driver plugin that needs `useService()` to wire against a peer's service has
no core-invoked hook where that call is legal. The `setup()`-to-`start()` closure
pattern documented in `docs/guides/plugin-authoring.md#setup-start-closure` only
helps the driver, because non-drivers' `start()` is never called.

The current escape — used in production by the issue reporter — is for the driver
to emit a "plugins ready" event in `start()` and for non-drivers to subscribe in
`setup()` and do their wiring inside the handler. It works because `await emit()`
is serial. But it forces every harness's driver to define and emit such an event,
and every consumer plugin to know that event's name. That contract lives outside
core and varies by harness, so a plugin published to npm cannot depend on it.

## Solution

Add an optional `onReady(ctx)` method to the plugin object. Core calls it once per
loaded plugin, after every `setup()` has completed and before `driver.start()` is
invoked. Core state is `RUNNING` when `onReady` fires, so `useService()` is legal.

This closes the gap without inventing new policy: it is the `RUNNING`-phase
counterpart to `setup()`, and it makes the existing phase-gating rules usable for
non-driver plugins.

## Lifecycle After Change

| Phase | Hook | Order |
| --- | --- | --- |
| `READY` | `setup()` | topo |
| `RUNNING` entry | `onReady()` *(new)* | topo |
| `RUNNING` (session loop) | `start()` *(driver only)* | n/a |
| `CLOSED` | `stop()` | reverse topo |

## Hook Semantics

- **Signature:** `onReady?(ctx: PluginContext): void | Promise<void>`. Optional.
  Return value is not consumed.
- **When:** After every plugin's `setup()` resolves successfully and before
  `driver.start()` is invoked.
- **State:** `getCoreState()` returns `RUNNING` during `onReady`. `useService()`
  is legal. `ctx.on()`, `ctx.defineService()`, `ctx.provideService()`, and
  `ctx.consumeService()` are **not** legal — same gating as `start()`.
- **Order:** Topological, using the existing `services.consumes` /
  `services.provides` edges that already order `setup()`. The same sorted list is
  reused; no new ordering policy is introduced.
- **Concurrency:** Awaited serially in topo order, matching `setup()`. A plugin's
  `onReady` is fully resolved before the next plugin's runs.
- **Symmetry across driver and non-driver:** Called on every loaded plugin
  including the driver. The driver may use `onReady` for the same `RUNNING`-phase
  wiring purpose; `start()` retains its "session loop" meaning. No carve-out.
- **Errors:** A throw from `onReady` is fatal and propagates the same way a throw
  from `setup()` does. No retry, no swallow.
- **Invocation count:** Exactly once per loaded plugin per harness boot. Hot
  reload (`PluginManager.reload`) is out of scope for this change — `onReady`
  is only invoked during the initial post-`setup()` pass. Re-invoking on reload
  can be added later if needed; deferring it avoids designing reload semantics
  here.

## Non-Goals

These are explicitly out of scope to keep the addition narrow:

- **No teardown counterpart.** `stop()` already exists and is already called on
  every plugin in reverse topo order. A new symmetric teardown hook would
  duplicate it.
- **No replacement for the events pattern.** Cross-plugin `RUNNING`-phase
  coordination that depends on another plugin's *runtime* state (e.g. "after the
  driver's session loop has started") still requires the events handshake.
  `onReady` only solves the "I need `useService()` legality" problem.
- **No new ordering guarantees.** `onReady` reuses the existing topo sort. No
  priority field, no per-hook ordering hints, no parallelism flag.
- **No re-invocation on state changes.** `onReady` does not fire again on
  consent changes, config refreshes, or other in-session events.
- **No driver carve-out.** The driver's `onReady` runs the same way as any other
  plugin's. There is no "skip onReady on the driver" mode.

## Documentation

- `docs/guides/plugin-authoring.md` — add an `onReady` section adjacent to the
  setup-start closure section. Mark `onReady` as the canonical place for
  non-driver `RUNNING`-phase wiring. Keep the events pattern documented for the
  separate use case of cross-plugin runtime coordination.
- `docs/concepts/plugin-model.md` — extend the lifecycle description to include
  `onReady` with its topo-ordered, every-plugin semantics.
- `docs/concepts/architecture.md` — update the lifecycle diagram / prose to show
  the new hook between `setup()` and `start()`.
- `docs/reference/host-api.md` — document the hook signature and phase legality
  (`useService` legal; `on` / `provideService` / `consumeService` /
  `defineService` not legal).

## Migration

No breaking changes. Plugins that do not define `onReady` are unaffected. The
issue reporter's events-based workaround continues to work; they may migrate
non-driver wiring from event handlers into `onReady` at their own pace.

## Acceptance Criteria

- A plugin defining `onReady(ctx)` has it called once, with `RUNNING` core state,
  after all `setup()` calls resolve and before `driver.start()` is invoked.
- `useService()` succeeds inside `onReady`. `ctx.on()`, `provideService`,
  `consumeService`, and `defineService` throw the same way they throw inside
  `start()`.
- Topo ordering: a plugin whose `services.consumes` includes `peer:x` has its
  `onReady` invoked after the `onReady` of the plugin providing `peer:x`.
- A throw from `onReady` aborts the harness run with a fatal error containing
  the offending plugin's name, the same shape as a `setup()` failure.
- Plugins that do not define `onReady` exhibit no behavior change.
- The driver's `onReady` (if defined) runs before its `start()`.
