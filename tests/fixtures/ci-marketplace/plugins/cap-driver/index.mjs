export default {
  name: "cap-driver",
  apiVersion: "2",
  driver: true,
  capabilities: { consumes: ["cap-provider:thing"] },
  async setup() {},
  async start() {},
};
