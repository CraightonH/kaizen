# Capability Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `provides`/`depends` role system with an owner-qualified capability registry, enabling multi-provider UI and executor capabilities while keeping `lifecycle.drive` singleton. Resolves adversarial-review finding 1.

**Architecture:** New `CapabilityRegistry` core module tracks capability definitions (with cardinality and schema) plus per-capability provider/consumer sets. `KaizenPlugin` gains a `capabilities: { provides, consumes }` field and an `aliases` field; `provides`/`depends` are removed. Topological sort consumes the capability graph. Existing `UiRegistry` and `ExecutorRegistry` are generalized to hold multiple providers. Lifecycle races input across all registered UI providers. A migration doc ships for the one external plugin author.

**Tech Stack:** TypeScript, Bun, ajv (schema validation, already a dependency).

**Scope note — divergence from spec:** The spec proposed a new `registerInputSource()` primitive; actual code already models UI as `UiProvider` with `accept(): AsyncIterable<UiChannel>`. This plan keeps `registerUi` but changes its cardinality from singleton to many and makes the lifecycle race `accept()` iterators across all registered providers. No new primitive required.

---

## File Structure

**New files:**
- `src/core/capability-registry.ts` — registry class, cardinality + schema enforcement
- `src/core/capability-registry.test.ts` — unit tests
- `src/commands/capability.ts` — `kaizen capability list/show` CLI handlers
- `docs/plugin-migration-capability-registry.md` — migration guide for plugin authors

**Modified files:**
- `src/types/plugin.ts` — `KaizenPlugin` interface: add `capabilities`, `aliases`, `CapabilitySpec`; remove `provides`, `depends`
- `src/core/context.ts` — add `defineCapability` to `PluginContext`
- `src/core/plugin-manager.ts` — replace role validation + topo sort with capability-based versions
- `src/core/ui-registry.ts` — multi-provider semantics
- `src/core/executor-registry.ts` — multi-provider semantics (first-registered wins, documented)
- `src/core/index.ts` — export `CapabilityRegistry`, wire into bootstrap
- `src/cli.ts` — add `capability` subcommand
- `plugins/core-lifecycle/**` — define foundational capabilities, consume input from all UI providers, migrate manifest
- `plugins/core-ui-terminal/**` — migrate manifest
- `plugins/core-executor-anthropic/**` — migrate manifest
- `plugins/core-executor-openai/**` — migrate manifest
- `plugins/core-executor-debug/**` — migrate manifest
- `plugins/core-executor-shell/**` — migrate manifest
- `plugins/core-cli/**` — migrate manifest
- `plugins/core-events/**` — migrate manifest
- `plugins/core-plugin-manager/**` — migrate manifest
- `plugins/kaizen-plugin-timestamps/**` — migrate manifest

---

## Phase 1 — Capability Registry Core

### Task 1: Define capability types

**Files:**
- Modify: `src/types/plugin.ts`

- [ ] **Step 1: Add capability-related types to `src/types/plugin.ts`**

Append to `src/types/plugin.ts` (before the `KaizenPlugin` interface):

```typescript
// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type Cardinality = "one" | "many";

export interface CapabilitySpec {
  /** "one": exactly one provider required when consumed. "many": any count, including zero. */
  cardinality: Cardinality;
  /** Optional JSON schema validated against provider registrations. */
  schema?: JsonSchema;
  /** Optional semver string — future-proofing; currently informational only. */
  version?: string;
  /** Human-readable; shown by `kaizen capability show`. */
  description: string;
}

export interface PluginCapabilities {
  provides?: string[];
  consumes?: string[];
}
```

- [ ] **Step 2: Replace `provides`/`depends` on `KaizenPlugin`**

In `src/types/plugin.ts`, replace the `KaizenPlugin` interface:

```typescript
export interface KaizenPlugin {
  /** kebab-case. Must match the config namespace key in kaizen.json. */
  name: string;

  /** semver. Core warns if major != PLUGIN_API_VERSION. */
  apiVersion: string;

  /** What this plugin provides and consumes in the capability registry. */
  capabilities?: PluginCapabilities;

  /**
   * Map short or alternative capability names to canonical owner-qualified names.
   * Resolved when reading the `capabilities` lists above.
   * e.g. { "ui.input": "core-lifecycle:ui.input" }
   */
  aliases?: Record<string, string>;

  setup(ctx: PluginContext): Promise<void>;
  start?(ctx: PluginContext): Promise<void>;
}
```

Also remove `provides: string[]` from `PluginEntry` and replace with `capabilities: PluginCapabilities`:

```typescript
export interface PluginEntry {
  name: string;
  apiVersion: string;
  capabilities: PluginCapabilities;
  status: "loaded" | "unloaded" | "failed";
}
```

- [ ] **Step 3: Bump `PLUGIN_API_VERSION` to `"2"`**

In `src/types/plugin.ts`:

```typescript
export const PLUGIN_API_VERSION = "2";
```

This is a breaking manifest change; major bump is correct.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`

Expected: many errors — built-in plugins and plugin-manager reference removed fields. Do NOT fix yet; these are addressed in later tasks. Record the error count and move on. This step just establishes the baseline.

- [ ] **Step 5: Commit**

```bash
git add src/types/plugin.ts
git commit -m "feat(types): add capability types to plugin API; bump API version to 2"
```

### Task 2: CapabilityRegistry class (tests first)

**Files:**
- Create: `src/core/capability-registry.ts`
- Test: `src/core/capability-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/capability-registry.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { CapabilityRegistry } from "./capability-registry.js";

