# Design: Capability Registry (Addresses Adversarial Review Finding 1)

Date: 2026-04-17
Status: DRAFT — awaiting user review
Supersedes: N/A
Related: `docs/adversarial-review.md` (findings 1, 2, 3)

## Problem Statement

The adversarial review identifies the exactly-one-provider-per-role constraint as
fundamentally at odds with kaizen's "build anything" positioning:

> Only one plugin may provide 'ui', one 'executor', one 'lifecycle'. You cannot run
> web + terminal UIs simultaneously, route between two LLMs, or layer lifecycle
> concerns. This is not a composable platform — it is a slot-filling system.

The root cause is that `provides`/`depends` is a coarse role system with
global singleton semantics. The three affected roles have different natural
cardinalities:

- `lifecycle` is structurally a singleton (one loop driver; two is chaos)
- `ui` has a legitimate multi-provider use case (web + terminal mirroring a session)
- `executor` has a legitimate multi-provider use case (routing, fallback, cost/quality tradeoffs)

The role system also cannot express *what* a plugin extends — it only controls
init ordering. Finding 3 in the review observes the same limitation from a
security angle: roles provide zero access control and create a false impression
of capability containment.

## Scope

### In Scope

- Replace the `provides`/`depends` role system with a **capability registry**: plugins
  declare what capabilities they provide and consume; core enforces per-capability
  cardinality.
- Migrate the three existing built-in roles (`lifecycle`, `ui`, `executor`) to
  capabilities, splitting `ui` into `ui.input` and `ui.output`.
- Add a new context primitive `registerInputSource()` so multiple UIs can drive
  session input concurrently (resolves finding 1 for UI).
- Change `executor` capability cardinality from singleton to many; defer the *routing
  mechanism* decision (but unblock multi-provider at the registry level).
- Capability declarations include a JSON schema describing the contract they expect
  providers to fulfill or consumers to receive.
- Owner-qualified capability names (`<defining-plugin>:<capability>`) with opt-in
  aliases for ergonomics and fork compatibility.
- Introspection CLI: `kaizen capability list` / `kaizen capability show <name>`.
- TypeScript type exports from capability-defining plugins (same pattern as
  `core-lifecycle` already uses for event payload types).
- **Plugin migration guide** (`docs/plugin-migration-capability-registry.md`)
  written for coding agents to mechanically migrate existing plugins from the
  `provides`/`depends` role system to the capability system. See
  "Plugin Migration Guide" section below for required contents.

### Explicitly Deferred (see "Deferred Work" section)

- Install-time capability consent UX (requires plugin installer redesign).
- Runtime enforcement / sandboxing (requires `worker_threads` or `vm` isolation;
  separate large effort).
- Multi-executor *routing mechanism* (cardinality opens up, but how lifecycle
  picks among executors — explicit dispatch, policy plugin, round-robin,
  fallback chain — is left to a follow-up design).
- Fixes for findings 2, 4–20 in the adversarial review.

## Premises

1. Capability declaration is a product deliverable on its own. Even without runtime
   enforcement or install-time consent, a declared capability contract is dramatically
   better than "read the source" for third-party integration.
2. Owner-qualified names piggyback on npm's existing global uniqueness — no governance
   body, no reserved-prefix policing.
3. Cardinality is a property of each capability, not a global rule. Role authors
   decide.
4. Input-driving is a capability (`registerInputSource`), not a side-effect of
   hooking an event. This matches the existing pattern for `registerExecutor` and
   `registerTool` — first-class primitives for first-class capabilities.

## Design

### Capability Registry

Capabilities are named, typed extension points. Any plugin can define one; any
plugin can provide or consume one.

```typescript
// During setup() (INITIALIZING state only):
ctx.defineCapability(name: string, spec: CapabilitySpec): void;

interface CapabilitySpec {
  cardinality: 'one' | 'many';
  // 'one': exactly one provider required when consumed. Zero or two → fatal.
  // 'many': any number of providers, including zero (graceful no-op if none).

  schema?: JsonSchema;
  // Describes the shape of what providers register (for registry-shaped capabilities)
  // or what consumers receive (for data-shaped capabilities). Optional — capabilities
  // without a schema are opaque.

  description: string;
  // Human-readable. Shown by `kaizen capability show`.
}
```

Capability names are **owner-qualified**: `<defining-plugin-name>:<capability-path>`.
The defining plugin's `name` field must be the prefix. Core rejects definitions
whose name does not match.

