export default {
  name: "cap-driver",
  apiVersion: "2",
  driver: true,
  services: { consumes: ["cap-provider:thing"] },
  async setup(ctx) {
    ctx.consumeService("cap-provider:thing");
  },
  async start() {},
};
