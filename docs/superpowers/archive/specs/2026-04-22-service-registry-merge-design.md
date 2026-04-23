# Service Registry Merge — Design

**Date:** 2026-04-22
**Status:** Approved
**Tracking issue:** follow-up to the "plugins can't import each other" investigation; resolves the architecture question raised while working on Issue #34.

## Motivation

Kaizen has two overlapping registries for plugin-to-plugin interop:

- **`CapabilityRegistry`** — string-keyed, tracks define / provide / consume relationships, carries a `CapabilitySpec`, used for topo-sort and post-init validation.
- **`ServiceRegistry`** — typed-token-based, carries a `Symbol` and phantom type, one impl per token, used for direct request/response interop.

The token-based registry requires plugins to share a token object at runtime, which forces bare-specifier imports between plugins (`import { SomeToken } from "core-events"`). That mechanism is not wired up by the installer and fails at plugin load time. Trying to make bare-specifier resolution work runs into version-conflict, name-collision, and cross-marketplace questions we don't want to solve.

The insight from brainstorming: the `CapabilityRegistry` can carry arbitrary payloads (constants, classes, Symbols, functions) — preserving runtime identity, class inheritance, and `instanceof` checks — without requiring any bare import. If the registry is the universal carrier and types are sourced via static `import type` against a plugin-shipped `.d.ts`, we eliminate bare-imports between plugins entirely.

This spec collapses the two registries into one, renames it `ServiceRegistry`, and defines the `ctx.*` surface, migration plan, and authoring guidance that follow.

## Goals

- Collapse `CapabilityRegistry` and `ServiceRegistry` into a single string-keyed `ServiceRegistry` that carries arbitrary payloads.
- Eliminate the need for plugins to import each other by bare specifier at runtime.
- Preserve the existing permission model, lockfile format, consent flow, and `EventBus` unchanged.
- Give plugin authors a clear decision rule for interop: host API vs service vs event.
- Keep the migration mechanical enough to rewrite the existing `kaizen-official-plugins` in one pass.

## Non-goals

- Changing the permission enforcer, sandbox, or consent flow.
- Subpath or bare-specifier module resolution between plugins.
- Auto-generating `.d.ts` files from registered service payloads.
- Full TypeScript editor DX beyond documenting the `tsconfig.json` `paths` pattern.
- Versioned service contracts (`events/v1` vs `events/v2`) — recorded as future work.
- Rewriting `EventBus`.

## Authoring guidance

Four mechanisms, four decision points (ships in `docs/concepts/plugin-model.md`):

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

## `ServiceRegistry` — API and semantics

```ts
class ServiceRegistry {
  define(name: string, pluginName: string, spec: ServiceSpec): void;
  provide<T>(name: string, pluginName: string, impl: T): void;
  consume(name: string, pluginName: string): void;
  use<T>(name: string): T;
  validateAll(): void;
  list(): ServiceEntry[];
  providersOf(name: string): string[];
  consumersOf(name: string): string[];
  getSpec(name: string): ServiceSpec | undefined;
  deregisterByPlugin(pluginName: string): void;
}

interface ServiceSpec {
  description?: string;
  schema?: JSONSchema;   // optional; informational in v1
  version?: string;      // optional; informational in v1
  // cardinality is implicitly "one" in v1 and not part of ServiceSpec yet
}
```

### Naming convention

Service names are `<plugin-name>:<symbol>`. The registry enforces that the defining plugin owns its namespace — `defineService("other:x", ...)` from plugin `me` throws. Inherited from the current `CapabilityRegistry` prefix check. Prevents silent collisions and makes provenance visible in every reference.

### Payload semantics

- The value passed to `provide` can be any JavaScript value — object, class constructor, `Symbol`, primitive, nested mix.
- `use` returns the exact same reference. No cloning, no proxying, no isolation.
- Shared mutable state between plugins is possible via mutation of a returned object. Document as a pitfall; plugins that want immutability provide `Object.freeze`'d payloads.

### Cardinality — v1 scope

Every service is **cardinality "one"** in v1: exactly one provider permitted. Attempting `provide` twice for the same name throws.

Per-plugin prefixing means multiple legitimate providers of "similar things" live at distinct service names (`core-terminal-ui:ui`, `core-web-ui:ui`). A caller who wants a *specific* implementation uses the name. A caller who wants to fan out to *whatever's loaded* uses events — that's what `EventBus` exists for.

Consumers are unlimited. A single service can be used by every other plugin in the harness.

### Validation rules (`validateAll`, called after all plugins finish `setup()`)

- Every consumed service must be defined. Otherwise fatal: `plugin '<x>' consumes undefined service '<y>'`.
- Every defined service must have exactly one provider. Otherwise fatal: `service '<y>' has <n> providers (exactly one required)`.
- Provider for undefined service: fatal on the `provide` call (fail fast, not deferred to `validateAll`).
- Multiple `define` calls for the same name: warn and keep the first. Matches existing behavior.

