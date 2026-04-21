// Scripted single-turn UI. accept() yields one channel; the channel delivers
// one user message via receive() then closes. send() just records.
//
// Post-registry-refactor: core no longer has a UiRegistry. In real plugins the
// driver plugin would export a ServiceToken and providers would registerService
// against it. These fixtures are separately-installed packages that can't share
// a token instance via imports, so they coordinate through a globalThis map
// keyed by capability name. This is a test-only pattern.
export default {
  name: "fixture-ui",
  apiVersion: "2",
  capabilities: { provides: ["fixture-lifecycle:ui"] },
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
    (globalThis.__kaizenFixtureImpls ??= {})["fixture-lifecycle:ui"] = impl;
  },
};
