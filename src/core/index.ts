import { join } from "path";
import { randomUUID } from "crypto";
import type { KaizenConfig } from "../types/plugin.js";
import { EventBus } from "./event-bus.js";
import { ServiceRegistry } from "./service-registry.js";
import { PluginManager } from "./plugin-manager.js";
import { createPluginContext } from "./context.js";
import { SecretsRegistry, createSecretsContext } from "./secrets.js";
import { PermissionEnforcer } from "./permission-enforcer.js";
import type { EnforcerMode } from "./permission-enforcer.js";
import { AuditLog } from "./audit-log.js";
import { initializeSandbox } from "./sandbox-bootstrap.js";
import { runInPluginScope } from "./plugin-scope.js";
import { DEFAULT_ENV_ALLOWLIST } from "./env-allowlist.js";
import { loadKaizenGlobalConfig } from "./kaizen-config.js";

export { PluginManager } from "./plugin-manager.js";
export { ServiceRegistry } from "./service-registry.js";

export { PLUGIN_API_VERSION } from "../types/plugin.js";
export type { KaizenPlugin, PluginContext } from "../types/plugin.js";
export { PermissionEnforcer } from "./permission-enforcer.js";

interface InitializedSystem {
  manager: PluginManager;
  eventBus: EventBus;
  serviceRegistry: ServiceRegistry;
  enforcer: PermissionEnforcer;
  auditLog: AuditLog;
  driver: Awaited<ReturnType<PluginManager["initialize"]>>["driver"];
}

export interface InitializePluginSystemOpts {
  lockfilePath: string;
  injectedEnforcer?: PermissionEnforcer;
}

export async function initializePluginSystem(
  kaizenConfig: KaizenConfig,
  opts: InitializePluginSystemOpts,
): Promise<InitializedSystem> {
  const { lockfilePath, injectedEnforcer } = opts;
  const eventBus = new EventBus();
  const serviceRegistry = new ServiceRegistry();

  let enforcer: PermissionEnforcer;
  if (injectedEnforcer) {
    enforcer = injectedEnforcer;
  } else {
    const mode = (process.env["KAIZEN_SANDBOX_MODE"] as EnforcerMode | undefined) ?? "enforce";
    const envAllowList = await resolveEnvAllowList(kaizenConfig);
    enforcer = new PermissionEnforcer({ mode, envAllowList });
    initializeSandbox(enforcer);
  }

  const auditLog = new AuditLog({
    rootDir: join(process.cwd(), ".kaizen", "audit"),
    sessionId: randomUUID(),
  });

  const trustLockfile = process.argv.includes("--trust-lockfile");
  const allowUnscoped = process.argv.includes("--allow-unscoped");
  const nonInteractive = process.argv.includes("--non-interactive");

  const manager = new PluginManager(
    kaizenConfig,
    eventBus, serviceRegistry,
    enforcer, auditLog,
    lockfilePath, { trustLockfile, allowUnscoped, nonInteractive },
  );
  const { driver } = await manager.initialize();
  return {
    manager, eventBus, serviceRegistry,
    enforcer, auditLog, driver,
  };
}

export interface RunHarnessOpts {
  kaizenConfig: KaizenConfig;
  lockfilePath: string;
  enforcer?: PermissionEnforcer;
}

export async function runHarness(opts: RunHarnessOpts): Promise<void> {
  const { kaizenConfig, lockfilePath, enforcer: injectedEnforcer } = opts;
  const init: InitializePluginSystemOpts = {
    lockfilePath,
    ...(injectedEnforcer !== undefined ? { injectedEnforcer } : {}),
  };
  const {
    manager, eventBus, serviceRegistry, enforcer, auditLog, driver,
  } = await initializePluginSystem(kaizenConfig, init);

  const driverConfig =
    (kaizenConfig[driver.name] as Record<string, unknown> | undefined) ?? {};
  const secretsCtx = createSecretsContext(new SecretsRegistry(), driver.name, {});
  const ctx = createPluginContext(
    driver.name, driverConfig, secretsCtx, eventBus, serviceRegistry,
    enforcer, () => "RUNNING", manager.getPublicApi(), manager.getLifecycleApi(),
  );

  try {
    await runInPluginScope(driver.name, async () => { await driver.start!(ctx); });
  } finally {
    try { await manager.unloadAll(); } catch (err) {
      console.error("[kaizen] error during plugin teardown:", err);
    }
    await auditLog.flush();
  }
}

export async function bootstrap(kaizenConfig: KaizenConfig, lockfilePath: string): Promise<void> {
  return runHarness({ kaizenConfig, lockfilePath });
}

/**
 * Resolve the effective env allow-list using precedence:
 *   1. Harness `env_allowlist` (if present, including [])
 *   2. User `defaults.env_allowlist` (if present, including [])
 *   3. Built-in DEFAULT_ENV_ALLOWLIST
 */
export async function resolveEnvAllowList(harnessConfig: KaizenConfig): Promise<string[]> {
  if (harnessConfig.env_allowlist !== undefined) return harnessConfig.env_allowlist;
  try {
    const global = await loadKaizenGlobalConfig();
    if (global.defaults?.env_allowlist !== undefined) return global.defaults.env_allowlist;
  } catch {
    // If global config fails to load, fall back to default. The CLI should
    // surface load errors before reaching here, but be defensive.
  }
  return DEFAULT_ENV_ALLOWLIST;
}
