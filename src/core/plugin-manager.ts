import { createRequire } from "module";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import type { KaizenPlugin, KaizenConfig, PluginEntry, PluginManagerPublicApi, PluginManagerLifecycleApi } from "../types/plugin.js";
import { PLUGIN_API_VERSION } from "../types/plugin.js";
import { fatal, warn, debug } from "./errors.js";
import { RESERVED_KEYS, KAIZEN_HOME, KAIZEN_HOME_PLUGINS, PROJECT_PLUGINS } from "./config.js";
import type { EventBus } from "./event-bus.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
import type { ServiceRegistry } from "./service-registry.js";
import { createPluginContext } from "./context.js";
import type { CoreState } from "./context.js";
import type { PermissionEnforcer } from "./permission-enforcer.js";
import type { AuditLog } from "./audit-log.js";
import { runInPluginScope } from "./plugin-scope.js";
import { scanPluginEntryImports } from "./manifest-import-scan.js";
import { readLockfile, writeLockfile, upsertPluginEntry } from "./lockfile.js";
import { computePluginHash } from "./plugin-hash.js";
import { decideConsent } from "./consent-flow.js";

// ---------------------------------------------------------------------------
// Resolution paths (cached once per process)
// ---------------------------------------------------------------------------

function getBunGlobalRoot(): string {
  try {
    const line = execSync("bun pm ls --global 2>/dev/null", { timeout: 5000 })
      .toString().split("\n")[0] ?? "";
    const match = line.match(/^(\S+)\s+node_modules/);
    return match ? `${match[1]}/node_modules` : "";
  } catch { return ""; }
}

function getNpmGlobalRoot(): string {
  try {
    return execSync("npm root -g 2>/dev/null", { timeout: 5000 }).toString().trim();
  } catch { return ""; }
}

const BUN_GLOBAL_ROOT = getBunGlobalRoot();
const NPM_GLOBAL_ROOT = getNpmGlobalRoot();

export const RESOLVE_PATHS = [
  join(KAIZEN_HOME, "node_modules"),
  join(process.cwd(), ".kaizen/node_modules"),
  BUN_GLOBAL_ROOT,
  NPM_GLOBAL_ROOT,
  process.cwd() + "/node_modules",
].filter(Boolean);

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

export type Builtins = Record<string, KaizenPlugin>;

interface LoadedPlugin {
  plugin: KaizenPlugin;
  resolvedPath: string | null;
}

