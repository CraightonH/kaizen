import type { PluginContext, ToolDefinition, PluginManagerPublicApi, PluginManagerLifecycleApi } from "../types/plugin.js";
import type { ServiceToken } from "../types/plugin.js";
import type { EventBus } from "./event-bus.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
import type { ServiceRegistry } from "./service-registry.js";

export type CoreState = "INITIALIZING" | "READY" | "RUNNING" | "CLOSED";

function assertInitializing(state: CoreState, operation: string): void {
  if (state !== "INITIALIZING") {
    throw new Error(`Cannot ${operation} after initialization.`);
  }
}

export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  eventBus: EventBus,
  toolRegistry: ToolRegistry,
  executorRegistry: ExecutorRegistry,
  uiRegistry: UiRegistry,
  serviceRegistry: ServiceRegistry,
  getState: () => CoreState,
  pluginManagerPublicApi: PluginManagerPublicApi,
  pluginManagerLifecycleApi: PluginManagerLifecycleApi,
): PluginContext {
  return {
    config: pluginConfig,

    log(msg: string): void {
      console.log(`[${pluginName}] ${msg}`);
    },

    pluginManager: pluginManagerPublicApi,

    registerService<T>(token: ServiceToken<T>, impl: T): void {
      assertInitializing(getState(), "register services");
      serviceRegistry.register(token, impl, pluginName);
    },

    getService<T>(token: ServiceToken<T>): T {
      return serviceRegistry.get(token);
    },

    registerTool(tool: ToolDefinition): void {
      assertInitializing(getState(), "register tools");
      toolRegistry.register(tool, pluginName);
    },

    registerExecutor(impl) {
      assertInitializing(getState(), "register executor");
      executorRegistry.register(impl, pluginName);
    },

    registerUi(impl) {
      assertInitializing(getState(), "register UI provider");
      uiRegistry.register(impl, pluginName);
    },

    defineEvent(name: string): void {
      assertInitializing(getState(), "define events");
      eventBus.defineEvent(name, pluginName);
    },

    on(event: string, handler: Parameters<PluginContext["on"]>[1]): void {
      assertInitializing(getState(), "register event handlers");
      eventBus.on(event, handler, pluginName);
    },

    async emit(event: string, payload?: unknown): Promise<unknown[]> {
      return eventBus.emit(event, payload);
    },

    runtime: {
      get executor() {
        return executorRegistry.get();
      },
      get ui() {
        return uiRegistry.get();
      },
      tools: {
        list() {
          return toolRegistry.list();
        },
        execute(name: string, args: Record<string, unknown>) {
          return toolRegistry.execute(name, args);
        },
      },
      pluginManager: pluginManagerLifecycleApi,
    },
  };
}
