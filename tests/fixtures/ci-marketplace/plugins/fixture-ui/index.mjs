// Scripted single-turn UI. accept() yields one channel; the channel delivers
// one user message via receive() then closes. send() just records.
export default {
  name: "fixture-ui",
  apiVersion: "2",
  capabilities: { provides: ["core-lifecycle:ui"] },
  async setup(ctx) {
    ctx.registerUi({
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
    });
  },
};
