---
stepsCompleted: ["step-01-init", "step-02-context", "step-03-starter", "step-04-decisions", "step-05-patterns", "step-06-structure", "step-07-validation", "step-08-complete"]
status: 'complete'
completedAt: '2026-04-08'
inputDocuments:
  - "_bmad-output/planning-artifacts/prd.md"
  - "_bmad-output/planning-artifacts/research/technical-synchronous-service-registry-plugin-ecosystems-research-2026-04-08.md"
  - "docs/architecture.md"
  - "docs/plugin-api.md"
  - "docs/adversarial-review.md"
workflowType: 'architecture'
project_name: 'kaizen'
user_name: 'Craighton'
date: '2026-04-08'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (22 total):**

The FRs fall into two implementation categories:

*Runtime behavior (implemented in `ServiceRegistry` + `PluginContext`):* FR1–FR9 — token creation, registration, retrieval, and error handling. These are the core LOC. FR10–FR12 are satisfied by the existing `depends` + topo-sort machinery (no new work required).

*Compile-time contracts (satisfied by TypeScript generics):* FR13–FR15 — type inference and mismatch detection. These are type-level guarantees, not runtime logic. Correct only when the generic signature is `getService<T>(token: ServiceToken<T>): T`.

*Platform integration (loader + docs):* FR16–FR22 — harness transparency, no new `kaizen.json` fields, built-in reference pair, documentation update.

**Non-Functional Requirements:**

- NFR1 (O(1) lookup): Dictates `Map<ServiceToken<unknown>, unknown>` — token object as key
- NFR2 (zero bootstrap overhead): Registry is a plain object instantiation, no lazy loading
- NFR3–NFR4 (capability boundary): Private map, no enumeration API
- NFR5–NFR6 (reliable errors): Synchronous throws with named token label; lifecycle guard consistent with existing pattern
- NFR7 (test isolation): Registry must be instantiated per bootstrap, never a module singleton

### Technical Constraints & Dependencies

- Language: TypeScript (strict mode, Bun runtime)
- No new npm dependencies
- Must integrate with existing `assertInitializing()` lifecycle guard
- Must be passed into `createPluginContext()` alongside existing `ToolRegistry`, `ExecutorRegistry`, `UiRegistry`
- `ServiceToken<T>` must be exported from `kaizen/types` barrel — same export path plugin authors already use
- Existing test suite must pass without modification

### Cross-Cutting Concerns Identified

- **Lifecycle state enforcement:** Shared pattern with all existing registries — `assertInitializing()` must be called in `registerService`, not `getService`
- **Generic type threading:** `ServiceToken<T>` → `getService<T>` → return type `T` must be correct end-to-end; TypeScript structural typing means a wrong signature silently accepts wrong types
- **Test isolation:** Each test that calls `bootstrap()` gets a fresh registry — module-level singletons would cause state leakage between tests
- **Public API surface stability:** `ServiceToken`, `registerService`, `getService` become a public contract on first ship; the type signature must be right before release

## Starter Template Evaluation

### Primary Technology Domain

TypeScript SDK / plugin system internals — brownfield feature addition to an existing codebase. No starter template needed or applicable.

### Existing Technology Foundation

**Language & Runtime:**
- TypeScript (strict mode)
- Bun runtime and package manager
- ESM modules (`"type": "module"`)

**Build Tooling:**
- Bun compile → single binary distribution
- Static imports for built-in harnesses (bundled at compile time)

**Project Structure (established):**
```
src/core/          # Core internals — new files go here
src/types/         # Public plugin API types — ServiceToken goes here
plugins/           # Built-in plugins — reference pair goes here
```

**Testing Infrastructure:**
- Existing test suite (Bun test runner)
- Per-bootstrap test isolation already expected by convention

**Code Organization Patterns:**
- Each registry is its own class in `src/core/` (`tool-registry.ts`, `executor-registry.ts`, `ui-registry.ts`)
- `createPluginContext()` in `src/core/context.ts` receives all registries and exposes them as `ctx.*` methods
- `assertInitializing()` guard shared by all registry write operations
- Public types exported from `src/types/plugin.ts` barrel

