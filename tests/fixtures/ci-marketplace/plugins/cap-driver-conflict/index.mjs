export default {
  name: "cap-driver-conflict",
  apiVersion: "2",
  driver: true,
  services: { consumes: ["cap-owner:thing"] },
  async setup(ctx) {
    ctx.consumeService("cap-owner:thing");
  },
  async start() {},
};
