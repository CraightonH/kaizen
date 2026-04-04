import type { KaizenConfig, GlobalConfig } from "../types/plugin.js";
import { loadGlobalConfig } from "./config.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { createLLMRuntime } from "./llm.js";
import { loadPlugins, type Builtins } from "./loader.js";
import { fatal } from "./errors.js";
import { createPluginContext } from "./context.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";

/**
 * Bootstrap the kaizen runtime.
 *
 * @param kaizenConfig  Parsed kaizen.json
 * @param builtins      Pre-loaded built-in plugins (avoids dynamic require in compiled binary)
 * @param globalConfig  Optional parsed ~/.kaizen/config.json (loaded from disk if omitted)
 */
export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
  globalConfig?: GlobalConfig,
): Promise<void> {
  const global = globalConfig ?? loadGlobalConfig();

  const providerConfig = global.providers[kaizenConfig.provider];
  if (!providerConfig) {
    fatal(
      `Provider '${kaizenConfig.provider}' not found in ~/.kaizen/config.json. ` +
        `Available providers: ${Object.keys(global.providers).join(", ") || "(none)"}`,
    );
  }

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const llmRuntime = createLLMRuntime(providerConfig);

  const { lifecycleProvider, state } = await loadPlugins(
    kaizenConfig,
    builtins,
    eventBus,
    toolRegistry,
    llmRuntime,
  );

  // Build a context for the lifecycle provider to use during start()
  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const ctx = createPluginContext(
    lifecycleProvider.name,
    lifecycleConfig,
    eventBus,
    toolRegistry,
    llmRuntime,
    () => state.current,
  );

  state.current = "RUNNING";
  try {
    await lifecycleProvider.start!(ctx);
  } finally {
    state.current = "CLOSED";
  }
}