describe("CapabilityRegistry", () => {
  test("define + getSpec round-trips", () => {
    const r = new CapabilityRegistry();
    r.define("core-lifecycle:ui.input", "core-lifecycle", {
      cardinality: "many", description: "User input source"
    });
    const spec = r.getSpec("core-lifecycle:ui.input");
    expect(spec?.cardinality).toBe("many");
    expect(spec?.description).toBe("User input source");
  });

  test("owner prefix must match defining plugin", () => {
    const r = new CapabilityRegistry();
    expect(() => r.define("foo:bar", "not-foo", {
      cardinality: "one", description: ""
    })).toThrow(/must be prefixed with plugin name 'not-foo'/);
  });

  test("duplicate define logs and ignores second", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "first" });
    r.define("p:x", "p", { cardinality: "many", description: "second" });
    expect(r.getSpec("p:x")?.description).toBe("first");
  });

  test("provider + consumer tracking", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "many", description: "" });
    r.addProvider("p:x", "a");
    r.addProvider("p:x", "b");
    r.addConsumer("p:x", "c");
    expect(r.providersOf("p:x")).toEqual(["a", "b"]);
    expect(r.consumersOf("p:x")).toEqual(["c"]);
  });

  test("validateCardinality one: exactly one ok", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "" });
    r.addProvider("p:x", "a");
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).not.toThrow();
  });

  test("validateCardinality one: zero providers throws if consumed", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "" });
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).toThrow(/No plugin provides/);
  });

  test("validateCardinality one: two providers throws", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "" });
    r.addProvider("p:x", "a");
    r.addProvider("p:x", "b");
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).toThrow(/Multiple plugins provide/);
  });

  test("validateCardinality many: zero/one/two all ok", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "many", description: "" });
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).not.toThrow();
    r.addProvider("p:x", "a");
    expect(() => r.validateAll()).not.toThrow();
    r.addProvider("p:x", "b");
    expect(() => r.validateAll()).not.toThrow();
  });

  test("validateAll: undefined capability in consumer throws", () => {
    const r = new CapabilityRegistry();
    r.addConsumer("p:undefined", "c");
    expect(() => r.validateAll()).toThrow(/undefined capability 'p:undefined'/);
  });

  test("validateAll: undefined capability in provider throws", () => {
    const r = new CapabilityRegistry();
    r.addProvider("p:undefined", "a");
    expect(() => r.validateAll()).toThrow(/undefined capability 'p:undefined'/);
  });

  test("resolveName: canonical passes through", () => {
    const r = new CapabilityRegistry();
    expect(r.resolveName("core-lifecycle:ui.input", {})).toBe("core-lifecycle:ui.input");
  });

  test("resolveName: alias resolves", () => {
    const r = new CapabilityRegistry();
    const aliases = { "ui.input": "core-lifecycle:ui.input" };
    expect(r.resolveName("ui.input", aliases)).toBe("core-lifecycle:ui.input");
  });

  test("list: returns all defined capabilities", () => {
    const r = new CapabilityRegistry();
    r.define("a:x", "a", { cardinality: "one", description: "X" });
    r.define("b:y", "b", { cardinality: "many", description: "Y" });
    const names = r.list().map((c) => c.name).sort();
    expect(names).toEqual(["a:x", "b:y"]);
  });

  test("deregisterByPlugin removes defines/providers/consumers", () => {
    const r = new CapabilityRegistry();
    r.define("a:x", "a", { cardinality: "many", description: "" });
    r.addProvider("a:x", "a");
    r.addConsumer("a:x", "b");
    r.deregisterByPlugin("a");
    expect(r.getSpec("a:x")).toBeUndefined();
    expect(r.providersOf("a:x")).toEqual([]);
    r.deregisterByPlugin("b");
    expect(r.consumersOf("a:x")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `bun test src/core/capability-registry.test.ts`

Expected: all tests fail — module does not exist.

- [ ] **Step 3: Implement `CapabilityRegistry`**

Create `src/core/capability-registry.ts`:

```typescript
import type { CapabilitySpec } from "../types/plugin.js";
import { warn } from "./errors.js";

export interface CapabilityEntry {
  name: string;
  spec: CapabilitySpec;
  definedBy: string;
  providers: string[];
  consumers: string[];
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();
  private readonly providers = new Map<string, Set<string>>();
  private readonly consumers = new Map<string, Set<string>>();

  define(name: string, pluginName: string, spec: CapabilitySpec): void {
    const colon = name.indexOf(":");
    if (colon < 0 || name.slice(0, colon) !== pluginName) {
      throw new Error(
        `Capability '${name}' must be prefixed with plugin name '${pluginName}' ` +
        `(e.g. '${pluginName}:...').`,
      );
    }
    if (this.entries.has(name)) {
      warn(`Capability '${name}' already defined. Ignoring duplicate from '${pluginName}'.`);
      return;
    }
    this.entries.set(name, {
      name, spec, definedBy: pluginName,
      providers: [], consumers: [],
    });
  }

  addProvider(name: string, pluginName: string): void {
    const set = this.providers.get(name) ?? new Set<string>();
    set.add(pluginName);
    this.providers.set(name, set);
  }

  addConsumer(name: string, pluginName: string): void {
    const set = this.consumers.get(name) ?? new Set<string>();
    set.add(pluginName);
    this.consumers.set(name, set);
  }

  providersOf(name: string): string[] {
    return Array.from(this.providers.get(name) ?? []);
  }

  consumersOf(name: string): string[] {
    return Array.from(this.consumers.get(name) ?? []);
  }

  getSpec(name: string): CapabilitySpec | undefined {
    return this.entries.get(name)?.spec;
  }

  resolveName(name: string, aliases: Record<string, string>): string {
    return aliases[name] ?? name;
  }

  list(): CapabilityEntry[] {
    return Array.from(this.entries.values()).map((e) => ({
      ...e,
      providers: this.providersOf(e.name),
      consumers: this.consumersOf(e.name),
    }));
  }

  validateAll(): void {
    // Detect undefined capabilities referenced by any plugin.
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
          `Plugin(s) [${plugins.join(", ")}] ${where} undefined capability '${name}'. ` +
          `Typo, missing plugin dependency, or missing alias?`,
        );
      }
    }

    // Cardinality enforcement.
    for (const entry of this.entries.values()) {
      if (entry.spec.cardinality !== "one") continue;
      const consumers = this.consumersOf(entry.name);
      if (consumers.length === 0) continue;  // not consumed → no enforcement
      const providers = this.providersOf(entry.name);
      if (providers.length === 0) {
        throw new Error(
          `No plugin provides capability '${entry.name}' (consumed by: ${consumers.join(", ")}).`,
        );
      }
      if (providers.length > 1) {
        throw new Error(
          `Multiple plugins provide capability '${entry.name}': ${providers.join(", ")}. Remove one.`,
        );
      }
    }
  }

  deregisterByPlugin(pluginName: string): void {
    for (const [name, entry] of this.entries) {
      if (entry.definedBy === pluginName) this.entries.delete(name);
    }
    for (const [name, set] of this.providers) {
      set.delete(pluginName);
      if (set.size === 0) this.providers.delete(name);
    }
    for (const [name, set] of this.consumers) {
      set.delete(pluginName);
      if (set.size === 0) this.consumers.delete(name);
    }
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test src/core/capability-registry.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/capability-registry.ts src/core/capability-registry.test.ts
git commit -m "feat(core): add CapabilityRegistry with cardinality enforcement"
```

### Task 3: Wire CapabilityRegistry into PluginContext

**Files:**
- Modify: `src/types/plugin.ts`, `src/core/context.ts`, `src/core/plugin-manager.ts`, `src/core/index.ts`

- [ ] **Step 1: Add `defineCapability` to `PluginContext`**

In `src/types/plugin.ts`, add to the `PluginContext` interface (grouped with other registration methods):

```typescript
  // --- Capability registry (INITIALIZING state only) -----------------------
  /** Declare a capability. Name must be prefixed with the calling plugin's name. */
  defineCapability(name: string, spec: CapabilitySpec): void;
```

- [ ] **Step 2: Implement in `createPluginContext`**

Modify `src/core/context.ts`:

Add the `CapabilityRegistry` import and constructor parameter:

```typescript
import type { CapabilityRegistry } from "./capability-registry.js";
```

Add `capabilityRegistry: CapabilityRegistry` to the parameters of `createPluginContext` (placed alongside the other registries). Inside the returned object, add:

```typescript
    defineCapability(name, spec) {
      assertInitializing(getState(), "define capabilities");
      capabilityRegistry.define(name, pluginName, spec);
    },
```

- [ ] **Step 3: Thread registry through `PluginManager`**

Modify `src/core/plugin-manager.ts`:

- Import `CapabilityRegistry`.
- Add a `capabilityRegistry: CapabilityRegistry` constructor parameter (alongside the other registries).
- Pass it through to `createPluginContext` in `setupPlugin()`.
- Add `this.capabilityRegistry.deregisterByPlugin(name)` inside `unload()`, next to the other `deregisterByPlugin` calls.

- [ ] **Step 4: Construct + expose in `src/core/index.ts`**

In `src/core/index.ts`, instantiate `new CapabilityRegistry()` during bootstrap, wire it into `PluginManager`, and re-export it. (Read the file first to see the existing bootstrap pattern and match it; no structural changes needed beyond adding this registry next to the others.)

- [ ] **Step 5: Run core tests**

Run: `bun test src/core/`

Expected: existing core tests still pass. Capability registry tests still pass. Manifest-level compile errors in built-ins are still present; that's expected — Task 4 addresses it.

- [ ] **Step 6: Commit**

```bash
git add src/types/plugin.ts src/core/context.ts src/core/plugin-manager.ts src/core/index.ts
git commit -m "feat(core): thread CapabilityRegistry through PluginContext + PluginManager"
```

### Task 4: Migration-pass — switch PluginManager to capability-based orchestration

**Files:**
- Modify: `src/core/plugin-manager.ts`

- [ ] **Step 1: Rewrite `topoSort` to use `consumes` graph**

Replace the `topoSort` function in `plugin-manager.ts` with a version that sorts by `capabilities.consumes` rather than `depends`. Resolve aliases, build provider-of-capability map, then order consumers after providers.

```typescript
function resolveCapName(name: string, aliases: Record<string, string>): string {
  return aliases[name] ?? name;
}

function topoSort(plugins: KaizenPlugin[]): KaizenPlugin[] {
  const nameToPlugin = new Map(plugins.map((p) => [p.name, p]));

  // Map canonical capability name → list of plugins that provide it.
  const capToProviders = new Map<string, string[]>();
  for (const p of plugins) {
    const aliases = p.aliases ?? {};
    for (const raw of p.capabilities?.provides ?? []) {
      const cap = resolveCapName(raw, aliases);
      const existing = capToProviders.get(cap) ?? [];
      existing.push(p.name);
      capToProviders.set(cap, existing);
    }
  }

  const inDegree = new Map(plugins.map((p) => [p.name, 0]));
  const edges = new Map<string, string[]>();

  for (const p of plugins) {
    const aliases = p.aliases ?? {};
    const seen = new Set<string>();
    for (const raw of p.capabilities?.consumes ?? []) {
      const cap = resolveCapName(raw, aliases);
      for (const providerName of capToProviders.get(cap) ?? []) {
        if (providerName === p.name) continue;
        if (seen.has(providerName)) continue;
        seen.add(providerName);
        const existing = edges.get(providerName) ?? [];
        existing.push(p.name);
        edges.set(providerName, existing);
        inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
      }
    }
  }

  const queue = plugins.filter((p) => (inDegree.get(p.name) ?? 0) === 0);
  const sorted: KaizenPlugin[] = [];
  while (queue.length > 0) {
    const p = queue.shift()!;
    sorted.push(p);
    for (const dependent of edges.get(p.name) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        const plugin = nameToPlugin.get(dependent);
        if (plugin) queue.push(plugin);
      }
    }
  }
  if (sorted.length !== plugins.length) {
    fatal("Cycle detected in plugin dependencies. Check your kaizen.json 'plugins' list.");
  }
  return sorted;
}
```

- [ ] **Step 2: Rewrite `initialize()` to use capabilities**

Replace the body of `initialize()` to:

1. Resolve plugins (unchanged).
2. Topo-sort (with the new `topoSort`).
3. For each plugin in order:
   - API version warn (unchanged).
   - Before calling `setup()`: **pre-register** every `capabilities.provides` entry of this plugin with the `CapabilityRegistry` via `addProvider`, resolving aliases. This lets dependents see the provider even if `setup()` hasn't registered a runtime value yet.
   - After `setup()` returns successfully: register every `capabilities.consumes` entry via `addConsumer`.
   - Error handling rule: a plugin whose `capabilities.provides` includes any **singleton** capability that some other plugin consumes is "critical" — failure is fatal. Otherwise, log + continue.
4. After all plugins are initialized, call `capabilityRegistry.validateAll()`. Failure → fatal.
5. Warn on unclaimed config keys (unchanged).
6. Resolve the lifecycle provider by looking up the sole provider of `core-lifecycle:lifecycle.drive`. If missing: fatal `"No lifecycle plugin found. Add one to kaizen.json."` If its `start()` is not a function: same fatal.

Use a helper to determine "critical":

```typescript
function isCritical(plugin: KaizenPlugin, reg: CapabilityRegistry): boolean {
  const aliases = plugin.aliases ?? {};
  for (const raw of plugin.capabilities?.provides ?? []) {
    const cap = resolveCapName(raw, aliases);
    const spec = reg.getSpec(cap);
    if (spec?.cardinality === "one" && reg.consumersOf(cap).length > 0) return true;
  }
  return false;
}
```

Because critical detection depends on consumers being registered, run **two passes**: first pass registers all `provides` and `consumes` with no `setup()` calls (metadata-only), so the registry has a complete view. Second pass calls `setup()` in topo order. This ordering is the reason for splitting register-metadata and setup.

Concrete structure:

```typescript
// Pass 1: register all metadata.
for (const plugin of sorted) {
  const aliases = plugin.aliases ?? {};
  for (const raw of plugin.capabilities?.provides ?? []) {
    this.capabilityRegistry.addProvider(resolveCapName(raw, aliases), plugin.name);
  }
  for (const raw of plugin.capabilities?.consumes ?? []) {
    this.capabilityRegistry.addConsumer(resolveCapName(raw, aliases), plugin.name);
  }
}

// Pass 2: call setup() per plugin in order.
for (const plugin of sorted) { /* setup, error handling as above */ }

// Pass 3: validate cardinalities.
try { this.capabilityRegistry.validateAll(); }
catch (err) { fatal(err instanceof Error ? err.message : String(err)); }
```

Also: in the existing `load()` method (hot-reload path), do the same metadata registration before calling `setupPlugin`, and the validation after.

- [ ] **Step 3: Update `PluginEntry` population**

Update both `initialize()` and `load()` to populate `entry.capabilities` (instead of `entry.provides`) from `plugin.capabilities ?? {}`. Match the new `PluginEntry` shape from Task 1.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`

Expected: `plugin-manager.ts` compiles. Built-in plugin packages still fail — they still use `provides`/`depends`. That's expected.

- [ ] **Step 5: Run core tests**

Run: `bun test src/core/`

Expected: capability-registry tests pass; plugin-manager tests may fail because test fixtures use `provides`/`depends`. Task 5 fixes them.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugin-manager.ts
git commit -m "feat(core): plugin-manager orchestrates via CapabilityRegistry"
```

### Task 5: Update plugin-manager tests

**Files:**
- Modify: `src/core/plugin-manager.test.ts`

- [ ] **Step 1: Read the existing test file**

Open `src/core/plugin-manager.test.ts` and enumerate every use of `provides`/`depends` in fixture plugins. For each, plan the capability equivalent. Typical conversions:

- A fixture plugin that uses `provides: ['lifecycle']` becomes a plugin that defines `core-lifecycle:lifecycle.drive` in `setup()` and declares `capabilities: { provides: ['core-lifecycle:lifecycle.drive'] }`. For test ergonomics, prefer fixtures that define and own their own capabilities (e.g. `test-plugin:foo`).
- A fixture with `depends: ['lifecycle']` becomes `capabilities: { consumes: ['core-lifecycle:lifecycle.drive'] }`.

- [ ] **Step 2: Add new tests for capability behavior**

Add test cases covering:
- Zero providers for a consumed singleton capability → fatal.
- Two providers for a consumed singleton capability → fatal.
- Zero providers for a consumed `many` capability → ok (no error).
- Cycle in `consumes` graph → fatal.
- Alias resolution in consumes (short name resolves to canonical provided by another plugin).
- Owner-prefix mismatch in `defineCapability` → plugin fails critically when it provides a consumed singleton, else continues.

- [ ] **Step 3: Update existing tests to capability-based fixtures**

Rewrite every `provides`/`depends` fixture to use `capabilities: { ... }`.

- [ ] **Step 4: Run tests**

Run: `bun test src/core/plugin-manager.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/plugin-manager.test.ts
git commit -m "test(core): migrate plugin-manager tests to capability fixtures"
```

---

## Phase 2 — Multi-provider Registries

### Task 6: UiRegistry supports multiple providers

**Files:**
- Modify: `src/core/ui-registry.ts`, `src/core/ui-registry.test.ts`, `src/types/plugin.ts`, `src/core/context.ts`

- [ ] **Step 1: Update tests for multi-provider behavior**

Edit `src/core/ui-registry.test.ts`:

- Remove the "two registrations → fatal" test.
- Add a test: two registrations → both are stored and returned by `list()` in registration order.
- Add a test: `getFirst()` returns the first registered provider.
- Add a test: `deregisterByPlugin` removes only the targeted plugin's provider.
- Add a test: `isRegistered()` returns true when at least one is registered.

- [ ] **Step 2: Run tests, expect failures**

Run: `bun test src/core/ui-registry.test.ts`

Expected: failures matching the new API surface.

- [ ] **Step 3: Update implementation**

Replace `src/core/ui-registry.ts` with:

```typescript
import type { UiProvider } from "../types/plugin.js";
import { fatal } from "./errors.js";

interface Entry { impl: UiProvider; pluginName: string; }

export class UiRegistry {
  private readonly entries: Entry[] = [];

  register(impl: UiProvider, pluginName: string): void {
    this.entries.push({ impl, pluginName });
  }

  /** All registered providers, in registration order. */
  list(): UiProvider[] {
    return this.entries.map((e) => e.impl);
  }

  /** First-registered provider, for back-compat with single-provider code paths. */
  getFirst(): UiProvider {
    if (this.entries.length === 0) fatal("No UI provider registered.");
    return this.entries[0]!.impl;
  }

  isRegistered(): boolean { return this.entries.length > 0; }

  deregisterByPlugin(pluginName: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.pluginName === pluginName) this.entries.splice(i, 1);
    }
  }
}
```

- [ ] **Step 4: Update `PluginContext.runtime.ui` shape**

In `src/types/plugin.ts`, change the shape of `runtime.ui`:

```typescript
    /** All registered UI providers, in registration order. */
    ui: {
      list(): UiProvider[];
      getFirst(): UiProvider;
    };
```

In `src/core/context.ts`, replace the `runtime.ui` getter with:

```typescript
      ui: {
        list: () => uiRegistry.list(),
        getFirst: () => uiRegistry.getFirst(),
      },
```

- [ ] **Step 5: Run tests**

Run: `bun test src/core/ui-registry.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/ui-registry.ts src/core/ui-registry.test.ts src/types/plugin.ts src/core/context.ts
git commit -m "feat(core): UiRegistry supports multiple providers"
```

### Task 7: ExecutorRegistry supports multiple providers

**Files:**
- Modify: `src/core/executor-registry.ts`, `src/core/executor-registry.test.ts`, `src/types/plugin.ts`, `src/core/context.ts`

- [ ] **Step 1: Update tests**

Edit `src/core/executor-registry.test.ts` following the same pattern as Task 6:
- Two registrations → both stored (no fatal).
- `list()` returns providers in registration order.
- `getFirst()` returns first provider, used by existing `runtime.executor` for back-compat.
- `deregisterByPlugin` removes only the targeted plugin.

- [ ] **Step 2: Run tests, expect failures.**

Run: `bun test src/core/executor-registry.test.ts`

- [ ] **Step 3: Update implementation**

Replace `src/core/executor-registry.ts` with the analog of the new `UiRegistry` — store an array of `{ impl, pluginName }` entries, expose `list()`, `getFirst()`, `isRegistered()`, `deregisterByPlugin()`.

- [ ] **Step 4: Update `PluginContext.runtime.executor` back-compat shim**

In `src/types/plugin.ts`, leave `runtime.executor: Executor` as-is for now (first-wins semantics). Add a parallel `runtime.executors` shape:

```typescript
    /** All registered executors; routing mechanism deferred. */
    executors: {
      list(): Executor[];
      getFirst(): Executor;
    };
    /** First-registered executor — preserved for back-compat. Deprecated once routing lands. */
    executor: Executor;
```

In `src/core/context.ts`, replace the `runtime.executor` getter to call `executorRegistry.getFirst()` and add the new `runtime.executors` block.

- [ ] **Step 5: Run tests**

Run: `bun test src/core/executor-registry.test.ts`

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor-registry.ts src/core/executor-registry.test.ts src/types/plugin.ts src/core/context.ts
git commit -m "feat(core): ExecutorRegistry supports multiple providers"
```

---

## Phase 3 — Built-in Plugin Migrations

> For each plugin: update the default export (`capabilities` replaces `provides`/`depends`, alias table added), and — where applicable — call `ctx.defineCapability` during `setup()`. Bump each plugin's `apiVersion` to `"2.0.0"`.

### Task 8: Migrate core-lifecycle

**Files:**
- Modify: `plugins/core-lifecycle/src/index.ts` (or equivalent entry)
- Modify: `plugins/core-lifecycle/package.json` — no version-field changes required beyond apiVersion inside the plugin export

- [ ] **Step 1: Read the current `core-lifecycle` plugin**

Read `plugins/core-lifecycle/src/index.ts` (or whichever file exports the default plugin). Identify the current `provides`/`depends` lists and any event definitions.

- [ ] **Step 2: Update the plugin export**

Change the plugin export to:

```typescript
import type { KaizenPlugin, CapabilitySpec } from "../../../src/types/plugin.js";
// (or whatever the existing import path for plugin types is in this workspace)

const UI_INPUT: CapabilitySpec = {
  cardinality: "many",
  description: "Provides user-input channels to the session loop.",
};
const UI_OUTPUT: CapabilitySpec = {
  cardinality: "many",
  description: "Renders session output to a destination.",
};
const LIFECYCLE_DRIVE: CapabilitySpec = {
  cardinality: "one",
  description: "Drives the session loop via start(ctx).",
};
const EXECUTOR_SEND: CapabilitySpec = {
  cardinality: "many",
  description: "Sends messages/tools to an executor backend.",
};

const plugin: KaizenPlugin = {
  name: "core-lifecycle",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["core-lifecycle:lifecycle.drive"],
    consumes: [
      "core-lifecycle:executor.send",
      "core-lifecycle:ui.input",
      "core-lifecycle:ui.output",
    ],
  },
  async setup(ctx) {
    ctx.defineCapability("core-lifecycle:lifecycle.drive", LIFECYCLE_DRIVE);
    ctx.defineCapability("core-lifecycle:ui.input", UI_INPUT);
    ctx.defineCapability("core-lifecycle:ui.output", UI_OUTPUT);
    ctx.defineCapability("core-lifecycle:executor.send", EXECUTOR_SEND);
    // ... existing event definitions
  },
  async start(ctx) {
    // ... existing session loop, updated per Task 14
  },
};
export default plugin;
```

Keep the existing event defineEvent/on/emit calls intact. Only replace the manifest fields and the new `defineCapability` calls.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

Expected: this plugin's types compile. Other built-ins still have errors.

- [ ] **Step 4: Commit**

```bash
git add plugins/core-lifecycle
git commit -m "feat(core-lifecycle): migrate to capability registry; define foundational capabilities"
```

### Task 9: Migrate core-ui-terminal

**Files:**
- Modify: `plugins/core-ui-terminal/src/index.ts`

- [ ] **Step 1: Read the current plugin**

Enumerate current `provides`/`depends` and `registerUi` usage.

- [ ] **Step 2: Update the manifest**

```typescript
const plugin: KaizenPlugin = {
  name: "core-ui-terminal",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"],
    consumes: [],
  },
  async setup(ctx) {
    // existing registerUi() call stays unchanged
    ctx.registerUi(terminalUiProvider);
  },
};
export default plugin;
```

- [ ] **Step 3: Commit**

```bash
git add plugins/core-ui-terminal
git commit -m "feat(core-ui-terminal): migrate to capability registry"
```

### Task 10: Migrate core-executor-anthropic

**Files:**
- Modify: `plugins/core-executor-anthropic/src/index.ts`

- [ ] **Step 1: Update the manifest**

```typescript
const plugin: KaizenPlugin = {
  name: "core-executor-anthropic",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["core-lifecycle:executor.send"],
    consumes: [],
  },
  async setup(ctx) {
    ctx.registerExecutor(anthropicExecutor);
  },
};
export default plugin;
```

- [ ] **Step 2: Commit**

```bash
git add plugins/core-executor-anthropic
git commit -m "feat(core-executor-anthropic): migrate to capability registry"
```

### Task 11: Migrate core-executor-openai, core-executor-debug, core-executor-shell

**Files:**
- Modify: `plugins/core-executor-openai/src/index.ts`
- Modify: `plugins/core-executor-debug/src/index.ts`
- Modify: `plugins/core-executor-shell/src/index.ts`

- [ ] **Step 1: Apply identical pattern to Task 10 to each plugin**

Each: add `capabilities: { provides: ["core-lifecycle:executor.send"] }`. Keep existing `registerExecutor` call. Bump `apiVersion` to `"2.0.0"`.

- [ ] **Step 2: Commit**

```bash
git add plugins/core-executor-openai plugins/core-executor-debug plugins/core-executor-shell
git commit -m "feat(executors): migrate openai/debug/shell to capability registry"
```

### Task 12: Migrate core-cli, core-events, core-plugin-manager, kaizen-plugin-timestamps

**Files:**
- Modify: `plugins/core-cli/src/index.ts`
- Modify: `plugins/core-events/src/index.ts`
- Modify: `plugins/core-plugin-manager/src/index.ts`
- Modify: `plugins/kaizen-plugin-timestamps/src/index.ts`

- [ ] **Step 1: Migrate each plugin's manifest**

For each, inspect current `provides`/`depends`:
- `core-cli` currently `depends: ['lifecycle']`. New: `capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] }`.
- `core-events` defines event-payload types (reference-only). Current `provides`/`depends` likely empty. New: `capabilities: {}` (empty block).
- `core-plugin-manager` registers tools for load/unload/reload. New: `capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] }` to ensure it initializes after lifecycle.
- `kaizen-plugin-timestamps` hooks events. New: `capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] }`.

Bump each `apiVersion` to `"2.0.0"`.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`

