---
stepsCompleted: ["step-01-init", "step-02-discovery", "step-02b-vision", "step-02c-executive-summary", "step-03-success", "step-04-journeys", "step-05-domain", "step-06-innovation", "step-07-project-type", "step-08-scoping", "step-09-functional", "step-10-nonfunctional", "step-11-polish", "step-12-complete"]
inputDocuments:
  - "_bmad-output/planning-artifacts/research/technical-synchronous-service-registry-plugin-ecosystems-research-2026-04-08.md"
  - "docs/architecture.md"
  - "docs/plugin-api.md"
  - "docs/adversarial-review.md"
workflowType: 'prd'
documentCounts:
  briefs: 0
  research: 1
  brainstorming: 0
  projectDocs: 3
classification:
  projectType: developer_tool
  domain: general
  complexity: medium
  projectContext: brownfield
---

# Product Requirements Document - kaizen

**Author:** Craighton
**Date:** 2026-04-08

## Executive Summary

Kaizen is a kernel-model plugin platform for LLM harnesses. Its core provides plugin loading, an event bus, and tool/executor primitives — everything else is a plugin. Today, plugins are islands: they sequence around shared lifecycle events but cannot share typed capabilities with each other. The event bus handles temporal coordination ("something happened"); it was not designed as an inter-plugin API layer.

This PRD defines the **synchronous service registry** — the primitive that closes the gap between plugin host and plugin platform. Plugin authors declare typed service tokens, register implementations during `setup()`, and retrieve them synchronously via `ctx.getService(token)`. The existing `depends` topological sort already guarantees provider-before-consumer ordering; the registry makes that ordering useful for direct, typed capability access.

The platform remains neutral about what composition produces. A simple custom LLM harness and a multi-plugin GitLab issue workflow are equally valid outputs of the same architecture. The service registry does not impose an orchestration model — it enables one, if the loaded plugin set calls for it.

### What Makes This Special

`ServiceToken<T>` (a named object wrapping a `Symbol`) is typed at compile time, unforgeable at runtime, collision-free across independently-authored packages, and importable as a module-level dependency declaration. The token import is load-bearing: importing `GitLabServiceToken` from `kaizen-plugin-gitlab` makes the inter-plugin coupling legible to static analysis and future tooling. Possession of the import equals possession of access — an implicit object-capability boundary with no additional machinery.

Ships as ~90 LOC across 4 files with zero breaking changes and no new dependencies. A reference provider/consumer plugin pair ships alongside as a first-class deliverable — working code that demonstrates the pattern plugin authors will follow.

## Project Classification

| Attribute | Value |
|---|---|
| Project Type | Developer tool / plugin platform SDK |
| Domain | General (developer tooling) |
| Complexity | Medium |
| Project Context | Brownfield — additive feature to existing system |
| Source | Adversarial review item 15; informed by technical research on VS Code, OSGi, Tapable, and TypeDI patterns |

## Success Criteria

### User Success

- A plugin author implements a provider/consumer pair by reading the reference implementation alone — no Kaizen internals required
- Type errors surface at compile time when token types are mismatched; missing `depends` declarations produce a named, actionable runtime error (not a silent undefined)
- The sync/async split is self-evident from the API surface: `ctx.getService()` vs `ctx.on()` communicates "call me" vs "something happened" without documentation

### Business Success

- The default Kaizen plugin stack dogfoods the service registry — at least one built-in plugin pair uses `registerService`/`getService` in production code, validating the pattern before third-party authors adopt it
- Plugin authors can publish a `ServiceToken` as part of their package's public API, making inter-plugin contracts a first-class npm artifact

### Technical Success

- ~90 LOC across 4 files (aspirational ceiling, not a hard constraint)
- Zero breaking changes to existing plugins or harnesses
- No new runtime dependencies
- `registerService` gated to `INITIALIZING` (consistent with `registerTool`); `getService` valid at any lifecycle state
- Error messages on missing service name the token label and suggest `depends`

### Measurable Outcomes

- At least one built-in plugin pair demonstrates provider/consumer pattern
- `ServiceToken<T>` and `registerService`/`getService` exported from `kaizen/types` and `plugin.ts` respectively
- Existing test suite passes without modification
- Reference implementation passes its own tests

## Product Scope

### MVP Strategy

