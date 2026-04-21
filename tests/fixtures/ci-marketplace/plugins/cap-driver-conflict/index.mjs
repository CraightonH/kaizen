export default {
  name: "cap-driver-conflict",
  apiVersion: "2",
  lifecycle: true,
  capabilities: { consumes: ["conflict:thing"] },
  async setup() {},
  async start() {},
};
