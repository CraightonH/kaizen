export default {
  name: "cap-provider",
  apiVersion: "2",
  services: { provides: ["cap-provider:thing"] },
  async setup(ctx) {
    ctx.defineService("cap-provider:thing", { description: "test" });
    ctx.provideService("cap-provider:thing", { ok: true });
  },
};