Examples:
- `core-lifecycle:lifecycle.drive`
- `core-lifecycle:ui.input`
- `core-lifecycle:ui.output`
- `core-executor-anthropic:executor.send`
- `kaizen-plugin-godot:project-inspector`

### Plugin Manifest

The `KaizenPlugin` interface gains two fields replacing `provides`/`depends`:

```typescript
interface KaizenPlugin {
  name: string;
  apiVersion: string;

  capabilities?: {
    provides?: string[];   // canonical or aliased capability names
    consumes?: string[];   // canonical or aliased capability names
  };

  aliases?: Record<string, string>;
  // Map short/alternative names to canonical. e.g.
  //   { 'ui.input': 'core-lifecycle:ui.input' }
  // Aliases resolve during load. A fork of core-lifecycle can declare
  //   aliases: { 'core-lifecycle:ui.input': 'my-fork:ui.input' }
  // for drop-in compatibility.

  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
}
```

The old `provides`/`depends` fields are removed. Migration is mechanical (see
Migration section).

### Cardinality Enforcement

After all `setup()` calls complete, core validates:

- For every capability in any plugin's `consumes`: the capability must be defined,
  and the number of providers must match its declared cardinality.
  - `cardinality: 'one'`: exactly one provider. Zero or two+ → fatal startup error.
  - `cardinality: 'many'`: any count including zero (consumer must handle empty).
- For every capability in any plugin's `provides`: the capability must be defined.
  Undefined → fatal error (typo protection).
- Providers' registered values are validated against the capability's `schema`
  (via ajv) if one is declared. Validation failure → fatal error for singleton
  capabilities, skip + warn for `many` capabilities.

### Dependency Ordering

Topological sort replaces `depends[]`-on-role with `consumes[]`-on-capability.
A plugin that consumes `X` initializes after all plugins that provide `X`. Cycles
produce a fatal error (same behavior as today).

### New Primitive: `registerInputSource`

Replaces the session-loop-event-return mechanism for UI input. Enables multiple
concurrent input sources.

```typescript
interface InputSource {
  next(): Promise<InputEvent>;
  // Resolves when this source has input for the lifecycle. Called in a race
  // against other sources. Should be cancellable — if another source wins,
  // the loser's pending next() is abandoned.

  cancel?(): void;
  // Optional. Called by lifecycle when another source has won the race, to
  // allow cleanup (e.g., stop reading stdin mid-read).
}

interface InputEvent {
  type: 'continue' | 'yield' | 'end';
  prompt?: string;
  source: string;  // which plugin produced this input (for logging/audit)
}

// On PluginContext:
ctx.registerInputSource(source: InputSource): void;
```

Providers of `core-lifecycle:ui.input` call `registerInputSource()` during
`setup()`. The lifecycle loop does:

```typescript
const sources = ctx.runtime.inputSources;  // array of registered sources
while (running) {
  const event = await Promise.race(sources.map(s => s.next()));
  sources.forEach(s => s.cancel?.());
  // ... handle event
}
```

If zero input sources are registered *and* no plugin consumes `ui.input` (headless
mode), lifecycle proceeds without waiting — matches the autonomous Pattern B use
case already documented in DESIGN.md.

`response:before` and `response:after` events stay as-is. Multiple UIs rendering
output concurrently is already supported through the existing serial-handler
event bus — every UI gets a chance to render.

### Multi-Provider Executor (Cardinality Only)

`executor.send` / `executor.stream` cardinality changes from `one` to `many`.
Multiple executor plugins may register. This plan stops there: **the routing
mechanism is deferred** to a follow-up design.

Until routing lands, the lifecycle's `ctx.runtime.executor` resolves to the first
registered provider (documented behavior, stable for existing single-executor
harnesses). Introducing a router in a later revision does not break existing
single-provider setups.

### Migration of Existing Built-in Roles

| Today | After |
|-------|-------|
| `core-lifecycle` provides `lifecycle`, depends `['executor']` | Defines `core-lifecycle:lifecycle.drive` (one), `core-lifecycle:ui.input` (many), `core-lifecycle:ui.output` (many). Provides `lifecycle.drive`. Consumes `executor.send`. |
| `core-ui-terminal` provides `ui` | Provides `core-lifecycle:ui.input` and `core-lifecycle:ui.output`. Calls `registerInputSource()` instead of hooking `session:loop` for input. |
| `core-executor-anthropic` provides `executor`, calls `registerExecutor()` | Defines `core-executor-anthropic:executor.send` (many) — or imports a shared definition from a `core-executor-types` package if we choose to hoist it. Provides that capability. |
| `core-cli` depends `['lifecycle']` | Consumes `core-lifecycle:lifecycle.drive`. |