Expected: all built-in plugins compile. No more `provides`/`depends` references.

- [ ] **Step 3: Commit**

```bash
git add plugins/core-cli plugins/core-events plugins/core-plugin-manager plugins/kaizen-plugin-timestamps
git commit -m "feat(plugins): migrate remaining built-ins to capability registry"
```

---

## Phase 4 — Multi-UI Lifecycle Support

### Task 13: Lifecycle races input across all registered UI providers

**Files:**
- Modify: `plugins/core-lifecycle/src/index.ts` (or wherever the session loop lives)
- Modify: `plugins/core-lifecycle/src/*.test.ts` or similar

- [ ] **Step 1: Read the existing session loop**

Locate the code that currently calls `ctx.runtime.ui.accept()` (or `ctx.runtime.ui.getFirst().accept()` after Task 6). Understand how channels are iterated and how input is read.

- [ ] **Step 2: Write failing test for multi-UI input race**

Create a test that registers two mock UI providers, each yielding one `UiChannel`. The first channel sends "hello from A", the second sends "hello from B" with a small delay. Run one session-loop turn. Assert: the first message received is "hello from A" (it arrived first), and the other channel receives the agent's response (output is broadcast).

Target file: a new `plugins/core-lifecycle/src/multi-ui.test.ts` or add to existing test.

