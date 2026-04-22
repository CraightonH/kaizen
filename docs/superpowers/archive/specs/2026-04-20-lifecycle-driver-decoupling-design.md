# Lifecycle Driver Decoupling

**Status:** Draft
**Date:** 2026-04-20
**Issue:** [#13](https://github.com/CraightonH/kaizen/issues/13)

## Problem

Core hardcodes the session-driver lookup to a specific plugin's capability
namespace:

```ts
// src/core/plugin-manager.ts:450
const lifeProviders = this.capabilityRegistry.providersOf("core-lifecycle:lifecycle.drive");
```

Combined with the capability registry's ownership rule (a capability
`<plugin>:<name>` may only be `defineCapability`'d by a plugin whose `name`
matches the prefix — `src/core/capability-registry.ts:19`), this means **only
a plugin literally named `core-lifecycle` can ever drive the session**.

The fixture plugin for the core orchestration tests (issue #12) had to
identify as `core-lifecycle` to satisfy the ownership check — a workaround for
a name-level coupling the platform has no business enforcing. The driver is a
slot; any plugin should be allowed to fill it.

## Framing

Walking back through what the platform actually does reveals that the bug is
smaller than the original issue suggests — and that a prior design decision
was the real mistake.

After `bootstrap()`, core does exactly one thing with plugins: it hands
control to one of them by calling its `start()` method. That hand-off is the
**single contract between core and plugins**. Everything else
(executors, UI, tools, secrets, events) is plugins talking to plugins — core
has no stake in it.

Earlier design language (`DESIGN.md`) introduced "roles" as a separate
concept, and executor, UI, and lifecycle were all modeled as roles. That
conflation caused two problems:

1. **Executor was wrongly elevated.** "Executor" is a convenience interface
   between `core-lifecycle` and its executor plugins. It is not a
   platform-level concept. A different lifecycle plugin might not use
   executors at all. Core should not know about it.
2. **Lifecycle was wrongly demoted.** Treating lifecycle as "just another
   capability" forced it through the registry's ownership-prefix rule,
   which is exactly what produced the hardcoded-namespace bug.

The fix separates these layers cleanly.

## Design

### Core holds exactly one opinion

Kaizen is a plugin platform with a single required contract: **one loaded
plugin must be the session driver.** Core loads plugins, validates
capabilities, then calls `start()` on that one plugin and gets out of the
way.

This is the minimum opinion the binary must hold — without it there is no
session to run. Everything else (what the driver does, what it calls, what
other plugins it consults) is plugin-land. Core holds no opinion about any
of it.

### Manifest flag identifies the driver

A plugin declares itself as the session driver by adding `lifecycle: true` to
its default export:

```ts
export default {
  name: "core-lifecycle",
  apiVersion: "2",
  lifecycle: true,
  capabilities: { ... },
  async setup(ctx) { ... },
  async start(ctx) { ... },
};
```

Core identifies the driver by scanning loaded plugins for this flag.

**No config-key fallback, no override mechanism.** Rationale: multiple
resolution paths invite "works on my machine" drift, where a developer flips
a config key locally and forgets to do it in CI. Declaring lifecycle-ness
belongs in the plugin's code, not harness configuration. Harnesses select a
lifecycle by installing exactly one plugin that declares the flag.

### Validation rules

Evaluated after all plugins are loaded and capability validation passes:

| Condition | Outcome |
|---|---|
| Exactly one plugin has `lifecycle: true` | Core calls its `start()`. |
| Zero plugins have `lifecycle: true` | Fatal: `No lifecycle plugin found. A plugin with 'lifecycle: true' must be loaded.` |
| Two or more plugins have `lifecycle: true` | Fatal: `Multiple lifecycle plugins loaded: 'a', 'b'. A harness may have exactly one plugin with 'lifecycle: true'. Remove one from your kaizen.json.` |
| Flagged plugin exists but has no `start` function | Fatal: `Plugin 'x' declares 'lifecycle: true' but does not export a start() function.` |

The multi-driver error lists all offending plugin names so the user knows
exactly which to remove.

### Capability registry unchanged

The registry keeps its current behavior — in particular, the ownership-prefix
rule for `defineCapability` stays. Capabilities are plugin-to-plugin
interfaces; the rule is a useful nudge that prevents one plugin from defining
something in another's namespace.

The `core-lifecycle:lifecycle.drive` capability is **deleted**. It exists
today solely as the hardcoded lookup key. With the manifest flag replacing
it, no one needs it:

- `core-lifecycle` no longer provides or defines it.
- Three consumer plugins (`core-cli`, `core-plugin-manager`, `timestamps`)
  declare `consumes: ["core-lifecycle:lifecycle.drive"]` but never reference
  it at runtime — it was a declarative "ensure a lifecycle is loaded"
  signal. That check is now subsumed by the driver-lookup error, which fires
  at the same bootstrap phase with a clearer message.

Other `core-lifecycle:*` capabilities (`ui.input`, `ui.output`,
`executor.send`) are untouched. They are real plugin-to-plugin interfaces
legitimately owned by `core-lifecycle`.

### Plugin type change

Add `lifecycle?: boolean` to the `KaizenPlugin` type in
`src/types/plugin.ts`. Optional; defaults to false/absent.

## Implementation

### Core (`kaizen`)

1. **`src/types/plugin.ts`** — add `lifecycle?: boolean` to `KaizenPlugin`.
2. **`src/core/plugin-manager.ts`** — replace the hardcoded capability lookup
   (lines ~449–455) with a scan of loaded plugins for `lifecycle === true`.
   Enforce the three validation rules above. Error messages per the table.
3. **`src/core/plugin-manager.test.ts`** — update existing tests that build
   fixtures via `provides: ["core-lifecycle:lifecycle.drive"]` to use
   `lifecycle: true` instead. Add tests for the zero / multiple / missing-start
   error paths.
4. **`src/core/orchestration.test.ts`** — no change needed (it consumes
   fixture plugins, doesn't define the driver directly).
5. **`tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/index.mjs`** —
   rename `name` back to `"fixture-lifecycle"`, add `lifecycle: true`, drop
   the `core-lifecycle:lifecycle.drive` provides entry and the corresponding
   `defineCapability`. Remove the issue #13 workaround comment.
6. **`DESIGN.md`** — replace the "Role" definition and any role-framed
   prose with the platform-contract framing: core's single opinion is the
   session-driver hand-off; everything else is plugin-to-plugin. Remove
   references to executor/UI as roles.

### Official plugins (`kaizen-official-plugins`)

Coordinated release alongside core. Mechanical edits:

1. **`plugins/core-lifecycle/index.ts`**
   - Add `lifecycle: true` to the default export.
   - Remove `"core-lifecycle:lifecycle.drive"` from `capabilities.provides`.
   - Remove the matching `ctx.defineCapability("core-lifecycle:lifecycle.drive", ...)` call.
2. **`plugins/core-cli/index.ts`** — remove `consumes: ["core-lifecycle:lifecycle.drive"]`.
3. **`plugins/core-plugin-manager/index.ts`** — same.
4. **`plugins/timestamps/index.ts`** — remove the `lifecycle.drive` entry from its
   `consumes` list (keep `core-events:service`).
5. **Tests** — update any per-plugin tests that assert on the deleted
   capability.

No executor, UI, secrets, or events plugin is touched. No capability names
are renamed.

### Release coordination

Core change and official-plugins change ship together. The kaizen binary
loading an old `core-lifecycle` (still providing `core-lifecycle:lifecycle.drive`
but without `lifecycle: true`) would fail with the "no lifecycle plugin
found" error. Old kaizen binary loading new `core-lifecycle` (no
`lifecycle.drive` capability) would also fail.

This is a breaking change for any third-party lifecycle plugins (none known
to exist at this stage of the project). No deprecation period.

## Acceptance

- A fixture plugin named `fixture-lifecycle` (or any other name) can drive
  the session without identifying as `core-lifecycle`.
- `tests/fixtures/ci-marketplace/plugins/fixture-lifecycle/` reverts to
  `name: "fixture-lifecycle"` with the workaround comment removed.
- The `core-lifecycle:lifecycle.drive` capability no longer exists anywhere
  in either repo.
- Real `core-lifecycle` still works; the default stack still boots.
- Loading two plugins with `lifecycle: true` produces the prescribed error.
- Loading zero lifecycle plugins produces the prescribed error.
- `grep -r 'core-lifecycle:' src/core/` in the kaizen repo returns no
  hardcoded capability strings in runtime code (only in tests and comments,
  if any).

## Non-goals

- Relaxing or removing the capability-registry ownership-prefix rule. Out of
  scope; the rule provides value for plugin-owned interfaces and is not what
  this issue is about.
- Introducing a formal "roles" concept. Explicitly rejected — capabilities
  cover plugin-to-plugin contracts; the single core contract is the driver
  hand-off.
- Config-based driver selection or override. Rejected for the reasons in the
  Manifest Flag section.
- Reworking executor, UI, or any other capability shape. Those stay as
  plugin-owned capabilities.