**Approach:** Platform primitive — delivers the complete, stable API surface in one ship. A partial service registry is worse than none; the pattern must be usable end-to-end on day one.

**Resource Requirements:** 1 engineer. TypeScript, existing Kaizen test infrastructure, no new tooling.

### MVP — Minimum Viable Product

**Core user journeys supported:** All four — provider/consumer authoring, type mismatch detection, transparent harness wiring, built-in dogfood pair.

**Must-have capabilities:**
- `ServiceToken<T>` class exported from `kaizen/types`
- `ctx.registerService(token, impl)` — gated to `INITIALIZING`
- `ctx.getService(token)` — ungated, throws named error on miss
- `ServiceRegistry` internal class (`src/core/service-registry.ts`)
- Loader integration — registry instantiated in bootstrap, passed into context
- Built-in reference provider/consumer plugin pair
- `docs/plugin-api.md` updated with service pattern section

### Growth Features (Post-MVP)

- Service introspection / debug tooling (list registered services by token label)
- `kaizen plugin` CLI surfacing available services for a loaded harness
- Service versioning or compatibility declarations

### Vision (Future)

- Dynamic service registration/unregistration during `RUNNING`
- Service discovery across distributed Kaizen instances
- Plugin marketplace metadata declaring published service tokens

### Risk Mitigation

**Technical:** Symbol-based identity is scoped to a single process — no cross-realm issues in Kaizen's architecture. No serialization of tokens needed.

**API stability:** Reference implementation ships with MVP and exercises the full API surface. Design flaws surface before public release, not after.

**Scope creep:** Growth and vision features explicitly documented as post-MVP. This PRD is the gate.

## User Journeys

### Journey 1: The Solo Plugin Author — Provider and Consumer (Happy Path)

**Meet Alex.** Alex is building a Kaizen plugin suite for a GitLab workflow harness — one plugin that fetches issue context, another that submits MRs. Today, plugin 2 has no way to call plugin 1 directly. Alex emits custom events with data in the payload and subscribes on the other side, but the types are lost, there's no contract, and a payload shape change in plugin 1 silently breaks plugin 2 at runtime with no useful error.

Alex discovers `ServiceToken`. In plugin 1's `index.ts`, they define and export a `GitLabServiceToken` with a typed interface — `getIssue(id: string): Issue`. They call `ctx.registerService(GitLabServiceToken, impl)` during `setup()`. In plugin 2, they import `GitLabServiceToken` from plugin 1's package and call `ctx.getService(GitLabServiceToken)` to get a fully typed handle. TypeScript enforces the contract at compile time.

The `depends` declaration in plugin 2's manifest ensures plugin 1 always initializes first. The workflow — fetch issue → pass context to LLM → submit MR — is now a real pipeline of composing plugins, not an event bus hack. Alex ships both plugins as separate npm packages; the service token is part of plugin 1's public API.

**Capabilities revealed:** `ServiceToken<T>` type, `ctx.registerService`, `ctx.getService`, compile-time type enforcement, `depends` ordering guarantee.

---

### Journey 2: The Type Mismatch — Wrong Token at Compile Time (Edge Case)

**Meet Jordan.** Jordan consumes a third-party `AnalyticsServiceToken` exported from `kaizen-plugin-analytics`. The package ships a new major version that changes the service interface — `track()` now takes a structured event object instead of a string. Jordan's plugin still imports the old token shape from a cached type definition.

TypeScript flags the mismatch at `ctx.getService(AnalyticsServiceToken)` — the returned type no longer matches Jordan's usage. Jordan sees a clear compile error pointing to the token import, updates the interface, and fixes the call site. No runtime crash, no silent data corruption. The token import itself signals where to look.

**Capabilities revealed:** Generic type parameter on `ServiceToken<T>` propagated through `getService` return type; module-level coupling makes version mismatches visible to the compiler, not discovered at runtime.

---

### Journey 3: The Harness Author — Transparent Wiring (Secondary User)

**Meet Sam.** Sam is assembling a `kaizen.json` for a team harness that bundles plugin 1 (GitLab service provider) and plugin 2 (MR submitter, consumer). Sam doesn't know or care about the service registry — that's an implementation detail between the plugin authors. Sam's job is to list the plugins and their `depends` declarations.

