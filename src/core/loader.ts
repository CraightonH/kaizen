import { createRequire } from "module";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { KaizenPlugin, KaizenConfig } from "../types/plugin.js";
import { PLUGIN_API_VERSION } from "../types/plugin.js";
import { fatal, warn, debug } from "./errors.js";
import { RESERVED_KEYS, KAIZEN_HOME, KAIZEN_HOME_PLUGINS, PROJECT_PLUGINS } from "./config.js";
import type { EventBus } from "./event-bus.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { ExecutorRegistry } from "./executor-registry.js";
import type { UiRegistry } from "./ui-registry.js";
import { createPluginContext, type CoreState } from "./context.js";

// ---------------------------------------------------------------------------
// Resolution paths (cached at module load — execSync called once per process)
// ---------------------------------------------------------------------------

function getBunGlobalRoot(): string {
  try {
    const line = execSync("bun pm ls --global 2>/dev/null", { timeout: 5000 })
      .toString()
      .split("\n")[0] ?? "";
    const match = line.match(/^(\S+)\s+node_modules/);
    return match ? `${match[1]}/node_modules` : "";
  } catch {
    return "";
  }
}

function getNpmGlobalRoot(): string {
  try {
    return execSync("npm root -g 2>/dev/null", { timeout: 5000 }).toString().trim();
  } catch {
    return "";
  }
}

const BUN_GLOBAL_ROOT = getBunGlobalRoot();
const NPM_GLOBAL_ROOT = getNpmGlobalRoot();

