import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { PluginManager, type Builtins } from "./plugin-manager.js";
import { createPluginContext } from "./context.js";

export { CapabilityRegistry } from "./capability-registry.js";
export { PluginManager } from "./plugin-manager.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";
export type { Builtins } from "./plugin-manager.js";

interface InitializedSystem {
  capabilityRegistry: CapabilityRegistry;
  manager: PluginManager;
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  executorRegistry: ExecutorRegistry;
  uiRegistry: UiRegistry;
  serviceRegistry: ServiceRegistry;
  lifecycleProvider: Awaited<ReturnType<PluginManager["initialize"]>>["lifecycleProvider"];
}

export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<InitializedSystem> {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const executorRegistry = new ExecutorRegistry();
  const uiRegistry = new UiRegistry();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();

  const manager = new PluginManager(
    kaizenConfig, builtins,
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
  );
  const { lifecycleProvider } = await manager.initialize();
  return {
    capabilityRegistry, manager, eventBus, toolRegistry,
    executorRegistry, uiRegistry, serviceRegistry, lifecycleProvider,
  };
}

export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<void> {
  const {
    manager, eventBus, toolRegistry, executorRegistry, uiRegistry,
    capabilityRegistry, serviceRegistry, lifecycleProvider,
  } = await initializePluginSystem(kaizenConfig, builtins);

  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const ctx = createPluginContext(
    lifecycleProvider.name,
    lifecycleConfig,
    eventBus,
    toolRegistry,
    executorRegistry,
    uiRegistry,
    capabilityRegistry,
    serviceRegistry,
    () => "RUNNING",
    manager.getPublicApi(),
    manager.getLifecycleApi(),
  );

  try {
    await lifecycleProvider.start!(ctx);
  } finally {
    // state is implicitly CLOSED after start() returns
  }
}
