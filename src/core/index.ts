import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { loadPlugins, type Builtins } from "./loader.js";
import { createPluginContext } from "./context.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";

/**
 * Bootstrap the kaizen runtime.
 *
 * @param kaizenConfig  Parsed kaizen.json
 * @param builtins      Pre-loaded built-in plugins (avoids dynamic require in compiled binary)
 */
export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<void> {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const executorRegistry = new ExecutorRegistry();

  const { lifecycleProvider, state } = await loadPlugins(
    kaizenConfig,
    builtins,
    eventBus,
    toolRegistry,
    executorRegistry,
  );

  // Build a context for the lifecycle provider to use during start()
  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const ctx = createPluginContext(
    lifecycleProvider.name,
    lifecycleConfig,
    eventBus,
    toolRegistry,
    executorRegistry,
    () => state.current,
  );

  state.current = "RUNNING";
  try {
    await lifecycleProvider.start!(ctx);
  } finally {
    state.current = "CLOSED";
  }
}
