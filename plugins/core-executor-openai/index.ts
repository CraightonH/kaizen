import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-executor-openai",
  apiVersion: "2.0.0",
  capabilities: { provides: ["core-lifecycle:executor.send"] },

  async setup(_ctx) {
    throw new Error("core-executor-openai: not implemented");
  },
};

export default plugin;
