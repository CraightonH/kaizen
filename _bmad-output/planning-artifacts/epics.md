---
stepsCompleted: ["step-01-validate-prerequisites", "step-02-design-epics", "step-03-create-stories", "step-04-final-validation"]
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/architecture.md"
---

# kaizen - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for kaizen, decomposing the requirements from the PRD and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: A plugin author can define a typed service token with a human-readable label that serves as both a registry key and an error message identifier
FR2: A plugin author can export a service token as part of a package's public API, making it importable by consumer plugins
FR3: The platform treats two independently-created tokens with the same label as distinct keys
FR4: A plugin can register a service implementation against a typed token during plugin initialization
FR5: The platform rejects service registration attempts made outside of plugin initialization
FR6: A registered service implementation must satisfy the type contract declared by the token at compile time
FR7: A plugin can retrieve a service implementation synchronously by presenting its token
FR8: Service retrieval is valid at any point after plugin initialization — including from tool execute handlers and event handlers
FR9: When a plugin attempts to retrieve an unregistered service, the platform throws an error naming the token label and suggesting a `depends` declaration
FR10: A plugin author can declare that their plugin depends on a named plugin to guarantee initialization order
FR11: The platform guarantees a service provider's `setup()` completes before any consumer plugin's `setup()` begins, when the consumer declares the correct `depends` relationship
FR12: The platform fails at startup — not at runtime — if a required plugin dependency is missing from the loaded set (existing behavior preserved)
FR13: The type of a retrieved service is inferred from the token's type parameter without requiring an explicit cast
FR14: A type mismatch between a token's declared interface and its usage is surfaced as a compile-time error
FR15: A token imported from a provider package carries the provider's interface type — consumer plugins do not redeclare the interface
FR16: A harness author can compose provider and consumer plugins without any service-registry-specific configuration beyond listing plugins and their dependencies
FR17: The service registry introduces no new fields to `kaizen.json`
FR18: The Kaizen default plugin stack includes at least one built-in plugin that registers a service
FR19: The Kaizen default plugin stack includes at least one built-in plugin that retrieves that service
FR20: The reference provider/consumer pair is documented in `docs/plugin-api.md` as the canonical pattern for plugin authors
FR21: A plugin author can discover what service a token provides by inspecting the token's type parameter in their IDE
FR22: A plugin author receives actionable guidance when a service lookup fails — including the token name and a concrete remediation step

### NonFunctional Requirements

NFR1: `ctx.getService(token)` completes in O(1) time — implemented as a `Map` keyed by token identity, not a linear scan
NFR2: Service registry initialization adds no measurable overhead to plugin bootstrap — registry instantiation is a single object creation, not a file load or async operation
NFR3: Service access requires possession of the token object — a plugin that does not import a token cannot retrieve the service it keys, even at runtime
NFR4: Tokens are not enumerable or discoverable from outside the registry — no "list all services" API at MVP, preventing unintended capability exposure
NFR5: A failed `getService` call throws synchronously with a message that includes the token's string label — no silent `undefined` returns, no swallowed errors
NFR6: `registerService` called outside `INITIALIZING` throws immediately with a clear lifecycle violation message — consistent with existing `registerTool` behavior
NFR7: Service registry state resets between bootstrap calls — no cross-test or cross-session contamination

### Additional Requirements

- Brownfield addition — no starter template; new files follow existing registry class pattern (`tool-registry.ts`, `executor-registry.ts`, `ui-registry.ts`)
- `ServiceToken<T>` class and `ServiceRegistry` class co-located in `src/core/service-registry.ts` — do NOT split into separate files
- `ServiceRegistry` instantiated inside `bootstrap()` — never at module scope (required for NFR7 test isolation)
- `assertInitializing()` called in `registerService`, NOT in `getService` — mirrors existing `registerTool` / event-handler split
- Phantom type brand (`declare readonly _type: T`) on `ServiceToken` for compile-time type threading — zero runtime overhead
- `Symbol(label)` used internally — never `Symbol.for()` — so two tokens with the same label remain distinct (FR3)
- Duplicate registration must throw: `"Service '${token.label}' is already registered. Each service token may only have one provider."`
- Not-found error message (exact): `"Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin."`
- `ServiceToken` re-exported from `src/types/plugin.ts` barrel (`kaizen/types`)
- `registerService<T>` and `getService<T>` added to `PluginContext` interface in `src/types/plugin.ts`
- `ServiceRegistry` passed to `createPluginContext()` as a constructor parameter — never accessed via global/module state
- Token variable naming: `PascalCaseServiceToken`; interface naming: same as service concept with no suffix
- Token label = TypeScript interface name exactly (no abbreviations, no kebab-case)
- Test file: `src/core/service-registry.test.ts` (new)
- Existing test suite must pass without modification
- Reference consumer: `core-lifecycle` plugin (already has `depends: ["core-events"]`); confirm during implementation by reading `plugins/core-lifecycle/index.ts`

