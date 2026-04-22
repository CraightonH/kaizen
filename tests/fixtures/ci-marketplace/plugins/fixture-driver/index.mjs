// Minimal driver plugin. Drives exactly one session turn, emits
// test:driver:start / :end bracketing the work, then returns so
// bootstrap() resolves.
//
// Post-registry-refactor: core no longer exposes runtime.{ui,executors,tools}.
// Driver plugins resolve providers themselves — typically via a shared
// ServiceToken. These fixtures coordinate through globalThis keyed by
// capability name (see fixture-ui/index.mjs for the rationale). Tools are
// intentionally absent: a future core-tools broker plugin will own that
// concept; until then the driver passes an empty tool list to executors.
export default {
  name: "fixture-driver",
  apiVersion: "2",
  driver: true,
  capabilities: {
    consumes: ["fixture-driver:executor.send", "fixture-driver:ui"],
  },
  async setup(ctx) {
    ctx.defineCapability("fixture-driver:executor.send", { cardinality: "one", description: "LLM executor" });
    ctx.defineCapability("fixture-driver:ui", { cardinality: "many", description: "UI provider" });
  },
  async start(ctx) {
    await ctx.emit("test:driver:start");
    await ctx.emit("session:start");

    const impls = globalThis.__kaizenFixtureImpls ?? {};
    const ui = impls["fixture-driver:ui"];
    const executor = impls["fixture-driver:executor.send"];

    for await (const channel of ui.accept()) {
      const userMsg = await channel.receive();
      if (!userMsg) break;
      await ctx.emit("session:user_message", userMsg);

      const response = await executor.send([userMsg], []);
      await ctx.emit("session:response", response);
      await channel.send({ type: "text", content: response.content });

      await channel.close();
      break;
    }

    await ctx.emit("session:end");
    await ctx.emit("test:driver:end");
  },
};
