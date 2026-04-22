// Scripted single-turn UI. accept() yields one channel; the channel delivers
// one user message via receive() then closes.
//
// Post service-registry-merge: UI sharing remains via globalThis because
// the UI is keyed by a fixture-driver service name (which is cardinality-one)
// and this fixture is intentionally decoupled from registering against it.
export default {
  name: "fixture-ui",
  apiVersion: "2",
  async setup(ctx) {
    const impl = {
      async *accept() {
        let delivered = false;
        let closed = false;
        yield {
          id: "fixture-session",
          async receive() {
            if (delivered || closed) {
              closed = true;
              return null;
            }
            delivered = true;
            await ctx.emit("test:ui:received", { content: "hello fixture" });
            return { type: "text", content: "hello fixture" };
          },
          async send(msg) {
            await ctx.emit("test:ui:sent", { msg });
          },
          async close() { closed = true; },
        };
      },
    };
    (globalThis.__kaizenFixtureImpls ??= {})["fixture-driver:ui"] = impl;
  },
};