Because plugin 2 already declares `depends: ["kaizen-plugin-gitlab"]`, Kaizen's loader handles ordering automatically. Sam doesn't wire services manually — the harness just works. If Sam accidentally omits the provider plugin entirely, Kaizen fails at startup with a role validation error (existing behavior), not a cryptic `getService` crash at runtime.

**Capabilities revealed:** Service registry is transparent to harness authors when `depends` is declared correctly. No new harness-level configuration required. Failure surface for missing providers stays at loader startup, not buried in runtime execution.

---

### Journey 4: The Core Contributor — Dogfooding in Built-in Plugins (Internal)

**Meet the Kaizen maintainer.** Before publishing the service registry API, a built-in plugin pair must use it in production. The maintainer identifies `core-events` as a natural provider — it already defines the event vocabulary. A new built-in consumer plugin registers against a `CoreEventsServiceToken` to access event definitions synchronously rather than through event subscriptions.

Writing the reference implementation surfaces two things: whether `assertInitializing` gating feels right in practice (it does), and whether the error message on a missing service is actually helpful (it is, once the token label is included). The built-in pair becomes the canonical example in `docs/plugin-api.md` — the first thing a third-party author reads.

**Capabilities revealed:** `assertInitializing` enforcement, named error messages on missing services, reference implementation as documentation anchor.

---

### Journey Requirements Summary

| Capability | Revealed By |
|---|---|
| `ServiceToken<T>` with string label | Journeys 1, 2 |
| `ctx.registerService(token, impl)` gated to `INITIALIZING` | Journeys 1, 4 |
| `ctx.getService(token)` returning `T` | Journeys 1, 2 |
| Compile-time type enforcement via generics | Journey 2 |
| No harness-level wiring required | Journey 3 |
| Named error on missing service, suggests `depends` | Journeys 3, 4 |
| Built-in reference provider/consumer pair | Journey 4 |

## API Design Reference

The service registry is a TypeScript API surface addition to Kaizen's existing plugin SDK. Target audience: TypeScript plugin authors. Distribution: built into the Kaizen binary — no separate install. IDE integration (autocomplete, type checking) comes for free via `ServiceToken<T>` generics; no additional tooling required.

### New Types (`src/types/plugin.ts`)

```typescript
// Typed, unforgeable, collision-free registry key
export class ServiceToken<T> {
  readonly label: string;       // human-readable name for error messages
  private readonly _symbol: unique symbol;
  constructor(label: string);
}
```

### New PluginContext Methods (`src/core/context.ts`)

```typescript
// Register a service — only valid during INITIALIZING
ctx.registerService<T>(token: ServiceToken<T>, impl: T): void

// Retrieve a service — valid at any lifecycle state
ctx.getService<T>(token: ServiceToken<T>): T
// Throws if service not registered:
// Error: "Service 'GitLabService' not found. Ensure the provider plugin
//         is listed in depends[] before this plugin."
```

### New Internal Class (`src/core/service-registry.ts`)

```typescript
class ServiceRegistry {
  register<T>(token: ServiceToken<T>, impl: T): void
  get<T>(token: ServiceToken<T>): T  // throws named error on miss
}
```

### Loader Integration (`src/core/loader.ts`)

- `ServiceRegistry` instantiated once per bootstrap
- Passed into `createPluginContext()` alongside existing registries
- `registerService` gated by `assertInitializing()` (same pattern as `registerTool`)

### Provider Plugin Pattern

```typescript
// kaizen-plugin-gitlab/index.ts
import type { KaizenPlugin } from "kaizen/types";
import { ServiceToken } from "kaizen/types";

export interface GitLabService {
  getIssue(id: string): Promise<Issue>;
}

export const GitLabServiceToken = new ServiceToken<GitLabService>("GitLabService");

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-gitlab",
  provides: [],
  depends: [],
  async setup(ctx) {
    ctx.registerService(GitLabServiceToken, {
      async getIssue(id) { /* ... */ }
    });
  },
};
export default plugin;
```

### Consumer Plugin Pattern

