// Minimal driver plugin. Drives exactly one session turn, emits
// test:driver:start / :end bracketing the work, then returns so
// bootstrap() resolves.
//
// Post service-registry-merge: executor is resolved via ctx.useService.
// The UI fixture still uses globalThis because cardinality-many would be
// needed to express "many UI providers" and v1 is cardinality-one; this
// fixture accepts one UI via the globalThis bridge established by
// fixture-ui during setup.
export default {
  name: "fixture-driver",
  apiVersion: "2",
  driver: true,
  // Note: intentionally does NOT declare consumes in manifest to avoid a
  // topo-sort cycle (provider of fixture-driver:executor.send depends on
  // this plugin as the definer). ctx.consumeService is still called below
  // so the runtime registry records the consumer relationship.
  async setup(ctx) {
    ctx.defineService("fixture-driver:executor.send", { description: "LLM executor" });
    ctx.consumeService("fixture-driver:executor.send");
  },
  async start(ctx) {
    await ctx.emit("test:driver:start");
    await ctx.emit("session:start");

    const impls = globalThis.__kaizenFixtureImpls ?? {};
    const ui = impls["fixture-driver:ui"];
    const executor = ctx.useService("fixture-driver:executor.send");

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
