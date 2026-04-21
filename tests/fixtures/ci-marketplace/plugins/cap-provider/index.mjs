export default {
  name: "cap-provider",
  apiVersion: "2",
  capabilities: { provides: ["cap-provider:thing"] },
  async setup(ctx) {
    ctx.defineCapability("cap-provider:thing", { cardinality: "one", description: "test" });
  },
};
