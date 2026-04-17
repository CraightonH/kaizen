# Plugin Migration Guide: Capability Registry (v1 → v2)

This guide is a mechanical walkthrough for migrating a Kaizen plugin from the v1
plugin API (`provides` / `depends` with anonymous role strings) to the v2 API
(owner-qualified capabilities with declared cardinality). It is self-contained:
you do not need to read the design spec or core source to complete a migration.

## 1. Overview

### What changed

- **v1** used two string arrays on the plugin manifest:
  - `provides: string[]` — anonymous role tags the plugin implements
    (`"lifecycle"`, `"ui"`, `"executor"`, `"events"`).
  - `depends: string[]` — roles the plugin needs some other plugin to provide.
- **v2** replaces both with a single `capabilities` field containing
  `provides` and `consumes` arrays of **owner-qualified capability names**:
  ```
  "<defining-plugin-name>:<local-capability-name>"
  ```
  Every capability is also formally declared via `ctx.defineCapability()` with
  an explicit cardinality (`"singleton"` or `"many"`) and optional JSON schema.

### Why

Anonymous role strings made conflicts silent (two plugins providing `"ui"`
produced undefined behavior), did not scope ownership (anyone could claim any
role), and hid cardinality from the loader. The capability registry makes each
contract explicit, validates it at load time, and makes providers/consumers
introspectable via `kaizen capability list`.

### Who this affects

Every plugin author. The `apiVersion` major must be bumped from `"1.0.0"` to
`"2.0.0"`. Plugins declaring `apiVersion: "1.x.x"` will fail to load under v2
core.

## 2. Canonical capability rename table

The four built-in v1 role strings map to these v2 capability names. Use these
names verbatim — they are defined by the core plugins.

| v1 role | v2 capability name | Cardinality | Provider plugin |
|---|---|---|---|
| `"lifecycle"` | `"core-lifecycle:lifecycle.drive"` | `singleton` | `core-lifecycle` |
| `"ui"` (input) | `"core-lifecycle:ui.input"` | `many` | `core-lifecycle` (consumer of registered providers) |
| `"ui"` (output) | `"core-lifecycle:ui.output"` | `many` | `core-lifecycle` (consumer of registered providers) |
| `"executor"` | `"core-lifecycle:executor.send"` | `many` | `core-lifecycle` consumes; any plugin can provide |
| `"events"` | `"core-events:service"` | `singleton` | `core-events` |

Notes:

- `"ui"` is split into `ui.input` and `ui.output`. If you only produce output
  (e.g. a logger), declare only `ui.output`. If you only read user input,
  declare only `ui.input`. Most UI plugins declare both.
- `executor.send` has `many` cardinality: multiple executor plugins may be
  loaded. Until routing lands, `core-lifecycle` picks the first registered
  executor. Having multiple is not an error.
- `lifecycle.drive` and `core-events:service` are singletons — the loader
  errors if two plugins claim either.

### `provides` rename (side-by-side)

**Before (v1):**
```typescript
provides: ["lifecycle"]
provides: ["ui"]
provides: ["executor"]
provides: ["events"]
```

**After (v2):**
```typescript
capabilities: { provides: ["core-lifecycle:lifecycle.drive"] }
capabilities: { provides: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"] }
capabilities: { provides: ["core-lifecycle:executor.send"] }
capabilities: { provides: ["core-events:service"] }
```

## 3. `depends` → `consumes` mapping

A plugin that previously depended on a role now declares the canonical
capability in `capabilities.consumes`. The loader uses `consumes` to compute
load order (topological sort on provides/consumes edges) and to validate that
every consumed capability is provided by some loaded plugin.

**Before (v1):**
```typescript
depends: ["lifecycle"]
depends: ["ui"]
depends: ["executor"]
depends: ["events"]
```

**After (v2):**
```typescript
capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] }
capabilities: { consumes: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"] }
capabilities: { consumes: ["core-lifecycle:executor.send"] }
capabilities: { consumes: ["core-events:service"] }
```

For `ui`, include only the directions you actually use. A plugin that reads
user input but never writes output should list only `"core-lifecycle:ui.input"`.

