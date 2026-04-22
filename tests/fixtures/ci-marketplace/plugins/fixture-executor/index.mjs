// Returns a canned response. Emits test:executor:send on every call so the
// spy plugin can count invocations and capture arguments.
//
// See fixture-ui/index.mjs for why these fixtures use globalThis instead of
// ctx.registerService to share implementations.
export default {
  name: "fixture-executor",
  apiVersion: "2",
  capabilities: { provides: ["fixture-driver:executor.send"] },
  async setup(ctx) {
    const impl = {
      async send(messages, tools) {
        await ctx.emit("test:executor:send", {
          messageCount: messages.length,
          toolCount: tools.length,
        });
        return { content: "fixture response", tool_calls: [], stop_reason: "end_turn" };
      },
      async *stream() { yield { type: "done" }; },
    };
    (globalThis.__kaizenFixtureImpls ??= {})["fixture-driver:executor.send"] = impl;
  },
};
