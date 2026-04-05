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

## Plugin config

Config is read from the plugin's namespace in `kaizen.json`:

```json
{
  "my-plugin": {
    "api_key_env": "MY_API_KEY",
    "timeout_ms": 5000
  }
}
```

Access it in `setup()`:
```typescript
const key = process.env[ctx.config["api_key_env"] as string];
const timeout = ctx.config["timeout_ms"] as number ?? 5000;
```

The config namespace key must exactly match `plugin.name`.

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