**Rule of thumb:** if your `setup()` calls `ctx.getService(CoreEventsServiceToken)`,
you consume `"core-events:service"`. If it calls `ctx.registerUi(...)`, you
provide `ui.input`/`ui.output`. If it calls lifecycle driver methods, you
consume `"core-lifecycle:lifecycle.drive"`.

## 4. Full manifest before/after

Hypothetical logging plugin that subscribes to user messages via the events
service.

### Before (v1)

```typescript
import type { KaizenPlugin } from "@kaizen/core";
import { CoreEventsServiceToken } from "@kaizen/core-events";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-logger",
  apiVersion: "1.0.0",
  provides: [],
  depends: ["events", "lifecycle"],
  async setup(ctx) {
    const { events } = ctx.getService(CoreEventsServiceToken);
    ctx.on(events.USER_MESSAGE, async (p) => {
      console.log("[log]", p);
    });
  },
};

export default plugin;
```

### After (v2)

```typescript
import type { KaizenPlugin } from "@kaizen/core";
import { CoreEventsServiceToken } from "@kaizen/core-events";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-logger",
  apiVersion: "2.0.0",
  capabilities: {
    consumes: ["core-events:service", "core-lifecycle:lifecycle.drive"],
  },
  async setup(ctx) {
    const { events } = ctx.getService(CoreEventsServiceToken);
    ctx.on(events.USER_MESSAGE, async (p) => {
      console.log("[log]", p);
    });
  },
};

export default plugin;
```

Notes on what changed:

- `apiVersion` bumped to `"2.0.0"`.
- `provides: []` removed (empty arrays are not required; omit them).
- `depends: ["events", "lifecycle"]` replaced with
  `capabilities.consumes: ["core-events:service", "core-lifecycle:lifecycle.drive"]`.
- `setup()` body is unchanged — the service token API did not change.

## 5. Defining a new capability (third-party plugins)

Any plugin may define its own capabilities. The rules:

1. The capability name **must** be owner-qualified with the plugin's own name:
   `"{this-plugin-name}:{local-name}"`. Core throws at `defineCapability()` if
   the prefix does not match the plugin's `name` field.
2. Call `ctx.defineCapability(name, spec)` inside `setup()` **before** anything
   consumes it.
3. List the same name in `capabilities.provides` so the loader includes it in
   the topological sort and cardinality check.
4. Optional but recommended: provide a JSON schema describing the shape of
   messages, config, or service objects associated with the capability.

### Complete example: a metrics plugin exposing `counter.increment`

```typescript
import type { KaizenPlugin } from "@kaizen/core";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-metrics",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["kaizen-plugin-metrics:counter.increment"],
  },
  async setup(ctx) {
    ctx.defineCapability("kaizen-plugin-metrics:counter.increment", {
      cardinality: "singleton",
      description: "Increment a named counter by a delta.",
      schema: {
        type: "object",
        required: ["name", "delta"],
        properties: {
          name: { type: "string", minLength: 1 },
          delta: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
    });

    const counters = new Map<string, number>();
    ctx.registerService("kaizen-plugin-metrics:counter.increment", {
      increment(name: string, delta: number) {
        counters.set(name, (counters.get(name) ?? 0) + delta);
      },
      get(name: string): number {
        return counters.get(name) ?? 0;
      },
    });
  },
};

export default plugin;
```

### A different plugin consuming it

```typescript
import type { KaizenPlugin } from "@kaizen/core";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-request-counter",
  apiVersion: "2.0.0",
  capabilities: {
    consumes: [
      "core-events:service",
      "kaizen-plugin-metrics:counter.increment",
    ],
  },
  async setup(ctx) {
    const metrics = ctx.getService<{
      increment(name: string, delta: number): void;
    }>("kaizen-plugin-metrics:counter.increment");

    ctx.on("request.completed", async () => {
      metrics.increment("requests.total", 1);
    });
  },
};

export default plugin;
```

The loader now enforces that `kaizen-plugin-metrics` is loaded whenever
`kaizen-plugin-request-counter` is loaded, and will order `metrics` before
`request-counter` in `setup()`.

## 6. Aliases (ergonomic short names)

Fully qualified names get verbose. A plugin may declare aliases that the loader
resolves before matching, validating, or sorting. Aliases are scoped to the
declaring plugin only — they do not leak to other plugins.