**Implementation Pattern:**
New files match the shape of existing registries. `ServiceRegistry` is a new file following the same pattern as `ToolRegistry`. No new patterns introduced.

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (block implementation):**
- ServiceToken Symbol strategy → `Symbol(label)`, unique per instantiation
- Generic type threading → phantom type brand (`declare readonly _type: T`)
- Map key strategy → token object identity (`Map<ServiceToken<unknown>, unknown>`)
- Duplicate registration → throw on duplicate (consistent with `registerTool`)

**Important Decisions (shape architecture):**
- Reference pair selection → `core-events` as provider; specific consumer determined during implementation from existing `depends: ["core-events"]` plugins

**Deferred Decisions (post-MVP):**
- Enumeration/introspection API — explicitly excluded (NFR4)
- Dynamic registration during `RUNNING` — explicitly post-MVP
- Service versioning/compatibility declarations — post-MVP

### Data Architecture

Not applicable — no persistent data, no database, no external I/O. The `ServiceRegistry` is an in-memory `Map` scoped to a single bootstrap lifecycle.

### Security Architecture

**Capability boundary (NFR3, NFR4):** Enforced structurally — `Map` is `private`, no `keys()` / `values()` / `entries()` exposed. Access requires token object possession. No API enumeration surface.

**Duplicate registration guard:** `registerService` throws if the token is already registered — prevents silent shadowing of services across plugins.

### API & Communication Patterns

**Inter-plugin contract:** `ServiceToken<T>` as the sole communication channel. Token import = dependency declaration = access grant. No string-keyed lookups, no dynamic discovery.

**Error contract:** Synchronous throw on `getService` miss — message format: `"Service '{label}' not found. Ensure the provider plugin is listed in depends[] before this plugin."` Token label is always present in the error.

**Lifecycle contract:** `registerService` → `INITIALIZING` only (via `assertInitializing()`). `getService` → any state. Consistent with all existing registry write/read patterns.

### Frontend Architecture

Not applicable — no UI.

### Infrastructure & Deployment

No changes to build, deploy, or CI pipeline. The binary is rebuilt with the new source files; no new build steps required.

### Decision Impact Analysis

**Implementation sequence:**
1. `src/core/service-registry.ts` — `ServiceToken<T>` class + `ServiceRegistry` class
2. `src/types/plugin.ts` — add `ServiceToken` export + `registerService`/`getService` to `PluginContext` interface
3. `src/core/context.ts` — implement `registerService`/`getService` wiring to registry
4. `src/core/loader.ts` — instantiate `ServiceRegistry` per bootstrap, pass to `createPluginContext()`
5. Reference provider plugin — `core-events` exposes `CoreEventsServiceToken`
6. Reference consumer plugin — identified during implementation from existing `depends: ["core-events"]` plugins
7. `docs/plugin-api.md` — service registry pattern section

**Cross-component dependencies:**
- Steps 1–4 are required before steps 5–7 can be written
- Steps 5–6 are the acceptance test for the entire API surface
- Step 7 cannot be written accurately until steps 5–6 are complete and the DX is validated

## Implementation Patterns & Consistency Rules

### Critical Conflict Points Identified

5 areas where an AI agent could make divergent choices without explicit guidance.

### Naming Patterns

**ServiceToken naming convention:**
- Token variable: `PascalCaseServiceToken` — e.g., `GitLabServiceToken`, `CoreEventsServiceToken`
- Interface name: same name as the service concept, no suffix — e.g., `GitLabService`, `CoreEventsService`
- Token file location: defined and exported from the *provider* plugin's `index.ts`, not a separate file

```typescript
// ✅ Correct
export interface CoreEventsService { ... }
export const CoreEventsServiceToken = new ServiceToken<CoreEventsService>("CoreEventsService");

// ❌ Wrong — suffix on interface, token in separate file
export interface CoreEventsServiceInterface { ... }
// tokens.ts: export const token = new ServiceToken<CoreEventsServiceInterface>("events");
```

**Token label convention:** label = TypeScript interface name exactly. No abbreviations, no lowercase, no kebab-case. Ensures error messages are unambiguous and grep-able.

### Structure Patterns

**File placement:**
- `ServiceToken<T>` class → `src/core/service-registry.ts` (alongside the registry class)
- `ServiceRegistry` class → same file `src/core/service-registry.ts`
- Export of `ServiceToken` → `src/types/plugin.ts` barrel (re-export from `src/core/service-registry.ts`)
- Do NOT split token definition and registry into separate files

