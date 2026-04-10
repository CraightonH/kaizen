---
title: 'Service Registry: full implementation — registry class, context wiring, dogfood pair, docs'
type: 'feature'
created: '2026-04-09'
status: 'done'\nbaseline_commit: '060a6b06573f82ca046d5fb754997312d64e5efc'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `ServiceToken<T>` exists but nothing stores or retrieves services: no `ServiceRegistry` class, no `ctx.registerService`/`ctx.getService` on plugin context, no built-in plugin pair proving the pattern, and no docs covering it.

**Approach:** Add `ServiceRegistry` to `service-registry.ts` (alongside `ServiceToken`), wire it through `context.ts` and `loader.ts`, dogfood it in `core-events` → `core-lifecycle`, then document the pattern in `docs/plugin-api.md`. All changes are purely additive — no existing behavior modified.

## Boundaries & Constraints

**Always:**
- `ServiceRegistry` lives in `src/core/service-registry.ts` alongside `ServiceToken` — same file, no split
- Map key is the **token object** (object identity via `Map.has(token)`) — never `token.label` string, never `token._symbol`
- `assertInitializing()` guard goes in `context.ts`'s `registerService` wrapper — NOT inside `ServiceRegistry.register()`
- `ServiceRegistry` instantiated inside `loadPlugins()`, never at module scope — per-bootstrap test isolation (NFR7)
- Exact not-found error string: `Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin.`
- Exact duplicate error string: `Service '${token.label}' is already registered. Each service token may only have one provider.`
- `getService` has zero lifecycle gate — valid during RUNNING (tool handlers, event handlers)
- `ServiceRegistry` class is NOT re-exported from `kaizen/types` — internal only
- `CoreEventsService` interface + `CoreEventsServiceToken` defined and exported from `plugins/core-events/index.ts`
- Token label = TypeScript interface name exactly: `"CoreEventsService"`
- No new `kaizen.json` fields

**Ask First:**
- If any existing test files outside `src/core/` fail after loader.ts changes — HALT and report before continuing

**Never:**
- `Symbol.for()` anywhere in token or registry logic
- Module-level `const registry = new ServiceRegistry()` (breaks test isolation)
- `listServices()`, `hasService()`, or any enumeration API
- New `kaizen.json` fields
- Modifications to existing test files
- Splitting `ServiceToken` and `ServiceRegistry` into separate files

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Register then get | token T, impl conforming to T | `get(token)` returns impl typed as T, no cast | — |
| Duplicate register | `register(token, a)` then `register(token, b)` | throws with duplicate error | synchronous throw |
| Get unregistered | `get(token)` where label is "Svc" | throws not-found error | synchronous throw |
| Same-label distinct tokens | `register(tA, a)`, `register(tB, b)`, `tA !== tB` | both succeed; `get(tA)` → a, `get(tB)` → b | — |
| `registerService` outside `setup()` | called from tool execute handler | throws lifecycle violation (assertInitializing) | synchronous throw |
| `getService` during RUNNING | called from tool execute handler | returns service, no error | — |
| Fresh bootstrap | second `loadPlugins()` call | registry empty; service from first bootstrap gone | `get` throws not-found |

</frozen-after-approval>

## Code Map

- `src/core/service-registry.ts` — add `ServiceRegistry` class below `ServiceToken`; remove placeholder comment
- `src/core/service-registry.test.ts` — add `ServiceRegistry` unit tests
- `src/types/plugin.ts` — add `registerService<T>` and `getService<T>` to `PluginContext` interface
- `src/core/context.ts` — import `ServiceRegistry`; add `serviceRegistry` param to `createPluginContext()`; implement `registerService` (with guard) and `getService` (no guard)
- `src/core/loader.ts` — import `ServiceRegistry`; instantiate inside `loadPlugins()` before setup loop; pass to `createPluginContext()`
- `plugins/core-events/index.ts` — export `CoreEventsService` interface and `CoreEventsServiceToken`; call `ctx.registerService` in `setup()`
- `plugins/core-lifecycle/index.ts` — import `CoreEventsServiceToken`; call `ctx.getService(CoreEventsServiceToken)` in `setup()` and `start()`; remove static `EVENTS` import
- `docs/plugin-api.md` — append `## Service Registry` section using `CoreEventsService` as the canonical example

## Tasks & Acceptance

**Execution:**
- [x] `src/core/service-registry.ts` -- add `ServiceRegistry` class with `private readonly services = new Map<ServiceToken<unknown>, unknown>()`, `register<T>`, `get<T>` -- core storage; exact error strings; remove Story 1.2 placeholder comment
- [x] `src/core/service-registry.test.ts` -- add `ServiceRegistry` unit tests covering all I/O matrix rows -- register+get, duplicate, not-found, same-label-distinct-tokens, fresh-instance isolation
- [x] `src/types/plugin.ts` -- add to `PluginContext` interface: `registerService<T>(token: ServiceToken<T>, impl: T): void` and `getService<T>(token: ServiceToken<T>): T` -- public plugin API contract
- [x] `src/core/context.ts` -- add `serviceRegistry: ServiceRegistry` param; add `registerService` (assertInitializing guard) and `getService` (no guard) to returned object -- mirrors registerTool/emit split exactly
- [x] `src/core/loader.ts` -- import `ServiceRegistry`; `const serviceRegistry = new ServiceRegistry()` inside `loadPlugins()` scope; pass as arg to `createPluginContext()` -- per-bootstrap isolation
- [x] `plugins/core-events/index.ts` -- export `CoreEventsService` interface and `CoreEventsServiceToken`; in `setup(ctx)` call `ctx.registerService(CoreEventsServiceToken, { events: EVENTS })` -- provider dogfood
- [x] `plugins/core-lifecycle/index.ts` -- import `CoreEventsServiceToken` from `core-events`; in `setup(ctx)` call `ctx.getService(CoreEventsServiceToken)`; in `start(ctx)` use `ctx.getService(CoreEventsServiceToken).events.*` in place of static `EVENTS`; remove static `EVENTS` import -- consumer dogfood
- [x] `docs/plugin-api.md` -- append `## Service Registry` section: concept, lifecycle rules, `CoreEventsService`/`CoreEventsServiceToken` as working provider/consumer example -- FR20

