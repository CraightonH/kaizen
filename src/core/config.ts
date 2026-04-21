import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { KaizenConfig } from "../types/plugin.js";
import { fatal, warn } from "./errors.js";

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

export const KAIZEN_HOME = join(homedir(), ".kaizen");
export const KAIZEN_HOME_CONFIG = join(KAIZEN_HOME, "kaizen.json");
export const KAIZEN_HOME_HARNESSES = join(KAIZEN_HOME, "harnesses");

export const PROJECT_DIR = ".kaizen";
export const PROJECT_CONFIG = join(PROJECT_DIR, "kaizen.json");
export const PROJECT_HARNESSES = join(PROJECT_DIR, "harnesses");

/** Legacy root-level kaizen.json — supported during migration. */
export const LEGACY_CONFIG = "kaizen.json";

// Reserved top-level keys — not treated as plugin config namespaces.
export const RESERVED_KEYS = new Set(["plugins", "extends"]);

// ---------------------------------------------------------------------------
// Harness resolution
//
// Harnesses are resolved through the marketplace install path. A canonical
// ref (`<marketplace>/<name>@<version>`) is materialized by cli.ts before
// reaching this function; here we handle the resulting local paths and the
// project/home fallback directories.
// ---------------------------------------------------------------------------

export interface ResolvedHarness {
  kaizenJsonPath: string;
  config: KaizenConfig;
}

/**
 * Resolve a harness name-or-path to both its kaizen.json location and parsed config.
 * Callers derive the lockfile path from `dirname(kaizenJsonPath) + "/permissions.lock"`.
 */
export function resolveHarness(nameOrPath: string): ResolvedHarness {
  // 1. Project-scoped harness
  const projectHarness = join(PROJECT_HARNESSES, nameOrPath, "kaizen.json");
  if (existsSync(projectHarness)) {
    return { kaizenJsonPath: projectHarness, config: parseAndValidateHarness(projectHarness, nameOrPath) };
  }

  // 2. Global kaizen home harness
  const homeHarness = join(KAIZEN_HOME_HARNESSES, nameOrPath, "kaizen.json");
  if (existsSync(homeHarness)) {
    return { kaizenJsonPath: homeHarness, config: parseAndValidateHarness(homeHarness, nameOrPath) };
  }

  // 3. Explicit path (./relative or /absolute)
  if (nameOrPath.startsWith("./") || nameOrPath.startsWith("/") || nameOrPath.startsWith("../")) {
    const filePath = nameOrPath.endsWith(".json") ? nameOrPath : join(nameOrPath, "kaizen.json");
    if (!existsSync(filePath)) fatal(`Harness not found at path: ${filePath}`);
    return { kaizenJsonPath: filePath, config: parseAndValidateHarness(filePath, nameOrPath) };
  }

  // 4. URL — not supported; use marketplace
  if (nameOrPath.startsWith("http://") || nameOrPath.startsWith("https://")) {
    fatal(
      `URL harnesses are not supported.\n` +
      `Publish the harness in a marketplace and reference it as '<marketplace>/<name>@<version>'.`,
    );
  }

  fatal(
    `Harness '${nameOrPath}' not found.\n` +
    `  Marketplace:    kaizen install <marketplace>/${nameOrPath}@<version>\n` +
    `  Project-scoped: .kaizen/harnesses/${nameOrPath}/kaizen.json\n` +
    `  Global:         ~/.kaizen/harnesses/${nameOrPath}/kaizen.json\n` +
    `  Path:           ./path/to/kaizen.json`,
  );
}

export function loadHarnessConfig(nameOrPath: string): KaizenConfig {
  return resolveHarness(nameOrPath).config;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function validateConfig(config: Record<string, unknown>, source: string): void {
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value) && value.some((v) => v === null || v === undefined)) {
      fatal(`Config error: '${key}' array in ${source} contains null/undefined entries.`);
    }
  }
}

function parseAndValidateHarness(path: string, label: string): KaizenConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fatal(`Failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fatal(`${path} must be a JSON object.`);
  }
  const config = raw as Record<string, unknown>;
  validateConfig(config, path);
  if (!config["plugins"]) fatal(`Harness '${label}' kaizen.json is missing 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`Harness '${label}' kaizen.json 'plugins' must be an array.`);
  return config as KaizenConfig;
}

