// Returns a canned response. Emits test:executor:send on every call so the
// spy plugin can count invocations and capture arguments.
export default {
  name: "fixture-executor",
  apiVersion: "2",
  capabilities: { provides: ["fixture-lifecycle:executor.send"] },
  async setup(ctx) {
    ctx.registerExecutor({
      async send(messages, tools) {
        await ctx.emit("test:executor:send", {
          messageCount: messages.length,
          toolCount: tools.length,
        });
        return { content: "fixture response", tool_calls: [], stop_reason: "end_turn" };
      },
      async *stream() { yield { type: "done" }; },
    });
  },
};