```typescript
import type { KaizenPlugin } from "@kaizen/core";
import { CoreEventsServiceToken } from "@kaizen/core-events";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-logger",
  apiVersion: "2.0.0",
  aliases: {
    "lifecycle": "core-lifecycle:lifecycle.drive",
    "events": "core-events:service",
  },
  capabilities: {
    consumes: ["events", "lifecycle"],
  },
  async setup(ctx) {
    const { events } = ctx.getService(CoreEventsServiceToken);
    ctx.on(events.USER_MESSAGE, async (p) => {
      console.log("[log]", p);
    });
  },
};

export default plugin;
```

Both the topological sort and the "is this capability defined?" check resolve
aliases first, so `consumes: ["events"]` behaves identically to
`consumes: ["core-events:service"]`.

## 7. Authoring a `UiProvider`

UI plugins provide `ui.input` and/or `ui.output` by registering a `UiProvider`
during `setup()`. Lifecycle merges channels from every registered provider:
input is **raced** (first input wins; others are ignored for that turn), output
is **broadcast** (every output channel receives every message). The plugin
author just yields channels — the racing/broadcasting logic lives in lifecycle.

Complete working example: an in-memory UI provider backed by a queue, suitable
for tests or headless drivers.

```typescript
import type {
  KaizenPlugin,
  UiProvider,
  UiChannel,
  UiMessage,
} from "@kaizen/core";

function makeQueueChannel(id: string): UiChannel {
  const inbox: UiMessage[] = [];
  let resolveNext: ((m: UiMessage) => void) | null = null;

  return {
    id,
    async readInput(): Promise<UiMessage> {
      const queued = inbox.shift();
      if (queued) return queued;
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    async writeOutput(message: UiMessage): Promise<void> {
      // In a real channel this would push to a terminal, websocket, etc.
      console.log(`[${id}]`, message);
    },
    push(message: UiMessage): void {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(message);
      } else {
        inbox.push(message);
      }
    },
  };
}

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-memory-ui",
  apiVersion: "2.0.0",
  capabilities: {
    provides: [
      "core-lifecycle:ui.input",
      "core-lifecycle:ui.output",
    ],
  },
  async setup(ctx) {
    const provider: UiProvider = {
      name: "memory-ui",
      async *channels(): AsyncIterable<UiChannel> {
        yield makeQueueChannel("memory-ui:main");
      },
    };
    ctx.registerUi(provider);
  },
};

export default plugin;
```

Key points:

- Declare both `ui.input` and `ui.output` if the channel supports both
  directions. If the channel only writes (e.g. a log sink), declare only
  `ui.output`.
- `ctx.registerUi(provider)` is idempotent within a single `setup()` call but
  should only be called once per plugin.
- Do not implement racing or broadcasting yourself; lifecycle handles it.

## 8. Introspection

Two CLI subcommands inspect the loaded capability graph. Use them to verify a
migration landed correctly.

### `kaizen capability list`

Sample output:

```
$ kaizen capability list
NAME                                    CARDINALITY  PROVIDERS                                CONSUMERS
core-events:service                     singleton    core-events                              kaizen-plugin-logger
core-lifecycle:executor.send            many         kaizen-plugin-anthropic                  core-lifecycle
core-lifecycle:lifecycle.drive          singleton    core-lifecycle                           kaizen-plugin-logger
core-lifecycle:ui.input                 many         kaizen-plugin-memory-ui                  core-lifecycle
core-lifecycle:ui.output                many         kaizen-plugin-memory-ui                  core-lifecycle
kaizen-plugin-metrics:counter.increment singleton    kaizen-plugin-metrics                    kaizen-plugin-request-counter
```

### `kaizen capability show <name>`

Sample output:

```
$ kaizen capability show kaizen-plugin-metrics:counter.increment
Name:         kaizen-plugin-metrics:counter.increment
Owner:        kaizen-plugin-metrics
Cardinality:  singleton
Description:  Increment a named counter by a delta.
Providers:
  - kaizen-plugin-metrics
Consumers:
  - kaizen-plugin-request-counter
Schema:
  {
    "type": "object",
    "required": ["name", "delta"],
    "properties": {
      "name":  { "type": "string", "minLength": 1 },
      "delta": { "type": "integer", "minimum": 1 }
    },
    "additionalProperties": false
  }
```