// npm-style resolution paths (for require.resolve)
export const RESOLVE_PATHS = [
  join(KAIZEN_HOME, "node_modules"),       // ~/.kaizen/node_modules (kaizen plugin install target)
  join(process.cwd(), ".kaizen/node_modules"), // .kaizen/node_modules (project-local install target)
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
  // 1. Builtins (workspace packages / compiled binary)
  if (builtins[name]) return builtins[name]!;

  const isPath = name.startsWith("./") || name.startsWith("/") || name.startsWith("../");

  if (!isPath) {
    // 2. .kaizen/plugins/<name>/ — project-scoped
    const projectPlugin = join(process.cwd(), PROJECT_PLUGINS, name);
    if (existsSync(projectPlugin)) return loadPluginFromPath(projectPlugin, name);

    // 3. ~/.kaizen/plugins/<name>/ — global kaizen home
    const homePlugin = join(KAIZEN_HOME_PLUGINS, name);
    if (existsSync(homePlugin)) return loadPluginFromPath(homePlugin, name);
  }

  // 4. Standard npm resolution (./node_modules, global bun/npm store, explicit paths)
  const req = createRequire(process.execPath);
  try {
    const resolved = isPath
      ? req.resolve(name)
      : req.resolve(name, { paths: RESOLVE_PATHS });
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

// ---------------------------------------------------------------------------
// Topological sort (Kahn's algorithm)
// ---------------------------------------------------------------------------

function topoSort(plugins: KaizenPlugin[]): KaizenPlugin[] {
  const nameToPlugin = new Map(plugins.map((p) => [p.name, p]));
  const roleToPlugin = new Map<string, KaizenPlugin>();
  for (const p of plugins) {
    for (const role of p.provides ?? []) {
      roleToPlugin.set(role, p);
    }
  }

  // Build adjacency: plugin → plugins that must come before it
  const inDegree = new Map(plugins.map((p) => [p.name, 0]));
  const edges = new Map<string, string[]>(); // name → names that depend on it

  for (const p of plugins) {
    for (const dep of p.depends ?? []) {
      // dep is either a role or a plugin name
      const depPlugin = roleToPlugin.get(dep) ?? nameToPlugin.get(dep);
      if (!depPlugin) continue; // missing dep — warned at role validation

      const depName = depPlugin.name;
      if (depName === p.name) continue; // self-dep, ignore

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
// Full initialization sequence
// ---------------------------------------------------------------------------

export async function loadPlugins(
  config: KaizenConfig,
  builtins: Builtins,
  eventBus: EventBus,
  toolRegistry: ToolRegistry,
  executorRegistry: ExecutorRegistry,
  uiRegistry: UiRegistry,
): Promise<{ lifecycleProvider: KaizenPlugin; state: { current: CoreState } }> {
  const stateContainer = { current: "INITIALIZING" as CoreState };
  const getState = () => stateContainer.current;

  // 1. Resolve plugins
  const resolved: KaizenPlugin[] = [];
  for (const name of config.plugins) {
    if (RESERVED_KEYS.has(name)) {
      warn(`Plugin name '${name}' collides with reserved config key. Skipping.`);
      continue;
    }
    const plugin = resolvePlugin(String(name), builtins);
    if (plugin) resolved.push(plugin);
  }

  // 2. Topo-sort
  const sorted = topoSort(resolved);

  // 3. Determine which roles are required (any plugin depends on them)
  const requiredRoles = new Set<string>();
  for (const p of sorted) {
    for (const dep of p.depends ?? []) {
      // Only add to requiredRoles if it looks like a role (not a plugin name)
      const isPluginName = sorted.some((q) => q.name === dep);
      if (!isPluginName) requiredRoles.add(dep);
    }
  }

  // 4. Setup each plugin
  const loadedNames = new Set<string>();
  for (const plugin of sorted) {
    // Version check
    const pluginMajor = plugin.apiVersion.split(".")[0];
    if (pluginMajor !== PLUGIN_API_VERSION) {
      warn(
        `Plugin '${plugin.name}' apiVersion ${plugin.apiVersion}, core expects ${PLUGIN_API_VERSION}.x. Loading anyway.`,
      );
    }

    const pluginConfig = (config[plugin.name] as Record<string, unknown> | undefined) ?? {};
    const ctx = createPluginContext(
      plugin.name,
      pluginConfig,
      eventBus,
      toolRegistry,
      executorRegistry,
      uiRegistry,
      getState,
    );

    const providesRequiredRole = (plugin.provides ?? []).some((r) => requiredRoles.has(r));

    try {
      await plugin.setup(ctx);
      loadedNames.add(plugin.name);
      debug(`Plugin '${plugin.name}' initialized.`);
    } catch (err) {
      if (providesRequiredRole) {
        const role = (plugin.provides ?? []).find((r) => requiredRoles.has(r))!;
        fatal(
          `${plugin.name} (provides: ${role}) failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        const stack = err instanceof Error ? err.stack : undefined;
        if (stack) debug(stack);
        console.error(
          `[kaizen] error: plugin '${plugin.name}' failed to initialize:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // 5. Role validation
  const roleProviders = new Map<string, string[]>();
  for (const p of sorted) {
    if (!loadedNames.has(p.name)) continue;
    for (const role of p.provides ?? []) {
      const existing = roleProviders.get(role) ?? [];
      existing.push(p.name);
      roleProviders.set(role, existing);
    }
  }

  for (const role of requiredRoles) {
    const providers = roleProviders.get(role) ?? [];
    if (providers.length === 0) {
      fatal(`No plugin provides role '${role}'. Add one to kaizen.json.`);
    }
    if (providers.length > 1) {
      fatal(`Multiple plugins provide role '${role}': ${providers.join(", ")}. Remove one.`);
    }
  }

  // 6. Warn on unclaimed config keys
  const claimedKeys = new Set(["plugins", ...loadedNames]);
  for (const key of Object.keys(config)) {
    if (!claimedKeys.has(key)) {
      warn(`Unknown config key '${key}'. No plugin claimed it.`);
    }
  }

  // 7. Find lifecycle provider
  const lifecycleProviderName = roleProviders.get("lifecycle")?.[0];
  if (!lifecycleProviderName) {
    fatal("No lifecycle plugin found. Add one to kaizen.json.");
  }
  const lifecycleProvider = sorted.find((p) => p.name === lifecycleProviderName);
  if (!lifecycleProvider || typeof lifecycleProvider.start !== "function") {
    fatal("No lifecycle plugin found. Add one to kaizen.json.");
  }

  stateContainer.current = "READY";
  return { lifecycleProvider, state: stateContainer };
}