### Lifecycle and state gating

- `define`, `provide`, `consume` — only during a plugin's `INITIALIZING` state (`setup()`). Enforced by `ctx` wrappers calling `assertInitializing()`.
- `use` — available in any state after `INITIALIZING` completes. Throws if the service isn't resolved (`provide` not yet called or `validateAll` hasn't run).
- `deregisterByPlugin` — called by `PluginManager` on plugin reload/unload.

### Why define / provide / consume stays split

Separating declaration from registration lets `PluginManager`'s pass 1 build the dependency graph for topo sort and pass 3 verify the graph before any plugin transitions to `RUNNING`. Collapsing into a single call would force provide/consume to happen in load order, which we can't guarantee without topo sort — chicken and egg.

## `ctx.*` surface

```ts
interface PluginContext {
  // Service registry — merged
  defineService(name: string, spec: ServiceSpec): void;
  provideService<T>(name: string, impl: T): void;
  consumeService(name: string): void;
  useService<T>(name: string): T;

  // Event bus — unchanged
  defineEvent(name: string): void;
  emit(name: string, payload: unknown): Promise<void>;
  on(name: string, handler: (payload: unknown) => void | Promise<void>): void;

  // Host API, fs/net/env/exec/secrets — unchanged
  // ...
}
```

### State gating

| Method | Allowed during `setup()` | Allowed during `RUNNING` |
|---|---|---|
| `defineService` | ✓ | ✗ (throws) |
| `provideService` | ✓ | ✗ (throws) |
| `consumeService` | ✓ | ✗ (throws) |
| `useService` | ✗ (throws — providers may not have registered yet) | ✓ |
| `defineEvent`, `on` | ✓ | ✗ |
| `emit` | ✗ | ✓ |

### Why `consumeService` is a separate explicit call

Two alternatives:

**(a) Implicit via `useService`** — the first call records the plugin as a consumer. Simple, but `validateAll()` cannot run before `RUNNING` because the graph isn't complete until consumers actually call `useService`. Defeats the "catch missing services early" property.

**(b) Explicit declaration during setup** — `ctx.consumeService(name)` during `setup()` declares intent; `useService` remains the runtime accessor. Matches the existing `CapabilityRegistry.addConsumer` pattern, preserves post-init validation, and gives `kaizen service list` the correct graph.

We pick (b). One extra line per consumed service is a fair price for fail-fast validation.

## Type flow — `import type` pattern

Plugins publish a `.d.ts` alongside their source. Consumers reference it via static `import type` — erased at build time, zero runtime effect.

Provider side:

```ts
// utils/public.d.ts — shipped alongside the plugin
export interface PathHelpers {
  resolveHome(): string;
  joinSafe(...segs: string[]): string;
}
```

```ts
// utils/index.ts
import type { PathHelpers } from "./public";

const plugin: KaizenPlugin = {
  name: "utils",
  setup(ctx) {
    ctx.defineService("utils:paths", { description: "path helpers" });
    ctx.provideService<PathHelpers>("utils:paths", {
      resolveHome: () => process.env.HOME ?? "/",
      joinSafe: (...segs) => join(...segs),
    });
  },
};
```

Consumer side:

```ts
import type { PathHelpers } from "official/utils/public";

const plugin: KaizenPlugin = {
  name: "github",
  setup(ctx) {
    ctx.consumeService("utils:paths");
  },
  start(ctx) {
    const paths = ctx.useService<PathHelpers>("utils:paths");
    paths.resolveHome();  // fully typed
  },
};
```

### Editor setup for consumers

`import type { X } from "official/utils/public"` is a bare specifier without a real package in `node_modules`. TypeScript needs help resolving it. Two supported paths:

**(1) Recommended — `tsconfig.json` `paths`** pointing at the installed plugin's exact version directory:

```json
{
  "compilerOptions": {
    "paths": {
      "official/utils/*": ["/Users/you/.kaizen/marketplaces/official/plugins/utils@0.1.0/*"]
    }
  }
}
```

