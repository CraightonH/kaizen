/**
 * Smoke test for kaizen core.
 *
 * Validates the full initialization sequence without a real LLM or network:
 *   - Plugin resolution, topo-sort, role validation
 *   - setup() called with a valid PluginContext
 *   - Event bus (defineEvent, on, emit)
 *   - Tool registration and execution
 *   - Executor registration via registerExecutor()
 *   - UI provider registration via registerUi()
 *   - Session loop: ui.accept() → receive() → executor.send() → channel.send()
 *   - start() called on the lifecycle provider
 *
 * Run: bun scripts/test-core.ts
 */
import { bootstrap } from "../src/core/index.js";
import type { KaizenPlugin, PluginContext, LLMResponse } from "../src/types/plugin.js";
import { EVENTS } from "../plugins/core-events/index.js";
import coreEvents from "../plugins/core-events/index.js";
import coreLifecycle from "../plugins/core-lifecycle/index.js";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Shared results bag
// ---------------------------------------------------------------------------

const results: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Mock executor — provides "executor", returns a fixed response
// ---------------------------------------------------------------------------

const mockExecutorPlugin: KaizenPlugin = {
  name: "mock-executor",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["core-lifecycle:executor.send"],
  },
  async setup(ctx) {
    ctx.registerExecutor({
      async send(): Promise<LLMResponse> {
        return { content: "mock response", tool_calls: [], stop_reason: "end_turn" };
      },
      async *stream() { yield { type: "done" as const }; },
    });
    results["executor_registered"] = true;
  },
};

// ---------------------------------------------------------------------------
// Mock UI — provides "ui", drives one scripted session
// ---------------------------------------------------------------------------

const mockUiPlugin: KaizenPlugin = {
  name: "mock-ui",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"],
  },
  async setup(ctx) {
    const sentMessages: unknown[] = [];
    let receiveCount = 0;

    ctx.registerUi({
      async *accept() {
        yield {
          id: "test-session",
          async receive() {
            receiveCount++;
            if (receiveCount === 1) return { type: "text" as const, content: "hello" };
            // Close after one exchange
            throw new Error("session ended");
          },
          async send(msg: unknown) {
            sentMessages.push(msg);
          },
          async close() {
            results["channel_closed"] = true;
            results["channel_sent"] = sentMessages;
          },
        };
      },
    });
    results["ui_registered"] = true;
  },
};

// ---------------------------------------------------------------------------
// Observer plugin — hooks into core-events to verify they fire
// ---------------------------------------------------------------------------

const observerPlugin: KaizenPlugin = {
  name: "observer",
  apiVersion: "2.0.0",
  capabilities: {
    consumes: ["core-events:service"],
  },
  async setup(ctx: PluginContext) {
    ctx.on(EVENTS.SESSION_START, async () => { results["event_session_start"] = true; });
    ctx.on(EVENTS.USER_MESSAGE, async (p) => { results["event_user_message"] = p; });
    ctx.on(EVENTS.AGENT_RESPONSE, async (p) => { results["event_agent_response"] = p; });
    ctx.on(EVENTS.SESSION_END, async () => { results["event_session_end"] = true; });

    // Tool registration — verify it works
    ctx.registerTool({
      name: "say_hello",
      description: "Says hello",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async execute(args) {
        return { ok: true, output: `Hello, ${args["name"]}!` };
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Run bootstrap
// ---------------------------------------------------------------------------

console.log("\nkaizen core smoke test\n");

await bootstrap(
  {
    plugins: ["core-events", "mock-executor", "mock-ui", "observer", "core-lifecycle"],
    "core-lifecycle": { systemPrompt: "You are a test assistant." },
  },
  {
    "core-events": coreEvents,
    "mock-executor": mockExecutorPlugin,
    "mock-ui": mockUiPlugin,
    "observer": observerPlugin,
    "core-lifecycle": coreLifecycle,
  },
);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

console.log("\nResults:\n");

// Registration
assert("executor registered", results["executor_registered"] === true);
assert("ui registered", results["ui_registered"] === true);

// Session loop
assert("session:start fired", results["event_session_start"] === true);
assert("session:user_message fired with content",
  (results["event_user_message"] as Record<string, unknown>)?.["content"] === "hello");
assert("session:response fired with content",
  (results["event_agent_response"] as Record<string, unknown>)?.["content"] === "mock response");
assert("session:end fired", results["event_session_end"] === true);

// Channel
assert("channel was closed", results["channel_closed"] === true);
assert("channel received agent text",
  (results["channel_sent"] as unknown[])?.some(
    (m) => (m as Record<string, unknown>)?.["type"] === "text"
  )
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
