# Story 1.1: ServiceToken\<T\> Class and Export

Status: done

## Story

As a plugin author,
I want to define a typed service token with a human-readable label,
so that I can establish a typed, unforgeable, collision-free contract between provider and consumer plugins.

## Acceptance Criteria

1. **Given** `import { ServiceToken } from 'kaizen/types'` — **When** compiled — **Then** the import resolves correctly (FR2)
2. **Given** `new ServiceToken<MyService>("MyService")` — **Then** instance has `.label === "MyService"` and TypeScript binds `T` to `MyService` (FR1)
3. **Given** two tokens: `new ServiceToken<A>("Svc")` and `new ServiceToken<A>("Svc")` — **When** compared via `===` — **Then** they are NOT equal (distinct internal `Symbol` per instantiation) (FR3)
4. **Given** a token `const T = new ServiceToken<ServiceA>("Svc")` passed where `ServiceToken<ServiceB>` is expected — **When** compiled — **Then** TypeScript reports a type error (FR14)
5. **Given** a `ServiceToken<T>` variable — **When** hovering in VS Code / IDE — **Then** the type parameter `T` is visible, revealing what service the token provides (FR21)

## Tasks / Subtasks

- [x] Create `src/core/service-registry.ts` with `ServiceToken<T>` class (AC: 2, 3, 4, 5)
  - [x] Implement `readonly label: string` public property
  - [x] Implement `private readonly _symbol: symbol` using `Symbol(label)` (NOT `Symbol.for`)
  - [x] Add phantom type brand: `declare readonly _type: T` (declaration only — NO assignment in constructor)
  - [x] Add constructor: `constructor(label: string) { this.label = label; this._symbol = Symbol(label); }`
  - [x] Add a `// ServiceRegistry class goes here in Story 1.2` placeholder comment below ServiceToken
- [x] Re-export `ServiceToken` from `src/types/plugin.ts` barrel (AC: 1)
  - [x] Add `export { ServiceToken } from "../core/service-registry.js";` to `src/types/plugin.ts`
  - [x] Verify existing exports are undisturbed
- [x] Create `src/core/service-registry.test.ts` with unit tests (AC: 1, 2, 3)
  - [x] Test: `label` property equals the string passed to constructor
  - [x] Test: two tokens with same label string are `!==` (object identity differs)
  - [x] Test: same token instance is `===` to itself

## Dev Notes

### Critical Implementation Rules — Do NOT Deviate

**Symbol strategy — use `Symbol(label)`, never `Symbol.for(label)`:**
```typescript
// ✅ Correct — unique symbol per call; same-label tokens are distinct keys
private readonly _symbol: symbol = Symbol(this.label);

// ❌ WRONG — Symbol.for is a global registry; same label → same symbol → FR3 violated
private readonly _symbol: symbol = Symbol.for(this.label);
```

**Phantom type brand — declaration only, zero runtime footprint:**
```typescript
// ✅ Correct — TS enforces the brand at compile time; no runtime field written
declare readonly _type: T;

// ❌ WRONG — this._ type = ... adds a runtime field, wastes memory, changes object shape
// (and TypeScript will error anyway since 'declare' members can't be assigned)
```

**Complete `ServiceToken<T>` implementation:**
```typescript
export class ServiceToken<T> {
  readonly label: string;
  private readonly _symbol: symbol;
  declare readonly _type: T; // phantom brand — compile-time only

  constructor(label: string) {
    this.label = label;
    this._symbol = Symbol(label);
  }
}
```

**File boundary — both classes share one file:**
```
src/core/service-registry.ts  ← ServiceToken<T> (this story) + ServiceRegistry (Story 1.2)
```
Do NOT create `src/core/service-token.ts`. Architecture explicitly requires co-location.

### Re-export in `src/types/plugin.ts`

Add exactly one line — import path must use `.js` extension (ESM + Bun):

```typescript
export { ServiceToken } from "../core/service-registry.js";
```

Place it near the top of the file, after `PLUGIN_API_VERSION` and before the JSON Schema types section. Do NOT alter any existing export.

### Why object identity as Map key works (preview for Story 1.2 context)

Each `new ServiceToken(...)` call creates a unique `Symbol` stored in `_symbol`. In Story 1.2, `ServiceRegistry` will use `Map<ServiceToken<unknown>, unknown>` with the **token object itself** as the key (JS `Map` uses SameValueZero for object keys → object identity). This means two tokens with the same label string are different map keys — correct behavior for FR3.

### Testing — Bun test runner, no existing test files in `src/`

This is the **first test file** in `src/core/`. Use Bun's built-in test runner:

