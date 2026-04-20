// Minimal lifecycle provider. Drives exactly one session turn, emits
// test:lifecycle:start / :end bracketing the work, then returns so
// bootstrap() resolves.
// Workaround for issue #13: core hardcodes "core-lifecycle:lifecycle.drive"
// as the session-driver lookup, and the capability-namespace ownership rule
// requires the defining plugin's name to match the namespace prefix. Until
// that coupling is removed, any lifecycle-driver plugin must identify as
// "core-lifecycle". Rename to "fixture-lifecycle" once #13 lands.
export default {
  name: "core-lifecycle",
  apiVersion: "2",
  capabilities: {
    provides: ["core-lifecycle:lifecycle.drive"],
    consumes: ["core-lifecycle:executor.send", "core-lifecycle:ui"],
  },
  async setup(ctx) {
    ctx.defineCapability("core-lifecycle:lifecycle.drive", { cardinality: "one", description: "lifecycle driver" });
    ctx.defineCapability("core-lifecycle:executor.send", { cardinality: "one", description: "LLM executor" });
    ctx.defineCapability("core-lifecycle:ui", { cardinality: "many", description: "UI provider" });
  },
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