Paths are concrete (pinned to a specific version directory) because TypeScript's `paths` mechanism does string substitution, not filesystem globbing — an `@*` wildcard won't resolve at runtime. `kaizen plugin create` scaffolds this `tsconfig.json` with the concrete version directories for whichever plugins are installed at scaffold time. Keeping `paths` in sync as plugins update is tracked as deferred work in [Open Questions #3](#open-questions--deferred-work); until that ships, users re-run the scaffolder (or manually update `paths`) after marketplace updates.

**(2) Fallback — declaration shim in `node_modules/@types/`** for authors whose build tool ignores `paths`. Opt-in; more invasive.

Runtime touches neither — they're TypeScript-only.

## Migration plan

### Strategy: hard cutover, no compat shim

Kaizen is pre-1.0 with one first-party plugin repo. A deprecation window isn't worth the carrying cost. One-shot rewrite, version bumps on both sides.

Kaizen bumps to `0.2.0`. Plugins bump their `minKaizenVersion` in the marketplace catalog. Existing `v0.1.x` binaries continue to work with unmigrated plugins; `v0.2.0` refuses to load them.

### Steps in order

**1. Kaizen core — new `ServiceRegistry` lands**

- Replace `src/core/service-registry.ts` with the merged, string-keyed implementation.
- Delete `src/core/capability-registry.ts` (its role is subsumed).
- Delete `ServiceToken` class from `src/types/plugin.ts`. Remove from host-API types exported via `kaizen/types`.
- Rename `PluginCapabilities` → `PluginServices` in `src/types/plugin.ts`; rename `KaizenPlugin.capabilities` → `KaizenPlugin.services`. Rename `CapabilitySpec` → `ServiceSpec`.
- Update `src/core/context.ts`:
  - Remove `registerService(token, impl)`, `getService(token)`, `defineCapability(name, spec)`.
  - Add `defineService`, `provideService`, `consumeService`, `useService`.
  - Preserve state-gating wrappers.
- Update `src/core/plugin-manager.ts` pass 1 (lines 349–358) and pass 3 (lines 401–405).
- Update `src/core/plugin-manager.ts` manifest reader: `plugin.capabilities` → `plugin.services`.

**2. Kaizen CLI — rename subcommand**

- `src/commands/capability.ts` → `src/commands/service.ts`. Rename `capabilityList` → `serviceList`, `capabilityShow` → `serviceShow`.
- `src/cli.ts:477–486`: `subcommand === "capability"` → `"service"`. Update help text in the top-level help.
- No compat alias for `kaizen capability` — pre-1.0, make the break clean.

**3. Tests — rewrite**

| File | Change |
|---|---|
| `src/core/capability-registry.test.ts` | Delete |
| `src/core/service-registry.test.ts` | Rewrite to cover the merged registry's API |
| `src/core/plugin-manager.test.ts` | Update fixtures from `capabilities: {}` → `services: {}`; update ctx mock |
| `src/core/integration/driver-capability-resolution.test.ts` | Rename and rewrite for `services` |
| `src/core/context.test.ts` (if present) | Update method coverage |

**4. Docs + scaffolder**

| File | Change |
|---|---|
| `docs/concepts/plugin-model.md` | Replace "capabilities" narrative with services + authoring guidance |
| `docs/guides/plugin-authoring.md` | Update examples to `defineService` / `provideService` / `useService`; remove `ServiceToken` section |
| `docs/reference/plugin-api.md` | Update method signatures; remove `ServiceToken`, rename `CapabilitySpec` → `ServiceSpec` |
| `docs/reference/host-api.md` | Remove `ServiceToken` from exported types list |
| `src/commands/plugin-create.ts` | Update `generateIndexTs` to the new API; include a `public.d.ts` stub; scaffold `tsconfig.json` with the `paths` pattern |

**5. kaizen-official-plugins repo — separate PR, lands after kaizen v0.2.0**

Each plugin:

- Rewrite cross-plugin imports: `import { X } from "core-events"` → `import type { X } from "official/core-events/public"` + runtime via `ctx.useService`.
- Delete `ServiceToken` usage; replace with string service names.
- Rewrite `ctx.registerService(token, impl)` / `ctx.getService(token)` → `ctx.provideService(name, impl)` / `ctx.useService(name)`.
- Rewrite `ctx.defineCapability(name, spec)` → `ctx.defineService(name, spec)`.
- Add `ctx.consumeService(name)` in `setup()` for every service used at runtime.
- Rename manifest field `capabilities` → `services`.
- Add `public.d.ts` listing exported types.
- Bump plugin version (`0.1.0` → `0.2.0`).

Catalog (`.kaizen/marketplace.json`):

- Bump `minKaizenVersion` to `0.2.0` for each entry.
- Bump each plugin's version.

### Lockfile behavior

Manifest shape changes (`capabilities` → `services`, version bump) invalidate existing tier-grant hashes. Consent flow re-prompts on next run — correct behavior: plugin surface changed, user reviews. No lockfile schema changes needed.

### Order of PRs

1. PR against `CraightonH/kaizen` — `ServiceRegistry` merge, context changes, CLI rename, tests, docs. Ship as v0.2.0.
2. PR against `CraightonH/kaizen-official-plugins` — plugin rewrites, version bumps, catalog `minKaizenVersion` bumps.

Kaizen v0.2.0 is released with no working marketplace plugins for a short window. Acceptable because the old binary still works for existing users and the window is hours, not days. Users who need stability pin to v0.1.x.

## Testing

### Unit — new `ServiceRegistry`

- `define` enforces `<pluginName>:<symbol>` prefix.
- `define` warns + keeps first on duplicate name.
- `provide` throws when called without prior `define`.
- `provide` throws on second call for the same name (cardinality-one enforcement).
- `consume` records consumer intent without requiring the service to be provided yet.
- `use` returns the registered implementation by reference (verified by `===`).
- `use` throws when the service has no provider at call time.
- `validateAll` fatal when a consumed service is undefined.
- `validateAll` fatal when a defined service has zero providers.
- `deregisterByPlugin` removes all define/provide/consume entries for the named plugin; others survive.
- `list` / `providersOf` / `consumersOf` / `getSpec` introspection returns expected shapes.

### Unit — `PluginContext` surface

- `defineService` / `provideService` / `consumeService` throw unless state is `INITIALIZING`.
- `useService` throws during `INITIALIZING`, succeeds during `RUNNING`.
- Prefix enforcement: `defineService("other-plugin:foo", ...)` from plugin `me` throws.

### Integration — plugin graph

- Two plugins A and B where A provides `a:thing` and B consumes it. Assert load order.
- Three-plugin chain with a cycle → fatal at topo sort.
- Plugin consumes `missing:thing` not defined by anyone → fatal at `validateAll`.
- Plugin defines `x:thing` but no one provides → fatal at `validateAll`.
- Two plugins both try to provide `a:thing` → fatal on the second `provideService`.

### Integration — plugin manager + real loader

- Load a two-plugin fixture through `PluginManager.initialize()` end-to-end; assert both transition `INITIALIZING → RUNNING` and the consumer can `useService` the provider's impl.

### CLI smoke

- `kaizen service list` against a harness prints define/provide/consume graph.
- `kaizen service show <name>` on a defined name prints spec + provider + consumers.
- `kaizen service show <missing>` prints a clean "not found" error.

### Manual E2E (pre-release)

- Build v0.2.0 binary.
- Migrate one official plugin as a smoke test (e.g. `core-events`). Run an end-to-end harness session.
- Re-migrate the full set; run `kaizen --harness official/core-shell@1.0.0` from a clean `~/.kaizen/`.

## Open questions / deferred work

**1. Versioned service contracts.** Future `service-name@1`, `@2` with multiple versions coexisting. Not needed today; worth flagging for when ecosystem turnover begins.

**2. Auto-generated `public.d.ts`.** A future `kaizen plugin types` tool could emit the declaration file from actual `provideService` payloads using TS's language service. Skippable for a small plugin set.

**3. tsconfig `paths` auto-sync.** `kaizen install <plugin>` could optionally update a project-scoped `tsconfig.json`'s `paths`. Opt-in post-install hook.

**4. Runtime payload validation against `ServiceSpec.schema`.** Field is informational in v1. Wiring it to validate `provideService` payloads is low-cost once the merge is done.

**5. Event bus and services converging.** We keep them separate. Revisit in ~6 months with real plugin-author feedback.

**6. Richer cross-plugin type publishing.** If demand appears for patterns like `official/core-events/types` subpath imports, a formal story is needed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Plugin authors don't keep `public.d.ts` in sync with runtime impl | Doc + scaffolder template; consider auto-generation later (open Q#2) |
| Consumers stringly-type `useService` without generic, get `unknown` | Lint rule / doc example; runtime behavior still works, just no types |
| Service name typos silently don't resolve | `validateAll` catches missing-provider case; `kaizen service list` surfaces typo-heavy names |
| Rewrite PR against kaizen-official-plugins stalls, leaving users on v0.2.0 with no working plugins | Ship both PRs same day; pin users to v0.1.x until plugins catch up |
| Editor DX regression annoys early users | Scaffolder ships a working `tsconfig.json`; docs cover manual setup; worst case is red squiggles, not broken runtime |

## Security posture — unchanged

Verified by a survey of permission-enforcement code: neither `CapabilityRegistry` nor `ServiceRegistry` is consulted by any permission check. The enforcer, sandbox, consent flow, and lockfile all read the plugin's declared `PluginPermissions` manifest — not registry state.

Files confirmed unaffected:

- `src/core/permission-enforcer.ts` and tests
- `src/core/sandbox-bootstrap.ts` and tests
- `src/core/consent-flow.ts`
- `src/core/lockfile.ts`
- `src/commands/plugin-consent.ts`, `plugin-review.ts`, `plugin-audit.ts`

The `EventBus` permission model (`events.subscribe` grants) is also unaffected; events remain a separate mechanism with its own grant shape.
