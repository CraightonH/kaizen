import { createRequire } from "module";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { KaizenPlugin, KaizenConfig, PluginEntry, PluginManagerPublicApi, PluginManagerLifecycleApi } from "../types/plugin.js";
import { PLUGIN_API_VERSION } from "../types/plugin.js";
import { fatal, warn, debug } from "./errors.js";
import { RESERVED_KEYS, KAIZEN_HOME, KAIZEN_HOME_PLUGINS, PROJECT_PLUGINS } from "./config.js";
import type { EventBus } from "./event-bus.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { CapabilityRegistry } from "./capability-registry.js";
import { createPluginContext } from "./context.js";
import type { CoreState } from "./context.js";

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

function loadPluginFromPath(path: string, name: string): KaizenPlugin | null {
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
    return plugin as KaizenPlugin;
  } catch (err) {
    warn(`Failed to load plugin at '${path}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function resolvePlugin(name: string, builtins: Builtins): KaizenPlugin | null {
  if (builtins[name]) return builtins[name]!;
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
// Topological sort (Kahn's algorithm) — driven by capability provides/consumes
// ---------------------------------------------------------------------------

function resolveCapName(name: string, aliases: Record<string, string>): string {
  return aliases[name] ?? name;
}

function isCritical(plugin: KaizenPlugin, reg: CapabilityRegistry): boolean {
  const aliases = plugin.aliases ?? {};
  for (const raw of plugin.capabilities?.provides ?? []) {
    const cap = resolveCapName(raw, aliases);
    const spec = reg.getSpec(cap);
    if (spec?.cardinality === "one" && reg.consumersOf(cap).length > 0) return true;
  }
  return false;
}

function topoSort(plugins: KaizenPlugin[]): KaizenPlugin[] {
  const nameToPlugin = new Map(plugins.map((p) => [p.name, p]));

  // Map canonical capability name → list of plugins that provide it.
  const capToProviders = new Map<string, string[]>();
  for (const p of plugins) {
    const aliases = p.aliases ?? {};
    for (const raw of p.capabilities?.provides ?? []) {
      const cap = resolveCapName(raw, aliases);
      const existing = capToProviders.get(cap) ?? [];
      existing.push(p.name);
      capToProviders.set(cap, existing);
    }
  }

  const inDegree = new Map(plugins.map((p) => [p.name, 0]));
  const edges = new Map<string, string[]>();

  for (const p of plugins) {
    const aliases = p.aliases ?? {};
    const seen = new Set<string>();
    for (const raw of p.capabilities?.consumes ?? []) {
      const cap = resolveCapName(raw, aliases);
      for (const providerName of capToProviders.get(cap) ?? []) {
        if (providerName === p.name) continue;
        if (seen.has(providerName)) continue;
        seen.add(providerName);
        const existing = edges.get(providerName) ?? [];
        existing.push(p.name);
        edges.set(providerName, existing);
        inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
      }
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
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly serviceRegistry: ServiceRegistry,
  ) {}

  // --------------------------------------------------------------------------
  // Initialization (startup path — replaces loadPlugins)
  // --------------------------------------------------------------------------

  async initialize(): Promise<{ lifecycleProvider: KaizenPlugin }> {
    const resolved: KaizenPlugin[] = [];
    for (const name of this.config.plugins) {
      if (RESERVED_KEYS.has(name)) {
        warn(`Plugin name '${name}' collides with reserved config key. Skipping.`);
        continue;
      }
      const plugin = resolvePlugin(String(name), this.builtins);
      if (plugin) resolved.push(plugin);
    }

    const sorted = topoSort(resolved);

    // PASS 1: register provide/consume metadata so criticality + validateAll see full graph
    for (const plugin of sorted) {
      const aliases = plugin.aliases ?? {};
      for (const raw of plugin.capabilities?.provides ?? []) {
        this.capabilityRegistry.addProvider(resolveCapName(raw, aliases), plugin.name);
      }
      for (const raw of plugin.capabilities?.consumes ?? []) {
        this.capabilityRegistry.addConsumer(resolveCapName(raw, aliases), plugin.name);
      }
    }

    // PASS 2: call setup() in topo order.
    const loadedNames = new Set<string>();
    for (const plugin of sorted) {
      const pluginMajor = plugin.apiVersion.split(".")[0];
      if (pluginMajor !== PLUGIN_API_VERSION) {
        warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
      }
      const critical = isCritical(plugin, this.capabilityRegistry);
      try {
        await this.setupPlugin(plugin);
        loadedNames.add(plugin.name);
        this.plugins.set(plugin.name, {
          plugin,
          entry: {
            name: plugin.name,
            apiVersion: plugin.apiVersion,
            capabilities: plugin.capabilities ?? {},
            status: "loaded",
          },
        });
        debug(`Plugin '${plugin.name}' initialized.`);
      } catch (err) {
        if (critical) {
          fatal(`${plugin.name} (provides critical capability) failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (err instanceof Error && err.stack) debug(err.stack);
        console.error(`[kaizen] error: plugin '${plugin.name}' failed to initialize:`, err instanceof Error ? err.message : err);
        this.plugins.set(plugin.name, {
          plugin,
          entry: {
            name: plugin.name,
            apiVersion: plugin.apiVersion,
            capabilities: plugin.capabilities ?? {},
            status: "failed",
          },
        });
      }
    }

    // PASS 3: validate capability cardinalities + referenced-but-undefined
    try {
      this.capabilityRegistry.validateAll();
    } catch (err) {
      fatal(err instanceof Error ? err.message : String(err));
    }

    // Warn on unclaimed config keys
    const claimedKeys = new Set(["plugins", "extends", ...loadedNames]);
    for (const key of Object.keys(this.config)) {
      if (!claimedKeys.has(key)) warn(`Unknown config key '${key}'. No plugin claimed it.`);
    }

    // Resolve lifecycle provider — sole provider of core-lifecycle:lifecycle.drive
    const lifeProviders = this.capabilityRegistry.providersOf("core-lifecycle:lifecycle.drive");
    if (lifeProviders.length === 0) fatal("No lifecycle plugin found. Add one to kaizen.json.");
    const lifecycleProvider = this.plugins.get(lifeProviders[0]!)?.plugin;
    if (!lifecycleProvider || typeof lifecycleProvider.start !== "function") {
      fatal("No lifecycle plugin found. Add one to kaizen.json.");
    }

    return { lifecycleProvider: lifecycleProvider! };
  }

  // --------------------------------------------------------------------------
  // Hot-reload API
  // --------------------------------------------------------------------------

  async load(name: string): Promise<void> {
    const plugin = resolvePlugin(name, this.builtins);
    if (!plugin) {
      warn(`Cannot load plugin '${name}': not found.`);
      return;
    }
    const pluginMajor = plugin.apiVersion.split(".")[0];
    if (pluginMajor !== PLUGIN_API_VERSION) {
      warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
    }
    const aliases = plugin.aliases ?? {};
    for (const raw of plugin.capabilities?.provides ?? []) {
      this.capabilityRegistry.addProvider(resolveCapName(raw, aliases), plugin.name);
    }
    for (const raw of plugin.capabilities?.consumes ?? []) {
      this.capabilityRegistry.addConsumer(resolveCapName(raw, aliases), plugin.name);
    }
    try {
      await this.setupPlugin(plugin);
      this.plugins.set(name, {
        plugin,
        entry: {
          name: plugin.name,
          apiVersion: plugin.apiVersion,
          capabilities: plugin.capabilities ?? {},
          status: "loaded",
        },
      });
      try {
        this.capabilityRegistry.validateAll();
      } catch (err) {
        warn(`Capability validation after loading '${name}': ${err instanceof Error ? err.message : String(err)}`);
      }
      debug(`Plugin '${name}' loaded.`);
    } catch (err) {
      this.plugins.set(name, {
        plugin,
        entry: {
          name: plugin.name,
          apiVersion: plugin.apiVersion,
          capabilities: plugin.capabilities ?? {},
          status: "failed",
        },
      });
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Plugin '${name}' failed to load: ${msg}`);
      const provList = (plugin.capabilities?.provides ?? []).join(", ");
      if (provList) warn(`Plugin '${name}' provides [${provList}] but failed — capability may be unavailable.`);
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
    this.capabilityRegistry.deregisterByPlugin(name);
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

  private async setupPlugin(plugin: KaizenPlugin): Promise<void> {
    let pluginState: CoreState = "INITIALIZING";
    const pluginConfig = (this.config[plugin.name] as Record<string, unknown> | undefined) ?? {};
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      this.eventBus,
      this.toolRegistry,
      this.executorRegistry,
      this.uiRegistry,
      this.capabilityRegistry,
      this.serviceRegistry,
      () => pluginState,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
    await plugin.setup(ctx);
    pluginState = "READY";
  }
}
