// Minimal lifecycle provider. Drives exactly one session turn, emits
// test:lifecycle:start / :end bracketing the work, then returns so
// bootstrap() resolves.
export default {
  name: "fixture-lifecycle",
  apiVersion: "2",
  capabilities: {
    provides: ["core-lifecycle:lifecycle.drive"],
    consumes: ["core-lifecycle:executor.send", "core-lifecycle:ui.input", "core-lifecycle:ui.output"],
  },
  async setup() {},
  async start(ctx) {
    await ctx.emit("test:lifecycle:start");
    await ctx.emit("session:start");

    const ui = ctx.runtime.ui.getFirst();
    const executor = ctx.runtime.executors.getFirst();

    for await (const channel of ui.accept()) {
      const userMsg = await channel.receive();
      if (!userMsg) break;
      await ctx.emit("session:user_message", userMsg);

      const tools = ctx.runtime.tools.list();
      const response = await executor.send([userMsg], tools);
      await ctx.emit("session:response", response);
      await channel.send({ type: "text", content: response.content });

      await channel.close();
      break;
    }

    await ctx.emit("session:end");
    await ctx.emit("test:lifecycle:end");
  },
};
