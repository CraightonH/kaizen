# Service Registry Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `CapabilityRegistry` + `ServiceRegistry` into a single string-keyed `ServiceRegistry` that carries arbitrary runtime payloads, eliminating the need for plugins to import each other by bare specifier.

**Architecture:** The new `ServiceRegistry` absorbs `CapabilityRegistry`'s define/provide/consume/validate semantics and `ServiceRegistry`'s impl-storage role. Services are keyed by `<pluginName>:<symbol>` strings. Cardinality is implicitly "one" (exactly one provider per name). The plugin `ctx.*` surface gains `defineService`/`provideService`/`consumeService`/`useService` and loses the old token/capability methods. Plugin manifests rename `capabilities` → `services`. `EventBus`, permission enforcer, sandbox, consent flow, and lockfile are untouched.

**Tech Stack:** TypeScript, Bun (test runner + `bun build --compile`), JSON (manifest), ES modules.

**Spec:** `docs/superpowers/specs/2026-04-22-service-registry-merge-design.md`

**Scope boundary:** This plan covers only the `CraightonH/kaizen` core repo. The follow-up rewrite of `CraightonH/kaizen-official-plugins` is a separate PR tracked in the spec's migration plan and is **out of scope** here.

---

## File Structure

### Files to create
- `src/core/service-registry.ts` — rewritten, merged implementation (this path exists today but will be overwritten wholesale)
- `src/core/service-registry.test.ts` — rewritten (path exists today)
- `src/commands/service.ts` — renamed from `src/commands/capability.ts`
- `src/core/integration/driver-service-resolution.test.ts` — renamed from `driver-capability-resolution.test.ts`

### Files to modify
- `src/types/plugin.ts` — drop `ServiceToken`, rename `CapabilitySpec` → `ServiceSpec`, rename `PluginCapabilities` → `PluginServices`, rename `KaizenPlugin.capabilities` → `services`, rename `PluginEntry.capabilities` → `services`, update `PluginContext` method signatures
- `src/host-api.ts` — drop `ServiceToken` runtime + type exports, update `CapabilitySpec` → `ServiceSpec` type export
- `src/core/context.ts` — replace `registerService`/`getService`/`defineCapability` with `defineService`/`provideService`/`consumeService`/`useService`
- `src/core/plugin-manager.ts` — passes 1 & 3 call new API; `isCritical`/`topoSort` read `plugin.services`; internal `SecretsProviderToken` lookup becomes a string lookup; constructor uses single `ServiceRegistry`
- `src/core/secrets.ts` — replace `SecretsProviderToken = new ServiceToken(...)` with `SECRETS_PROVIDER_SERVICE = "core-secrets:provider"` string constant
- `src/core/plugin-manager.test.ts` — fixtures' `capabilities:` → `services:`, setupBody `defineCapability` → `defineService`, remove tests exercising cardinality `"many"` (behavior being removed)
- `src/core/index.ts` — update `initializePluginSystem` to construct one `ServiceRegistry` (not two registries)
- `src/core/capability-registry.ts` — **DELETE**
- `src/core/capability-registry.test.ts` — **DELETE**
- `src/commands/capability.ts` — **DELETE** (replaced by `service.ts`)
- `src/cli.ts` — route `subcommand === "service"` (not `"capability"`); update help text; rename variable
- `src/commands/plugin-create.ts` — `generateIndexTs` emits `services: { ... }` + `ctx.defineService`/`provideService`/`consumeService`; test-mock emits `capabilities` → `services`
- `src/commands/plugin-create.test.ts` (if present) — update expected output
- `tests/fixtures/ci-marketplace/plugins/cap-provider/index.mjs` — `capabilities:` → `services:`, `defineCapability` → `defineService`
- `tests/fixtures/ci-marketplace/plugins/cap-owner/index.mjs` — same
- `tests/fixtures/ci-marketplace/plugins/cap-driver/index.mjs` — same
- `tests/fixtures/ci-marketplace/plugins/cap-driver-conflict/index.mjs` — same
- `tests/fixtures/ci-marketplace/plugins/cap-dup-a/index.mjs` — same
- `tests/fixtures/ci-marketplace/plugins/cap-dup-b/index.mjs` — same
- `tests/fixtures/ci-marketplace/plugins/fixture-driver/index.mjs` — `capabilities:` → `services:`, `defineCapability` → `defineService`, remove the cardinality `"many"` `fixture-driver:ui` capability (services are cardinality-one in v1)
- `tests/fixtures/ci-marketplace/plugins/fixture-ui/index.mjs` — update provides
- `tests/fixtures/ci-marketplace/plugins/fixture-executor/index.mjs` — update provides
- `docs/concepts/plugin-model.md` — replace "capabilities" narrative with services + authoring decision table
- `docs/guides/plugin-authoring.md` — update examples
- `docs/reference/plugin-api.md` — update method signatures
- `docs/reference/host-api.md` — drop `ServiceToken` from exported-types list
- `package.json` — version `0.1.3` → `0.2.0`

---

## Task 1: Merge `CapabilityRegistry` + `ServiceRegistry`

**Rationale:** This is the atomic core change. Every file listed below references each other's types or APIs; splitting further produces intermediate states that don't compile. One task, one commit.

**Files:**
- Rewrite: `src/core/service-registry.ts`
- Rewrite: `src/core/service-registry.test.ts`
- Delete: `src/core/capability-registry.ts`, `src/core/capability-registry.test.ts`
- Modify: `src/types/plugin.ts`, `src/host-api.ts`, `src/core/context.ts`, `src/core/plugin-manager.ts`, `src/core/secrets.ts`, `src/core/index.ts`, `src/core/plugin-manager.test.ts`
- Rename + rewrite: `src/core/integration/driver-capability-resolution.test.ts` → `src/core/integration/driver-service-resolution.test.ts`
- Modify fixtures: `tests/fixtures/ci-marketplace/plugins/{cap-provider,cap-owner,cap-driver,cap-driver-conflict,cap-dup-a,cap-dup-b,fixture-driver,fixture-ui,fixture-executor}/index.mjs`

### Steps

- [ ] **Step 1.1: Write new `ServiceRegistry` implementation**

Replace the entire contents of `src/core/service-registry.ts` with:

```ts
import type { ServiceSpec } from "../types/plugin.js";
import { warn } from "./errors.js";

export interface ServiceEntry {
  name: string;
  spec: ServiceSpec;
  definedBy: string;
  providers: string[];
  consumers: string[];
}

/**
 * String-keyed registry for cross-plugin services.
 *
 * Each service has one definer (plugin declaring `defineService`), exactly
 * one provider (plugin calling `provideService`), and any number of consumers.
 * Cardinality is implicitly "one" in v1. Payloads are arbitrary JS values;
 * `use` returns the exact reference registered by `provide`.
 */
export class ServiceRegistry {
  private readonly entries = new Map<string, ServiceEntry>();
  private readonly providers = new Map<string, string>();  // name -> providerPluginName
  private readonly impls = new Map<string, unknown>();     // name -> impl
  private readonly consumers = new Map<string, Set<string>>();

  define(name: string, pluginName: string, spec: ServiceSpec): void {
    const colon = name.indexOf(":");
    if (colon < 0 || name.slice(0, colon) !== pluginName) {
      throw new Error(
        `Service '${name}' must be prefixed with plugin name '${pluginName}' ` +
        `(e.g. '${pluginName}:...').`,
      );
    }
    if (this.entries.has(name)) {
      warn(`Service '${name}' already defined. Ignoring duplicate from '${pluginName}'.`);
      return;
    }
    this.entries.set(name, {
      name, spec, definedBy: pluginName,
      providers: [], consumers: [],
    });
  }

  provide<T>(name: string, pluginName: string, impl: T): void {
    if (!this.entries.has(name)) {
      throw new Error(
        `Plugin '${pluginName}' provides undefined service '${name}'. ` +
        `The defining plugin must call defineService() first.`,
      );
    }
    if (this.providers.has(name)) {
      throw new Error(
        `Service '${name}' already has a provider ('${this.providers.get(name)}'). ` +
        `Cardinality is one — only one plugin may provide a service.`,
      );
    }
    this.providers.set(name, pluginName);
    this.impls.set(name, impl);
  }

  consume(name: string, pluginName: string): void {
    const set = this.consumers.get(name) ?? new Set<string>();
    set.add(pluginName);
    this.consumers.set(name, set);
  }

  use<T>(name: string): T {
    if (!this.impls.has(name)) {
      throw new Error(
        `Service '${name}' has no provider. Check that the provider plugin ` +
        `is loaded and listed before consumers.`,
      );
    }
    return this.impls.get(name) as T;
  }

  providersOf(name: string): string[] {
    const p = this.providers.get(name);
    return p ? [p] : [];
  }

  consumersOf(name: string): string[] {
    return Array.from(this.consumers.get(name) ?? []);
  }

  getSpec(name: string): ServiceSpec | undefined {
    return this.entries.get(name)?.spec;
  }

  list(): ServiceEntry[] {
    return Array.from(this.entries.values()).map((e) => ({
      ...e,
      providers: this.providersOf(e.name),
      consumers: this.consumersOf(e.name),
    }));
  }

  validateAll(): void {
    const referenced = new Set<string>([
      ...this.providers.keys(),
      ...this.consumers.keys(),
    ]);
    for (const name of referenced) {
      if (!this.entries.has(name)) {
        const where = this.providers.has(name) ? "provides" : "consumes";
        const plugins = where === "provides"
          ? this.providersOf(name) : this.consumersOf(name);
        throw new Error(
          `Plugin(s) [${plugins.join(", ")}] ${where} undefined service '${name}'. ` +
          `Typo or missing plugin dependency?`,
        );
      }
    }

    for (const entry of this.entries.values()) {
      const consumers = this.consumersOf(entry.name);
      if (consumers.length === 0) continue;
      const providers = this.providersOf(entry.name);
      if (providers.length === 0) {
        throw new Error(
          `No plugin provides service '${entry.name}' (consumed by: ${consumers.join(", ")}).`,
        );
      }
    }
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [name, entry] of this.entries) {
      if (entry.definedBy === pluginName) this.entries.delete(name);
    }
    for (const [name, provider] of this.providers) {
      if (provider === pluginName) {
        this.providers.delete(name);
        this.impls.delete(name);
      }
    }
    for (const [name, set] of this.consumers) {
      set.delete(pluginName);
      if (set.size === 0) this.consumers.delete(name);
    }
  }
}
```

- [ ] **Step 1.2: Replace `ServiceToken` type with `ServiceSpec` / `PluginServices` in `src/types/plugin.ts`**

Open `src/types/plugin.ts` and make the following edits:

Remove (lines 24-28):
```ts
// ServiceToken is the type of the class instance; the class itself is
// exposed to plugins through host-api.ts. Internal consumers import the
// class directly from service-registry.js.
import type { ServiceToken } from "../core/service-registry.js";
export type { ServiceToken };
```

(Delete entirely — no replacement.)

Replace the `Cardinality`/`CapabilitySpec`/`PluginCapabilities` block (lines 176-196):

```ts
// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface ServiceSpec {
  /** Optional JSON schema validated against provider payloads (informational in v1). */
  schema?: JsonSchema;
  /** Optional semver string — future-proofing; currently informational only. */
  version?: string;
  /** Human-readable; shown by `kaizen service show`. */
  description: string;
}

export interface PluginServices {
  provides?: string[];
  consumes?: string[];
}
```

(Note: `Cardinality` type is removed. No export of it anywhere else needed — search confirms no other file uses it outside what this task updates.)

Update the `PluginContext` interface (lines 202-230). Replace the `// --- Service registry ---` and `// --- Capability registry ---` blocks with:

```ts
  // --- Service registry ----------------------------------------------------

  /** Declare a service. Only valid during INITIALIZING (setup()). Name must be prefixed with the calling plugin's name. */
  defineService(name: string, spec: ServiceSpec): void;

  /** Provide an implementation for a previously-defined service. Only valid during INITIALIZING. */
  provideService<T>(name: string, impl: T): void;

  /** Declare intent to consume a service. Only valid during INITIALIZING. */
  consumeService(name: string): void;

  /** Retrieve the provided implementation. Valid only after INITIALIZING. Throws if no provider. */
  useService<T>(name: string): T;
```

Update `KaizenPlugin` (line 320):
```ts
  /** What services this plugin provides and consumes. */
  services?: PluginServices;
```
(Rename field `capabilities` → `services`.)

Update the nearby comment on line 324: `` `capabilities` `` → `` `services` ``.

Update `PluginEntry` (line 363):
```ts
  services: PluginServices;
```

