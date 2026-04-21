import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import type { KaizenPlugin, KaizenConfig, KaizenGlobalConfig, PluginEntry, PluginManagerPublicApi, PluginManagerLifecycleApi } from "../types/plugin.js";
import { PLUGIN_API_VERSION } from "../types/plugin.js";
import { mergePluginConfig, separateSecrets, applyEnvOverrides } from "./config-merge.js";
import { validateConfig, validateSchemaItself } from "./config-validator.js";
import { SecretsRegistry, createSecretsContext, SecretsProviderToken } from "./secrets.js";
import { fatal, warn, debug } from "./errors.js";
import { RESERVED_KEYS } from "./config.js";
import { pluginInstallDir } from "./kaizen-config.js";
import { parseRef } from "./ref-resolver.js";
import type { EventBus } from "./event-bus.js";
import type { ServiceRegistry } from "./service-registry.js";
import type { CapabilityRegistry } from "./capability-registry.js";
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
// Package root resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from a resolved entry file (or directory) to the nearest ancestor
 * directory that contains a package.json. Used for hash computation and
 * package.json reads when the plugin's entry points into a subdirectory
 * (e.g. dist/index.js).
 */
export function findPackageRoot(startPath: string): string {
  let dir =
    existsSync(startPath) && statSync(startPath).isDirectory()
      ? startPath
      : dirname(startPath);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json found walking up from ${startPath}`);
    dir = parent;
  }
}

export async function isInstalled(
  marketplaceId: string, name: string, version: string,
): Promise<boolean> {
  return existsSync(join(pluginInstallDir(marketplaceId, name, version), "package.json"));
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

export type Builtins = Record<string, KaizenPlugin>;

interface LoadedPlugin {
  plugin: KaizenPlugin;
  resolvedPath: string | null;
}

async function loadPluginFromPath(dirOrFile: string, name: string): Promise<LoadedPlugin | null> {
  let entryPath: string;
  let resolvedPath: string;
  try {
    const stat = statSync(dirOrFile);
    if (stat.isDirectory()) {
      const pkgPath = join(dirOrFile, "package.json");
      if (!existsSync(pkgPath)) {
        warn(`Plugin '${name}': no package.json at ${dirOrFile}. Skipping.`);
        return null;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string; module?: string };
      const entry = pkg.module ?? pkg.main ?? "index.js";
      entryPath = join(dirOrFile, entry);
      resolvedPath = entryPath;
    } else {
      entryPath = dirOrFile;
      resolvedPath = dirOrFile;
    }
  } catch (err) {
    warn(`Plugin '${name}' path '${dirOrFile}' is not accessible: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  try {
    // Cache-bust query so reload() re-imports the module (ESM import cache has no
    // user-facing invalidation API). Cost: extra in-memory module copy per reload.
    const url = pathToFileURL(entryPath).href + `?t=${Date.now()}`;
    const mod = (await import(url)) as { default?: unknown };
    const plugin = mod.default;
    if (
      typeof plugin !== "object" || plugin === null ||
      typeof (plugin as Record<string, unknown>)["name"] !== "string" ||
      typeof (plugin as Record<string, unknown>)["setup"] !== "function"
    ) {
      warn(`Plugin '${name}' does not export a valid KaizenPlugin. Skipping.`);
      return null;
    }
    return { plugin: plugin as KaizenPlugin, resolvedPath };
  } catch (err) {
    warn(`Failed to load plugin at '${entryPath}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function loadPluginFromMarketplaceInstall(
  marketplaceId: string, pluginName: string, version: string, displayName: string,
): Promise<LoadedPlugin | null> {
  const dir = pluginInstallDir(marketplaceId, pluginName, version);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { main?: string; module?: string };
  const entry = pkg.module ?? pkg.main ?? "index.js";
  const abs = join(dir, entry);
  try {
    const mod = (await import(abs)) as { default?: unknown };
    const plugin = mod.default;
    if (
      typeof plugin !== "object" || plugin === null ||
      typeof (plugin as Record<string, unknown>)["name"] !== "string" ||
      typeof (plugin as Record<string, unknown>)["setup"] !== "function"
    ) {
      warn(`Plugin '${displayName}' at ${abs} does not export a valid KaizenPlugin. Skipping.`);
      return null;
    }
    return { plugin: plugin as KaizenPlugin, resolvedPath: abs };
  } catch (err) {
    warn(`Failed to load plugin at '${abs}': ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function resolvePlugin(name: string, builtins: Builtins): Promise<LoadedPlugin | null> {
  if (builtins[name]) return { plugin: builtins[name]!, resolvedPath: null };

  const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");

  // Canonical marketplace ref: "<id>/<name>@<version>" → marketplace install dir.
  if (!isPath) {
    try {
      const parsed = parseRef(name);
      if (parsed.kind === "marketplace" && parsed.version) {
        const loaded = await loadPluginFromMarketplaceInstall(
          parsed.marketplaceId, parsed.name, parsed.version, name,
        );
        if (loaded) return loaded;
      }
    } catch { /* not a canonical ref — fall through */ }
  }

  // Local path (./, ../, /) — load directly.
  if (isPath) {
    const abs = name.startsWith("/") ? name : join(process.cwd(), name);
    if (existsSync(abs)) return loadPluginFromPath(abs, name);
  }

  warn(
    `Cannot find plugin '${name}'.\n` +
    `  Install from marketplace: kaizen install <marketplace>/${name}@<version>\n` +
    `  Or reference a local path: "./path/to/plugin"`,
  );
  return null;
}

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm) — driven by capability provides/consumes
// ---------------------------------------------------------------------------

function resolveCapName(name: string, aliases: Record<string, string>): string {
  return aliases[name] ?? name;
}

function isCritical(plugin: KaizenPlugin, reg: CapabilityRegistry): boolean {
  if (plugin.lifecycle === true) return true;
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
  private readonly secretsRegistry = new SecretsRegistry();

  constructor(
    private readonly config: KaizenConfig,
    private readonly builtins: Builtins,
    private readonly eventBus: EventBus,
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly serviceRegistry: ServiceRegistry,
    private readonly enforcer: PermissionEnforcer,
    private readonly auditLog: AuditLog,
    private readonly lockfilePath: string,
    private readonly options: { trustLockfile: boolean; allowUnscoped: boolean; nonInteractive: boolean },
    private readonly globalConfig?: KaizenGlobalConfig,
  ) {
    // Wire denial listener → audit log.
    this.enforcer.onDenial((r) => this.auditLog.record(r));
  }

  // --------------------------------------------------------------------------
  // Lockfile consent
  // --------------------------------------------------------------------------

  /**
   * @param persistOnAcceptAndRecord - When false (runtime path), demotes
   *   `accept-and-record` to a silent accept without writing the lockfile.
   *   Read-only filesystems (CI, sealed images) would fail on write; explicit
   *   commands (kaizen install / plugin consent) pass true to persist.
   */
  private consultLockfile(
    plugin: KaizenPlugin,
    pluginDir: string | null,
    persistOnAcceptAndRecord = false,
  ): boolean {
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
        if (persistOnAcceptAndRecord) {
          writeLockfile(this.lockfilePath, upsertPluginEntry(lf, plugin.name, decision.entry));
        } else {
          debug(`would record consent for '${plugin.name}'; run \`kaizen plugin consent ${plugin.name}\` to persist`);
        }
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
      const loaded = await resolvePlugin(String(name), this.builtins);
      if (!loaded) continue;
      const pluginDir = loaded.resolvedPath ? findPackageRoot(loaded.resolvedPath) : null;
      if (!this.consultLockfile(loaded.plugin, pluginDir)) continue;
      resolvedPlugins.push(loaded);
    }

    const sorted = topoSort(resolvedPlugins.map((r) => r.plugin));
    // Map plugin name → resolvedPath for import scan below.
    const resolvedPathMap = new Map(resolvedPlugins.map((r) => [r.plugin.name, r.resolvedPath]));

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
      const rPath = resolvedPathMap.get(plugin.name) ?? null;
      try {
        await this.setupPlugin(plugin, rPath);
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

    // Resolve lifecycle provider — the one plugin with `lifecycle: true`.
    // Core's single cross-plugin contract: call start() on the session driver.
    const lifecyclePluginNames: string[] = [];
    for (const [name, entry] of this.plugins) {
      if (entry.plugin.lifecycle === true && entry.entry.status === "loaded") {
        lifecyclePluginNames.push(name);
      }
    }
    if (lifecyclePluginNames.length === 0) {
      fatal("No lifecycle plugin found. A plugin with 'lifecycle: true' must be loaded. Add one to kaizen.json.");
    }
    if (lifecyclePluginNames.length > 1) {
      const quoted = lifecyclePluginNames.map((n) => `'${n}'`).join(", ");
      fatal(
        `Multiple lifecycle plugins loaded: ${quoted}. ` +
        `A harness may have exactly one plugin with 'lifecycle: true'. Remove one from your kaizen.json.`,
      );
    }
    const lifecycleName = lifecyclePluginNames[0]!;
    const lifecycleProvider = this.plugins.get(lifecycleName)?.plugin;
    if (!lifecycleProvider || typeof lifecycleProvider.start !== "function") {
      fatal(`Plugin '${lifecycleName}' declares 'lifecycle: true' but does not export a start() function.`);
    }

    return { lifecycleProvider: lifecycleProvider! };
  }

  // --------------------------------------------------------------------------
  // Hot-reload API
  // --------------------------------------------------------------------------

  async load(name: string): Promise<void> {
    const loaded = await resolvePlugin(name, this.builtins);
    if (!loaded) {
      warn(`Cannot load plugin '${name}': not found.`);
      return;
    }
    const { plugin, resolvedPath } = loaded;
    const pluginMajor = plugin.apiVersion.split(".")[0];
    if (pluginMajor !== PLUGIN_API_VERSION) {
      warn(`Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`);
    }
    const pluginDir = resolvedPath ? findPackageRoot(resolvedPath) : null;
    if (!this.consultLockfile(plugin, pluginDir)) {
      this.plugins.set(name, {
        plugin,
        entry: {
          name: plugin.name,
          apiVersion: plugin.apiVersion,
          capabilities: plugin.capabilities ?? {},
          status: "failed",
        },
      });
      warn(`Plugin '${name}' not loaded: consent refused or pending.`);
      return;
    }
    const aliases = plugin.aliases ?? {};
    for (const raw of plugin.capabilities?.provides ?? []) {
      this.capabilityRegistry.addProvider(resolveCapName(raw, aliases), plugin.name);
    }
    for (const raw of plugin.capabilities?.consumes ?? []) {
      this.capabilityRegistry.addConsumer(resolveCapName(raw, aliases), plugin.name);
    }
    try {
      await this.setupPlugin(plugin, resolvedPath);
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
    this.eventBus.deregisterByPlugin(name);
    this.serviceRegistry.deregisterByPlugin(name);
    this.enforcer.deregister(name);
    this.capabilityRegistry.deregisterByPlugin(name);
    record.entry.status = "unloaded";
    this.plugins.delete(name);
    debug(`Plugin '${name}' unloaded.`);
  }

  async reload(name: string): Promise<void> {
    await this.unload(name);
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

    // Merge config layers
    const harnessConfig = (this.config[plugin.name] as Record<string, unknown> | undefined) ?? {};
    const globalDefaults = (this.globalConfig?.defaults?.[plugin.name] as Record<string, unknown> | undefined) ?? {};
    const merged = mergePluginConfig(plugin.config, globalDefaults, harnessConfig);

    // Separate secrets from non-secret config
    const { config: pluginConfig, secretRefs } = separateSecrets(merged, plugin.config?.secrets ?? []);

    // Apply env overrides to non-secret config
    applyEnvOverrides(plugin.name, pluginConfig, plugin.config?.schema);

    // Validate non-secret config against schema
    if (plugin.config?.schema) {
      if (!validateSchemaItself(plugin.config.schema)) {
        fatal(`${plugin.name}: config.schema is not valid JSON Schema`);
      }
      const errors = validateConfig(plugin.config.schema, pluginConfig);
      if (errors.length > 0) {
        fatal(`${plugin.name} config invalid:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`);
      }
    }

    // Check every declared secret's provider is registered
    for (const [key, ref] of Object.entries(secretRefs)) {
      const providerName = typeof ref === "string" ? "kaizen" : ref.provider;
      if (!this.secretsRegistry.getProvider(providerName)) {
        fatal(
          `${plugin.name}: secret '${key}' targets provider '${providerName}' but no plugin provides it.\n` +
          `  Install a provider: kaizen install <provider-plugin>\n` +
          `  Or change the ref: kaizen config set ${plugin.name} ${key} '{"provider":"kaizen","ref":"..."}'`,
        );
      }
    }

    // Prefetch declared secrets in background (errors are logged, not fatal)
    await this.secretsRegistry.prefetchForPlugin(plugin.name, secretRefs);

    // Build secrets context for this plugin
    const secretsCtx = createSecretsContext(this.secretsRegistry, plugin.name, secretRefs);

    let pluginState: CoreState = "INITIALIZING";
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      secretsCtx,
      this.eventBus,
      this.capabilityRegistry,
      this.serviceRegistry,
      this.enforcer,
      () => pluginState,
      this.getPublicApi(),
      this.getLifecycleApi(),
    );
    await runInPluginScope(plugin.name, async () => { await plugin.setup(ctx); });
    pluginState = "READY";

    // After setup, check if this plugin provided a secret provider
    // (core-secrets calls ctx.registerService(SecretsProviderToken, provider))
    try {
      const provider = this.serviceRegistry.get(SecretsProviderToken);
      this.secretsRegistry.register(provider);
    } catch {
      // Plugin didn't register a secret provider — that's fine
    }
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