function parseConfigFile(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fatal(`Failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fatal(`${path} must be a JSON object.`);
  }
  const config = raw as Record<string, unknown>;
  validateConfig(config, path);
  return config;
}

/**
 * Find the project config file.
 * Priority: .kaizen/kaizen.json > kaizen.json (legacy)
 */
export function findProjectConfig(): string | null {
  if (existsSync(PROJECT_CONFIG)) return PROJECT_CONFIG;
  if (existsSync(LEGACY_CONFIG)) {
    warn(`Found kaizen.json at root. Consider moving it to .kaizen/kaizen.json.`);
    return LEGACY_CONFIG;
  }
  return null;
}

export function loadKaizenConfig(path: string): KaizenConfig {
  if (!existsSync(path)) {
    fatal(`Config not found at ${path}. Run 'kaizen init' to create one.`);
  }
  const config = parseConfigFile(path);
  if (!config["plugins"]) fatal(`${path} is missing required field 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`${path} 'plugins' must be an array.`);
  return config as KaizenConfig;
}

// ---------------------------------------------------------------------------
// Config merging
//
// Harness is the base. Local config overlays it:
//   - plugins: local replaces harness entirely (if specified)
//   - plugin configs (objects): shallow-merged, local wins on conflicts
//   - extends: stripped — it's resolved before merging
// ---------------------------------------------------------------------------

export function mergeConfigs(base: KaizenConfig, overlay: KaizenConfig): KaizenConfig {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (key === "extends") continue;

    if (key === "plugins") {
      merged["plugins"] = value;
    } else if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof merged[key] === "object" && merged[key] !== null && !Array.isArray(merged[key])
    ) {
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
    } else {
      merged[key] = value;
    }
  }

  return merged as KaizenConfig;
}

// ---------------------------------------------------------------------------
// Resolve the final config from CLI args
//
// Priority (highest → lowest):
//   CLI --config flag
//   .kaizen/kaizen.json      (project)
//   kaizen.json              (legacy root)
//   ~/.kaizen/kaizen.json    (global default)
// ---------------------------------------------------------------------------

export function resolveConfig(opts: {
  harness?: string;
  configPath?: string;
  /**
   * Pre-materialized extends path (set by the CLI pre-pass when the local
   * config's `extends` is a marketplace ref). Overrides the raw `extends`
   * string read from the local config.
   */
  extendsOverride?: string;
}): KaizenConfig {
  const { harness, configPath, extendsOverride } = opts;

  // Explicit --config path
  const explicitPath = configPath ?? null;
  const projectConfigPath = explicitPath ?? findProjectConfig();

  if (harness) {
    const harnessConfig = loadHarnessConfig(harness);
    if (projectConfigPath) {
      const localConfig = loadKaizenConfig(projectConfigPath);
      if (localConfig.extends && localConfig.extends !== harness) {
        warn(`--harness ${harness} overrides extends '${localConfig.extends}' in config.`);
      }
      return mergeConfigs(harnessConfig, localConfig);
    }
    return harnessConfig;
  }

  if (projectConfigPath) {
    const localConfig = loadKaizenConfig(projectConfigPath);
    const ext = extendsOverride ?? localConfig.extends;
    if (ext) {
      return mergeConfigs(loadHarnessConfig(ext), localConfig);
    }
    return localConfig;
  }

  // Global default
  if (existsSync(KAIZEN_HOME_CONFIG)) {
    const globalConfig = loadKaizenConfig(KAIZEN_HOME_CONFIG);
    const ext = extendsOverride ?? globalConfig.extends;
    if (ext) {
      return mergeConfigs(loadHarnessConfig(ext), globalConfig);
    }
    return globalConfig;
  }

  fatal(
    `No config found.\n` +
    `  Project config: kaizen init\n` +
    `  Global config:  kaizen init --global\n` +
    `  Harness:        kaizen --harness <marketplace>/<name>@<version>`,
  );
}