- [ ] **Step 1.3: Update `src/host-api.ts` exports**

Replace the file's imports block (lines 12-16) with:
```ts
import { readStdinLine } from "./core/stdin.js";
import { createLLMRuntime } from "./core/llm.js";
import { PLUGIN_API_VERSION } from "./types/plugin.js";
```

Replace the `hostApi` object (lines 18-25) with:
```ts
/** Runtime values exposed to plugins via `import "kaizen/types"`. */
export const hostApi = {
  createLLMRuntime,
  readStdinLine,
  PLUGIN_API_VERSION,
} as const;
```

(Drop `ServiceToken` and `SecretsProviderToken` from runtime exports — both had been exposing the old token API.)

In the type-only re-exports (lines 28-68):
- Remove line: `PluginCapabilities,`
- Add line: `PluginServices,`
- Remove line: `CapabilitySpec,`
- Add line: `ServiceSpec,`
- Remove line: `Cardinality,`

- [ ] **Step 1.4: Replace `SecretsProviderToken` with string constant in `src/core/secrets.ts`**

Replace line 6 of `src/core/secrets.ts`:
```ts
// Before:
// export const SecretsProviderToken = new ServiceToken<SecretProvider>("core-secrets:provider");

// After:
export const SECRETS_PROVIDER_SERVICE = "core-secrets:provider";
```

Remove the `import { ServiceToken } from "./service-registry.js";` at top of that file.

(A downstream repo grep may show `SecretsProviderToken` imports still exist in `src/core/plugin-manager.ts` and `src/host-api.ts`. The host-api edit in Step 1.3 already removes it. The plugin-manager edit in Step 1.6 below replaces the lookup.)

- [ ] **Step 1.5: Update `src/core/context.ts`**

Replace the file's imports (lines 1-7) with:
```ts
import type { PluginContext, PluginManagerPublicApi, PluginManagerLifecycleApi, SecretsContext } from "../types/plugin.js";
import type { EventBus } from "./event-bus.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
```

Replace the `createPluginContext` signature (lines 17-28) with:
```ts
export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  secretsContext: SecretsContext,
  eventBus: EventBus,
  serviceRegistry: ServiceRegistry,
  enforcer: PermissionEnforcer,
  getState: () => CoreState,
  pluginManagerPublicApi: PluginManagerPublicApi,
  pluginManagerLifecycleApi: PluginManagerLifecycleApi,
): PluginContext {
```

(Removed `capabilityRegistry` parameter.)

Replace the service/capability block in the returned object (lines 44-56) with:
```ts
    defineService(name, spec): void {
      assertInitializing(getState(), "define services");
      serviceRegistry.define(name, pluginName, spec);
    },

    provideService<T>(name: string, impl: T): void {
      assertInitializing(getState(), "provide services");
      serviceRegistry.provide(name, pluginName, impl);
    },

    consumeService(name: string): void {
      assertInitializing(getState(), "declare service consumption");
      serviceRegistry.consume(name, pluginName);
    },

    useService<T>(name: string): T {
      return serviceRegistry.use<T>(name);
    },
```

- [ ] **Step 1.6: Update `src/core/plugin-manager.ts`**

Make these edits in order:

**a.** Replace imports at lines 14-15:
```ts
import type { ServiceRegistry } from "./service-registry.js";
```
(Remove the `CapabilityRegistry` import. Keep `ServiceRegistry`.)

**b.** Update the `SecretsProviderToken` import at line 8:
```ts
import { SecretsRegistry, createSecretsContext, SECRETS_PROVIDER_SERVICE } from "./secrets.js";
```

**c.** Update `isCritical` (lines 174-183):
```ts
function isCritical(plugin: KaizenPlugin, reg: ServiceRegistry): boolean {
  if (plugin.driver === true) return true;
  const aliases = plugin.aliases ?? {};
  for (const raw of plugin.services?.provides ?? []) {
    const cap = resolveCapName(raw, aliases);
    // A service is critical when it has any consumers — cardinality is one.
    if (reg.consumersOf(cap).length > 0) return true;
  }
  return false;
}
```

**d.** Update `topoSort` (lines 185-215ish): replace every `plugin.capabilities?.provides` / `plugin.capabilities?.consumes` with `plugin.services?.provides` / `plugin.services?.consumes`.

**e.** Update constructor signature (lines ~258-263):
Replace the two registry parameters with one:
```ts
    private readonly serviceRegistry: ServiceRegistry,
```
(Remove `capabilityRegistry` parameter. All callers must update — see Step 1.7 for `src/core/index.ts`.)

**f.** Update PASS 1 (lines 349-358):
```ts
    // PASS 1: record provide/consume metadata so isCritical + validateAll see full graph
    for (const plugin of sorted) {
      const aliases = plugin.aliases ?? {};
      for (const raw of plugin.services?.provides ?? []) {
        // define happens inside setup(); this pass only records intent. Provider
        // is resolved later when setup() calls provideService.
        // No-op here for provide (explicit provideService call inside setup does it).
      }
      for (const raw of plugin.services?.consumes ?? []) {
        this.serviceRegistry.consume(resolveCapName(raw, aliases), plugin.name);
      }
    }
```

(Note: the old `addProvider` call in PASS 1 recorded intent before `setup()` ran. The new registry requires `define` before `provide`, and both are expected to happen inside `setup()`. So the declarative `provides: [...]` array is informational/critical-check only; actual registration is via `ctx.provideService`. Update the `isCritical` helper to use `plugin.services?.provides` to compute criticality.)

