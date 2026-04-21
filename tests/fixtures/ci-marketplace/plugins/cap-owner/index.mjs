export default {
  name: "cap-owner",
  apiVersion: "2",
  async setup(ctx) {
    ctx.defineCapability("conflict:thing", { cardinality: "one", description: "test" });
  },
};
