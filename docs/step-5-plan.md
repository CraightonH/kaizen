# Step 5 Implementation Plan: UI Provider Role + Event Architecture

Goal: two things that belong together.

1. **UI provider role** — a typed `UiProvider`/`UiChannel` abstraction so the
   session loop is transport-agnostic. Terminal, web, and test UIs are
   drop-in replacements for each other.

2. **Event architecture** — events are open-world. Any plugin can define and
   emit any event. Core is pure infrastructure (event bus mechanism only) and
   emits nothing itself. A new `core-events` plugin owns the canonical event
   vocabulary and its payload types, versioned independently of kaizen.

---

## Design decisions captured here

### Open-world events

`emit()` on an undefined event warns but never blocks — this is already true
in the current `EventBus` implementation. No change needed to that behavior.

`defineEvent()` is documentation, not permission. Its only runtime effect is
suppressing the "unknown event" warning when that event is later emitted. Any
plugin can call `defineEvent()` for its own events during `setup()`.

`depends` is the contract mechanism. If plugin B subscribes to events defined
by plugin A, B declares `depends: ["plugin-a"]` (or `depends: ["role"]`).
This guarantees A's `setup()` runs first and B's `on()` calls land after the
events are defined.

### Core emits nothing

Core (`src/core/`) is pure infrastructure: event bus, registries, plugin
loader, bootstrap. It defines no event names and emits no events. All event
vocabulary belongs to plugins.

### `core-events` plugin

A new `plugins/core-events/` plugin provides the `"events"` role. It calls
`defineEvent()` for the canonical set during `setup()` and exports the
corresponding TypeScript payload types. Plugin authors who handle canonical
events import those types from `core-events`, not from `kaizen`.

Versioned independently — `core-events@1.2.0` can add new events without
requiring a new `kaizen` release.

A third-party `coolguy-events` can provide the same `"events"` role with a
completely different vocabulary. Plugins that want those events declare
`depends: ["coolguy-events"]` and import types from that package.

### Payload types leave `src/types/plugin.ts`

`SessionContext`, `ToolCallContext`, `ResponseContext`, `LoopContext`, and
`LoopSignal` currently live in core types. They move to `core-events` because
they are the payload types of canonical events — the contract lives with the
thing that defines the concept.

Core types (`src/types/plugin.ts`) retain only infrastructure interfaces:
primitives (`Message`, `ToolDefinition`, etc.), plugin manifest (`KaizenPlugin`,
`PluginContext`), and role interfaces (`Executor`, `UiProvider`, `UiChannel`).

---

## 1. `src/types/plugin.ts`

**Remove** `SessionContext`, `ToolCallContext`, `ResponseContext`, `LoopContext`,
`LoopSignal` — they move to `core-events`.

**Add UI message types:**

```typescript
export type UserMessage =
  | { type: "text"; content: string };

export type AgentMessage =
  | { type: "text";        content: string }
  | { type: "text_delta";  content: string }
  | { type: "tool_call";   name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "error";       message: string };
```

**Add `UiChannel` and `UiProvider` interfaces:**

```typescript
export interface UiChannel {
  readonly id: string;
  receive(): Promise<UserMessage>;
  send(msg: AgentMessage): Promise<void>;
  close(): Promise<void>;
}

export interface UiProvider {
  /**
   * Yields one UiChannel per session.
   * Terminal: yields one channel then stops.
   * Web: yields a new channel per incoming connection, indefinitely.
   */
  accept(): AsyncIterable<UiChannel>;
}
```

**Update `PluginContext`:**
- Add `registerUi(impl: UiProvider): void` (INITIALIZING only)
- Add `runtime.ui: UiProvider`

---

## 2. New: `src/core/ui-registry.ts`

Identical pattern to `ExecutorRegistry`:

```typescript
import type { UiProvider } from "../types/plugin.js";
import { fatal } from "./errors.js";

export class UiRegistry {
  private impl: UiProvider | null = null;
  private registeredBy: string | null = null;

  register(impl: UiProvider, pluginName: string): void {
    if (this.impl !== null) {
      fatal(`Two plugins registered a UI provider: '${this.registeredBy}' and '${pluginName}'. Remove one.`);
    }
    this.impl = impl;
    this.registeredBy = pluginName;
  }

  get(): UiProvider {
    if (!this.impl) fatal("No UI provider registered. Add a UI plugin to kaizen.json.");
    return this.impl;
  }

  isRegistered(): boolean { return this.impl !== null; }
}
```

---

## 3. `src/core/context.ts`