### UX Design Requirements

N/A — developer tool / SDK; no UI component.

### FR Coverage Map

FR1: Epic 1 — `ServiceToken<T>` class definition
FR2: Epic 1 — Token exported from provider package as public API
FR3: Epic 1 — `Symbol(label)` per-instantiation — same-label tokens are distinct
FR4: Epic 1 — `ctx.registerService(token, impl)` during INITIALIZING
FR5: Epic 1 — `assertInitializing()` guard on `registerService`
FR6: Epic 1 — Generic type threading enforces contract at compile time
FR7: Epic 1 — `ctx.getService(token)` returns `T` synchronously
FR8: Epic 1 — `getService` has no lifecycle gate — valid in RUNNING handlers
FR9: Epic 1 — Named error on miss with `depends` suggestion
FR10: Epic 2 — `depends` declaration verified via integration test
FR11: Epic 2 — Topo-sort guarantees provider-before-consumer (existing behavior)
FR12: Epic 2 — Startup failure on missing dependency (existing behavior preserved)
FR13: Epic 1 — Generic return type `T` inferred — no explicit cast
FR14: Epic 1 — Type mismatch is a compile-time error
FR15: Epic 1 — Provider's interface type flows through token import
FR16: Epic 1 — No harness-level service config required
FR17: Epic 1 — No new `kaizen.json` fields
FR18: Epic 2 — `core-events` registers `CoreEventsServiceToken`
FR19: Epic 2 — `core-lifecycle` retrieves `CoreEventsServiceToken`
FR20: Epic 3 — `docs/plugin-api.md` service registry section
FR21: Epic 1 — Generic type parameter visible in IDE via token
FR22: Epic 1 — Named error message + `depends` remediation hint

## Epic List

### Epic 1: Plugin Authors Can Define, Register, and Consume Typed Services
Plugin authors have a working `ServiceToken<T>` + `ctx.registerService` / `ctx.getService` API backed by a type-safe registry wired into the bootstrap lifecycle. TypeScript enforces contracts at compile time; runtime errors are named and actionable.
**FRs covered:** FR1–FR9, FR13–FR17, FR21–FR22
**NFRs covered:** NFR1–NFR7
**Files:** `src/core/service-registry.ts` (new), `src/types/plugin.ts` (modified), `src/core/context.ts` (modified), `src/core/loader.ts` (modified), `src/core/service-registry.test.ts` (new)

### Epic 2: Built-in Reference Pair Dogfoods the Pattern End-to-End
The Kaizen platform itself uses the service registry in at least one provider/consumer plugin pair (`core-events` → `core-lifecycle`). This validates the full API surface in production code, confirms dependency ordering works, and creates the canonical example for third-party authors.
**FRs covered:** FR10–FR12, FR18–FR19
**Files:** `plugins/core-events/index.ts` (modified), `plugins/core-lifecycle/index.ts` (modified), integration tests

### Epic 3: Documentation Enables Third-Party Plugin Authors to Adopt the Pattern
`docs/plugin-api.md` gains a service registry section using the reference pair as the canonical example. A plugin author can read docs alone and implement the provider/consumer pattern without reading Kaizen internals.
**FRs covered:** FR20
**Files:** `docs/plugin-api.md` (modified)

---

## Epic 1: Plugin Authors Can Define, Register, and Consume Typed Services

Plugin authors have a working `ServiceToken<T>` + `ctx.registerService` / `ctx.getService` API backed by a type-safe registry wired into the bootstrap lifecycle. TypeScript enforces contracts at compile time; runtime errors are named and actionable.

### Story 1.1: ServiceToken\<T\> Class and Export

As a plugin author,
I want to define a typed service token with a human-readable label,
So that I can establish a typed, unforgeable, collision-free contract between provider and consumer plugins.

**Acceptance Criteria:**

**Given** I import `ServiceToken` from `kaizen/types`
**When** I construct `new ServiceToken<MyService>("MyService")`
**Then** the token has a `.label` property equal to `"MyService"` and the TypeScript type parameter `T` is bound to `MyService`

