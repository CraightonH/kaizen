---
stepsCompleted: [1, 2, 3, 4, 5, 6]
inputDocuments: []
workflowType: 'research'
lastStep: 1
research_type: 'technical'
research_topic: 'Synchronous service registry patterns in plugin ecosystems'
research_goals: 'Inform implementation of item 15 from adversarial-review.md — add a typed, synchronous inter-plugin API surface to Kaizen'
user_name: 'Craighton'
date: '2026-04-08'
web_research_enabled: true
source_verification: true
---

# Research Report: Technical

**Date:** 2026-04-08
**Author:** Craighton
**Research Type:** Technical

---

## Executive Summary

Plugin ecosystems that aspire to genuine composability — the ability to "build anything" from independent parts — require two distinct communication layers: an asynchronous event bus for decoupled notification, and a synchronous service registry for typed, direct capability access. Kaizen currently provides only the former. This research identifies exactly how to add the latter with minimal code change and zero breaking impact on existing plugins.

Four battle-tested ecosystems were surveyed: VS Code's `activate()`/`exports` inter-extension pattern, OSGi's `registerService()`/`getService()` specification, webpack's Tapable synchronous hook taxonomy, and TypeDI's `Token<T>` typed service identity pattern. All converge on the same core design: a `ServiceToken<T>` object (wrapping a `Symbol`) serves as a typed, unforgeable, collision-free registry key. Providers register during initialization; consumers retrieve synchronously after their `depends` ordering guarantee fires.

Applied to Kaizen: the implementation requires **~90 lines of code across 4 files** — a new `ServiceRegistry` class, `ServiceToken<T>` exported from `plugin.ts`, two new methods on `PluginContext`, and three lines in `loader.ts`. No new dependencies. No breaking changes. The existing `depends` topological sort already guarantees ordering; the service registry simply makes that ordering *useful* for synchronous typed access.

**Key Technical Findings:**

- `ServiceToken<T>` (object-identity based, wrapping `Symbol`) is the correct token type — typed, unforgeable, and debuggable; superior to plain strings or `unique symbol`
- Service locator pattern (`ctx.getService(token)`) is correct for Kaizen — plugin types are unknown at compile time; decorator-based DI requires `reflect-metadata` and adds unnecessary complexity
- Registration must be gated to `INITIALIZING` (matching `registerTool`); retrieval is valid at any lifecycle state
- The `depends` field already solves activation ordering — no new ordering mechanism needed
- The token import requirement creates an implicit object-capability boundary — possession of the import equals possession of access

**Technical Recommendations:**

1. Implement `ServiceToken<T>` + `ServiceRegistry` as described — ~90 LOC, 4 files
2. Gate `registerService` with `assertInitializing`; leave `getService` ungated
3. Error message on missing service must name the token label and suggest `depends`
4. Publish at least one built-in plugin pair as a reference implementation
5. Document the sync/async split explicitly: services = nouns (call a method); events = verbs (something happened)

---

## Table of Contents