function loadPluginFromPath(path: string, name: string): LoadedPlugin | null {
  const req = createRequire(process.execPath);
  try {
    const mod = req(path) as { default?: unknown };
    const plugin = mod.default;
    if (
      typeof plugin !== "object" || plugin === null ||
      typeof (plugin as Record<string, unknown>)["name"] !== "string" ||
      typeof (plugin as Record<string, unknown>)["setup"] !== "function"
    ) {
      warn(`Plugin '${name}' does not export a valid KaizenPlugin. Skipping.`);
      return null;
    }
    return { plugin: plugin as KaizenPlugin, resolvedPath: path };
  } catch (err) {
    warn(`Failed to load plugin at '${path}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function resolvePlugin(name: string, builtins: Builtins): LoadedPlugin | null {
  if (builtins[name]) return { plugin: builtins[name]!, resolvedPath: null };
  const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");
  if (!isPath) {
    const projectPlugin = join(process.cwd(), PROJECT_PLUGINS, name);
    if (existsSync(projectPlugin)) return loadPluginFromPath(projectPlugin, name);
    const homePlugin = join(KAIZEN_HOME_PLUGINS, name);
    if (existsSync(homePlugin)) return loadPluginFromPath(homePlugin, name);
  }
  const req = createRequire(process.execPath);
  try {
    const resolved = isPath ? req.resolve(name) : req.resolve(name, { paths: RESOLVE_PATHS });
    return loadPluginFromPath(resolved, name);
  } catch (err) {
    warn(
      `Cannot find plugin '${name}'.\n` +
      `  Project-scoped: .kaizen/plugins/${name}/\n` +
      `  Global install: kaizen plugin install ${name}\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function bustRequireCache(name: string): void {
  const req = createRequire(process.execPath);
  try {
    const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");
    const resolved = isPath ? req.resolve(name) : req.resolve(name, { paths: RESOLVE_PATHS });
    delete req.cache[resolved];
  } catch {
    // Ignore — load() will surface resolution errors
  }
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

function topoSort(plugins: KaizenPlugin[]): KaizenPlugin[] {
  const nameToPlugin = new Map(plugins.map((p) => [p.name, p]));
  const roleToPlugin = new Map<string, KaizenPlugin>();
  for (const p of plugins) {
    for (const role of p.provides ?? []) roleToPlugin.set(role, p);
  }
  const inDegree = new Map(plugins.map((p) => [p.name, 0]));
  const edges = new Map<string, string[]>();
  for (const p of plugins) {
    for (const dep of p.depends ?? []) {
      const depPlugin = roleToPlugin.get(dep) ?? nameToPlugin.get(dep);
      if (!depPlugin) continue;
      const depName = depPlugin.name;
      if (depName === p.name) continue;
      const existing = edges.get(depName) ?? [];
      existing.push(p.name);
      edges.set(depName, existing);
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
    }
  }
  const queue = plugins.filter((p) => (inDegree.get(p.name) ?? 0) === 0);
  const sorted: KaizenPlugin[] = [];
  while (queue.length > 0) {
    const p = queue.shift()!;
    sorted.push(p);
    for (const dependent of edges.get(p.name) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        const plugin = nameToPlugin.get(dependent);
        if (plugin) queue.push(plugin);
      }
    }
  }
  if (sorted.length !== plugins.length) {
    fatal("Cycle detected in plugin dependencies. Check your kaizen.json 'plugins' list.");
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

interface PluginRecord {
  plugin: KaizenPlugin;
  entry: PluginEntry;
}

export class PluginManager {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly pendingLoads = new Set<string>();
  private readonly pendingUnloads = new Set<string>();
  private readonly pendingReloads = new Set<string>();

  constructor(
    private readonly config: KaizenConfig,
    private readonly builtins: Builtins,
    private readonly eventBus: EventBus,
    private readonly toolRegistry: ToolRegistry,
    private readonly executorRegistry: ExecutorRegistry,
    private readonly uiRegistry: UiRegistry,
    private readonly serviceRegistry: ServiceRegistry,
    private readonly enforcer: PermissionEnforcer,
    private readonly auditLog: AuditLog,
    private readonly lockfilePath: string,
    private readonly options: { trustLockfile: boolean; allowUnscoped: boolean; nonInteractive: boolean },
  ) {
    // Wire denial listener → audit log.
    this.enforcer.onDenial((r) => this.auditLog.record(r));
  }

  // --------------------------------------------------------------------------
  // Lockfile consent
  // --------------------------------------------------------------------------

  private consultLockfile(plugin: KaizenPlugin, pluginDir: string | null): boolean {
    // Built-ins with no pluginDir: pre-trusted; ship with the core binary.
    if (!pluginDir) return true;

    const lf = readLockfile(this.lockfilePath);
    const pkgPath = join(pluginDir, "package.json");
    const version = existsSync(pkgPath)
      ? ((JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "unknown")
      : "unknown";
    const hash = computePluginHash(pluginDir);
    const permissions = plugin.permissions ?? { tier: "trusted" };

    const decision = decideConsent({
      pluginName: plugin.name,
      version,
      hash,
      permissions,
      lockfile: lf,
      interactive: !this.options.nonInteractive && process.stdin.isTTY === true,
      allowUnscoped: this.options.allowUnscoped,
    });

    switch (decision.kind) {
      case "accept":
        return true;
      case "accept-and-record":
        writeLockfile(this.lockfilePath, upsertPluginEntry(lf, plugin.name, decision.entry));
        return true;
      case "prompt-scoped":
      case "prompt-unscoped":
        warn(`Plugin '${plugin.name}' requires consent. Run: kaizen plugin consent ${plugin.name}`);
        return false;
      case "refuse":
        warn(`Plugin '${plugin.name}' refused: ${decision.reason}`);
        return false;
    }
  }

  // --------------------------------------------------------------------------
  // Initialization (startup path — replaces loadPlugins)
  // --------------------------------------------------------------------------

  async initialize(): Promise<{ lifecycleProvider: KaizenPlugin }> {
    const resolvedPlugins: LoadedPlugin[] = [];
    for (const name of this.config.plugins) {
      if (RESERVED_KEYS.has(name)) {
        warn(`Plugin name '${name}' collides with reserved config key. Skipping.`);
        continue;
      }
      const loaded = resolvePlugin(String(name), this.builtins);
      if (!loaded) continue;
      const pluginDir = loaded.resolvedPath ? dirname(loaded.resolvedPath) : null;
      if (!this.consultLockfile(loaded.plugin, pluginDir)) continue;
      resolvedPlugins.push(loaded);
    }

    const sorted = topoSort(resolvedPlugins.map((r) => r.plugin));
    // Map plugin name → resolvedPath for import scan below.
    const resolvedPathMap = new Map(resolvedPlugins.map((r) => [r.plugin.name, r.resolvedPath]));

    const requiredRoles = new Set<string>();
    for (const p of sorted) {
      for (const dep of p.depends ?? []) {
        const isPluginName = sorted.some((q) => q.name === dep);
        if (!isPluginName) requiredRoles.add(dep);
      }
    }

    const loadedNames = new Set<string>();
    for (const plugin of sorted) {
      const pluginMajor = plugin.apiVersion.split(".")[0];
      if (pluginMajor !== PLUGIN_API_VERSION) {
        warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
      }
      const providesRequiredRole = (plugin.provides ?? []).some((r) => requiredRoles.has(r));
      const rPath = resolvedPathMap.get(plugin.name) ?? null;
      try {
        await this.setupPlugin(plugin, rPath);
        loadedNames.add(plugin.name);
        this.plugins.set(plugin.name, {
          plugin,
          entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "loaded" },
        });
        debug(`Plugin '${plugin.name}' initialized.`);
      } catch (err) {
        if (providesRequiredRole) {
          const role = (plugin.provides ?? []).find((r) => requiredRoles.has(r))!;
          fatal(`${plugin.name} (provides: ${role}) failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          if (err instanceof Error && err.stack) debug(err.stack);
          console.error(`[kaizen] error: plugin '${plugin.name}' failed to initialize:`, err instanceof Error ? err.message : err);
          this.plugins.set(plugin.name, {
            plugin,
            entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "failed" },
          });
        }
      }
    }

    // Role validation
    const roleProviders = new Map<string, string[]>();
    for (const [name, record] of this.plugins) {
      if (record.entry.status !== "loaded") continue;
      for (const role of record.plugin.provides ?? []) {
        const existing = roleProviders.get(role) ?? [];
        existing.push(name);
        roleProviders.set(role, existing);
      }
    }
    for (const role of requiredRoles) {
      const providers = roleProviders.get(role) ?? [];
      if (providers.length === 0) fatal(`No plugin provides role '${role}'. Add one to kaizen.json.`);
      if (providers.length > 1) fatal(`Multiple plugins provide role '${role}': ${providers.join(", ")}. Remove one.`);
    }

    // Warn on unclaimed config keys
    const claimedKeys = new Set(["plugins", ...loadedNames]);
    for (const key of Object.keys(this.config)) {
      if (!claimedKeys.has(key)) warn(`Unknown config key '${key}'. No plugin claimed it.`);
    }

    // Find lifecycle provider
    const lifecycleProviderName = roleProviders.get("lifecycle")?.[0];
    if (!lifecycleProviderName) fatal("No lifecycle plugin found. Add one to kaizen.json.");
    const lifecycleProvider = this.plugins.get(lifecycleProviderName!)?.plugin;
    if (!lifecycleProvider || typeof lifecycleProvider.start !== "function") {
      fatal("No lifecycle plugin found. Add one to kaizen.json.");
    }

    return { lifecycleProvider: lifecycleProvider! };
  }

  // --------------------------------------------------------------------------
  // Hot-reload API
  // --------------------------------------------------------------------------

  async load(name: string): Promise<void> {
    const loaded = resolvePlugin(name, this.builtins);
    if (!loaded) {
      warn(`Cannot load plugin '${name}': not found.`);
      return;
    }
    const { plugin, resolvedPath } = loaded;
    const pluginMajor = plugin.apiVersion.split(".")[0];
    if (pluginMajor !== PLUGIN_API_VERSION) {
      warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
    }
    const pluginDir = resolvedPath ? dirname(resolvedPath) : null;
    if (!this.consultLockfile(plugin, pluginDir)) {
      this.plugins.set(name, {
        plugin,
        entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "failed" },
      });
      warn(`Plugin '${name}' not loaded: consent refused or pending.`);
      return;
    }
    try {
      await this.setupPlugin(plugin, resolvedPath);
      this.plugins.set(name, {
        plugin,
        entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "loaded" },
      });
      debug(`Plugin '${name}' loaded.`);
    } catch (err) {
      this.plugins.set(name, {
        plugin,
        entry: { name: plugin.name, apiVersion: plugin.apiVersion, provides: plugin.provides ?? [], status: "failed" },
      });
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Plugin '${name}' failed to load: ${msg}`);
      const providesList = (plugin.provides ?? []).join(", ");
      if (providesList) warn(`Plugin '${name}' provides [${providesList}] but failed — role may be unavailable.`);
    }
  }

  async unload(name: string): Promise<void> {
    const record = this.plugins.get(name);
    if (!record) {
      warn(`Cannot unload plugin '${name}': not loaded.`);
      return;
    }
    this.toolRegistry.deregisterByPlugin(name);
    this.eventBus.deregisterByPlugin(name);
    this.serviceRegistry.deregisterByPlugin(name);
    this.executorRegistry.deregisterByPlugin(name);
    this.uiRegistry.deregisterByPlugin(name);
    this.enforcer.deregister(name);
    record.entry.status = "unloaded";
    this.plugins.delete(name);
    debug(`Plugin '${name}' unloaded.`);
  }

  async reload(name: string): Promise<void> {
    await this.unload(name);
    bustRequireCache(name);
    await this.load(name);
  }

  queueLoad(name: string): void { this.pendingLoads.add(name); }
  queueUnload(name: string): void { this.pendingUnloads.add(name); }
  queueReload(name: string): void { this.pendingReloads.add(name); }

  async drainPendingReloads(): Promise<void> {
    const loads = [...this.pendingLoads];
    const unloads = [...this.pendingUnloads];
    const reloads = [...this.pendingReloads];
    this.pendingLoads.clear();
    this.pendingUnloads.clear();
    this.pendingReloads.clear();
    for (const name of unloads) await this.unload(name);
    for (const name of loads) await this.load(name);
    for (const name of reloads) await this.reload(name);
  }

  list(): PluginEntry[] {
    return Array.from(this.plugins.values()).map((r) => ({ ...r.entry }));
  }

  // --------------------------------------------------------------------------
  // Scoped API surfaces
  // --------------------------------------------------------------------------

  getPublicApi(): PluginManagerPublicApi {
    return {
      load: (name) => this.load(name),
      unload: (name) => this.unload(name),
      reload: (name) => this.reload(name),
      queueLoad: (name) => this.queueLoad(name),
      queueUnload: (name) => this.queueUnload(name),
      queueReload: (name) => this.queueReload(name),
      list: () => this.list(),
    };
  }

  getLifecycleApi(): PluginManagerLifecycleApi {
    return { drainPendingReloads: () => this.drainPendingReloads() };
  }

  // --------------------------------------------------------------------------
  // Internal setup
  // --------------------------------------------------------------------------

  private async setupPlugin(plugin: KaizenPlugin, resolvedPath: string | null = null): Promise<void> {
    // Register the plugin's permission manifest (defaults to trusted).
    this.enforcer.register(plugin.name, plugin.permissions ?? { tier: "trusted" });
    // Scan imports after registration so check() has the manifest.
    if (resolvedPath !== null) this.scanAndCheckImports(plugin.name, resolvedPath);

    let pluginState: CoreState = "INITIALIZING";
    const pluginConfig = (this.config[plugin.name] as Record<string, unknown> | undefined) ?? {};
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      this.eventBus,
      this.toolRegistry,
      this.executorRegistry,
      this.uiRegistry,
      this.serviceRegistry,
      this.enforcer,
      () => pluginState,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
    await runInPluginScope(plugin.name, async () => { await plugin.setup(ctx); });
    pluginState = "READY";
  }

  private scanAndCheckImports(pluginName: string, resolvedPath: string): void {
    try {
      const imports = scanPluginEntryImports(resolvedPath);
      for (const mod of imports) {
        this.enforcer.check(pluginName, { kind: "import", module: mod });
      }
    } catch (err) {
      // Swallow IO errors on scan (best-effort); real enforcement happens via require patch.
      debug(`Import scan for '${pluginName}' failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
