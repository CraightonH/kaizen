export default {
  name: "cap-dup-b",
  apiVersion: "2",
  services: { provides: ["cap-owner:thing"] },
  async setup(ctx) {
    ctx.provideService("cap-owner:thing", { from: "b" });
  },
};
