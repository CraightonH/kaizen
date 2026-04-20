# Plugin Authoring Guide

*Read when: you are writing a kaizen plugin or harness companion plugin.*

A kaizen plugin is an npm package that exports a `KaizenPlugin` as its default
export. Plugins register tools, subscribe to lifecycle events, and optionally
provide capability roles (executor, UI, lifecycle).

## Minimal plugin

```typescript
// my-plugin/index.ts
import type { KaizenPlugin } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "my-plugin",       // kebab-case; must match config key in kaizen.json
  apiVersion: "1.0.0",
  provides: [],            // capability roles this plugin fulfills
  depends: [],             // roles or plugin names that must load before this one

  async setup(ctx) {
    // Register tools, subscribe to events — all here, during INITIALIZING.
    // Anything you register after setup() returns will throw.
  },
};

export default plugin;
```

```json
// package.json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.js",
  "keywords": ["kaizen-plugin"]
}
```

## Registering a tool

```typescript
async setup(ctx) {
  ctx.registerTool({
    name: "weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
    async execute(args) {
      const city = args.city as string;
      // ... fetch weather ...
      return { ok: true, output: `It's sunny in ${city}.` };
    },
  });
}
```

### ToolResult

```typescript
interface ToolResult {
  ok: boolean;
  output?: string;   // human-readable. sent to LLM when data is absent
  data?: unknown;    // structured JSON. sent to LLM instead of output when present
  error?: string;    // sent to LLM when ok=false
  exit_code?: number;
}
```

If `execute()` throws, core wraps it as `{ ok: false, error: err.message }`.

Core validates `args` against `parameters` (JSON Schema via ajv) before calling
`execute()`. Invalid args → `{ ok: false, error: "Invalid arguments: ..." }`,
`execute()` is not called.

Mark a tool `destructive: true` to signal that it modifies state. `core-cli`
uses this flag to prompt the user before running such tools.

## Subscribing to events

Subscribe to lifecycle events using `ctx.on()` during `setup()`. To use the
default event vocabulary, import from `core-events`:

```typescript
import { EVENTS } from "core-events";

async setup(ctx) {
  ctx.on(EVENTS.TOOL_BEFORE, async (payload) => {
    const { tool, args } = payload as { tool: string; args: Record<string, unknown> };
    ctx.log(`about to run: ${tool}`);
    // Return void to let execution continue normally.
    // Return a ToolResult to short-circuit execute() (lifecycle plugin must check).
  });

  ctx.on(EVENTS.TOOL_AFTER, async (payload) => {
    const { tool, ok } = payload as { tool: string; ok: boolean };
    ctx.log(`${tool} finished: ${ok ? "ok" : "err"}`);
  });

  ctx.on(EVENTS.SESSION_START, async () => {
    ctx.log("session started");
  });
}
```

### Default event vocabulary (from `core-events`)

| Event | Payload type | Notes |
|-------|-------------|-------|
| `session:start` | `SessionContext` | Fires once at session open |
| `session:end` | `{ sessionId }` | Fires once at session close |
| `session:user_message` | `UserMessageContext` | Each user turn |
| `session:response` | `ResponseContext` | Each assistant response |
| `tool:before` | `ToolCallContext` | Before execute() |
| `tool:after` | `ToolResultContext` | After execute() |

Import payload types from `core-events`:
```typescript
import type { ToolCallContext, ToolResultContext } from "core-events";
```

### Defining custom events

If your plugin emits its own events, declare them during `setup()`:
```typescript
ctx.defineEvent("my-plugin:custom-event");
ctx.emit("my-plugin:custom-event", { data: 42 });
```

Other plugins can subscribe: `ctx.on("my-plugin:custom-event", handler)`.

## Providing a capability role

Declare `provides: ["my-role"]` to fulfill a role. Other plugins can then declare
`depends: ["my-role"]` and core will enforce exactly one provider is loaded.

### Providing an executor

```typescript
import type { KaizenPlugin, Executor } from "kaizen/types";

const myExecutor: Executor = {
  async send(messages, tools) {
    // call your LLM / shell / mock ...
    return { content: "response text", tool_calls: [], stop_reason: "end_turn" };
  },
  async *stream(messages, tools) {
    yield { type: "text", text: "response" };
    yield { type: "done" };
  },
};