```typescript
// kaizen-plugin-mr-submitter/index.ts
import { GitLabServiceToken } from "kaizen-plugin-gitlab";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-mr-submitter",
  depends: ["kaizen-plugin-gitlab"],  // required — ensures ordering
  async setup(ctx) {
    const gitlab = ctx.getService(GitLabServiceToken); // typed: GitLabService
    ctx.registerTool({
      name: "submit_mr",
      async execute(args) {
        const issue = await gitlab.getIssue(args.issue_id as string);
        // ...
      }
    });
  },
};
```

### Implementation Notes

- `ServiceToken` uses a `Symbol` internally — object identity is the key, not string equality. Two tokens with the same label are distinct.
- `registerService` calls `assertInitializing()` — consistent with `registerTool`, `registerExecutor`, `registerUi`.
- `getService` has no lifecycle gate — valid in `RUNNING` tool handlers and event handlers.
- Duplicate registration behavior (last-write-wins vs throw) is an implementation decision, not specified here.
- Exports: `ServiceToken` added to `kaizen/types` barrel; `registerService`/`getService` added to `PluginContext` interface in `src/types/plugin.ts`.

## Functional Requirements

### Service Token Definition

- **FR1:** A plugin author can define a typed service token with a human-readable label that serves as both a registry key and an error message identifier
- **FR2:** A plugin author can export a service token as part of a package's public API, making it importable by consumer plugins
- **FR3:** The platform treats two independently-created tokens with the same label as distinct keys

### Service Registration

- **FR4:** A plugin can register a service implementation against a typed token during plugin initialization
- **FR5:** The platform rejects service registration attempts made outside of plugin initialization
- **FR6:** A registered service implementation must satisfy the type contract declared by the token at compile time

### Service Retrieval

- **FR7:** A plugin can retrieve a service implementation synchronously by presenting its token
- **FR8:** Service retrieval is valid at any point after plugin initialization — including from tool execute handlers and event handlers
- **FR9:** When a plugin attempts to retrieve an unregistered service, the platform throws an error naming the token label and suggesting a `depends` declaration

### Dependency Ordering

- **FR10:** A plugin author can declare that their plugin depends on a named plugin to guarantee initialization order
- **FR11:** The platform guarantees a service provider's `setup()` completes before any consumer plugin's `setup()` begins, when the consumer declares the correct `depends` relationship
- **FR12:** The platform fails at startup — not at runtime — if a required plugin dependency is missing from the loaded set (existing behavior preserved)

### Type Safety

- **FR13:** The type of a retrieved service is inferred from the token's type parameter without requiring an explicit cast
- **FR14:** A type mismatch between a token's declared interface and its usage is surfaced as a compile-time error
- **FR15:** A token imported from a provider package carries the provider's interface type — consumer plugins do not redeclare the interface

### Platform Transparency

- **FR16:** A harness author can compose provider and consumer plugins without any service-registry-specific configuration beyond listing plugins and their dependencies
- **FR17:** The service registry introduces no new fields to `kaizen.json`

### Reference Implementation

- **FR18:** The Kaizen default plugin stack includes at least one built-in plugin that registers a service
- **FR19:** The Kaizen default plugin stack includes at least one built-in plugin that retrieves that service
- **FR20:** The reference provider/consumer pair is documented in `docs/plugin-api.md` as the canonical pattern for plugin authors

### Developer Experience

- **FR21:** A plugin author can discover what service a token provides by inspecting the token's type parameter in their IDE
- **FR22:** A plugin author receives actionable guidance when a service lookup fails — including the token name and a concrete remediation step

## Non-Functional Requirements

### Performance

- **NFR1:** `ctx.getService(token)` completes in O(1) time — implemented as a `Map` keyed by token identity, not a linear scan
- **NFR2:** Service registry initialization adds no measurable overhead to plugin bootstrap — registry instantiation is a single object creation, not a file load or async operation

### Security

- **NFR3:** Service access requires possession of the token object — a plugin that does not import a token cannot retrieve the service it keys, even at runtime
- **NFR4:** Tokens are not enumerable or discoverable from outside the registry — no "list all services" API at MVP, preventing unintended capability exposure

### Reliability

- **NFR5:** A failed `getService` call throws synchronously with a message that includes the token's string label — no silent `undefined` returns, no swallowed errors
- **NFR6:** `registerService` called outside `INITIALIZING` throws immediately with a clear lifecycle violation message — consistent with existing `registerTool` behavior
- **NFR7:** Service registry state resets between bootstrap calls — no cross-test or cross-session contamination
