import { join } from "path";
import { randomUUID } from "crypto";
import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
import { PluginManager, type Builtins } from "./plugin-manager.js";
import { createPluginContext } from "./context.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import { initializeSandbox } from "./sandbox-bootstrap.js";
import { runInPluginScope } from "./plugin-scope.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";
export type { Builtins } from "./plugin-manager.js";

export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<void> {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const executorRegistry = new ExecutorRegistry();
  const uiRegistry = new UiRegistry();
  const serviceRegistry = new ServiceRegistry();

  const enforcer = new PermissionEnforcer({ mode: "log-only" });
  initializeSandbox(enforcer);
  const auditLog = new AuditLog({
    rootDir: join(process.cwd(), ".kaizen", "audit"),
    sessionId: randomUUID(),
  });

  const manager = new PluginManager(
    kaizenConfig, builtins,
    eventBus, toolRegistry, executorRegistry, uiRegistry, serviceRegistry,
    enforcer, auditLog,
  );

  const { lifecycleProvider } = await manager.initialize();

  const lifecycleConfig =
    (kaizenConfig[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const ctx = createPluginContext(
    lifecycleProvider.name,
    lifecycleConfig,
    eventBus,
    toolRegistry,
    executorRegistry,
    uiRegistry,
    serviceRegistry,
    enforcer,
    () => "RUNNING",
    manager.getPublicApi(),
    manager.getLifecycleApi(),
  );

  try {
    await runInPluginScope(lifecycleProvider.name, async () => { await lifecycleProvider.start!(ctx); });
  } finally {
    await auditLog.flush();
  }
}