**Given** two tokens constructed with the same label: `new ServiceToken<A>("Svc")` and `new ServiceToken<A>("Svc")`
**When** both tokens exist in memory
**Then** they are not equal via `===` — each has a distinct internal Symbol so same-label tokens are distinct keys (FR3)

**Given** a token `const T = new ServiceToken<ServiceA>("Svc")` is passed where `ServiceToken<ServiceB>` is expected
**When** TypeScript compiles the code
**Then** a type error is reported — the generic parameter is enforced at compile time (FR14)

**Given** `ServiceToken` is re-exported from `src/types/plugin.ts`
**When** a plugin author writes `import { ServiceToken } from 'kaizen/types'`
**Then** the import resolves correctly (FR2)

**Given** a `ServiceToken<T>` instance
**When** a developer hovers the token variable in their IDE
**Then** the IDE shows the type parameter `T`, revealing what service the token provides (FR21)

### Story 1.2: ServiceRegistry Class with Register, Get, and Error Handling

As a plugin platform,
I want a service registry that stores and retrieves typed service implementations by token object identity,
So that plugin-to-plugin capability sharing is backed by a reliable, type-safe, O(1) data store with clear error reporting.

**Acceptance Criteria:**

**Given** a `ServiceRegistry` instance and a `ServiceToken<T>`
**When** `registry.register(token, impl)` is called with a conforming implementation
**Then** `registry.get(token)` returns it typed as `T` — no explicit cast required (FR7, FR13, NFR1)

**Given** a `ServiceRegistry` instance
**When** `registry.get(token)` is called for an unregistered token with label `"GitLabService"`
**Then** it throws synchronously: `"Service 'GitLabService' not found. Ensure the provider plugin is listed in depends[] before this plugin."` — never returns `undefined` (FR9, FR22, NFR5)

**Given** a `ServiceRegistry` with token `T` already registered
**When** `registry.register(T, anotherImpl)` is called again
**Then** it throws: `"Service 'GitLabService' is already registered. Each service token may only have one provider."`

**Given** two distinct tokens with the same label `"Svc"` (FR3)
**When** `registry.register(tokenA, implA)` and `registry.register(tokenB, implB)` are both called
**Then** both succeed — they are distinct keys; `registry.get(tokenA)` returns `implA`, `registry.get(tokenB)` returns `implB`

**Given** the internal `Map` inside `ServiceRegistry`
**When** code outside `service-registry.ts` attempts to enumerate or iterate registered services
**Then** no public API exists to do so — the Map is private, no `listServices()` or iteration method present (NFR4)

**Given** a new `ServiceRegistry` instance
**When** it is constructed
**Then** it completes synchronously with no I/O — instantiation overhead is a single `new Map()` (NFR2)

### Story 1.3: Loader Integration and PluginContext API Surface Wiring

As a plugin author,
I want `ctx.registerService(token, impl)` and `ctx.getService(token)` on the plugin context,
So that I can register and consume typed services using the standard Kaizen plugin API with correct lifecycle enforcement and per-bootstrap isolation.

**Acceptance Criteria:**

**Given** a plugin's `setup(ctx)` function
**When** `ctx.registerService(MyToken, impl)` is called during `setup()`
**Then** the service is stored and `ctx.getService(MyToken)` returns `impl` typed as `T` with no explicit cast (FR4, FR6)

**Given** a plugin that calls `ctx.registerService(MyToken, impl)` from a tool's `execute` handler (outside `setup()`)
**When** the tool executes at runtime
**Then** it throws a lifecycle violation error — consistent with `registerTool` called outside `setup()` (FR5, NFR6)

**Given** a plugin that calls `ctx.getService(MyToken)` from a tool's `execute` handler
**When** the tool executes at runtime (RUNNING state)
**Then** it returns the service without error — `getService` has no lifecycle gate (FR8)

**Given** two separate `bootstrap()` calls in the same test process
**When** the first bootstrap registers `MyToken` and the second does not
**Then** `ctx.getService(MyToken)` in the second bootstrap throws — registry is fresh per bootstrap (NFR7)

**Given** the `PluginContext` interface in `src/types/plugin.ts`
**When** a TypeScript consumer reads the interface
**Then** `registerService<T>(token: ServiceToken<T>, impl: T): void` and `getService<T>(token: ServiceToken<T>): T` are present with correct generic signatures (FR16, FR17 — no new `kaizen.json` fields required)

**Given** the existing test suite
**When** `bun test` is run after all changes
**Then** all pre-existing tests pass without modification

---