- Add `uiRegistry: UiRegistry` param
- Add `registerUi(impl)` method: calls `assertInitializing` + `uiRegistry.register(impl, pluginName)`
- Add `runtime.ui` lazy getter: proxies to `uiRegistry.get()`

---

## 4. `src/core/loader.ts`

- Add `uiRegistry: UiRegistry` param to `loadPlugins`
- Pass to every `createPluginContext()` call

---

## 5. `src/core/index.ts`

- Import `UiRegistry`
- Create `const uiRegistry = new UiRegistry()`
- Pass to `loadPlugins` and the lifecycle `createPluginContext` call

---

## 6. New: `plugins/core-events/`

**`package.json`:**
```json
{
  "name": "core-events",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.4.0"
  }
}
```

**`index.ts`** — defines events and exports payload types:

```typescript
import type { KaizenPlugin, KaizenConfig } from "../../src/types/plugin.js";

// ---------------------------------------------------------------------------
// Canonical event names
// ---------------------------------------------------------------------------

export const EVENTS = {
  SESSION_START:    "session:start",
  SESSION_END:      "session:end",
  SESSION_LOOP:     "session:loop",
  USER_MESSAGE:     "session:user_message",
  AGENT_RESPONSE:   "session:response",
  TOOL_BEFORE:      "tool:before",
  TOOL_AFTER:       "tool:after",
} as const;

// ---------------------------------------------------------------------------
// Payload types — import these from 'core-events', not from 'kaizen'
// ---------------------------------------------------------------------------

export interface SessionContext {
  sessionId: string;
  config: KaizenConfig;
}

export interface UserMessageContext {
  sessionId: string;
  content: string;
}

export interface ResponseContext {
  sessionId: string;
  content: string;
}

export interface ToolCallContext {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultContext {
  sessionId: string;
  tool: string;
  ok: boolean;
  output: string;
}

/** Returned by session:loop handlers to control the session loop. */
export type LoopSignal =
  | { type: "continue"; prompt: string }
  | { type: "yield" }
  | { type: "end" };

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: KaizenPlugin = {
  name: "core-events",
  apiVersion: "1.0.0",
  provides: ["events"],
  depends: [],

  async setup(ctx) {
    for (const name of Object.values(EVENTS)) {
      ctx.defineEvent(name);
    }
  },
};

export default plugin;
```

---

## 7. `plugins/core-ui-terminal/index.ts`

First real implementation. `accept()` yields exactly one channel backed by
stdin/stdout, then returns. Does not depend on `events` — UI is transport only.

```typescript
import * as readline from "readline";
import { randomUUID } from "crypto";
import type { KaizenPlugin, UiChannel, UserMessage, AgentMessage } from "../../src/types/plugin.js";

function createTerminalChannel(): UiChannel {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return {
    id: randomUUID(),

    receive(): Promise<UserMessage> {
      return new Promise((resolve, reject) => {
        rl.once("line", (line) => resolve({ type: "text", content: line }));
        rl.once("close", () => reject(new Error("stdin closed")));
      });
    },

    async send(msg: AgentMessage): Promise<void> {
      if (msg.type === "text" || msg.type === "text_delta") {
        process.stdout.write(msg.content);
      } else if (msg.type === "tool_call") {
        process.stdout.write(`[tool: ${msg.name}(${JSON.stringify(msg.args)})]\n`);
      } else if (msg.type === "tool_result") {
        process.stdout.write(`[result: ${msg.ok ? "ok" : "err"} ${msg.output}]\n`);
      } else if (msg.type === "error") {
        process.stderr.write(`[error: ${msg.message}]\n`);
      }
    },

    async close(): Promise<void> {
      rl.close();
    },
  };
}

const plugin: KaizenPlugin = {
  name: "core-ui-terminal",
  apiVersion: "1.0.0",
  provides: ["ui"],
  depends: [],

  async setup(ctx) {
    ctx.registerUi({
      async *accept() {
        yield createTerminalChannel();
      },
    });
  },
};

export default plugin;
```

---

## 8. `plugins/core-lifecycle/index.ts`

First real implementation. Depends on `events`, `executor`, and `ui`. Emits
canonical events from `EVENTS` at each stage of the session loop. The loop
strategy is transport-agnostic — it never touches stdin/stdout directly.