Concrete test sketch (pseudo-code — adapt to existing test infra):

```typescript
test("lifecycle races input from multiple UI providers", async () => {
  const a = new MockUiProvider([mockChannel("hello from A", 0)]);
  const b = new MockUiProvider([mockChannel("hello from B", 50)]);
  const ctx = buildTestContext({ uiProviders: [a, b] });
  const turn = await runOneTurn(ctx);
  expect(turn.firstUserMessage).toBe("hello from A");
  expect(a.sent).toContainEqual({ type: "text", content: expect.any(String) });
  expect(b.sent).toContainEqual({ type: "text", content: expect.any(String) });
});
```

- [ ] **Step 3: Run test, expect failure**

Run: `bun test plugins/core-lifecycle`

Expected: fail — loop only consumes from `getFirst()`.

- [ ] **Step 4: Update the session loop**

Replace the single-provider consumption pattern with a cross-provider pattern:

1. On session start, call `accept()` on every provider (`ctx.runtime.ui.list().map(p => p.accept())`). Merge channels as they appear. A simple pattern: for each provider, spawn a background task that pulls channels from its iterator and pushes them onto a shared `channels: UiChannel[]` array.
2. When gathering input for a turn:
   - Call `receive()` on every channel in parallel: `channels.map(c => c.receive().then(msg => ({ msg, channel: c })))`.
   - Use `Promise.race` to get the first one. That's the driving input for this turn.
   - Cancel or abandon the other pending `receive()` calls. (Simplest: leave them pending; next turn's race will pick up whatever arrives next, including the second user's message if still unread.)
