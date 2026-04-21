export default {
  name: "cap-owner",
  apiVersion: "2",
  async setup(ctx) {
    ctx.defineCapability("cap-owner:thing", { cardinality: "one", description: "test" });
  },
};
