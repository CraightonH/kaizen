import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { KaizenConfig } from "../types/plugin.js";
import { fatal } from "./errors.js";

// ---------------------------------------------------------------------------
// Well-known paths
// ---------------------------------------------------------------------------

export const KAIZEN_HOME = join(homedir(), ".kaizen");
export const KAIZEN_HOME_CONFIG = join(KAIZEN_HOME, "kaizen.json");
export const KAIZEN_HOME_HARNESSES = join(KAIZEN_HOME, "harnesses");

export const PROJECT_DIR = ".kaizen";
export const PROJECT_HARNESSES = join(PROJECT_DIR, "harnesses");

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

function validateHarnessConfig(config: Record<string, unknown>, source: string): void {
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
  validateHarnessConfig(config, path);
  if (!config["plugins"]) fatal(`Harness '${label}' kaizen.json is missing 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`Harness '${label}' kaizen.json 'plugins' must be an array.`);
  return config as KaizenConfig;
}

// ---------------------------------------------------------------------------
// Resolve the final config from CLI args
//
// The caller is responsible for loading ~/.kaizen/kaizen.json and passing
// defaults.harness via opts.harness before calling this function.
// ---------------------------------------------------------------------------

export function resolveConfig(opts: {
  harness?: string;
  /**
   * Pre-materialized extends path (set by the CLI pre-pass when the caller
   * already resolved a marketplace ref to a local harness dir).
   */
  extendsOverride?: string;
}): KaizenConfig {
  const { harness, extendsOverride } = opts;

  if (harness) {
    return loadHarnessConfig(harness);
  }
  if (extendsOverride) {
    return loadHarnessConfig(extendsOverride);
  }

  fatal(
    `A harness is required.\n` +
    `  kaizen --harness <marketplace>/<name>@<version>\n` +
    `  kaizen --harness ./path/to/harness/\n` +
    `  Set 'defaults.harness' in ~/.kaizen/kaizen.json`,
  );
}