```typescript
import type { KaizenPlugin, PluginContext, UiChannel, Message } from "../../src/types/plugin.js";
import { EVENTS } from "../core-events/index.js";
import { randomUUID } from "crypto";

async function runSession(channel: UiChannel, ctx: PluginContext): Promise<void> {
  const sessionId = randomUUID();
  const history: Message[] = [];

  const systemPrompt = ctx.config["systemPrompt"];
  if (typeof systemPrompt === "string") {
    history.push({ role: "system", content: systemPrompt });
  }

  await ctx.emit(EVENTS.SESSION_START, { sessionId, config: ctx.config });

  try {
    while (true) {
      let userMsg;
      try {
        userMsg = await channel.receive();
      } catch {
        break;
      }

      await ctx.emit(EVENTS.USER_MESSAGE, { sessionId, content: userMsg.content });
      history.push({ role: "user", content: userMsg.content });

      const tools = ctx.runtime.tools.list();
      const response = await ctx.runtime.executor.send(history, tools);

      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls.length > 0 ? response.tool_calls : undefined,
      });

      for (const tc of response.tool_calls) {
        await ctx.emit(EVENTS.TOOL_BEFORE, { sessionId, tool: tc.name, args: tc.args });
        await channel.send({ type: "tool_call", name: tc.name, args: tc.args });

        const result = await ctx.runtime.tools.execute(tc.name, tc.args);
        const output = result.error ?? result.output ?? JSON.stringify(result.data) ?? "";
        history.push({ role: "tool", content: output, tool_call_id: tc.id });

        await ctx.emit(EVENTS.TOOL_AFTER, { sessionId, tool: tc.name, ok: result.ok, output });
        await channel.send({ type: "tool_result", name: tc.name, ok: result.ok, output });
      }

      if (response.content) {
        await ctx.emit(EVENTS.AGENT_RESPONSE, { sessionId, content: response.content });
        await channel.send({ type: "text", content: response.content + "\n" });
      }
    }
  } finally {
    await ctx.emit(EVENTS.SESSION_END, { sessionId });
    await channel.close();
  }
}

const plugin: KaizenPlugin = {
  name: "core-lifecycle",
  apiVersion: "1.0.0",
  provides: ["lifecycle"],
  depends: ["events", "executor", "ui"],

  async setup(_ctx) {},

  async start(ctx) {
    for await (const channel of ctx.runtime.ui.accept()) {
      runSession(channel, ctx).catch((err: unknown) => {
        ctx.log(`session ${channel.id} error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  },
};

export default plugin;
```

---

## 9. Root `package.json`

Add workspace references:
```json
"core-events": "workspace:*",
"core-ui-terminal": "workspace:*"
```

(The existing `core-lifecycle` and `core-cli` refs are already there.)

Also add `core-events` to static imports in `src/cli.ts` so it's bundled into
the compiled binary.

---

## 10. `scripts/test-core.ts`

Remove the old `helloWorldPlugin`. Replace with four focused plugins:

1. **`mockEventsPlugin`** — provides `"events"`, calls `defineEvent()` for a
   test event, records `events_registered`
2. **`mockUiPlugin`** — provides `"ui"`, yields one scripted channel:
   sends `"hello"`, captures whatever the agent sends back, then closes
3. **`mockExecutorPlugin`** — unchanged from Step 4
4. **`mockLifecyclePlugin`** — provides `"lifecycle"`, depends on all three
   above, runs one session via `ctx.runtime.ui.accept()` and asserts the
   response came back through the channel

New assertions:
- `events_registered === true`
- `ui_registered === true`
- `channel_received_response === true` (mock `send()` captures agent reply)
- Session loop exited cleanly

---

## 11. DESIGN.md

Change Step 5 row from `⬜ Todo` to `✅ Done`:
`core-events (versioned event vocabulary + payload types). core-ui-terminal (UiProvider/accept()). core-lifecycle (transport-agnostic session loop). open-world events. bun run test:core N/N.`

---

## Execution order

1 → 2 → 3 → 4 → 5 (core types + registries, typecheck after 5)
6 and 7 can be done in parallel (independent plugins)
8 after 6 and 7
9 → 10 → 11

---

## What this enables (Step 6: `core-executor-debug`)

`core-executor-debug` intercepts `executor.send()`, prints the incoming
messages and tools to stderr so the developer can see what the session loop
is handing it, then reads a response from stdin via `readline`. It reads
stdin directly — not through `ctx.runtime.ui` — because the UI channel is
owned by the session loop; the debug executor is a parallel dev-only tap.

A future `core-ui-web` plugin implements `UiProvider.accept()` by starting an
HTTP server and yielding one `UiChannel` per WebSocket connection. No changes
to `core-lifecycle`, `core-events`, or any other plugin required.

A future `acme-events` plugin provides the `"events"` role with a different
vocabulary. Any plugin that `depends: ["acme-events"]` gets that vocabulary
with full type safety by importing from `acme-events`.