Actually — reconsider: the old `addProvider` in PASS 1 was what made `isCritical` work (`reg.consumersOf(cap).length > 0` needed the consumer list populated before `setup()` ran). We need the same here for consumers. Keep the `serviceRegistry.consume(...)` call in PASS 1 so the consumer list is populated before `setupPlugin` runs. Drop the provider call (it'll happen when the plugin calls `provideService`).

**g.** Update the two `capabilities:` keys in the `PluginEntry` literals (lines 377 and 393): `capabilities: plugin.capabilities ?? {}` → `services: plugin.services ?? {}`. Same change at lines 462, 483, 499.

**h.** Update PASS 3 (line 402):
```ts
      this.serviceRegistry.validateAll();
```

**i.** Update `load(name)` (around lines 470-474) — same rename: `capabilities` → `services`, `capabilityRegistry.addProvider` → (removed, provider registers via `provideService`), `capabilityRegistry.addConsumer` → `serviceRegistry.consume`, `capabilityRegistry.validateAll` → `serviceRegistry.validateAll`.

**j.** Update `unload` (line 517-519): remove the `this.capabilityRegistry.deregisterByPlugin(name);` line (single registry now handles it).

**k.** Update the secrets lookup (lines ~637-639):
```ts
      const provider = this.serviceRegistry.use<SecretProvider>(SECRETS_PROVIDER_SERVICE);
```

If `SecretProvider` isn't already imported in this file, add:
```ts
import type { SecretProvider } from "./secret-providers/types.js";
```
(Check near the top of the existing imports — there may already be a related import group.)

**l.** Update the `createPluginContext` call site (lines ~625-627): remove `this.capabilityRegistry` argument.

**m.** Update the `provList` line (505-506): `plugin.capabilities?.provides` → `plugin.services?.provides`, and change `capability may be unavailable` → `service may be unavailable`.

- [ ] **Step 1.7: Update `src/core/index.ts`**

Find the `initializePluginSystem` function. Currently it constructs both `CapabilityRegistry` and `ServiceRegistry`. Replace to construct one:

Remove: `const capabilityRegistry = new CapabilityRegistry();`
Keep: `const serviceRegistry = new ServiceRegistry();`

Remove any `import { CapabilityRegistry }` at the top.

Update the `PluginManager` constructor call — drop the `capabilityRegistry,` argument.

Update the returned object: remove `capabilityRegistry` field. Any caller that previously destructured `capabilityRegistry` must now use `serviceRegistry`.

Update the `InitializedSystem` interface (same file) to drop `capabilityRegistry` and keep only `serviceRegistry`.

- [ ] **Step 1.8: Delete `src/core/capability-registry.ts` and its test**

```bash
rm src/core/capability-registry.ts src/core/capability-registry.test.ts
```

- [ ] **Step 1.9: Rewrite `src/core/service-registry.test.ts`**

Replace the entire file with:

```ts
import { describe, it, expect } from "bun:test";
import { ServiceRegistry } from "./service-registry.js";

describe("ServiceRegistry", () => {
  describe("define", () => {
    it("accepts a well-prefixed name", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:thing", "owner", { description: "ok" });
      expect(reg.getSpec("owner:thing")).toEqual({ description: "ok" });
    });

    it("rejects a name that doesn't start with the plugin's prefix", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.define("other:thing", "owner", { description: "x" })).toThrow(
        /must be prefixed with plugin name 'owner'/,
      );
    });

    it("rejects a name with no prefix", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.define("thing", "owner", { description: "x" })).toThrow(
        /must be prefixed with plugin name 'owner'/,
      );
    });

    it("keeps the first definition and warns on duplicate", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "first" });
      reg.define("owner:x", "owner", { description: "second" });
      expect(reg.getSpec("owner:x")).toEqual({ description: "first" });
    });
  });

  describe("provide", () => {
    it("throws when defining is missing", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.provide("owner:thing", "owner", {})).toThrow(
        /undefined service 'owner:thing'/,
      );
    });

    it("stores impl and returns it from use", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:paths", "owner", { description: "x" });
      const impl = { resolve: () => "/" };
      reg.provide("owner:paths", "owner", impl);
      expect(reg.use("owner:paths")).toBe(impl);
    });

    it("throws on a second provider (cardinality one)", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.provide("owner:x", "owner", { a: 1 });
      expect(() => reg.provide("owner:x", "other", { a: 2 })).toThrow(
        /already has a provider/,
      );
    });
  });

  describe("consume", () => {
    it("records consumer intent without requiring a provider", () => {
      const reg = new ServiceRegistry();
      reg.consume("owner:thing", "consumer");
      expect(reg.consumersOf("owner:thing")).toEqual(["consumer"]);
    });

    it("deduplicates when the same plugin consumes twice", () => {
      const reg = new ServiceRegistry();
      reg.consume("owner:thing", "consumer");
      reg.consume("owner:thing", "consumer");
      expect(reg.consumersOf("owner:thing")).toEqual(["consumer"]);
    });
  });

  describe("use", () => {
    it("throws when no provider has registered", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.use("owner:missing")).toThrow(/has no provider/);
    });

    it("returns the exact reference registered by provide", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:thing", "owner", { description: "x" });
      const obj = { id: Symbol() };
      reg.provide("owner:thing", "owner", obj);
      expect(reg.use("owner:thing")).toBe(obj);
    });
  });

  describe("validateAll", () => {
    it("fatal when a consumed service is undefined", () => {
      const reg = new ServiceRegistry();
      reg.consume("missing:x", "consumer");
      expect(() => reg.validateAll()).toThrow(/undefined service 'missing:x'/);
    });

    it("fatal when a defined service has consumers but no provider", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.consume("owner:x", "consumer");
      expect(() => reg.validateAll()).toThrow(/No plugin provides service 'owner:x'/);
    });

    it("passes when defined, provided, and consumed correctly", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.provide("owner:x", "owner", {});
      reg.consume("owner:x", "consumer");
      expect(() => reg.validateAll()).not.toThrow();
    });

    it("passes when defined but unused (no consumers, no provider)", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      expect(() => reg.validateAll()).not.toThrow();
    });
  });

  describe("deregisterByPlugin", () => {
    it("removes definitions owned by that plugin", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.deregisterByPlugin("owner");
      expect(reg.getSpec("owner:x")).toBeUndefined();
    });

    it("removes provider + impl owned by that plugin", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.provide("owner:x", "owner", { a: 1 });
      reg.deregisterByPlugin("owner");
      expect(reg.providersOf("owner:x")).toEqual([]);
      expect(() => reg.use("owner:x")).toThrow();
    });

    it("removes the plugin from consumer lists", () => {
      const reg = new ServiceRegistry();
      reg.consume("owner:x", "consumer-a");
      reg.consume("owner:x", "consumer-b");
      reg.deregisterByPlugin("consumer-a");
      expect(reg.consumersOf("owner:x")).toEqual(["consumer-b"]);
    });

    it("leaves unrelated entries intact", () => {
      const reg = new ServiceRegistry();
      reg.define("a:x", "a", { description: "" });
      reg.define("b:y", "b", { description: "" });
      reg.deregisterByPlugin("a");
      expect(reg.getSpec("a:x")).toBeUndefined();
      expect(reg.getSpec("b:y")).toBeDefined();
    });
  });

  describe("list", () => {
    it("returns entries with populated provider/consumer arrays", () => {
      const reg = new ServiceRegistry();
      reg.define("a:x", "a", { description: "test" });
      reg.provide("a:x", "a", {});
      reg.consume("a:x", "b");
      const entries = reg.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.definedBy).toBe("a");
      expect(entries[0]!.providers).toEqual(["a"]);
      expect(entries[0]!.consumers).toEqual(["b"]);
    });
  });
});
```

- [ ] **Step 1.10: Update fixture plugins in `tests/fixtures/ci-marketplace/plugins/`**

For each file below, rewrite the contents:

`cap-provider/index.mjs`:
```js
export default {
  name: "cap-provider",
  apiVersion: "2",
  services: { provides: ["cap-provider:thing"] },
  async setup(ctx) {
    ctx.defineService("cap-provider:thing", { description: "test" });
    ctx.provideService("cap-provider:thing", { ok: true });
  },
};
```

`cap-owner/index.mjs`:
```js
export default {
  name: "cap-owner",
  apiVersion: "2",
  async setup(ctx) {
    ctx.defineService("cap-owner:thing", { description: "test" });
  },
};
```

`cap-driver/index.mjs`:
```js
export default {
  name: "cap-driver",
  apiVersion: "2",
  services: { consumes: ["cap-provider:thing"] },
  async setup(ctx) {
    ctx.consumeService("cap-provider:thing");
  },
};
```

`cap-driver-conflict/index.mjs`:
```js
export default {
  name: "cap-driver-conflict",
  apiVersion: "2",
  services: { consumes: ["cap-owner:thing"] },
  async setup(ctx) {
    ctx.consumeService("cap-owner:thing");
  },
};
```

`cap-dup-a/index.mjs`:
```js
export default {
  name: "cap-dup-a",
  apiVersion: "2",
  services: { provides: ["cap-owner:thing"] },
  async setup(ctx) {
    ctx.provideService("cap-owner:thing", { from: "a" });
  },
};
```

`cap-dup-b/index.mjs`:
```js
export default {
  name: "cap-dup-b",
  apiVersion: "2",
  services: { provides: ["cap-owner:thing"] },
  async setup(ctx) {
    ctx.provideService("cap-owner:thing", { from: "b" });
  },
};
```

`fixture-driver/index.mjs`:
```js
// Minimal driver-like fixture: owns a service, drives a session.
export default {
  name: "fixture-driver",
  apiVersion: "2",
  driver: true,
  services: {
    provides: ["fixture-driver:executor.send"],
  },
  async setup(ctx) {
    ctx.defineService("fixture-driver:executor.send", { description: "LLM executor" });
    // Real executor provider registers below via fixture-executor.
  },
  async start(ctx) {
    const exec = ctx.useService("fixture-driver:executor.send");
    // no-op for fixture purposes
  },
};
```

(Note: removed the `fixture-driver:ui` cardinality-many definition — cardinality-many is removed from v1.)

`fixture-ui/index.mjs`:
```js
export default {
  name: "fixture-ui",
  apiVersion: "2",
  async setup(_ctx) {
    // UI fixture previously provided cardinality-many fixture-driver:ui.
    // In v1 services are cardinality-one; UI coordination moves to events
    // (out of scope for this fixture). Left as a minimal passive plugin.
  },
};
```

`fixture-executor/index.mjs`:
```js
export default {
  name: "fixture-executor",
  apiVersion: "2",
  services: { provides: ["fixture-driver:executor.send"] },
  async setup(ctx) {
    ctx.provideService("fixture-driver:executor.send", {
      send: async () => ({ content: "ok" }),
    });
  },
};
```

- [ ] **Step 1.11: Rewrite `src/core/plugin-manager.test.ts` fixtures**

Open `src/core/plugin-manager.test.ts`. Make these edits:

1. Line 77: the fixture type declaration:
```ts
  services?: { provides?: string[]; consumes?: string[] };
```

2. Line 97: the fixture-generator:
```ts
  if (spec.services) parts.push(`  services: ${JSON.stringify(spec.services)},`);
```

3. Line 295: same rename:
```ts
      "  services: { provides: [] },",
```

4. All `capabilities: { ... }` in `writePlugin({ ... capabilities: ... })` calls (lines 367, 372, 387, 390-392, 406, 409, 424, 429, 449, 455, 475): rename key to `services`.

5. All `setupBody: \`ctx.defineCapability(...)\`` (lines 368, 388, 407, 425, 430, 450, 476): rewrite to use the new API. Example transformation for line 368:
```ts
   setupBody: `ctx.defineService("owner:thing", { description: "t" });`,
```
(Drop `cardinality: "one"` — implicit in v1.)

6. Cardinality-many tests to **delete** outright (their premise — zero or multiple providers under the same name — is no longer legal under cardinality-one):
   - Test block containing lines ~406-409 (a-b cycle of provides with `cardinality: "many"`, or similar — any test using `cardinality: "many"`).
   - Test block containing lines ~424-430 (two-plugin cycle with `cardinality: "many"`).
   - Test block containing lines ~449-450 (the `cardinality: "many"` UI provider test).

   Tests to **keep but update** (rewrite defineCapability → defineService, drop cardinality key):
   - The test at lines 367-372 (provide+consume, one provider) — rewrite, keeps same behavior.
   - The test at lines 387-392 (two providers of same name rejected) — the new behavior is "`provideService` throws on second registration," so this test asserts the same outcome via a different mechanism. Update it to expect the error from the registry's `provide` call (or from PluginManager's topo-sort).
   - The test at lines 475-476 (prefix mismatch) — still valid; rewrite with `defineService`.

   After the rewrite, grep the test file for `cardinality` to confirm zero matches.