**How to verify a migration:**

1. Run `kaizen capability list` and confirm every capability your plugin
   declares appears in the table.
2. Confirm the `PROVIDERS` column lists your plugin for each name in
   `capabilities.provides`.
3. Confirm the `CONSUMERS` column lists your plugin for each name in
   `capabilities.consumes`.
4. For any capability you defined yourself, run `kaizen capability show <name>`
   and verify the cardinality, description, and schema match what you passed
   to `defineCapability()`.

## 9. Failure modes and fixes

Core emits fatal errors at load time for the conditions below. For each:
cause, example, fix.

### `Capability 'X:Y' must be prefixed with plugin name 'Z'`

**Cause.** `ctx.defineCapability("X:Y", …)` was called from plugin `Z`, but the
name does not start with `Z:`.

**Fix.** Rename the capability to use the plugin's own name as prefix. If you
genuinely want a different owner, move the `defineCapability` call into that
plugin.

```typescript
// BAD — plugin name is "kaizen-plugin-metrics" but capability prefix is wrong.
ctx.defineCapability("metrics:counter.increment", { cardinality: "singleton" });

// GOOD
ctx.defineCapability("kaizen-plugin-metrics:counter.increment", {
  cardinality: "singleton",
});
```

### `No plugin provides capability 'X:Y' (consumed by: A, B)`

**Cause.** Plugins `A` and `B` declare `consumes: ["X:Y"]`, but no loaded
plugin declares `provides: ["X:Y"]`.

**Fix.** Add the providing plugin to `kaizen.json`. If the provider is a core
plugin, ensure the harness loads it (the default harness already loads
`core-lifecycle`, `core-events`, and `core-plugin-manager`).

### `Multiple plugins provide capability 'X:Y': A, B`

**Cause.** `X:Y` has `cardinality: "singleton"`, but plugins `A` and `B` both
declare `provides: ["X:Y"]`.

**Fix.** Remove one of the providers from `kaizen.json`. If both truly need to
coexist, the capability is miscategorized — change its definition to
`cardinality: "many"` (you can only do this in the plugin that defines it).

### `Plugin(s) [A] consumes undefined capability 'Y:Z'`

**Cause.** Plugin `A` declares `consumes: ["Y:Z"]` but no loaded plugin has
called `defineCapability("Y:Z", …)`.

**Fix.** One of:

1. **Typo.** Check spelling against `kaizen capability list` output.
2. **Defining plugin not loaded.** Add the defining plugin to `kaizen.json`.
3. **Missing alias.** If you intended to use a short name, add it under the
   plugin's `aliases` table (see section 6).

## 10. Migration checklist

Execute these steps in order. Each is independently verifiable.

1. **Bump `apiVersion`** to `"2.0.0"` in the plugin manifest.
2. **Translate `provides`.** Replace `provides: [...]` with
   `capabilities: { provides: [...] }`, substituting each v1 role string with
   its canonical name from the rename table in section 2. Remove the old
   `provides` field entirely.
3. **Translate `depends`.** Replace `depends: [...]` with
   `capabilities: { consumes: [...] }` (merge into the same `capabilities`
   object from step 2). Use the same canonical names. Remove the old `depends`
   field.
4. **Declare new capabilities.** If your plugin defines any new capability,
   add `ctx.defineCapability("<your-plugin-name>:<local.name>", { cardinality, description, schema? })`
   inside `setup()`, and also add `"<your-plugin-name>:<local.name>"` to
   `capabilities.provides`.
5. **(Optional) Add aliases.** If you want ergonomic short names in your
   `provides`/`consumes` arrays, add an `aliases` table mapping short → fully
   qualified.
6. **Typecheck.** Run `bun run typecheck`. Expect 0 errors.
7. **Test.** Run `bun test`. Expect all tests pass.
8. **List.** Run `kaizen capability list` and verify every capability your
   plugin declares appears with the expected providers and consumers.
9. **Show.** For each capability you defined yourself, run
   `kaizen capability show <name>` and verify the cardinality, description,
   and schema are correct.

If steps 6–9 all pass, the migration is complete.
