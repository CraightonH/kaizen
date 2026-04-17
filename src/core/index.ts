import { join } from "path";
import { randomUUID } from "crypto";
import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ToolRegistry } from "./tool-registry.js";
import { ExecutorRegistry } from "./executor-registry.js";
import { UiRegistry } from "./ui-registry.js";
import { ServiceRegistry } from "./service-registry.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { PluginManager, type Builtins } from "./plugin-manager.js";
import { createPluginContext } from "./context.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import type { EnforcerMode } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import { initializeSandbox } from "./sandbox-bootstrap.js";
import { runInPluginScope } from "./plugin-scope.js";

export { CapabilityRegistry } from "./capability-registry.js";
export { PluginManager } from "./plugin-manager.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";
export type { Builtins } from "./plugin-manager.js";
export { PermissionEnforcer } from "./permission-enforcer.js";

interface InitializedSystem {
  capabilityRegistry: CapabilityRegistry;
  manager: PluginManager;
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  executorRegistry: ExecutorRegistry;
  uiRegistry: UiRegistry;
  serviceRegistry: ServiceRegistry;
  enforcer: PermissionEnforcer;
  auditLog: AuditLog;
  lifecycleProvider: Awaited<ReturnType<PluginManager["initialize"]>>["lifecycleProvider"];
}

export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
  injectedEnforcer?: PermissionEnforcer,
): Promise<InitializedSystem> {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const executorRegistry = new ExecutorRegistry();
  const uiRegistry = new UiRegistry();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();

  let enforcer: PermissionEnforcer;
  if (injectedEnforcer) {
    enforcer = injectedEnforcer;
    // caller already called initializeSandbox
  } else {
    const mode = (process.env["KAIZEN_SANDBOX_MODE"] as EnforcerMode | undefined) ?? "enforce";
    enforcer = new PermissionEnforcer({ mode });
    initializeSandbox(enforcer);
  }

  const auditLog = new AuditLog({
    rootDir: join(process.cwd(), ".kaizen", "audit"),
    sessionId: randomUUID(),
  });

  const trustLockfile = process.argv.includes("--trust-lockfile");
  const allowUnscoped = process.argv.includes("--allow-unscoped");
  const nonInteractive = process.argv.includes("--non-interactive");
  const lockfilePath = join(process.cwd(), "kaizen.permissions.lock");

  const manager = new PluginManager(
    kaizenConfig, builtins,
    eventBus, toolRegistry, executorRegistry, uiRegistry, capabilityRegistry, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, { trustLockfile, allowUnscoped, nonInteractive },
  );
  const { lifecycleProvider } = await manager.initialize();
  return {
    capabilityRegistry, manager, eventBus, toolRegistry,
    executorRegistry, uiRegistry, serviceRegistry,
    enforcer, auditLog, lifecycleProvider,
  };
}

export interface RunHarnessOpts {
  kaizenConfig: KaizenConfig;
  builtins?: Builtins;
  enforcer?: PermissionEnforcer;
}

export async function runHarness(opts: RunHarnessOpts): Promise<void> {
  const { kaizenConfig, builtins = {}, enforcer: injectedEnforcer } = opts;
  const {
    manager, eventBus, toolRegistry, executorRegistry, uiRegistry,
    capabilityRegistry, serviceRegistry, enforcer, auditLog, lifecycleProvider,
  } = await initializePluginSystem(kaizenConfig, builtins, injectedEnforcer);

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

export async function bootstrap(
  kaizenConfig: KaizenConfig,
  builtins: Builtins = {},
): Promise<void> {
  return runHarness({ kaizenConfig, builtins });
}