const plugin: KaizenPlugin = {
  name: "my-executor",
  apiVersion: "1.0.0",
  provides: ["executor"],
  depends: [],
  async setup(ctx) {
    ctx.registerExecutor(myExecutor);
  },
};
```

### Providing a UI

```typescript
import type { KaizenPlugin, UiProvider, UiChannel } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "my-ui",
  apiVersion: "1.0.0",
  provides: ["ui"],
  depends: [],
  async setup(ctx) {
    ctx.registerUi({
      async *accept() {
        // Yield one channel per session.
        // Terminal: yield once. Web server: yield per connection.
        yield myChannel;
      },
    });
  },
};
```

### Providing a lifecycle

Only implement `start()` if your plugin provides the `lifecycle` role. Core calls
`start(ctx)` after all plugins initialize.

```typescript
const plugin: KaizenPlugin = {
  name: "my-lifecycle",
  apiVersion: "1.0.0",
  provides: ["lifecycle"],
  depends: ["executor", "ui"],
  async setup(ctx) { /* subscribe to events */ },
  async start(ctx) {
    // Drive the session loop here.
    for await (const channel of ctx.runtime.ui.accept()) {
      const msg = await channel.receive();
      const response = await ctx.runtime.executor.send(
        [{ role: "user", content: msg.content }],
        ctx.runtime.tools.list(),
      );
      await channel.send({ type: "text", content: response.content });
      await channel.close();
    }
  },
};
```

## Plugin Config & Secrets

Plugins declare config schema and defaults in their manifest, then access merged
config via `ctx.config` and secrets via `await ctx.secrets.get(key)`.

### Declaring config on your plugin

Add `config` to your plugin's `manifest()`:

```typescript
import type { KaizenPlugin, ConfigSchema } from "kaizen/types";

const plugin: KaizenPlugin = {
  name: "my-api",
  apiVersion: "1.0.0",
  
  config: {
    schema: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description: "Request timeout in milliseconds",
        },
        api_key: {
          type: "string",
          description: "API key (stored as secret)",
          secret: true, // marks this as a secret
        },
        endpoint: {
          type: "string",
          description: "API endpoint URL",
        },
      },
      required: ["api_key"],
    },
    defaults: {
      timeout_ms: 5000,
      endpoint: "https://api.example.com",
    },
    secrets: ["api_key"], // keys that are secrets
  },

  async setup(ctx) {
    // ctx.config contains non-secret merged values
    const timeout = ctx.config.timeout_ms as number;
    const endpoint = ctx.config.endpoint as string;
    
    // Secrets are fetched separately
    const apiKey = await ctx.secrets.get("api_key");
  },
};
```

### What `ctx.config` contains

`ctx.config` is a plain object containing the merged, non-secret config values:
- User config from `kaizen.json` (or harness config)
- Defaults from your plugin's `config.defaults`
- Environment overrides via `KAIZEN_<PLUGIN>_<KEY>` (see below)

Secret values are **not** included in `ctx.config`.

### Accessing secrets with `ctx.secrets.get(key)`

Secrets are fetched separately using `await ctx.secrets.get(key)`:

```typescript
async setup(ctx) {
  const apiKey = await ctx.secrets.get("api_key");
  const password = await ctx.secrets.get("password");
}
```

`get()` throws if the secret is not configured or unavailable. Use try-catch
if you need graceful fallbacks.

### Secret refs in harness config

Secrets can reference different storage backends. In `kaizen.json`, use:

**Bare string (simple case):**
```json
{
  "my-api": {
    "api_key": "my-secret-api-key"
  }
}
```

**Full ref (explicit provider):**
```json
{
  "my-api": {
    "api_key": {
      "provider": "vault",
      "ref": "secret/data/my-api/key",
      "envOverride": "MY_API_KEY_OVERRIDE"
    }
  }
}
```

The `{ provider, ref, envOverride? }` shape lets harnesses use custom secret
providers (see `docs/plugin-secrets.md` for writing one).

- `provider` — name of the secret provider (e.g., `"vault"`, `"doppler"`)
- `ref` — provider-specific reference (e.g., vault path, Doppler key name)
- `envOverride?` — (optional) env var to check first before hitting the provider

### Environment override convention

Secrets can be overridden by environment variables using `KAIZEN_<PLUGIN>_<KEY>`:

```bash
export KAIZEN_MY_API_API_KEY="sk-prod-12345"
kaizen start
```

This takes precedence over `kaizen.json` config and explicit providers.

The env name is constructed as:
- `KAIZEN_` prefix
- plugin name in UPPER_SNAKE_CASE
- secret key in UPPER_SNAKE_CASE

Example: plugin `my-api`, secret `api_key` → `KAIZEN_MY_API_API_KEY`

### Shallow merge caveat

Config objects are shallow-merged (one level deep):

```json
{
  "my-plugin": {
    "database": {
      "host": "localhost"
    }
  }
}
```

If your defaults specify `database.port`, the merge **replaces** `database`
entirely, not merging nested keys. To avoid surprises, avoid nesting config
objects; use flat keys like `database_host` and `database_port` instead.

```typescript
// Flat config: safe
defaults: {
  database_host: "localhost",
  database_port: 5432,
}

// Nested config: risky
defaults: {
  database: { host: "localhost", port: 5432 }
}
```

### Migration from old pattern (deprecated)

The old pattern used `api_key_env` indirection:

```typescript
// BEFORE (deprecated)
{
  "my-plugin": {
    "api_key_env": "MY_API_KEY"
  }
}