3. When sending output: call `send()` on every channel in parallel (`Promise.all(channels.map(c => c.send(msg)))`).
4. If zero channels are present and the capability `core-lifecycle:ui.input` has no declared consumer (check via a new helper or via the presence of registered UI providers), run headlessly — no blocking receive.

Write the implementation carefully; this is the core change of finding 1. Keep a single-turn driver function that takes the channel set and returns after one complete interaction (input → executor → tools → output), so tests can step through one turn at a time.

- [ ] **Step 5: Run test, verify pass**

Run: `bun test plugins/core-lifecycle`

Expected: pass.

- [ ] **Step 6: Run all tests**

Run: `bun test`

Expected: all tests pass. Existing single-UI tests still work because the race with one channel is a no-op.

- [ ] **Step 7: Commit**

```bash
git add plugins/core-lifecycle
git commit -m "feat(core-lifecycle): race input across all registered UI providers (finding 1)"
```

### Task 14: Integration test — two UIs driving one session

**Files:**
- Create: `plugins/core-lifecycle/src/two-ui-integration.test.ts` (or similar path)

- [ ] **Step 1: Write integration test**

Use two in-memory UI providers and an in-memory executor. Feed one input through UI-A, verify both UIs receive the agent response. Feed a second input through UI-B, verify first UI and second UI both receive the next response. This exercises the full race + broadcast.