- [ ] **Step 1.12: Rename and rewrite the integration test**

```bash
git mv src/core/integration/driver-capability-resolution.test.ts src/core/integration/driver-service-resolution.test.ts
```

Open the renamed file and make these edits:

1. Remove import `import { CapabilityRegistry } from "../capability-registry.js";`.
2. Remove `const capabilityRegistry = new CapabilityRegistry();` from `makeHarness`.
3. Remove the `capabilityRegistry,` arg passed to `new PluginManager(...)` — now only one registry arg (serviceRegistry).
4. Remove the `capabilityRegistry` field from the returned object.
5. Rename the top-level `describe("driver capability resolution (post-registry-refactor)", ...)` to `describe("driver service resolution", ...)`.
6. In every `it(...)` body that asserts via `capabilityRegistry`, switch to `serviceRegistry`.
7. Remove any test whose premise is cardinality `"many"` (search for the string `"many"` in the file — delete or rewrite the containing test).

- [ ] **Step 1.13: Run the full test suite**

Run: `bun test`

Expected: all tests pass. No `CapabilityRegistry`, `ServiceToken`, or `defineCapability` references remain anywhere in source. The count will drop from the current 358 because cardinality-many tests are removed — acceptable.

If something fails, it's almost certainly a missed rename. Run this grep across all source:

```bash
grep -rn "capabilityRegistry\|CapabilityRegistry\|defineCapability\|registerService\|getService\|ServiceToken\|capabilities:" src/ tests/fixtures/ci-marketplace/
```

Should return zero matches. Notable files that might harbor stragglers:
- `src/commands/manage.ts` (reads `plugin.capabilities` when printing plugin list) — update to `plugin.services`.
- `src/core/secrets.ts` — confirm `ServiceToken` import is gone.
- `src/host-api.ts` — confirm `ServiceToken` and `SecretsProviderToken` are removed from the runtime exports.

Docs under `docs/` are updated in Task 4, not this task — exclude them from the grep.

- [ ] **Step 1.14: Commit Task 1**

```bash
git add -A
git commit -m "refactor: merge CapabilityRegistry and ServiceRegistry into a single string-keyed ServiceRegistry

- New ServiceRegistry: string-keyed, define/provide/consume/use, cardinality one
- Delete CapabilityRegistry + token-based ServiceRegistry
- Drop ServiceToken type/class; replace SecretsProviderToken with string 'core-secrets:provider'
- Rename PluginCapabilities → PluginServices, CapabilitySpec → ServiceSpec
- Rename KaizenPlugin.capabilities → services, PluginEntry.capabilities → services
- New ctx methods: defineService / provideService / consumeService / useService
- Update all core wiring (context, plugin-manager, secrets, index)
- Update fixtures and tests
- Remove cardinality-many tests (behavior removed in v1)

Spec: docs/superpowers/specs/2026-04-22-service-registry-merge-design.md"
```

---

## Task 2: Rename `kaizen capability` CLI subcommand to `kaizen service`

**Files:**
- Rename: `src/commands/capability.ts` → `src/commands/service.ts`
- Modify: `src/cli.ts`

### Steps

- [ ] **Step 2.1: Rename the command file**

```bash
git mv src/commands/capability.ts src/commands/service.ts
```

- [ ] **Step 2.2: Update the renamed file's contents**

Replace `src/commands/service.ts` with:

```ts
import type { ServiceRegistry } from "../core/service-registry.js";

export function serviceList(reg: ServiceRegistry): void {
  const entries = reg.list().sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    console.log("No services defined.");
    return;
  }
  for (const e of entries) {
    console.log(`${e.name}  — ${e.spec.description}`);
    console.log(`    defined by: ${e.definedBy}`);
    console.log(`    provider:   ${e.providers[0] ?? "(none)"}`);
    console.log(`    consumers:  ${e.consumers.join(", ") || "(none)"}`);
  }
}

export function serviceShow(reg: ServiceRegistry, name: string): void {
  const entry = reg.list().find((e) => e.name === name);
  if (!entry) {
    console.error(`Service '${name}' not defined.`);
    process.exit(1);
  }
  console.log(`Name:        ${entry.name}`);
  console.log(`Defined by:  ${entry.definedBy}`);
  console.log(`Description: ${entry.spec.description}`);
  if (entry.spec.version) console.log(`Version:     ${entry.spec.version}`);
  console.log(`Provider:    ${entry.providers[0] ?? "(none)"}`);
  console.log(`Consumers:   ${entry.consumers.join(", ") || "(none)"}`);
  if (entry.spec.schema) {
    console.log("Schema:");
    console.log(JSON.stringify(entry.spec.schema, null, 2));
  }
}
```

- [ ] **Step 2.3: Update `src/cli.ts` routing**

In `src/cli.ts`, find the block starting `if (subcommand === "capability") { ... }` (around line 412 in pre-merge state; line number may drift). Replace the entire block with:

```ts
if (subcommand === "service") {
  const sub = rawArgs[1];
  const { serviceList, serviceShow } = await import("./commands/service.js");
  const { initializePluginSystem } = await import("./core/index.js");
  const harnessJsonPath = resolveHarnessJsonPath({});
  const lockfilePath = deriveLockfilePath(harnessJsonPath);
  const cfg = resolveConfig({});
  const { serviceRegistry } = await initializePluginSystem(cfg, { lockfilePath });
  if (sub === "list") {
    serviceList(serviceRegistry);
  } else if (sub === "show") {
    const name = rawArgs[2];
    if (!name) {
      console.error("Usage: kaizen service show <name>");
      process.exit(1);
    }
    serviceShow(serviceRegistry, name);
  } else {
    console.error("Usage: kaizen service list|show <name>");
    process.exit(1);
  }
  process.exit(0);
}
```

(The `initializePluginSystem` signature was updated in Step 1.7 — it now returns `serviceRegistry` instead of `capabilityRegistry`.)

- [ ] **Step 2.4: Update the top-level `--help` text**

In the same file, find the help-text block (the big template literal printed for `--help` / `-h` / `help`). Locate the line:
```
  capability {list|show <name>}
```

Replace with:
```
  service {list|show <name>}
```

- [ ] **Step 2.5: Run tests and a smoke check**

```bash
bun test
```

Expected: all tests still pass (no new tests added in this task; command tests are exercised via CLI integration).

Manual smoke:
```bash
bun build --compile --target=bun-darwin-arm64 ./src/cli.ts --outfile /tmp/kaizen-local
/tmp/kaizen-local service list   # expect "No services defined." or error about no active harness
/tmp/kaizen-local --help | grep service   # expect the new line
```

- [ ] **Step 2.6: Commit Task 2**

```bash
git add -A
git commit -m "refactor: rename 'kaizen capability' CLI subcommand to 'kaizen service'

Matches the registry rename in Task 1. No compat alias (pre-1.0)."
```

---

## Task 3: Update plugin scaffolder templates

**Files:**
- Modify: `src/commands/plugin-create.ts`
- Possibly: `src/commands/plugin-create.test.ts` (if present)