async setup(ctx) {
  const key = process.env[ctx.config["api_key_env"] as string];
}
```

The new pattern is direct and type-safe:

```typescript
// AFTER
{
  "my-plugin": {
    "api_key": { provider: "env", ref: "MY_API_KEY" }
  }
}

async setup(ctx) {
  const key = await ctx.secrets.get("api_key");
}
```

Or, if the secret is stored in the OS keychain:

```typescript
// AFTER (keychain)
{
  "my-plugin": {
    "api_key": "stored-in-keychain"
  }
}

async setup(ctx) {
  const key = await ctx.secrets.get("api_key");
}

## Logging

```typescript
ctx.log("something happened");
// prints: [my-plugin] something happened
```

## depends[] resolution

`depends[]` accepts role names or plugin names:
- `depends: ["executor"]` — needs any plugin providing role `executor`
- `depends: ["core-events"]` — needs the specific plugin named `core-events`

Core uses this only for topological sort and role validation. You cannot access
another plugin's instance directly — use events or shared state via closures.

## Installation and discovery

Publish to npm with keyword `kaizen-plugin`:

```json
{
  "keywords": ["kaizen-plugin"]
}
```

Users install with:
```bash
kaizen plugin install my-plugin
# or: bun add --global my-plugin
```

Search for plugins:
```bash
npm search kaizen-plugin
```

## API version

Set `apiVersion` to the kaizen plugin API version you target. Core warns (but
still loads) if the major version doesn't match. The current API major version is
exported as `PLUGIN_API_VERSION` from `kaizen/core`.

```typescript
import { PLUGIN_API_VERSION } from "kaizen/core";
```

## Service Registry

Plugins can share typed capabilities using `ServiceToken<T>`, `ctx.registerService`, and `ctx.getService`. This is the canonical way for one plugin to expose an API to another — typed at compile time, collision-free, and order-safe via `depends`.

### Concepts

- **`ServiceToken<T>`** — an unforgeable, typed key. Each `new ServiceToken(label)` call produces a distinct key, even if two tokens share the same label string.
- **`ctx.registerService(token, impl)`** — register a service implementation. Valid only during `setup()`. Throws on duplicate registration.
- **`ctx.getService(token)`** — retrieve a service. Valid at any lifecycle state (including tool handlers). Throws with a named error if the service is not registered.
- **`depends`** — ensures the provider's `setup()` runs before the consumer's `setup()`. Required whenever `getService` is called during `setup()`.

### Provider plugin

```typescript
// plugins/my-provider/index.ts
import type { KaizenPlugin } from "kaizen/types";
import { ServiceToken } from "kaizen/types";

export interface MyService {
  greet(name: string): string;
}

export const MyServiceToken = new ServiceToken<MyService>("MyService");

const plugin: KaizenPlugin = {
  name: "my-provider",
  apiVersion: "1.0.0",
  provides: [],
  depends: [],
  async setup(ctx) {
    ctx.registerService(MyServiceToken, {
      greet: (name) => `Hello, ${name}!`,
    });
  },
};
export default plugin;
```

### Consumer plugin

```typescript
// plugins/my-consumer/index.ts
import type { KaizenPlugin } from "kaizen/types";
import { MyServiceToken } from "my-provider";

const plugin: KaizenPlugin = {
  name: "my-consumer",
  apiVersion: "1.0.0",
  depends: ["my-provider"], // guarantees provider initializes first
  async setup(ctx) {
    const svc = ctx.getService(MyServiceToken); // typed as MyService
    ctx.log(svc.greet("world"));               // "Hello, world!"
  },
};
export default plugin;
```

### Built-in reference pair

`core-events` ships a `CoreEventsServiceToken` that exposes its canonical event name constants. `core-lifecycle` consumes it — this is the canonical real-world example:

```typescript
// provider (core-events/index.ts, simplified)
export interface CoreEventsService { readonly events: typeof EVENTS; }
export const CoreEventsServiceToken = new ServiceToken<CoreEventsService>("CoreEventsService");
// in setup(): ctx.registerService(CoreEventsServiceToken, { events: EVENTS });

// consumer (core-lifecycle/index.ts, simplified)
import { CoreEventsServiceToken } from "core-events";
// in start(): const { events } = ctx.getService(CoreEventsServiceToken);
```

### Rules summary

| Rule | Detail |
|------|--------|
| `registerService` is INITIALIZING-only | Call it in `setup()`. Calling it from a tool handler throws. |
| `getService` is always valid | Call it in `setup()`, tool handlers, or event handlers. |
| `depends` is required for ordering | If provider and consumer can load in any order, `getService` may throw at startup. |
| Token label = interface name | `new ServiceToken<MyService>("MyService")` — label matches the TypeScript type name exactly. |
| One provider per token | Duplicate `registerService` calls for the same token throw immediately. |