**Registry instantiation:**
- Created in `src/core/loader.ts` once per `bootstrap()` call
- Never instantiated at module level — must be local to bootstrap scope (NFR7)
- Passed into `createPluginContext()` as a parameter, not accessed via global/module state

### Format Patterns

**Error message format (exact):**
```
Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin.
```

**Duplicate registration error format:**
```
Service '${token.label}' is already registered. Each service token may only have one provider.
```

### Communication Patterns

**`registerService` guard pattern — match existing registries exactly:**
```typescript
registerService<T>(token: ServiceToken<T>, impl: T): void {
  assertInitializing(this.state); // same call as registerTool, registerExecutor
  if (this.services.has(token)) {
    throw new Error(`Service '${token.label}' is already registered. Each service token may only have one provider.`);
  }
  this.services.set(token, impl);
}
```

**`getService` pattern — no lifecycle gate:**
```typescript
getService<T>(token: ServiceToken<T>): T {
  // NO assertInitializing call — valid at any lifecycle state
  const impl = this.services.get(token);
  if (impl === undefined) {
    throw new Error(`Service '${token.label}' not found. Ensure the provider plugin is listed in depends[] before this plugin.`);
  }
  return impl as T;
}
```

### Process Patterns

**All AI agents MUST:**
- Never add `getService` to the lifecycle gate — it must work in `RUNNING` handlers
- Never use `Symbol.for()` — always `Symbol(label)` for per-instantiation uniqueness
- Never expose the internal `Map` — no `listServices()`, `hasService()`, or iteration at MVP
- Always use `token.label` in error messages
- Always pass `ServiceRegistry` as a constructor parameter — never import as a singleton

### Enforcement Guidelines

The reference built-in plugin pair is the canonical example. TypeScript enforces the generic contract at compile time; no runtime type checks needed. Each test calling `bootstrap()` must verify registry state is fresh (NFR7).

**Anti-patterns:**
- `Symbol.for(label)` — breaks FR3 (same-label tokens would collide)
- Module-level `const registry = new ServiceRegistry()` — breaks NFR7 (test contamination)
- `getService` inside lifecycle guard — breaks FR8 (valid post-init)
- Token label string as Map key — breaks object-identity lookup

## Project Structure & Boundaries

This is a brownfield feature addition. The structure section documents the delta — new files and modified files — mapped against the existing project tree.

### Complete Project Directory Structure

```
kaizen/
├── src/
│   ├── core/
│   │   ├── service-registry.ts          ← NEW: ServiceToken<T> + ServiceRegistry
│   │   ├── context.ts                   ← MODIFIED: registerService/getService wiring
│   │   ├── loader.ts                    ← MODIFIED: instantiate ServiceRegistry per bootstrap
│   │   ├── tool-registry.ts             (unchanged — pattern reference)
│   │   ├── executor-registry.ts         (unchanged — pattern reference)
│   │   ├── ui-registry.ts               (unchanged — pattern reference)
│   │   ├── event-bus.ts                 (unchanged)
│   │   ├── config.ts                    (unchanged)
│   │   ├── errors.ts                    (unchanged)
│   │   ├── index.ts                     (unchanged)
│   │   ├── llm.ts                       (unchanged)
│   │   └── stdin.ts                     (unchanged)
│   └── types/
│       └── plugin.ts                    ← MODIFIED: ServiceToken export + PluginContext methods
├── plugins/
│   ├── core-events/
│   │   ├── index.ts                     ← MODIFIED: export CoreEventsService + CoreEventsServiceToken
│   │   └── package.json                 (unchanged)
│   ├── core-lifecycle/                  ← CANDIDATE consumer (depends: ["core-events"] already)
│   │   ├── index.ts                     ← MODIFIED (if chosen): ctx.getService(CoreEventsServiceToken)
│   │   └── package.json                 (unchanged)
│   └── ... (all others unchanged)
└── docs/
    └── plugin-api.md                    ← MODIFIED: service registry pattern section
```

**Test files** (co-located as `*.test.ts` per Bun convention):
```
src/core/service-registry.test.ts        ← NEW: unit tests for ServiceToken + ServiceRegistry
```

### Architectural Boundaries

