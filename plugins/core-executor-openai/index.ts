import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-executor-openai",
  apiVersion: "2.0.0",
  permissions: {
    tier: "scoped",
    net: { connect: ["api.openai.com:443"] },
    env: ["OPENAI_API_KEY"],
  },
  capabilities: { provides: ["core-lifecycle:executor.send"] },

  config: {
    schema: {
      properties: {
        model: { type: "string" },
        baseURL: { type: "string" },
      },
      required: ["model"],
    },
    defaults: { model: "gpt-4o" },
    secrets: ["api_key"],
  },

  async setup(_ctx) {
    throw new Error("core-executor-openai: not implemented");
  },
};

export default plugin;
