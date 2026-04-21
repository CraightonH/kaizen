export default {
  name: "cap-provider",
  apiVersion: "2",
  capabilities: { provides: ["cap:thing"] },
  async setup(ctx) {
    ctx.defineCapability("cap:thing", { cardinality: "one", description: "test" });
  },
};