- [ ] **Step 2: Run, pass, commit**

```bash
bun test plugins/core-lifecycle/src/two-ui-integration.test.ts
git add plugins/core-lifecycle
git commit -m "test(core-lifecycle): integration test for two UIs driving one session"
```

---

## Phase 5 — Introspection CLI

### Task 15: `kaizen capability list/show` commands

**Files:**
- Create: `src/commands/capability.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Read `src/cli.ts` to understand command dispatch**

Identify how other subcommands (`run`, `init`, `plugin`) are wired.

- [ ] **Step 2: Implement `capability.ts`**

```typescript
import type { CapabilityRegistry } from "../core/capability-registry.js";

export function capabilityList(reg: CapabilityRegistry): void {
  const entries = reg.list().sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    console.log("No capabilities defined.");
    return;
  }
  for (const e of entries) {
    console.log(`${e.name}  (${e.spec.cardinality})  — ${e.spec.description}`);
    console.log(`    defined by: ${e.definedBy}`);
    console.log(`    providers:  ${e.providers.join(", ") || "(none)"}`);
    console.log(`    consumers:  ${e.consumers.join(", ") || "(none)"}`);
  }
}

export function capabilityShow(reg: CapabilityRegistry, name: string): void {
  const entry = reg.list().find((e) => e.name === name);
  if (!entry) {
    console.error(`Capability '${name}' not defined.`);
    process.exit(1);
  }
  console.log(`Name:        ${entry.name}`);
  console.log(`Cardinality: ${entry.spec.cardinality}`);
  console.log(`Defined by:  ${entry.definedBy}`);
  console.log(`Description: ${entry.spec.description}`);
  if (entry.spec.version) console.log(`Version:     ${entry.spec.version}`);
  console.log(`Providers:   ${entry.providers.join(", ") || "(none)"}`);
  console.log(`Consumers:   ${entry.consumers.join(", ") || "(none)"}`);
  if (entry.spec.schema) {
    console.log("Schema:");
    console.log(JSON.stringify(entry.spec.schema, null, 2));
  }
}
```

- [ ] **Step 3: Wire into `src/cli.ts`**

Add a `capability` subcommand branching on `list` / `show <name>`. It must run the full plugin initialization path (so the registry is populated) and then invoke the command.

- [ ] **Step 4: Manual verification**

Run: `bun src/cli.ts capability list`

Expected: prints all capabilities defined by built-ins (from `core-lifecycle`) plus any plugin-defined ones, with providers and consumers listed.

Run: `bun src/cli.ts capability show core-lifecycle:ui.input`

Expected: detailed view.

- [ ] **Step 5: Commit**

```bash
git add src/commands/capability.ts src/cli.ts
git commit -m "feat(cli): add 'kaizen capability list' and 'kaizen capability show'"
```

---

## Phase 6 — Migration Documentation

### Task 16: Plugin migration guide

**Files:**
- Create: `docs/plugin-migration-capability-registry.md`

- [ ] **Step 1: Write the migration guide**

Create `docs/plugin-migration-capability-registry.md` with exactly these sections (no placeholders; each must contain working copy-pasteable content):

1. **Overview** — what changed, why, who it affects.
2. **Rename table** — side-by-side: `provides: ['ui']` → `capabilities: { provides: ['core-lifecycle:ui.input', 'core-lifecycle:ui.output'] }`, and equivalents for `'lifecycle'`, `'executor'`.
3. **`depends` → `consumes` mapping** — for every built-in role a plugin might depend on today, give the canonical capability name.
4. **Manifest before/after diff** — a realistic plugin showing the full transformation.
5. **Third-party capability definition recipe** — how to define a new capability with `ctx.defineCapability(...)`, including an owner-qualified name example and a JSON schema example.
6. **Alias declaration recipe** — when to add an `aliases` map and how consumers reference short names.
7. **`UiProvider` authoring recipe** — if the plugin provides a UI, include a complete working `UiProvider` with a `UiChannel` backed by a mock queue, showing the shape agents must produce. (Input-racing is transparent — the plugin just provides a `UiProvider`; lifecycle handles multi-provider racing.)
8. **Introspection** — how to run `kaizen capability list` and `kaizen capability show <name>` to verify migration.
9. **Failure modes and fixes** — for each fatal message core now emits (`Capability 'X' must be prefixed ...`, `No plugin provides capability ...`, `Multiple plugins provide capability ...`, `Plugin(s) [...] consumes undefined capability ...`), show the cause and the exact diff.
10. **Migration checklist** — an ordered checklist an agent can execute: (a) bump `apiVersion` to `2.0.0`; (b) replace `provides` with `capabilities.provides` using canonical names; (c) replace `depends` with `capabilities.consumes`; (d) if defining a new capability, add a `defineCapability` call and put the owner-qualified name in `capabilities.provides`; (e) run `bun run typecheck`; (f) run `bun test`; (g) run `kaizen capability show <your-capability>` to verify.

Target audience is a coding agent doing a mechanical migration. Prioritize copy-pasteable snippets over prose. Keep the doc self-contained — do not assume the agent has read the spec or core source.

- [ ] **Step 2: Manual review**

Read through the doc. For each section, confirm: could an agent, starting from only this file + a pre-migration plugin, complete the migration? If any step requires information not in the doc, add it.

- [ ] **Step 3: Commit**

```bash
git add docs/plugin-migration-capability-registry.md
git commit -m "docs: plugin migration guide for capability registry"
```

---

## Phase 7 — End-to-end Verification

### Task 17: Full default-stack smoke test

**Files:**
- None (manual verification).

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`