### Steps

- [ ] **Step 3.1: Update `generateIndexTs` in `src/commands/plugin-create.ts`**

In `src/commands/plugin-create.ts`, locate `generateIndexTs` (around line 60). Make these edits:

**a.** The comment at line 80 `// Build capabilities block` → `// Build services block`.

**b.** Line 146 `` `  capabilities: {`, `` → `` `  services: {`, ``.

**c.** After the `services` block closes, add a comment block in the generated output that guides authors on the new API. Change the end of the lines array (around line 155-163) to:
```ts
  lines.push(
    ``,
    `  async setup(ctx) {`,
    ...setupLines,
    `  },`,
    `};`,
    ``,
    `export default plugin;`,
    ``
  );
```
(No code change here — keep as-is — but the `setupLines` construction should also be updated if it references old API. Grep the function body for `defineCapability`, `registerService`; if any are emitted to generated setup, update them.)

Looking at the current source (lines 130-135), `setupLines` only does log + secrets; no capability/service calls are emitted. So no change needed there. But if a scaffolded plugin declares provides/consumes, the scaffolded `setup()` should demonstrate the new API. Extend `setupLines` construction:

Replace lines 129-135 (`Build setup body`) with:
```ts
  // Build setup body
  const setupLines: string[] = [];
  if (secretKeys.length > 0) {
    const first = secretKeys[0]!;
    setupLines.push(`    const ${first.name} = await ctx.secrets.get("${first.name}");`);
  }
  for (const svc of cfg.provides) {
    setupLines.push(`    ctx.defineService("${svc}", { description: "TODO" });`);
    setupLines.push(`    ctx.provideService("${svc}", { /* TODO: implementation */ });`);
  }
  for (const svc of consumesArr) {
    setupLines.push(`    ctx.consumeService("${svc}");`);
  }
  setupLines.push("    ctx.log(`" + cfg.name + " setup complete`);");
```

**d.** Update the test-mock in `generateIndexTestTs` (line 213):
Replace `` `    capabilities: { register: mock(() => {}) },` `` with:
```ts
    `    defineService: mock(() => {}),`,
    `    provideService: mock(() => {}),`,
    `    consumeService: mock(() => {}),`,
    `    useService: mock(() => undefined),`,
```

(Emit four lines instead of one.)

- [ ] **Step 3.2: Update `plugin-create.test.ts` (if it exists) to match new expected output**

```bash
ls src/commands/plugin-create.test.ts 2>/dev/null && echo exists
```

If exists, find any expected-output string literals that include `capabilities:` or `defineCapability` and update them to the new API. Run `bun test src/commands/plugin-create.test.ts` to confirm.

If it doesn't exist, skip.

- [ ] **Step 3.3: Manually scaffold a test plugin**

```bash
bun src/cli.ts plugin create /tmp/scaffold-test --defaults
cat /tmp/scaffold-test/index.ts
grep -E "services|defineService|provideService|consumeService" /tmp/scaffold-test/index.ts
```

Expected: `services:` block appears; setup body shows the new API calls if provides/consumes were declared.

Clean up: `rm -rf /tmp/scaffold-test`.

- [ ] **Step 3.4: Run tests**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 3.5: Commit Task 3**

```bash
git add -A
git commit -m "feat: scaffolder emits new service API (defineService / provideService / consumeService)

Matches the registry rename in Task 1. Generated index.ts uses ctx.defineService
et al. instead of defineCapability/registerService. Generated test mocks match
the new ctx surface."
```

---

## Task 4: Documentation updates

**Files:**
- Modify: `docs/concepts/plugin-model.md`
- Modify: `docs/guides/plugin-authoring.md`
- Modify: `docs/reference/plugin-api.md`
- Modify: `docs/reference/host-api.md`

### Steps

- [ ] **Step 4.1: Update `docs/concepts/plugin-model.md`**

Read the current file first:
```bash
cat docs/concepts/plugin-model.md
```

Apply the following changes:

- Every occurrence of "capability" / "Capability" → "service" / "Service" (when referring to the registry concept, not the English word).
- Every occurrence of `defineCapability` → `defineService`.
- Every occurrence of `registerService` → `provideService`.
- Every occurrence of `getService` → `useService`.
- Every occurrence of `ctx.capabilities` / `plugin.capabilities` → `plugin.services`.
- Remove any mention of `ServiceToken` / `Cardinality` / `cardinality: "one"` / `cardinality: "many"` — these concepts no longer exist. Where a paragraph referenced them, either delete the paragraph or restate in new-model terms (single provider per service name, fan-out goes via EventBus).
- Add an "Authoring decision matrix" section near the top with the four-way table from the spec:

```md
## When to use what

| If you need… | Use | Permission |
|---|---|---|
| A type, class, constant, or helper the platform itself provides | `import from "kaizen/types"` (host API) | n/a — platform surface |
| A type, class, or constant from another plugin's public contract | `import type { X } from "<marketplace>/<plugin>/public"` — types only, erased at build | n/a — no runtime coupling |
| Another plugin to do work and return a result | `ctx.provideService("name", impl)` / `ctx.useService<T>("name")` | None. Risk lives with the provider |
| To announce that something happened and let others react | `ctx.defineEvent("name")` / `ctx.emit(...)` / `ctx.on("other:name", handler)` | Subscribing requires `events.subscribe` grant |
```

- [ ] **Step 4.2: Update `docs/guides/plugin-authoring.md`**

Apply the same renames as Step 4.1. Additionally:

- Where the guide shows example plugin code, rewrite to use the new API:

  - `ctx.defineCapability("owner:x", { cardinality: "one", description: "..." })` → `ctx.defineService("owner:x", { description: "..." })`
  - `ctx.registerService(Token, impl)` → `ctx.provideService("owner:x", impl)`
  - `ctx.getService(Token)` → `ctx.useService<T>("owner:x")`
  - Any `import { Token } from "other-plugin"` pattern → `import type { T } from "other-marketplace/other-plugin/public"` + runtime via `useService`.

- Add a short subsection "Publishing types" describing the `public.d.ts` pattern from the spec.

- Add a subsection "Consumer TypeScript setup" with the `tsconfig.json` `paths` example from the spec.

- [ ] **Step 4.3: Update `docs/reference/plugin-api.md`**

Apply renames. Specifically:

- Replace `ServiceToken<T>` section entirely — removed.
- Replace `CapabilitySpec` with `ServiceSpec` (and remove the `cardinality` field from its documented shape).
- Replace `PluginCapabilities` with `PluginServices`.
- Replace the `ctx.registerService`, `ctx.getService`, `ctx.defineCapability` method sections with:
  - `ctx.defineService(name, spec)`
  - `ctx.provideService<T>(name, impl)`
  - `ctx.consumeService(name)`
  - `ctx.useService<T>(name): T`
  - Each with TypeScript signature, state gating, and one-sentence description.
- In `KaizenPlugin` interface docs, rename `capabilities` → `services`.

- [ ] **Step 4.4: Update `docs/reference/host-api.md`**

- Remove `ServiceToken` from the list of exported runtime values.
- Remove `SecretsProviderToken` from the same list (it was exposed alongside).
- Remove `Cardinality` from exported types.
- Replace `CapabilitySpec` with `ServiceSpec` in the type-exports list.
- Replace `PluginCapabilities` with `PluginServices`.

- [ ] **Step 4.5: Verify docs build cleanly**

If the project has a docs build/linter:
```bash
ls scripts/build-docs.sh scripts/lint-docs.sh 2>/dev/null
```
If nothing exists, skip. Otherwise run it and fix any warnings.

Grep for any remaining stale references:
```bash
grep -rn "defineCapability\|registerService\|getService\|ServiceToken\|PluginCapabilities\|CapabilitySpec\|Cardinality" docs/
```
Expected: zero matches in the four updated files (historical archive under `docs/superpowers/archive/` may still contain them — leave those alone, they're snapshots).

- [ ] **Step 4.6: Commit Task 4**

```bash
git add docs/
git commit -m "docs: update plugin-model, authoring, plugin-api, host-api for service registry merge

Reflects the registry rename from Task 1. Adds authoring decision matrix
(host API vs service vs event vs type-only import). Documents the public.d.ts
pattern and tsconfig 'paths' setup for type-only consumer imports."
```

---

## Task 5: Version bump and release preparation

**Files:**
- Modify: `package.json`

### Steps

- [ ] **Step 5.1: Bump version in `package.json`**

Change:
```json
"version": "0.1.3",
```
to:
```json
"version": "0.2.0",
```

- [ ] **Step 5.2: Run the full test suite one more time**

```bash
bun test
```

Expected: all pass.

- [ ] **Step 5.3: Build a binary and smoke-test**

```bash
bun build --compile --target=bun-darwin-arm64 ./src/cli.ts --outfile /tmp/kaizen-local
echo "--- service list (no harness) ---"
/tmp/kaizen-local service list 2>&1 | head -3
echo "--- --help ---"
/tmp/kaizen-local --help 2>&1 | head -12
echo "--- install (harness-ref) ---"
/tmp/kaizen-local install official/core-shell@1.0.0 --non-interactive 2>&1 | head -5
```

Expected:
- `service list` either prints "No services defined." (if a harness is active) or the clean harness-required error (`error: this command requires an active harness...`). Not a raw stack trace.
- `--help` prints the usage block with `service {list|show <name>}` (not `capability`).
- Harness install succeeds if network + marketplace are set up; otherwise shows a clean error.

Clean up: `rm /tmp/kaizen-local`.

- [ ] **Step 5.4: Commit version bump**

```bash
git add package.json
git commit -m "chore: bump to v0.2.0 for service registry merge

Breaking change: plugin manifest field 'capabilities' → 'services',
ServiceToken removed, new ctx.defineService/provideService/consumeService/
useService replace old API. See docs/superpowers/specs/2026-04-22-service-registry-merge-design.md."
```

---

## Task 6: Open PR

- [ ] **Step 6.1: Push branch and create PR**

```bash
git push -u origin design/service-registry-merge
gh pr create --title "refactor: merge CapabilityRegistry + ServiceRegistry (v0.2.0)" --body "$(cat <<'EOF'
## Summary

Collapses CapabilityRegistry and ServiceRegistry into one string-keyed ServiceRegistry that carries arbitrary runtime payloads. Eliminates the plugin-to-plugin bare-import requirement by making the registry the universal carrier for shared runtime values; types flow through static \`import type\` against a plugin-shipped \`public.d.ts\`.

Preserves permission model, consent flow, lockfile, and EventBus unchanged. Hard cutover at v0.2.0.

**Spec:** \`docs/superpowers/specs/2026-04-22-service-registry-merge-design.md\`

## Breaking changes

- Plugin manifest field \`capabilities\` → \`services\`.
- \`ServiceToken\` class removed; replaced by string names.
- \`ctx.registerService\` / \`getService\` / \`defineCapability\` → \`ctx.defineService\` / \`provideService\` / \`consumeService\` / \`useService\`.
- \`kaizen capability list|show\` CLI → \`kaizen service list|show\` (no compat alias — pre-1.0).
- Cardinality \`"many"\` removed (services are cardinality-one in v1; fan-out goes through EventBus).
- \`SecretsProviderToken\` export removed (was a \`ServiceToken\` instance); internal lookup now uses the string \`"core-secrets:provider"\`.

## Follow-up

The \`CraightonH/kaizen-official-plugins\` repo requires a matching rewrite before users can \`kaizen install\` against v0.2.0. That's a separate PR against that repo, tracked in the spec's migration plan.

## Test plan

- [x] Unit tests for new ServiceRegistry (define/provide/consume/use/validateAll/deregister)
- [x] Plugin-manager integration tests updated to new API
- [x] CI fixtures migrated to new API
- [x] \`bun test\` green
- [x] Binary builds; \`kaizen --help\` / \`kaizen service list\` / \`kaizen install official/core-shell@1.0.0\` all exit with clean errors or correct output
EOF
)"
```

- [ ] **Step 6.2: Wait for CI, then merge**

```bash
gh pr checks --watch
```

Once green, merge via the GitHub UI or `gh pr merge --squash --delete-branch`.

- [ ] **Step 6.3: Tag and push v0.2.0**

```bash
git checkout master
git pull
git tag -a v0.2.0 -m "v0.2.0: service registry merge

Breaking: plugin manifest 'capabilities' → 'services';
ServiceToken removed; new ctx API (defineService/provideService/consumeService/useService);
CLI 'capability' → 'service'.

Requires kaizen-official-plugins rewrite (see spec)."
git push origin v0.2.0
```

Release workflow auto-publishes to GitHub Releases.
