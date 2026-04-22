export default {
  name: "cap-owner",
  apiVersion: "2",
  async setup(ctx) {
    ctx.defineService("cap-owner:thing", { description: "test" });
  },
};