Open decision (to surface in planning): whether the `executor.send` capability
should be defined by each executor plugin independently (natural under owner-qualified
naming, but means every consumer needs aliases) or hoisted into a shared
`core-executor-protocol` package. Leaning toward hoisted — this is a protocol
that predates any specific executor.

### Introspection CLI

```
kaizen capability list
  # Prints all defined capabilities across loaded plugins:
  #   core-lifecycle:lifecycle.drive  (one)   — drives the session loop
  #   core-lifecycle:ui.input         (many)  — provides user input to the session
  #   core-lifecycle:ui.output        (many)  — renders session output
  #   core-executor-anthropic:executor.send (many) — sends messages to an LLM
  #   ...

kaizen capability show core-lifecycle:ui.input
  # Prints: cardinality, description, schema, providers loaded,
  # consumers loaded, aliases.
```

Implemented by a new `core-capability-cli` plugin (or folded into `core-cli`).
Reads from the capability registry. No new core API required beyond exposing the
registry to plugins for introspection (read-only).

### Plugin Migration Guide

A dedicated migration document (`docs/plugin-migration-capability-registry.md`)
ships as part of this work. Context: there is currently one external plugin
author building against kaizen. Their agents will use this doc to perform the
migration mechanically, without reading core source or this spec.

The migration doc must contain:

1. **The rename table** — `provides: ['ui']` → `capabilities: { provides:
   ['core-lifecycle:ui.input', 'core-lifecycle:ui.output'] }`, etc. Full
   mapping for every built-in role, copy-pasteable.
2. **`depends` → `consumes` mapping** for every built-in role, including
   capability names the plugin must now reference.
3. **Input-source migration recipe** — if the plugin hooked `session:loop` to
   provide input: concrete before/after code snippets showing the shift to
   `ctx.registerInputSource(source)`. Must include a complete working
   `InputSource` implementation as a template.
4. **Third-party capability definition recipe** — how a plugin defines its own
   capabilities, including owner-qualified naming rules and an example.
5. **Alias declaration recipe** — when to declare `aliases` (fork compatibility,
   short-name ergonomics), with examples.
6. **Introspection commands** — `kaizen capability list` and
   `kaizen capability show` for verifying the migration succeeded.
7. **Failure modes and fixes** — the exact fatal-error strings core emits
   (unknown capability, cardinality violation, owner-prefix mismatch, schema
   validation failure) and the diff needed to resolve each.
8. **Migration checklist** — ordered steps an agent can execute end-to-end:
   update manifest → rename fields → wire `registerInputSource` if applicable
   → run tests → verify with introspection CLI.

Acceptance criterion: a capable agent, given only the migration doc and a
pre-migration plugin, can produce a working post-migration plugin without
reading this spec or core source.

### Event Bus: Unchanged

The event bus stays as-is. Capabilities are for *registered extension points*
(things plugins call `register*()` for); events are for *notifications* (things
plugins `emit()`). Both systems coexist. This design does not touch `defineEvent`,
`on`, or `emit`.

## Error Handling

- Capability name with wrong owner prefix → fatal error at `defineCapability()`
  call: `"Capability 'foo:bar' must be prefixed with plugin name 'baz'."`
- Undefined capability in `consumes` → fatal: `"Plugin '<X>' consumes undefined
  capability '<cap>'. Typo? Missing plugin dependency?"`
- Cardinality violation for `one` capability → fatal with list of offenders.
- Provider registers a value failing schema validation:
  - For `one`: fatal.
  - For `many`: warn + skip that provider's registration, continue.
