export default {
  name: "cap-driver-conflict",
  apiVersion: "2",
  driver: true,
  capabilities: { consumes: ["cap-owner:thing"] },
  async setup() {},
  async start() {},
};