**Acceptance Criteria:**
- Given `ctx.registerService(token, impl)` called in `setup()`, when `ctx.getService(token)` called, then returns `impl` typed as `T` with no explicit cast
- Given `ctx.registerService(token, impl)` called in a tool execute handler, when the tool runs, then throws a lifecycle violation error
- Given `ctx.getService(token)` called in a tool execute handler (RUNNING), then returns the service without error
- Given two sequential `loadPlugins()` calls, when second does not register `token`, then `getService(token)` throws not-found in the second bootstrap
- Given `core-events` and `core-lifecycle` both loaded, when `bootstrap()` completes, then `core-lifecycle` successfully retrieves `CoreEventsServiceToken` service and uses it in `start()`
- Given `bun test` run after all changes, then all pre-existing tests pass without modification

## Design Notes

**ServiceRegistry class** (add directly below `ServiceToken`, remove placeholder comment):
```typescript
export class ServiceRegistry {
  private readonly services = new Map<ServiceToken<unknown>, unknown>();

  register<T>(token: ServiceToken<T>, impl: T): void {
    if (this.services.has(token)) {
      throw new Error(`Service '${token.label}' is already registered. Each service token may only have one provider.`);
    }
    this.services.set(token, impl);
  }

  get<T>(token: ServiceToken<T>): T {
    const impl = this.services.get(token);
    if (impl === undefined) {
      throw new Error(`Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin.`);
    }
    return impl as T;
  }
}
```

**context.ts wiring** (mirror `registerTool`/`emit` pattern exactly):
```typescript
registerService<T>(token: ServiceToken<T>, impl: T): void {
  assertInitializing(getState(), "register services");
  serviceRegistry.register(token, impl);
},
getService<T>(token: ServiceToken<T>): T {
  return serviceRegistry.get(token); // no assertInitializing
},
```

**core-events provider:**
```typescript
export interface CoreEventsService { readonly events: typeof EVENTS; }
export const CoreEventsServiceToken = new ServiceToken<CoreEventsService>("CoreEventsService");
// in setup(ctx): ctx.registerService(CoreEventsServiceToken, { events: EVENTS });
```

**core-lifecycle consumer** — `getService` is valid at any lifecycle state so can be called in both `setup()` and `start()`:
```typescript
// setup: prove service is available
async setup(ctx) { ctx.getService(CoreEventsServiceToken); },
// start: use service instead of static import
async start(ctx) {
  const { events } = ctx.getService(CoreEventsServiceToken);
  // replace all EVENTS.* with events.*
}
```

## Verification

**Commands:**
- `bun test` -- expected: all tests pass, 0 fail (includes new ServiceRegistry tests)
- `bun x tsc --noEmit` -- expected: exit 0, zero type errors

## Suggested Review Order

**Core data structure**

- Typed token class with phantom brand; `ServiceRegistry` using object-identity Map key
  [`service-registry.ts:1`](../../src/core/service-registry.ts#L1)

- `Map.has()` guard (not `=== undefined`) enables `undefined` as a valid impl
  [`service-registry.ts:22`](../../src/core/service-registry.ts#L22)

**Public API contract**

- `PluginContext` gains `registerService`/`getService`; `ServiceToken` re-exported for plugin authors
  [`plugin.ts:14`](../../src/types/plugin.ts#L14)

**Context wiring**

- `registerService` gets `assertInitializing` guard; `getService` is lifecycle-free — asymmetry is intentional
  [`context.ts:34`](../../src/core/context.ts#L34)

- `new ServiceRegistry()` scoped inside `loadPlugins()` — per-bootstrap isolation (NFR7)
  [`loader.ts:184`](../../src/core/loader.ts#L184)

- `index.ts` threads `serviceRegistry` into the lifecycle `start()` context (second `createPluginContext` call)
  [`index.ts:28`](../../src/core/index.ts#L28)

**Dogfood pair**

- `core-events` exports the token and registers via `ctx.registerService`
  [`core-events/index.ts:61`](../../plugins/core-events/index.ts#L61)

- `core-lifecycle` validates availability in `setup()` then consumes in `start()`
  [`core-lifecycle/index.ts:72`](../../plugins/core-lifecycle/index.ts#L72)

**Tests & docs**

- 9 unit tests cover: token identity, same-label distinctness, register/get, `undefined` impl, isolation
  [`service-registry.test.ts:1`](../../src/core/service-registry.test.ts#L1)

- `## Service Registry` doc section with provider/consumer examples and rules table
  [`plugin-api.md:287`](../../docs/plugin-api.md#L287)
