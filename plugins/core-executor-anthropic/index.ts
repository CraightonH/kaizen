import type { KaizenPlugin } from "../../src/types/plugin.js";
import { createLLMRuntime } from "../../src/core/llm.js";

const plugin: KaizenPlugin = {
  name: "core-executor-anthropic",
  apiVersion: "2.0.0",
  capabilities: { provides: ["core-lifecycle:executor.send"] },

  permissions: {
    tier: "scoped",
    net: { connect: ["api.anthropic.com:443"] },
    env: ["ANTHROPIC_API_KEY"],
  },

  async setup(ctx) {
    const cfg = ctx.config as {
      model?: string;
      api_key_env?: string;
      api_key?: string;
      baseURL?: string;
    };

    if (!cfg.model) throw new Error("core-executor-anthropic: config.model is required");

    // Resolve API key via ctx.secrets (permission-gated env access).
    // cfg.api_key takes precedence; fall back to api_key_env (default: ANTHROPIC_API_KEY).
    const envVarName = cfg.api_key_env ?? "ANTHROPIC_API_KEY";
    const resolvedApiKey = cfg.api_key ?? ctx.secrets.get(envVarName) ?? undefined;

    const executor = createLLMRuntime({
      adapter: "anthropic",
      model: cfg.model,
      ...(resolvedApiKey !== undefined ? { api_key: resolvedApiKey } : {}),
      ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
    });

    ctx.registerExecutor(executor);
  },
};

export default plugin;