## Epic 2: Built-in Reference Pair Dogfoods the Pattern End-to-End

The Kaizen platform itself uses the service registry in at least one provider/consumer plugin pair (`core-events` → `core-lifecycle`). This validates the full API surface in production code, confirms dependency ordering works, and creates the canonical example for third-party authors.

### Story 2.1: core-events Plugin Exports CoreEventsServiceToken

As a Kaizen maintainer,
I want the `core-events` built-in plugin to export a typed `CoreEventsServiceToken`,
So that the platform dogfoods its own service registry API and provides a canonical provider example for third-party authors.

**Acceptance Criteria:**

**Given** `plugins/core-events/index.ts`
**When** the plugin is loaded
**Then** it exports `CoreEventsService` (interface) and `CoreEventsServiceToken` (a `ServiceToken<CoreEventsService>`) from its module

**Given** `CoreEventsServiceToken` is exported from `core-events`
**When** `core-events`'s `setup(ctx)` runs
**Then** it calls `ctx.registerService(CoreEventsServiceToken, impl)` with a conforming implementation of `CoreEventsService`

**Given** the naming conventions from the architecture doc
**When** the token and interface are defined
**Then** the token variable is named `CoreEventsServiceToken`, the interface is named `CoreEventsService`, and the token label string is `"CoreEventsService"` — exactly matching the interface name

**Given** the existing `core-events` plugin behavior
**When** this story is complete
**Then** all existing `core-events` functionality is unchanged — the service registration is purely additive (FR12 preserved)

### Story 2.2: core-lifecycle Plugin Consumes CoreEventsServiceToken and Integration Tests

As a Kaizen maintainer,
I want the `core-lifecycle` plugin to consume `CoreEventsServiceToken` via `ctx.getService`,
So that the full provider→consumer flow is exercised in production built-in code and dependency ordering is verified end-to-end.

**Acceptance Criteria:**

**Given** `plugins/core-lifecycle/index.ts` already declares `depends: ["core-events"]`
**When** `core-lifecycle`'s `setup(ctx)` runs
**Then** it calls `ctx.getService(CoreEventsServiceToken)` and receives a fully typed `CoreEventsService` — no explicit cast

**Given** a harness that loads both `core-events` and `core-lifecycle`
**When** `bootstrap()` completes
**Then** `core-events.setup()` runs before `core-lifecycle.setup()` — guaranteed by the existing topo-sort; `getService` succeeds (FR10, FR11)

**Given** a harness that omits `core-events` but includes `core-lifecycle`
**When** `bootstrap()` is called
**Then** it fails at startup with a dependency error naming `core-events` as missing — not at runtime when `getService` is called (FR12)

**Given** the existing `core-lifecycle` plugin behavior
**When** this story is complete
**Then** all existing `core-lifecycle` functionality is unchanged — the service consumption is purely additive

**Given** the full integration test suite runs
**When** `bun test` completes
**Then** all pre-existing tests pass and at least one new integration test exercises the `core-events` → `core-lifecycle` service handoff

---

## Epic 3: Documentation Enables Third-Party Plugin Authors to Adopt the Pattern

`docs/plugin-api.md` gains a service registry section using the reference pair as the canonical example. A plugin author can read docs alone and implement the provider/consumer pattern without reading Kaizen internals.

### Story 3.1: docs/plugin-api.md Service Registry Section

As a third-party plugin author,
I want a service registry section in `docs/plugin-api.md` with a complete provider/consumer example,
So that I can implement the pattern by reading docs alone without studying Kaizen internals.

**Acceptance Criteria:**

**Given** `docs/plugin-api.md`
**When** the service registry section is added
**Then** it includes: what `ServiceToken<T>` is, when to use `registerService` vs `getService`, the lifecycle rule (`registerService` during `setup()` only, `getService` anytime), and the `depends` requirement for ordering

**Given** the `core-events` / `core-lifecycle` reference pair from Epic 2
**When** the docs section shows a code example
**Then** the example uses the actual built-in pair (or a GitLab-style alias matching the PRD's Journey 1) — not pseudocode; it must be copy-pasteable and TypeScript-valid

**Given** a plugin author who reads only the new docs section
**When** they implement their own provider plugin
**Then** they have enough information to: define and export a `ServiceToken<T>`, call `ctx.registerService` in `setup()`, declare a `depends` relationship in the consumer, and call `ctx.getService` correctly

**Given** the existing content of `docs/plugin-api.md`
**When** the section is added
**Then** existing content is unchanged — the service registry section is purely additive and fits naturally into the existing doc structure
