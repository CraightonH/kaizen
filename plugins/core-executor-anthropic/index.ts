import type { KaizenPlugin } from "../../src/types/plugin.js";
import { createLLMRuntime } from "../../src/core/llm.js";

const plugin: KaizenPlugin = {
  name: "core-executor-anthropic",
  apiVersion: "2.0.0",
  capabilities: { provides: ["core-lifecycle:executor.send"] },

  async setup(ctx) {
    const cfg = ctx.config as {
      model?: string;
      api_key_env?: string;
      api_key?: string;
      baseURL?: string;
    };

    if (!cfg.model) throw new Error("core-executor-anthropic: config.model is required");

    const executor = createLLMRuntime({
      adapter: "anthropic",
      model: cfg.model,
      ...(cfg.api_key_env !== undefined ? { api_key_env: cfg.api_key_env } : {}),
      ...(cfg.api_key !== undefined ? { api_key: cfg.api_key } : {}),
      ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
    });

    ctx.registerExecutor(executor);
  },
};

export default plugin;
