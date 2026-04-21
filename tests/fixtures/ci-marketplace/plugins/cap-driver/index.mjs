export default {
  name: "cap-driver",
  apiVersion: "2",
  lifecycle: true,
  capabilities: { consumes: ["cap-provider:thing"] },
  async setup() {},
  async start() {},
};
