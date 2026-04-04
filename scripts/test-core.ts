/**
 * Smoke test for kaizen core.
 *
 * Validates the full initialization sequence without a real LLM or network:
 *   - Plugin resolution from builtins map
 *   - setup() called with a valid PluginContext
 *   - Event bus (defineEvent, on, emit)
 *   - Tool registration and execution
 *   - Role validation
 *   - start() called on the lifecycle provider
 *
 * Run: bun scripts/test-core.ts
 */
import { bootstrap } from "../src/core/index.js";
import type { KaizenPlugin, PluginContext } from "../src/types/plugin.js";

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
// Hello-world plugin — provides 'lifecycle', exercises all PluginContext APIs
// ---------------------------------------------------------------------------

const results: Record<string, unknown> = {};

const helloWorldPlugin: KaizenPlugin = {
  name: "hello-world",
  apiVersion: "1.0.0",
  provides: ["lifecycle"],
  depends: [],

  async setup(ctx: PluginContext) {
    results["setup_called"] = true;
    results["config"] = ctx.config;

    // Event bus
    ctx.defineEvent("hello:greet");
    ctx.on("hello:greet", async (payload) => {
      results["event_payload"] = payload;
      return "handler-result";
    });

    // Tool registration
    ctx.registerTool({
      name: "say_hello",
      description: "Says hello to a name",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      async execute(args) {
        return { ok: true, output: `Hello, ${args["name"]}!` };
      },
    });

    // Calling registerTool/defineEvent/on after setup() should throw — tested in start()
  },

  async start(ctx: PluginContext) {
    results["start_called"] = true;

    // emit() works outside INITIALIZING
    const emitResults = await ctx.emit("hello:greet", { who: "world" });
    results["emit_results"] = emitResults;

    // Tool execution via runtime
    const toolResult = await ctx.runtime.tools.execute("say_hello", { name: "kaizen" });
    results["tool_result"] = toolResult;

    // Tools are listed
    results["tool_count"] = ctx.runtime.tools.list().length;

    // State enforcement: registerTool throws after setup()
    try {
      ctx.registerTool({
        name: "late_tool",
        description: "should not register",
        parameters: { type: "object", properties: {} },
        async execute() { return { ok: true }; },
      });
      results["late_register_threw"] = false;
    } catch {
      results["late_register_threw"] = true;
    }
  },
};

// ---------------------------------------------------------------------------
// Run bootstrap
// ---------------------------------------------------------------------------

console.log("\nkaizen core smoke test\n");

await bootstrap(
  {
    provider: "test",
    plugins: ["hello-world"],
    "hello-world": { greeting: "hi" },
  },
  { "hello-world": helloWorldPlugin },
  // Minimal global config — LLM is never called so credentials don't matter
  {
    providers: {
      test: { adapter: "anthropic", model: "claude-opus-4-6", api_key: "test-key" },
    },
  },
);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

console.log("\nResults:\n");

assert("setup() was called", results["setup_called"] === true);
assert("config slice passed to plugin", (results["config"] as Record<string, unknown>)?.["greeting"] === "hi");
assert("start() was called", results["start_called"] === true);
assert("emit() returned handler results", Array.isArray(results["emit_results"]) && (results["emit_results"] as unknown[])[0] === "handler-result");
assert("event payload received", (results["event_payload"] as Record<string, unknown>)?.["who"] === "world");
assert("tool executed successfully", (results["tool_result"] as { ok: boolean; output: string })?.ok === true);
assert("tool output correct", (results["tool_result"] as { output: string })?.output === "Hello, kaizen!");
assert("tool is listed", results["tool_count"] === 1);
assert("registerTool throws after initialization", results["late_register_threw"] === true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