1. [Research Overview and Methodology](#research-overview)
2. [Technical Research Scope Confirmation](#technical-research-scope-confirmation)
3. [Technology Stack Analysis](#technology-stack-analysis)
   - Reference Implementations and Frameworks
   - VS Code Activate-and-Export Pattern
   - OSGi / Eclipse Service Registry
   - Webpack Tapable Synchronous Hooks
   - TypeScript Well-Typed Plugin Architecture
4. [Integration Patterns Analysis](#integration-patterns-analysis)
   - API Design Patterns (A, B, C)
   - Service Token Design: Symbol vs String vs Token Object
   - Lifecycle Integration: Sync Registry + Async Event Bus Coexistence
   - Initialization Ordering and Dependency Graph
   - Communication Protocol: When to Use Which
   - Integration Security
5. [Architectural Patterns and Design](#architectural-patterns-and-design)
   - ServiceRegistry Class Design
   - PluginContext Surface Changes
   - Design Principles and Trade-offs (Service Locator vs DI, SOLID)
   - Scalability and Performance
   - Circular Dependency Detection
   - Integration with loader.ts
   - Security Architecture
6. [Implementation Approaches and Technology Adoption](#implementation-approaches-and-technology-adoption)
   - Exact File Change Map
   - Step-by-Step Implementation
   - Technology Adoption Strategy
   - Testing and Quality Assurance
   - Developer Experience for Plugin Authors
   - Risk Assessment and Mitigation
7. [Technical Research Recommendations](#technical-research-recommendations)
   - Implementation Roadmap
   - Technology Stack Recommendations
   - Success Metrics

---

## Research Overview

This document surveys synchronous inter-plugin service registry patterns across major plugin ecosystems, with the goal of informing a concrete design for Kaizen's item 15: adding a typed, synchronous service API surface so plugins can expose capabilities directly to other plugins, without relying on the async event bus.

The research was conducted in five phases: (1) scope confirmation, (2) technology stack and reference ecosystem analysis, (3) integration patterns specific to Kaizen's lifecycle model, (4) architectural design decisions including exact class shapes and API signatures, and (5) implementation specifics grounded in Kaizen's live source code. All claims are verified against 2024–2026 web sources and cross-referenced against the current Kaizen codebase.

**Methodology:** Multi-source web search (2024–2026 sources) cross-referenced against Kaizen's current plugin type system (`src/types/plugin.ts`) to produce actionable, Kaizen-specific recommendations. Confidence levels noted where sources diverge.

---

## Technical Research Scope Confirmation

**Research Topic:** Synchronous service registry patterns in plugin ecosystems
**Research Goals:** Inform implementation of item 15 from adversarial-review.md — add a typed, synchronous inter-plugin API surface to Kaizen

**Technical Research Scope:**

- Architecture Analysis - design patterns, frameworks, system architecture
- Implementation Approaches - development methodologies, coding patterns
- Technology Stack - languages, frameworks, tools, platforms
- Integration Patterns - APIs, protocols, interoperability
- Performance Considerations - scalability, optimization, patterns

**Research Methodology:**

- Current web data with rigorous source verification
- Multi-source validation for critical technical claims
- Confidence level framework for uncertain information
- Comprehensive technical coverage with architecture-specific insights

**Scope Confirmed:** 2026-04-08

---

## Technology Stack Analysis

### Programming Languages

TypeScript is the unambiguous choice for Kaizen's service registry — it is already the project language and uniquely enables *compile-time* verification of inter-plugin contracts via generics, conditional types, and module augmentation.

_Primary Language:_ TypeScript (Kaizen is already fully TypeScript)
_Key Capability:_ Generic `ServiceToken<T>` pattern enables `getService<T>(token)` to return `T` without casting
_Language Evolution:_ TypeScript 5.x (2024–2026) brings improved const type parameters and inferred template literal types — both useful for typed service tokens
_Source:_ [Microsoft TypeScript 7 Progress - InfoQ](https://www.infoq.com/news/2026/01/typescript-7-progress/)

### Reference Implementations and Frameworks

Four battle-tested ecosystems directly inform Kaizen's design:

#### 1. VS Code Extension API — Activate-and-Export

VS Code's inter-extension pattern is the closest analogue to Kaizen's plugin lifecycle:

- **Provider:** `activate(context)` returns a typed API object (the "service surface")
- **Consumer:** `extensions.getExtension('publisher.name').exports` accesses it synchronously
- **Dependency declaration:** Consumer declares the provider in `extensionDependencies` in `package.json` — VS Code guarantees activation order
- **Key constraint:** `exports` is only valid after the target extension is activated; accessing it before activation is an error

```typescript
// Provider plugin's activate():
export function activate(context) {
  return {
    sum(a: number, b: number): number { return a + b; },
    mul(a: number, b: number): number { return a * b; },
  };
}

// Consumer plugin (after provider is guaranteed active):
const mathExt = vscode.extensions.getExtension<MathAPI>('genius.math');
const api = mathExt!.exports; // synchronous, typed
```

**Kaizen mapping:** `setup(ctx)` is the equivalent of `activate()`. The service is returned (or registered) during setup, and `depends` already guarantees ordering. The missing piece is only the `ctx.getService()` lookup.

_Source:_ [VS Code Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy), [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)

#### 2. OSGi / Eclipse Service Registry — The Canonical Pattern

OSGi is the most thoroughly specified synchronous plugin service registry in existence. Its model:

- **`BundleContext.registerService(interface, impl, props)`** — provider registers during activation
- **`BundleContext.getService(ServiceReference)`** — consumer retrieves synchronously
- **Service notifications are synchronous** — a listener calling `getService()` inside `registerService()` is valid
- **Service Tracker helper** — manages dynamic availability (services can unregister at runtime)

Key insight: OSGi separates the *token* (the Java interface class object) from the *implementation*, enabling typed lookup without coupling to impl class.

_Confidence:_ High — OSGi Core 7 specification is authoritative
_Source:_ [OSGi Core 7 Service Layer Spec](https://docs.osgi.org/specification/osgi.core/7.0.0/framework.service.html), [OSGi Service Tutorial](https://www.knopflerfish.org/osgi_service_tutorial.html)

#### 3. Webpack Tapable — Typed Synchronous Hooks

Tapable is not a service registry but its synchronous hook taxonomy is directly relevant for cases where plugins need to *contribute to* a shared pipeline synchronously:

| Hook Type | Behavior | Use case |
|---|---|---|
| `SyncHook` | Calls all taps, ignores return values | Side effects, notification |
| `SyncBailHook` | Stops at first non-undefined return | Validation, capability queries |
| `SyncWaterfallHook` | Chains return value through taps | Data transformation pipelines |
| `SyncLoopHook` | Retries from start until all return undefined | State convergence |

The distinction between `SyncBailHook` (first provider wins) and `SyncWaterfallHook` (all transform in turn) maps cleanly onto two service registry semantics: *exclusive service* vs *middleware stack*.

_Source:_ [webpack/tapable on GitHub](https://github.com/webpack/tapable), [Webpack Plugin API](https://webpack.js.org/api/plugins/)

#### 4. TypeScript Well-Typed Plugin Architecture — Interface Merging

Two open-source patterns demonstrate how to achieve *compile-time typed* service access:

**Pattern A — Module augmentation** (gr2m):
Plugins extend a shared namespace declaration, growing the merged type at compile time. No runtime registry needed; types are structural.

```typescript
declare module "my-platform" {
  namespace Platform {
    interface Services {
      "emoji-prompt": EmojiPromptService;
    }
  }
}
```

**Pattern B — Interface intersection** (code.lol):
A generic `engine.createInterface()` merges plugin return types into an intersection, giving callers a single fully-typed object.

```typescript
const ø = engine.createInterface();
ø.bark();   // DogPlugin
ø.meow();   // CatPlugin
```

Both approaches achieve compile-time safety but require plugin types to be known at build time — less suitable for runtime-distributed plugins (npm packages loaded at runtime), which is Kaizen's model.

_Source:_ [Towards a well-typed plugin architecture](https://code.lol/post/programming/plugin-architecture/), [javascript-plugin-architecture-with-typescript-definitions](https://github.com/gr2m/javascript-plugin-architecture-with-typescript-definitions)

### Development Tools and Platforms

_Runtime:_ Bun (current Kaizen runtime) — fully supports TypeScript generics at runtime through its native TS execution
_Build:_ No compile step required for service token symbols; `Symbol()` and generic inference work at runtime
_Testing:_ Existing Bun test runner can verify service registration/retrieval in plugin unit tests
_IDE Support:_ Generic `ServiceToken<T>` pattern gives full IntelliSense autocomplete on retrieved services with zero extra config

### Technology Adoption Trends

- **Service token as `unique symbol`** — growing TypeScript idiom (2024–2025) for branded service identity without string collision risk
- **Decorator-based DI** (InversifyJS, TypeDI) — popular but requires `experimentalDecorators`; adds complexity Kaizen doesn't need
- **Pure-function DI** (iocta) — newer (2024) lightweight alternative; factory-function pattern fits Kaizen's existing `setup()` model better than decorator-based approaches
- **Interface-first tokens** (VS Code pattern) — most idiomatic for plugin systems where consumers import the token type from the provider package

_Sources:_ [iocta on GitHub](https://github.com/romeerez/iocta), [Top 5 TypeScript DI containers - LogRocket](https://blog.logrocket.com/top-five-typescript-dependency-injection-containers/), [InversifyJS overview](https://www.linkedin.com/pulse/empower-your-typescript-projects-inversifyjs-control-haidery-mwglf)

## Integration Patterns Analysis

### API Design Patterns for Inter-Plugin Services

Three distinct API surface designs emerge from reference ecosystems, each with different trade-offs for Kaizen:

#### Pattern A — Return-from-setup (VS Code model)

The provider plugin returns its service object directly from `setup()` (or `activate()` in VS Code terms). Core stores it keyed by plugin name. Consumers retrieve it by name or token after the initialization phase.

```typescript
// Provider plugin:
async setup(ctx: PluginContext): Promise<void> {
  ctx.registerService(EmojiServiceToken, new EmojiService());
}

// Consumer plugin (setup() runs after provider, because depends: ['emoji-prompt']):
async setup(ctx: PluginContext): Promise<void> {
  const emoji = ctx.getService(EmojiServiceToken); // synchronous, typed
  emoji.prefix('hello');                            // TS infers EmojiService type
}
```

**Verdict for Kaizen:** Best fit. Maps directly onto the existing `setup()` / `depends` lifecycle. Zero new concepts for plugin authors — it reads like `registerTool` / `on`, which they already know.

_Source:_ [VS Code Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy), [VS Code Extensibility Principles](https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/)

#### Pattern B — Token-based container (TypeDI / InversifyJS model)

A centralized `Container` holds service bindings. Plugins call `Container.set(token, impl)` and `Container.get(token)` with a typed `Token<T>` object.

```typescript
export const EmojiService = new Token<IEmojiService>('emoji-service');
Container.set(EmojiService, new EmojiServiceImpl());
const svc = Container.get(EmojiService); // type: IEmojiService
```

Key insight from TypeDI: **two tokens with the same name are different tokens** — uniqueness is by object identity (`new Token()`), not string. This eliminates the tool-name collision problem (adversarial item 6) if adopted.

**Verdict for Kaizen:** The `Token<T>` class is worth adopting as the registry key type even if Kaizen doesn't use a full DI container. It provides type safety, debug labels, and collision-free identity.

_Source:_ [TypeDI Service Tokens docs](https://github.com/typestack/typedi/blob/develop/docs/typescript/06-service-tokens.md), [Top 5 TS DI containers - LogRocket](https://blog.logrocket.com/top-five-typescript-dependency-injection-containers/)

#### Pattern C — Module augmentation (gr2m / TypeScript structural model)

Consumer and provider share a declared interface namespace. TypeScript merges all augmentations at compile time into a single typed surface.

**Verdict for Kaizen:** Not suitable for runtime-distributed npm plugins. Plugin types can't be known at compile time when plugins are arbitrary npm packages. Suitable only if Kaizen ever offers a compile-time "typed harness" mode.

_Source:_ [javascript-plugin-architecture-with-typescript-definitions](https://github.com/gr2m/javascript-plugin-architecture-with-typescript-definitions)

---

### Service Token Design: Symbol vs String vs Token Object

| Approach | Type safety | Collision risk | Debug label | Kaizen fit |
|---|---|---|---|---|
| Plain string `'emoji-service'` | ❌ No inference | High (global namespace) | ✅ | ❌ Poor |
| `Symbol('emoji-service')` | ⚠️ Requires generic | None (identity-based) | ⚠️ Weak | ⚠️ Partial |
| `new Token<T>('emoji-service')` | ✅ Full inference | None (object identity) | ✅ | ✅ Best |
| Class reference (InversifyJS) | ✅ | None | ✅ | ⚠️ Adds class requirement |

**Recommendation:** `ServiceToken<T>` — a minimal class wrapping a `Symbol` with a debug label and generic parameter. This is the TypeDI `Token<T>` pattern without pulling in the full TypeDI dependency.

```typescript
// In src/types/plugin.ts (new export):
export class ServiceToken<T> {
  readonly #sym = Symbol(this.label);
  constructor(readonly label: string) {}
  /** Used internally by the registry as the Map key. */
  get key(): symbol { return this.#sym; }
}
```

Plugin authors publish their token as a named export from their package, just as VS Code extensions export their API type. Consumers import the token and call `ctx.getService(token)`.

---

### Lifecycle Integration: Sync Registry + Async Event Bus Coexistence

The critical integration question for Kaizen is: **how does a synchronous service registry coexist with the existing async event bus without creating order-of-initialization landmines?**

Reference data from Home Assistant's architecture (a large plugin ecosystem with both a service registry and an event bus) reveals the canonical split:

- **Service registry** — used during *setup/initialization* for typed, synchronous capability exposure. Available once a plugin completes `setup()`.
- **Event bus** — used during *runtime* for decoupled, cross-cutting notification. Fire-and-forget; no caller-to-callee type contract.
- **State machine** — authoritative runtime state; plugins read it synchronously, mutations emit events asynchronously.

This maps exactly to Kaizen's two phases: `INITIALIZING` (setup loop) and `RUNNING` (start loop + event-driven execution).

**Rule derived:** `ctx.registerService()` is valid only during `INITIALIZING` (same gate as `registerTool`). `ctx.getService()` is valid from `INITIALIZING` onward — but only returns a service if the providing plugin has already completed `setup()`. Because `depends` enforces ordering, a plugin that declares `depends: ['emoji-prompt']` is *guaranteed* the service exists when its `setup()` runs.

_Source:_ [XState async registry discussion](https://github.com/davidkpiano/xstate/discussions/2259), Home Assistant architecture (via LobeHub), [Grails async event bus issue](https://github.com/grails/grails-async/issues/14)

---

### Initialization Ordering and Dependency Graph

Kaizen's existing `depends` field already solves activation ordering (the same problem VS Code's `extensionDependencies` and OSGi's `BundleContext` solve). **No new ordering mechanism is needed.** The service registry piggybacks on the existing guarantee:

> If plugin B declares `depends: ['plugin-a-role']`, core guarantees plugin A's `setup()` completes before plugin B's `setup()` begins.

This means `ctx.getService(token)` during `setup()` can throw synchronously if the token isn't registered — and that throw is a *programming error* (missing `depends` declaration), not a runtime race. The error message should say exactly that: "Service `emoji-service` not found. Did you forget to declare it in `depends`?"

_Source:_ [VS Code ExtensionsActivator activation ordering](https://deepwiki.com/microsoft/vscode/3-product-configuration-and-policy), [VS Code Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)

---

### Communication Protocol: Synchronous vs Asynchronous — When to Use Which

The adversarial review correctly identifies that the event bus is *not designed* for synchronous coordination. Reference ecosystems converge on a clean split:

| Need | Use | Rationale |
|---|---|---|
| Typed capability lookup (does X exist?) | Service registry `getService()` | Synchronous, typed, clear error on miss |
| Shared mutable state | Service registry (expose a stateful service object) | Single owner, typed interface |
| Cross-cutting notification (something happened) | Event bus `emit()` | Decoupled, multiple listeners, no return contract |
| Tool interception / result transformation | Event bus `tool:before` hook | Existing pattern, async pipeline |
| Synchronous data pipeline (waterfall) | Tapable `SyncWaterfallHook` pattern | If Kaizen adds hook types in future |

The key insight: **services are nouns (things you call); events are verbs (things that happened)**. Any pattern where a plugin needs to *call a method on another plugin* should go through the service registry, not the event bus.

_Source:_ [MiddleWay: sync APIs on async event bus](https://www.middleway.eu/building-synchronous-apis-on-an-asynchronous-event-bus-using-azure-service-bus/), [NServiceBus async handlers](https://docs.particular.net/nservicebus/handlers/async-handlers/)

---

### Integration Security: Service Access Control

The adversarial review (item 3) notes that `provides`/`depends` creates a false impression of capability containment. The service registry pattern doesn't fully solve this — any plugin can still call `ctx.getService(importedToken)` if it has access to the token object.

However, the `Token<T>` object-identity pattern provides a meaningful improvement over string-based lookup:

- **Tokens are unforgeable** — you can't call `ctx.getService(someToken)` without importing the token from the provider's package. This creates an *implicit capability* — possession of the import is possession of the access right.
- **Tokens can be scoped** — a provider can export different tokens for public vs. internal surfaces, controlling what other plugins can discover.
- **Not a security boundary** — any loaded plugin can still import any other plugin's token at runtime. Full sandboxing requires OS-level isolation (item 2 of the review), which is out of scope for item 15.

_Confidence:_ Medium — this is a design inference from TypeDI token identity semantics, not a formally specified security model.

_Source:_ [TypeDI Token identity docs](https://github.com/typestack/typedi/blob/develop/docs/typescript/06-service-tokens.md), [OSGi service registry access control](https://docs.osgi.org/specification/osgi.core/7.0.0/framework.service.html)

---

## Architectural Patterns and Design

### System Architecture: ServiceRegistry Class Design

The registry is a thin, typed `Map` wrapper. It does not need a full IoC container — no decorators, no reflection, no metadata. The canonical design is:

```typescript
// src/core/service-registry.ts
export class ServiceRegistry {
  readonly #services = new Map<symbol, unknown>();
  #sealed = false;

  register<T>(token: ServiceToken<T>, impl: T): void {
    if (this.#sealed) {
      throw new Error(`Cannot register service '${token.label}' after initialization.`);
    }
    if (this.#services.has(token.key)) {
      throw new Error(`Service '${token.label}' already registered.`);
    }
    this.#services.set(token.key, impl);
  }

  get<T>(token: ServiceToken<T>): T {
    if (!this.#services.has(token.key)) {
      throw new Error(
        `Service '${token.label}' not found. ` +
        `Did you forget to declare it in 'depends'?`
      );
    }
    return this.#services.get(token.key) as T;
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.#services.has(token.key);
  }

  /** Called by core after INITIALIZING → RUNNING transition. Prevents new registrations. */
  seal(): void { this.#sealed = true; }
}
```

**Key design decisions:**
- `Map<symbol, unknown>` with cast-on-get — the generic `T` on `ServiceToken<T>` makes the cast safe at call sites
- `register()` throws on duplicate — prevents silent shadowing (unlike the event bus which silently stacks handlers)
- `get()` throws with actionable message — identifies the missing `depends` declaration as root cause
- `seal()` enforces the INITIALIZING-only registration gate — same pattern as `registerTool` lock-out

_Source:_ [Registry Pattern - GeeksforGeeks](https://www.geeksforgeeks.org/system-design/registry-pattern/), [Service Registry Pattern - Medium](https://medium.com/design-microservices-architecture-with-patterns/service-registry-pattern-75f9c4e50d09)

---

### PluginContext Surface Changes

Two methods added to `PluginContext` in `src/types/plugin.ts`. Everything else is unchanged:

```typescript
export interface PluginContext {
  // ... existing members unchanged ...

  // --- Service registry (NEW) -----------------------------------------------

  /**
   * Expose a typed synchronous service to other plugins.
   * Valid only during INITIALIZING (setup). Throws after seal.
   * Throws if a service with this token is already registered.
   */
  registerService<T>(token: ServiceToken<T>, impl: T): void;

  /**
   * Retrieve a typed synchronous service registered by another plugin.
   * Valid during INITIALIZING and RUNNING.
   * Throws if the token has no registered service — indicates a missing `depends` declaration.
   */
  getService<T>(token: ServiceToken<T>): T;
}
```

And `ServiceToken<T>` is added as a new export:

```typescript
export class ServiceToken<T> {
  readonly #key = Symbol(this.label);
  constructor(readonly label: string) {}
  /** @internal */
  get key(): symbol { return this.#key; }
}
```

This is the *only* public-API change. The `KaizenPlugin` interface and all other types remain untouched.

_Source:_ [Towards a well-typed plugin architecture](https://code.lol/post/programming/plugin-architecture/), [TypeDI service tokens](https://github.com/typestack/typedi/blob/develop/docs/typescript/06-service-tokens.md)

---

### Design Principles and Trade-offs

#### Service Locator vs Dependency Injection

A key architectural debate: should services be *pulled* by consumers (`ctx.getService(token)` — service locator) or *pushed* by core during `setup()` (classic DI)?

**Verdict: service locator is correct for Kaizen.**

Reasons:
1. Core cannot know at setup-time which services a plugin will need — plugins are runtime-distributed npm packages with no compile-time visibility
2. TypeScript interfaces become nothing at runtime (they can't serve as tokens) — DI frameworks work around this with decorators/metadata; Kaizen avoids this complexity
3. The `depends` field already declares intent; `ctx.getService()` is how that intent is *exercised*
4. Plugin authors already pull from `ctx` (e.g., `ctx.config`, `ctx.runtime.tools.list()`) — the mental model is consistent

The main critique of service locator (hidden dependencies, hard to test) is mitigated by the `ServiceToken<T>` import requirement — you cannot call `getService` on a token you haven't imported, making dependencies visible at the module level.

_Source:_ [Dependency Injection in NodeJS — Mario Casciaro](https://mario.fyi/dependency-injection-in-node-js-and-other-architectural-patterns/), [Pure DI in TypeScript — DEV Community](https://dev.to/vad3x/typesafe-almost-zero-cost-dependency-injection-in-typescript-112)

#### SOLID Application

- **Single Responsibility:** `ServiceRegistry` only stores and retrieves services. Lifecycle enforcement (seal) lives in `loader.ts`.
- **Open/Closed:** New service types are added by plugins exporting new `ServiceToken<T>` instances — no core changes needed.
- **Liskov Substitution:** `registerService(token, impl)` accepts any value assignable to `T` — a plugin can provide a mock in tests.
- **Interface Segregation:** `ServiceToken<T>` is minimal. Plugins that don't use services import nothing new.
- **Dependency Inversion:** Plugins depend on the `ServiceToken<T>` exported by a provider package, not on the provider's implementation class.

---

### Scalability and Performance Patterns

**Lookup cost:** `Map.get(symbol)` is O(1). For the scale of plugin systems (tens, not thousands, of services), performance is irrelevant.

**Registry size:** Plugins typically register 0–5 services each. A 20-plugin harness registers at most ~100 services. No pagination, lazy loading, or eviction needed.

**Concurrent access:** Kaizen runs in a single-threaded Node.js/Bun event loop. No locking primitives needed. `seal()` is called synchronously after the setup loop; no race condition possible.

**Memory:** Each entry is a `symbol` key + object reference. Negligible footprint even for long-lived sessions.

_Source:_ [Registry Pattern GeeksforGeeks](https://www.geeksforgeeks.org/system-design/registry-pattern/), [Common Design Patterns in TypeScript — Noveo](https://blog.noveogroup.com/2024/07/common-design-patterns-typescript)

---

### Circular Dependency Detection

Kaizen already has plugin-level cycle detection. Service tokens do not introduce *new* circular dependency risks at the runtime level because:

1. Services are registered during `setup()` in topological order (enforced by `depends`)
2. `getService()` during `setup()` only succeeds if the provider's `setup()` already ran
3. Mutual `depends` between two plugins is already a fatal error — service tokens inherit this protection for free

**Edge case:** A plugin that calls `getService` for a service it is itself responsible for providing would fail with the "not found" error — this is a clear programming error caught immediately at startup.

_Source:_ [Detecting circular dependencies in TypeScript — xjavascript.com](https://www.xjavascript.com/blog/find-circular-dependency-typescript/), [DPDM on GitHub](https://github.com/acrazing/dpdm)

---

### Integration with loader.ts — Minimal Footprint

Changes to `src/core/loader.ts` are surgical:

1. Instantiate `ServiceRegistry` alongside `EventBus`, `ToolRegistry`, etc.
2. In the setup loop, pass `registry.register.bind(registry)` and `registry.get.bind(registry)` into each plugin's `PluginContext`
3. After the setup loop completes, call `registry.seal()`
4. During `RUNNING`, `registerService` in the context can throw "sealed" or be omitted entirely

No new files strictly required beyond `src/core/service-registry.ts` (~45 LOC). `ServiceToken<T>` is added to the existing `src/types/plugin.ts`.

---

### Security Architecture: Token as Capability

The `ServiceToken<T>` object-identity model creates a lightweight *object-capability* boundary:

- A plugin cannot call `ctx.getService(token)` without a reference to the `token` object
- Token references are obtained by importing from the provider's package
- Tokens are unforgeable — `Symbol()` is unique per call; no plugin can construct a matching token without the original object
- Providers can export a `publicToken` (in `index.ts`) and keep an `internalToken` unexported — other plugins only access the public surface

**Limitation:** Not a hard security boundary. Full sandboxing (adversarial item 2) requires OS-level process isolation and is out of scope for item 15.

_Source:_ [TypeDI token identity](https://github.com/typestack/typedi/blob/develop/docs/typescript/06-service-tokens.md), [OSGi service layer spec](https://docs.osgi.org/specification/osgi.core/7.0.0/framework.service.html)

---

### Deployment and Operations Architecture

No deployment changes. `ServiceRegistry` is in-memory, per-session, not serialized, and requires no `kaizen.json` configuration. Plugin authors publish their `ServiceToken<T>` as a named export from their npm package — the npm package is the service discovery mechanism.

---

## Implementation Approaches and Technology Adoption

### Exact File Change Map

Based on reading the live source (`src/core/loader.ts`, `src/core/context.ts`, `src/types/plugin.ts`), the implementation touches **4 locations** with minimal blast radius:

| File | Change type | Est. LOC delta |
|---|---|---|
| `src/types/plugin.ts` | Add `ServiceToken<T>` class + 2 methods to `PluginContext` | +25 |
| `src/core/service-registry.ts` | **New file** — `ServiceRegistry` class | +45 |
| `src/core/context.ts` | Add `serviceRegistry` param + 2 method impls to `createPluginContext` | +15 |
| `src/core/loader.ts` | Instantiate `ServiceRegistry`, pass to `createPluginContext` | +5 |

**Total: ~90 LOC across 3 changed files + 1 new file.**

---

### Step-by-Step Implementation

#### Step 1 — `src/types/plugin.ts`: Add `ServiceToken<T>` and `PluginContext` methods

After the existing `EventHandler` type alias (line 135), add:

```typescript
// ---------------------------------------------------------------------------
// Service registry
// ---------------------------------------------------------------------------

/**
 * A typed, collision-free token for the service registry.
 * Create one per service interface and export it from your plugin package.
 *
 * @example
 * export const MyServiceToken = new ServiceToken<IMyService>('my-plugin:my-service');
 */
export class ServiceToken<T> {
  readonly #key = Symbol(this.label);
  constructor(readonly label: string) {}
  /** @internal — used by ServiceRegistry as Map key. Do not use directly. */
  get key(): symbol { return this.#key; }
}
```

In `PluginContext`, after the `emit` method, add:

```typescript
  // --- Service registry ----------------------------------------------------

  /**
   * Expose a typed synchronous service to other plugins.
   * Valid only during INITIALIZING. Throws if called after setup completes.
   * Throws if a service with this token is already registered.
   */
  registerService<T>(token: ServiceToken<T>, impl: T): void;

  /**
   * Retrieve a typed synchronous service registered by another plugin.
   * Valid at any lifecycle state (INITIALIZING, READY, RUNNING).
   * Throws with an actionable message if the token has no registered service.
   */
  getService<T>(token: ServiceToken<T>): T;
```

#### Step 2 — `src/core/service-registry.ts` (new file)

```typescript
import type { ServiceToken } from "../types/plugin.js";

export class ServiceRegistry {
  readonly #services = new Map<symbol, unknown>();

  register<T>(token: ServiceToken<T>, impl: T, callerPlugin: string): void {
    if (this.#services.has(token.key)) {
      throw new Error(
        `Service '${token.label}' is already registered. ` +
        `Called by plugin '${callerPlugin}'.`
      );
    }
    this.#services.set(token.key, impl);
  }

  get<T>(token: ServiceToken<T>): T {
    if (!this.#services.has(token.key)) {
      throw new Error(
        `Service '${token.label}' not found. ` +
        `Ensure the providing plugin is loaded and declared in 'depends'.`
      );
    }
    return this.#services.get(token.key) as T;
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.#services.has(token.key);
  }
}
```

Note: No `seal()` needed — the existing `assertInitializing(getState(), ...)` pattern in `context.ts` handles the lifecycle gate automatically.

#### Step 3 — `src/core/context.ts`: Wire up ServiceRegistry

Add `ServiceRegistry` import and parameter to `createPluginContext`:

```typescript
import type { ServiceRegistry } from "./service-registry.js";

export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  eventBus: EventBus,
  toolRegistry: ToolRegistry,
  executorRegistry: ExecutorRegistry,
  uiRegistry: UiRegistry,
  getState: () => CoreState,
  serviceRegistry: ServiceRegistry,   // ← new parameter (add at end)
): PluginContext {
  return {
    // ... all existing methods unchanged ...

    registerService<T>(token, impl) {
      assertInitializing(getState(), "register services");
      serviceRegistry.register(token, impl, pluginName);
    },

    getService<T>(token) {
      return serviceRegistry.get(token);
    },
  };
}
```

#### Step 4 — `src/core/loader.ts`: Instantiate and pass ServiceRegistry

In `loadPlugins` (around line 173), import and instantiate:

```typescript
import { ServiceRegistry } from "./service-registry.js";

// Inside loadPlugins(), add alongside EventBus etc.:
const serviceRegistry = new ServiceRegistry();

// In the setup loop (line 220), pass to createPluginContext:
const ctx = createPluginContext(
  plugin.name,
  pluginConfig,
  eventBus,
  toolRegistry,
  executorRegistry,
  uiRegistry,
  getState,
  serviceRegistry,   // ← new argument
);
```

No other changes needed in `loader.ts`.

---

### Technology Adoption Strategy

**Zero breaking changes.** The new `registerService` and `getService` methods are *additions* to `PluginContext`. No existing plugin implements `PluginContext` directly — plugins receive it as a parameter to `setup()`. Adding methods to the interface does not break any existing plugin.

**Gradual adoption.** Existing plugins continue using the event bus for cross-plugin coordination. New and updated plugins can begin using the service registry where synchronous typed access is preferable. The two patterns coexist indefinitely.

**No required migration.** Kaizen's built-in plugins that currently work around item 15 via event bus can be migrated opportunistically, not as part of this feature.

_Source:_ [Backwards-compatible TypeScript interface extension — Michael's Coding Spot](https://michaelscodingspot.com/typescript-api-change/), [Extending types in TypeScript — Graphite](https://graphite.com/guides/extending-types-typescript)

---

### Testing and Quality Assurance

**Unit testing `ServiceRegistry`:** The class is a pure in-memory store with no external dependencies — straightforward to test with Bun's native test runner:

```typescript
// service-registry.test.ts
import { ServiceRegistry } from "../src/core/service-registry.js";
import { ServiceToken } from "../src/types/plugin.js";

const MyToken = new ServiceToken<string>('test:my-service');

test("register and retrieve", () => {
  const reg = new ServiceRegistry();
  reg.register(MyToken, "hello", "test-plugin");
  expect(reg.get(MyToken)).toBe("hello");
});

test("get throws on missing token", () => {
  const reg = new ServiceRegistry();
  expect(() => reg.get(MyToken)).toThrow("not found");
});

test("register throws on duplicate", () => {
  const reg = new ServiceRegistry();
  reg.register(MyToken, "first", "plugin-a");
  expect(() => reg.register(MyToken, "second", "plugin-b")).toThrow("already registered");
});
```

**Testing plugin service consumers:** Because `ServiceToken<T>` is an ordinary object, plugin tests can create a real registry, pre-populate it with stub implementations, and pass it through `createPluginContext`:

```typescript
const reg = new ServiceRegistry();
reg.register(EmojiServiceToken, { prefix: (s) => `🎉 ${s}` }, "test");
const ctx = createPluginContext("my-plugin", {}, ..., reg);
// test plugin.setup(ctx) with real service available
```

No mocking framework needed — the registry itself is the seam.

_Source:_ [Harnessing TypeScript Generics for Mocking — Moldstud](https://moldstud.com/articles/p-harnessing-typescript-generics-for-effective-mocking-and-stubbing-in-unit-tests), [Unit Testing in TypeScript — Refraction](https://refraction.dev/blog/unit-testing-in-typescript)

---

### Developer Experience for Plugin Authors

Plugin authors need three things:

1. **Create a token** (in the provider plugin package):
```typescript
// my-emoji-plugin/index.ts
import { ServiceToken } from 'kaizen';
export interface IEmojiService { prefix(text: string): string; }
export const EmojiServiceToken = new ServiceToken<IEmojiService>('my-emoji-plugin:emoji');
```

2. **Register the service** during `setup()`:
```typescript
async setup(ctx) {
  ctx.registerService(EmojiServiceToken, new EmojiServiceImpl());
}
```

3. **Consume it** (in the consumer plugin, with `depends` declared):
```typescript
import { EmojiServiceToken } from 'my-emoji-plugin';
// plugin.ts:
depends: ['my-emoji-plugin'],
async setup(ctx) {
  const emoji = ctx.getService(EmojiServiceToken); // type: IEmojiService ✅
  emoji.prefix('hello'); // full IntelliSense ✅
}
```

The import of `EmojiServiceToken` makes the dependency *visible at the module level* — IDE "find all references" and bundler tree-shaking both work correctly.

_Source:_ [Plugin architecture TypeScript — Gitnation](https://gitnation.com/contents/plug-in-architecture-how-typescript-let-us-paint-by-numbers)

---

### Risk Assessment and Mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Plugin calls `getService` before provider's `setup()` | Medium | `getService` throws with actionable error; caught at startup, not runtime |
| Two plugins register the same token | Low | `register()` throws immediately; fail-fast at startup |
| Plugin forgets `depends` but imports token | Medium | Startup error with clear message; regression test in CI |
| Performance overhead | Very Low | `Map.get(symbol)` is O(1); irrelevant at plugin-count scale |
| Backward compat break | None | Additive interface change; no existing plugin implements `PluginContext` |

---

## Technical Research Recommendations

### Implementation Roadmap

1. **Story 1** — Core: Add `ServiceToken<T>` to `plugin.ts`, create `ServiceRegistry`, wire into `context.ts` and `loader.ts`. Add unit tests. (~1–2 hours implementation)
2. **Story 2** — Validation: Add integration test with two plugins where plugin B retrieves plugin A's service during setup. Verify error messages for missing `depends`.
3. **Story 3** — Documentation: Add `ServiceToken` to plugin authoring docs. Add worked example to `DESIGN.md`. Update `docs/adversarial-review.md` to note item 15 resolved.
4. **Story 4 (optional)** — Migrate one existing built-in plugin pair that currently coordinates via event bus to use the service registry instead, as a reference implementation.

### Technology Stack Recommendations

- **No new dependencies.** `ServiceToken<T>` uses only `Symbol()` (built-in). `ServiceRegistry` uses only `Map` (built-in). No DI framework, no decorators, no `reflect-metadata`.
- **Bun native test runner** for unit tests — consistent with existing project tooling.
- **TypeScript strict mode** — already enabled; the generic constraints on `ServiceToken<T>` work correctly under strict mode.

### Success Metrics

- `ctx.getService(token)` returns the correct typed value with full IntelliSense in VS Code/IDE
- `setup()` calling `getService` for an unregistered token throws at startup with a message naming the missing `depends`
- `registerService` called after initialization throws with a clear message
- All existing tests continue passing (zero regression)
- `ServiceRegistry` unit tests: ≥95% branch coverage
- At least one built-in plugin pair demonstrates the pattern end-to-end

---

## Technical Research Conclusion

### Summary of Key Technical Findings

Item 15 of the adversarial review — the absence of a synchronous inter-plugin service API — is a real architectural gap that manifests as friction whenever a plugin needs to directly invoke a typed capability provided by another plugin. The event bus workaround produces hidden coupling, untyped payloads, async overhead, and no compile-time contract.

The solution is well-understood across major plugin ecosystems and maps cleanly onto Kaizen's existing architecture. The `ServiceToken<T>` + `ServiceRegistry` pattern is:

- **Typed:** generic inference means `ctx.getService(MyToken)` returns `MyService` without casting
- **Safe:** `Symbol`-based identity means tokens cannot be forged or collided
- **Minimal:** ~90 LOC, no new runtime dependencies
- **Consistent:** `registerService`/`getService` follow the same conventions as `registerTool`/`runtime.tools.execute`
- **Backward-compatible:** additive change; zero existing plugins broken

### Strategic Technical Impact

Implementing item 15 directly addresses the adversarial review's "composability" critique. It makes Kaizen's `provides`/`depends` system *meaningful beyond initialization ordering* — plugins can now expose real typed APIs, not just role slots. This is the prerequisite for any complex plugin ecosystem: shared state, typed registries, synchronous coordination between peer plugins.

It also partially mitigates item 3 (false capability containment impression) by making the token import the de facto access declaration — visible at the module level, traceable by IDE tooling, and not forgeable at runtime.

### Next Steps

1. **Create PRD** — `/bmad-create-prd` — to scope the feature formally (what's in/out, edge cases, docs requirements)
2. **Create Architecture doc** — `/bmad-create-architecture` — to formalize the `ServiceRegistry` design as an ADR
3. **Create Epics and Stories** — `/bmad-create-epics-and-stories` — to break into Stories 1–4 from the implementation roadmap
4. **Check Implementation Readiness** — `/bmad-check-implementation-readiness` — gate before writing code

---

**Technical Research Completion Date:** 2026-04-08
**Research Period:** 2024–2026 sources, live Kaizen codebase (branch: master, commit 332d183)
**Source Verification:** All technical claims cited with current sources
**Technical Confidence Level:** High — multiple authoritative sources; architectural recommendations grounded in live source code inspection

_This document is the authoritative technical research reference for Kaizen item 15 (synchronous inter-plugin service API). Proceed to `/bmad-create-prd` in a fresh context window._
