import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-executor-openai",
  apiVersion: "1.0.0",
  permissions: {
    tier: "scoped",
    net: { connect: ["api.openai.com:443"] },
    env: ["OPENAI_API_KEY"],
  },
  provides: ["executor"],
  depends: [],

  async setup(_ctx) {
    throw new Error("core-executor-openai: not implemented");
  },
};

export default plugin;