- Cycle in `consumes` graph → fatal (same as today's `depends` cycle).
- Alias conflict (two plugins alias the same short name to different canonicals)
  → warn; first wins.

## Testing Strategy

Unit:
- Capability name validation (owner-prefix enforcement).
- Cardinality enforcement (zero/one/many combinations for both `one` and `many`).
- Schema validation paths (valid, invalid, missing schema).
- Alias resolution, including the fork-compatibility case.
- Topological sort using `consumes` graph.

Integration:
- Default stack still boots end-to-end after migration.
- A second UI plugin (`core-ui-mock`) loads alongside `core-ui-terminal` and both
  register input sources. Lifecycle races them correctly.
- Headless lifecycle (no `ui.input` consumer, no input sources registered) runs
  the autonomous Pattern B harness without hanging.
- `kaizen capability list` / `show` output matches the loaded registry.

Contract:
- `kaizen-plugin-noop` continues to load without changes beyond the one-line
  `provides`/`depends` → `capabilities` rename.

## Success Criteria

1. Two UI plugins (`core-ui-terminal` + a mock web UI) load simultaneously. Either
   can submit a prompt; the session uses whichever submits first for each turn.
   Zero changes to `core-lifecycle` or `core-executor-*` beyond the migration.
2. Multiple `executor.send` providers load without a cardinality error. (Routing
   not yet implemented — first-registered wins, documented.)
3. A third-party plugin author can integrate with `acme-lifecycle` by reading
   `kaizen capability show` output and the exported TypeScript types, without
   reading `acme-lifecycle`'s source.
4. `kaizen capability list` surfaces every capability across every loaded plugin.
5. All existing tests pass after migration. The autonomous Pattern B harness runs
   headlessly.
6. `docs/plugin-migration-capability-registry.md` is published. A capable coding
   agent, given only that doc and a pre-migration plugin, produces a working
   post-migration plugin with no access to this spec or core source.

## Deferred Work

Captured here so the trail is clear for follow-up design sessions. None of these
block this plan; all of them are unlocked or eased by it.

### D1. Install-Time Consent UX (Layer 1 security model)

Display a UAC-style prompt at plugin install time showing declared capabilities,
sensitive consumes (fs, network, env, subprocess), and recording consent. Requires
a broader plugin-installer redesign (version pinning, provenance, uninstall/update
flows, consent persistence). The capability manifest declared by this plan is the
input to that UX — data is already there, just not displayed or gated.

**Partially addresses:** review findings 2, 3, 9.

### D2. Runtime Enforcement / Sandboxing (Layer 2 security model)

Actually prevent a plugin from reading `/etc/shadow` when it didn't declare
`fs.read:/etc/**`. Requires `worker_threads`, a `vm` context, or SES. Substantial
effort. The declared manifest from this plan becomes the enforcement policy.

**Addresses:** review findings 2, 3, 4, 11 (partially).

### D3. Multi-Executor Routing Mechanism

Cardinality opens up in this plan, but how lifecycle selects among multiple
registered executors (explicit dispatch by name, policy plugin, fallback chain,
cost/quality routing) is a separate design. Options to explore:
- `ctx.runtime.executors` as `Map<string, Executor>`; lifecycle dispatches by name
  or configured policy.
- A dedicated `executor-router` capability that wraps the multi-provider selection.
- Per-tool-call routing metadata.

### D4. Adversarial Review Findings Not Addressed

This plan is scoped to finding 1 with foundations for 2/3. Other findings
(4–8, 10, 12–20) are untouched. Explicit non-goals for this plan:
- Namespace isolation for events (finding 13) — related, but a separate refactor.
- Tool name namespacing (finding 6) — analogous solution (owner-qualified) could
  apply in a future plan.
- Harness extends-chain validation (finding 8).
- apiVersion hard failure (finding 12).
- Supply chain / version pinning (finding 9) — paired with D1.
- README and developer SDK (findings 16, 18).

### D5. Parallel Handler Execution

Current event bus runs handlers serially. `response:before` rendering across
multiple UIs works but is sequential. A follow-up could opt certain events into
parallel handler execution. Not required by this plan.

## Open Questions

1. Should `executor.send` / `executor.stream` be defined by a shared
   `core-executor-protocol` package, or independently per executor plugin with
   aliases? Leaning shared. Decide during planning.
2. Should `registerInputSource` support priority / fallback semantics (e.g., a
   "backup" source used only when primary sources have been idle for N ms)? Out
   of scope for MVP of this plan; easy to add later.
3. Do we version capability schemas? A plugin declaring a capability today may
   evolve the schema. Adding a `version` field to `CapabilitySpec` is cheap and
   future-proof. Recommend yes; decide during planning.

## Rollback

The migration is additive up to the point of removing `provides`/`depends`. A
phased rollout (capability system lives alongside roles for one version, roles
deprecated with warning, roles removed) is possible but adds complexity. Given
there are no third-party plugins in the ecosystem yet, a hard cutover is
acceptable and is the recommended approach.