**Public API Boundary** (`src/types/plugin.ts` → `kaizen/types` barrel):
- `ServiceToken<T>` — exported, consumed by plugin authors
- `PluginContext.registerService<T>` — method on context interface
- `PluginContext.getService<T>` — method on context interface
- Nothing else from `src/core/service-registry.ts` is exported publicly

**Internal Boundary** (`src/core/service-registry.ts`):
- `ServiceRegistry` class — internal only, not re-exported from `kaizen/types`
- `ServiceToken._symbol` — private; not accessible outside the class
- `ServiceRegistry.services` (Map) — private; no enumeration surface

**Plugin Boundary** (provider plugin's `index.ts`):
- `ServiceToken` instance + service interface — exported as part of plugin's public API
- Service implementation object — never exported (registered via `ctx.registerService`, consumed via token)

**Lifecycle Boundary** (`src/core/loader.ts`):
- `ServiceRegistry` instantiated inside `bootstrap()` — never at module scope
- Passed into `createPluginContext()` alongside `ToolRegistry`, `ExecutorRegistry`, `UiRegistry`
- Destroyed implicitly when bootstrap scope ends (NFR7)

### Requirements to Structure Mapping

| FR Category | Files |
|---|---|
| FR1–FR3: Token definition | `src/core/service-registry.ts` (ServiceToken class) |
| FR4–FR6: Registration | `src/core/service-registry.ts` (registerService), `src/core/context.ts` (wiring) |
| FR7–FR9: Retrieval + errors | `src/core/service-registry.ts` (getService), `src/core/context.ts` (wiring) |
| FR10–FR12: Dependency ordering | No new files — existing `loader.ts` topo-sort |
| FR13–FR15: Type safety | `src/core/service-registry.ts` (phantom type brand), `src/types/plugin.ts` (generics) |
| FR16–FR17: Harness transparency | No new files — no new kaizen.json fields |
| FR18–FR19: Reference pair | `plugins/core-events/index.ts` + `plugins/core-lifecycle/index.ts` |
| FR20: Documentation | `docs/plugin-api.md` |
| FR21–FR22: DX | Covered by generic signature + error message format |

**NFR mapping:**
- NFR1 (O(1)): `Map<ServiceToken<unknown>, unknown>` in `service-registry.ts`
- NFR2 (zero overhead): `new ServiceRegistry()` in `loader.ts` — synchronous, no I/O
- NFR3–NFR4 (capability boundary): `private` Map + no iteration API in `service-registry.ts`
- NFR5–NFR6 (reliable errors): error throws in `service-registry.ts`
- NFR7 (test isolation): local instantiation in `loader.ts`

### Integration Points

**Internal Communication** (within bootstrap):
```
loader.ts:bootstrap()
  → new ServiceRegistry()
  → createPluginContext(toolRegistry, executorRegistry, uiRegistry, serviceRegistry)
  → ctx.registerService / ctx.getService delegate to ServiceRegistry methods
```

**Plugin-to-Plugin Communication** (via token):
```
core-events/index.ts
  → exports CoreEventsServiceToken (ServiceToken<CoreEventsService>)
  → ctx.registerService(CoreEventsServiceToken, impl)  [during setup()]

core-lifecycle/index.ts
  → imports CoreEventsServiceToken from "core-events"
  → ctx.getService(CoreEventsServiceToken)              [during setup() or handlers]
```

**Data Flow:**
```
Token import (static)
  → registerService(token, impl)  →  Map.set(token, impl)
  → getService(token)             →  Map.get(token) → typed T
```

## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility:** All decisions are internally consistent. `Symbol(label)` per-instantiation uniqueness → object-identity Map key → no `Symbol.for()` form a closed, conflict-free chain. The phantom type brand (`declare readonly _type: T`) is compile-time only, aligning with the zero-runtime-overhead constraint (NFR2). `assertInitializing()` in `registerService` / no gate in `getService` mirrors the existing `registerTool` / event handler split exactly.

**Pattern Consistency:** Naming conventions (`PascalCaseServiceToken`, label = interface name) are consistent with existing Kaizen conventions. Error message format uses `token.label` everywhere — no inconsistency between duplicate-registration and not-found messages. The `registerService`/`getService` code patterns match the structural shape of `registerTool` and existing read methods.

**Structure Alignment:** All 4 modified/new files have clear, non-overlapping responsibilities. `ServiceToken` and `ServiceRegistry` in the same file (`service-registry.ts`) prevents the split-file anti-pattern and matches the single-responsibility shape of `tool-registry.ts`.

### Requirements Coverage Validation ✅

**FR Coverage:**

| FR Group | Covered By | Status |
|---|---|---|
| FR1–FR3 (token) | `ServiceToken` class, Symbol internals | ✅ |
| FR4–FR6 (registration) | `registerService` + `assertInitializing` | ✅ |
| FR7–FR9 (retrieval + error) | `getService` + named throw | ✅ |
| FR10–FR12 (ordering) | Existing loader topo-sort — no new work | ✅ |
| FR13–FR15 (type safety) | Phantom type + generic signature | ✅ |
| FR16–FR17 (transparency) | No new `kaizen.json` fields — structural | ✅ |
| FR18–FR19 (reference pair) | `core-events` + `core-lifecycle` | ✅ |
| FR20 (docs) | `docs/plugin-api.md` update | ✅ |
| FR21–FR22 (DX) | Generic return type + error message format | ✅ |

**NFR Coverage:**

| NFR | Architectural Mechanism | Status |
|---|---|---|
| NFR1 (O(1)) | `Map` keyed by token object | ✅ |
| NFR2 (zero overhead) | Synchronous `new ServiceRegistry()` | ✅ |
| NFR3 (token possession required) | No string-based lookup, token object required | ✅ |
| NFR4 (no enumeration) | `private` Map, no iteration API | ✅ |
| NFR5 (sync throw on miss) | `getService` throws, never returns undefined | ✅ |
| NFR6 (lifecycle violation throws) | `assertInitializing()` in `registerService` | ✅ |
| NFR7 (test isolation) | `new ServiceRegistry()` inside `bootstrap()` | ✅ |

Zero gaps across all 22 FRs and 7 NFRs.

### Implementation Readiness Validation ✅

**Decision completeness:** All 4 critical decisions (Symbol strategy, phantom type, Map key, duplicate behavior) documented with exact TypeScript. Reference consumer identification intentionally deferred to implementation — resolved by reading `core-lifecycle/index.ts`.

**Structure completeness:** All 4 files identified with exact paths. Test file location specified. No placeholder directories.

**Pattern completeness:** 5 conflict points addressed. Exact `registerService`/`getService` signatures provided. Both error message strings are finalized (copy-paste ready). Anti-pattern list covers all known failure modes.

### Gap Analysis

**Critical gaps:** None.

**Important gaps:** None.

**Minor / deferred by design:**
- Reference consumer identity (`core-lifecycle` vs another plugin) — resolved during implementation by reading existing plugin files. Architecture intentionally defers this.
- `docs/plugin-api.md` section content — cannot be finalized until reference pair is implemented and DX is validated. Correctly post-implementation.

### Architecture Completeness Checklist

- [x] Project context analyzed (22 FRs, 7 NFRs, 4 cross-cutting concerns)
- [x] Technology stack documented (TypeScript strict, Bun, ESM)
- [x] All critical decisions made (Symbol strategy, phantom type, Map key, duplicate handling)
- [x] Naming patterns defined with examples and anti-examples
- [x] Structure patterns defined with exact code
- [x] Error message formats finalized (copy-paste ready)
- [x] Anti-patterns enumerated
- [x] Complete file delta documented (4 modified, 2 new)
- [x] Architectural boundaries defined (public API, internal, plugin, lifecycle)
- [x] All FRs and NFRs mapped to specific files
- [x] Integration data flow documented
- [x] Test isolation mechanism documented

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**

**Confidence: High** — brownfield addition with well-understood constraints, existing registry pattern to mirror, and explicit code examples for all implementation decisions. No deferred critical decisions.

**Key strengths:**
- Zero ambiguity in `registerService`/`getService` signatures — exact TypeScript provided
- Error messages are finalized strings, not descriptions
- Anti-patterns enumerated — agent cannot stumble into them unknowingly
- Reference pair consumer identification is the only "TBD" and it's a one-file read

**Post-MVP enhancements (explicitly out of scope):**
- Service introspection / `listServices()` debug API
- Dynamic registration during `RUNNING`
- Service versioning declarations
