import type { PluginContext, PluginManagerPublicApi, PluginManagerLifecycleApi, SecretsContext } from "../types/plugin.js";
import type { ServiceToken } from "../types/plugin.js";
import type { EventBus } from "./event-bus.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
import type { CapabilityRegistry } from "./capability-registry.js";

export type CoreState = "INITIALIZING" | "READY" | "RUNNING" | "CLOSED";

function assertInitializing(state: CoreState, operation: string): void {
  if (state !== "INITIALIZING") {
    throw new Error(`Cannot ${operation} after initialization.`);
  }
}

export function createPluginContext(
  pluginName: string,
  pluginConfig: Record<string, unknown>,
  secretsContext: SecretsContext,
  eventBus: EventBus,
  capabilityRegistry: CapabilityRegistry,
  serviceRegistry: ServiceRegistry,
  enforcer: PermissionEnforcer,
  getState: () => CoreState,
  pluginManagerPublicApi: PluginManagerPublicApi,
  pluginManagerLifecycleApi: PluginManagerLifecycleApi,
): PluginContext {
  const io = createCtxIo(pluginName, enforcer);
  return {
    config: pluginConfig,

    log(msg: string): void {
      console.log(`[${pluginName}] ${msg}`);
    },

    pluginManager: pluginManagerPublicApi,

    fs: io.fs,
    net: io.net,
    secrets: secretsContext,
    exec: io.exec,

    registerService<T>(token: ServiceToken<T>, impl: T): void {
      assertInitializing(getState(), "register services");
      serviceRegistry.register(token, impl, pluginName);
    },

    getService<T>(token: ServiceToken<T>): T {
      return serviceRegistry.get(token);
    },

    defineCapability(name, spec) {
      assertInitializing(getState(), "define capabilities");
      capabilityRegistry.define(name, pluginName, spec);
    },

    defineEvent(name: string): void {
      assertInitializing(getState(), "define events");
      eventBus.defineEvent(name, pluginName);
    },

    on(event: string, handler: Parameters<PluginContext["on"]>[1]): void {
      assertInitializing(getState(), "register event handlers");
      enforcer.check(pluginName, { kind: "events.subscribe", event });
      eventBus.on(event, handler, pluginName);
    },

    async emit(event: string, payload?: unknown): Promise<unknown[]> {
      return eventBus.emit(event, payload);
    },

    runtime: {
      pluginManager: pluginManagerLifecycleApi,
    },
  };
}