```typescript
// src/core/service-registry.test.ts
import { describe, expect, test } from "bun:test";
import { ServiceToken } from "./service-registry.js";

describe("ServiceToken", () => {
  test("label property matches constructor arg", () => {
    const token = new ServiceToken<string>("MyService");
    expect(token.label).toBe("MyService");
  });

  test("two tokens with same label are distinct (FR3)", () => {
    const a = new ServiceToken<string>("Svc");
    const b = new ServiceToken<string>("Svc");
    expect(a).not.toBe(b);
  });

  test("same token is identical to itself", () => {
    const token = new ServiceToken<string>("Svc");
    expect(token).toBe(token);
  });
});
```

Run with: `bun test src/core/service-registry.test.ts`

### Project Structure Notes

**Files touched:**
- `src/core/service-registry.ts` — NEW (create this file)
- `src/types/plugin.ts` — MODIFIED (one new export line)
- `src/core/service-registry.test.ts` — NEW (create this file)

**Files NOT touched this story:**
- `src/core/context.ts` — modified in Story 1.3
- `src/core/loader.ts` — modified in Story 1.3
- `plugins/` — modified in Epic 2

**Existing pattern references (read-only, do not modify):**
- `src/core/tool-registry.ts` — pattern for how registry classes are structured
- `src/core/executor-registry.ts` — pattern for simpler registry (single impl)
- `src/types/plugin.ts` — understand existing exports before adding

### References

- ServiceToken design: [Source: _bmad-output/planning-artifacts/architecture.md#Naming Patterns]
- Phantom type brand: [Source: _bmad-output/planning-artifacts/architecture.md#Implementation Patterns & Consistency Rules]
- Symbol strategy: [Source: _bmad-output/planning-artifacts/epics.md#Additional Requirements]
- FR1–FR3, FR14, FR21: [Source: _bmad-output/planning-artifacts/prd.md#Functional Requirements]
- File placement: [Source: _bmad-output/planning-artifacts/architecture.md#Structure Patterns]
- Re-export barrel: [Source: _bmad-output/planning-artifacts/architecture.md#Architectural Boundaries]

### Review Findings

- [x] [Review][Patch] Self-referential identity test adds no value [src/core/service-registry.test.ts:16] — `expect(token).toBe(token)` asserts a JavaScript axiom (every object is `===` to itself); replace with an assertion that actually exercises token behavior, e.g. verify `.label` survives a round-trip reference.
- [x] [Review][Defer] No `toString()`/inspect override [src/core/service-registry.ts] — deferred, pre-existing; tokens print as `ServiceToken {}` in logs; not required by any AC.
- [x] [Review][Defer] Symbol realm isolation risk — deferred, pre-existing; if `service-registry.js` is resolved from two different on-disk paths, cross-realm `instanceof` would fail; no `instanceof` guard is planned for ServiceRegistry (Map uses object identity), so this is low-impact until that assumption changes.
- [x] [Review][Defer] Empty-string label not validated [src/core/service-registry.ts:6] — deferred, pre-existing; `new ServiceToken("")` is silently accepted; no AC requires a guard.
- [x] [Review][Defer] AC4 compile-time mismatch not tested with `@ts-expect-error` — deferred, pre-existing; TypeScript generics guarantee this at compile time; `tsd` tooling not set up in project.
- [x] [Review][Defer] `_type` phantom brand not declared `private` — deferred, pre-existing; `declare readonly _type: T` is public in TypeScript's type system; marking `declare private` would be cleaner but is a style preference consistent with project conventions.

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — implementation was straightforward with no blocking issues.

### Completion Notes List

- Implemented `ServiceToken<T>` in `src/core/service-registry.ts` using `Symbol(label)` for per-instantiation uniqueness (FR3). Phantom brand `declare readonly _type: T` is compile-time only — no runtime field.
- Added `export { ServiceToken } from "../core/service-registry.js"` to `src/types/plugin.ts` barrel immediately after `PLUGIN_API_VERSION`. All existing exports preserved.
- Created `src/core/service-registry.test.ts` as the first test file in `src/core/`. Three tests: label property, same-label distinctness (FR3), and self-identity. All pass.
- TypeScript strict-mode typecheck (`bun x tsc --noEmit`) exits 0. `verbatimModuleSyntax` is enabled — re-export works correctly for the class (value + type).
- Story 1.2 placeholder comment left in `service-registry.ts` to guide the next developer.

### File List

- `src/core/service-registry.ts` (new)
- `src/core/service-registry.test.ts` (new)
- `src/types/plugin.ts` (modified — added ServiceToken re-export)