Expected: zero errors across workspace.

- [ ] **Step 2: Run full test suite**

Run: `bun test`

Expected: all tests pass.

- [ ] **Step 3: Run integration**

Run: `bun run test:core`

Expected: all integration tests pass.

- [ ] **Step 4: Run default harness end-to-end**

Run: `bun src/cli.ts --harness core-anthropic` (or `core-debug` if no API key locally).

Expected: session opens, accepts input, LLM responds. No capability-related errors in output.

- [ ] **Step 5: Run `kaizen capability list`**

Run: `bun src/cli.ts capability list`

Expected: lists `core-lifecycle:lifecycle.drive`, `core-lifecycle:ui.input`, `core-lifecycle:ui.output`, `core-lifecycle:executor.send`, with correct providers and consumers populated from the loaded built-ins.

- [ ] **Step 6: Commit any final fixes and create checkpoint commit**

```bash
git commit --allow-empty -m "chore: capability registry — end-to-end verified"
```

---

## Deferred Work (not in this plan)

From the design spec, sections D1–D5:

- **D1:** Install-time consent UX (blocked by plugin-installer redesign)
- **D2:** Runtime sandboxing / enforcement (separate large effort)
- **D3:** Multi-executor routing mechanism (cardinality opens up here, but routing is a follow-up design)
- **D4:** Other adversarial-review findings (4–8, 10, 12–20)
- **D5:** Parallel event handler execution

---

## Notes for the Implementing Engineer

1. **Read the file before editing.** `plugin-manager.ts` has a hot-reload path (`load()`, `unload()`, `reload()`) that mirrors the startup path. Every change to registration/validation logic must be mirrored in both.
2. **Run tests after every task.** The codebase has a `bun test` suite; use it as the regression guard.
3. **Preserve back-compat shims** inside core (`runtime.executor`, `runtime.ui.getFirst()`) so that plugins migrating one at a time don't break the default stack mid-migration.
4. **If a plugin's current `provides: ['ui']` implies both input and output**, split it into both canonical capabilities (`core-lifecycle:ui.input` AND `core-lifecycle:ui.output`). The terminal UI does both; a log-only web viewer would only declare `ui.output`.
5. **If you find a built-in plugin declaring `depends: ['some-role-string']` that doesn't match one of the canonical capabilities documented above**, pause and raise a question rather than guessing — there may be a capability the spec didn't anticipate.
