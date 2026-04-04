import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { KaizenConfig } from "../types/plugin.js";
import { fatal, warn } from "./errors.js";

// Reserved top-level keys — not treated as plugin config namespaces.
const RESERVED_KEYS = new Set(["plugins", "extends"]);

// ---------------------------------------------------------------------------
// Harness resolution
//
// Search order:
//   1. <kaizen-repo-root>/harnesses/<name>/kaizen.json  (built-ins, dev)
//   2. kaizen-harness-<name>/kaizen.json                (installed npm package)
// ---------------------------------------------------------------------------

function kaizenRoot(): string {
  // Walk up from this file (src/core/config.ts) to the repo root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function resolveHarness(name: string): string {
  // 1. Built-in harness alongside the kaizen source tree
  const builtin = join(kaizenRoot(), "harnesses", name, "kaizen.json");
  if (existsSync(builtin)) return builtin;

  // 2. Installed npm package (kaizen-harness-<name>)
  const pkg = join(kaizenRoot(), "node_modules", `kaizen-harness-${name}`, "kaizen.json");
  if (existsSync(pkg)) return pkg;

  fatal(
    `Harness '${name}' not found.\n` +
    `  Built-in harnesses: core-debug\n` +
    `  Install third-party: bun add kaizen-harness-${name}`,
  );
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

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

  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value) && value.some((v) => v === null || v === undefined)) {
      fatal(`Config error: '${key}' array in ${path} contains null/undefined entries.`);
    }
  }

  return config;
}

export function loadKaizenConfig(path = "kaizen.json"): KaizenConfig {
  if (!existsSync(path)) {
    fatal(`kaizen.json not found at ${path}. Run 'kaizen init' to create one.`);
  }

  const config = parseConfigFile(path);

  if (!config["plugins"]) fatal(`kaizen.json is missing required field 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`kaizen.json 'plugins' must be an array.`);

  return config as KaizenConfig;
}

export function loadHarnessConfig(name: string): KaizenConfig {
  const path = resolveHarness(name);
  const config = parseConfigFile(path);

  if (!config["plugins"]) fatal(`Harness '${name}' kaizen.json is missing 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`Harness '${name}' kaizen.json 'plugins' must be an array.`);

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
    if (key === "extends") continue; // consumed during resolution

    if (key === "plugins") {
      merged["plugins"] = value; // plugins array: overlay wins entirely
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof merged[key] === "object" &&
      merged[key] !== null &&
      !Array.isArray(merged[key])
    ) {
      // Plugin config objects: shallow merge
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
//   local kaizen.json  >  harness  >  defaults
// ---------------------------------------------------------------------------

export function resolveConfig(opts: {
  harness?: string;
  configPath?: string;
}): KaizenConfig {
  const { harness, configPath = "kaizen.json" } = opts;

  const localExists = existsSync(configPath);

  if (harness) {
    const harnessConfig = loadHarnessConfig(harness);

    if (localExists) {
      const localConfig = loadKaizenConfig(configPath);
      const extendsTarget = localConfig.extends ?? harness;

      if (extendsTarget !== harness) {
        warn(`--harness ${harness} specified but kaizen.json extends '${extendsTarget}'. Using --harness.`);
      }

      return mergeConfigs(harnessConfig, localConfig);
    }

    return harnessConfig;
  }

  if (localExists) {
    const localConfig = loadKaizenConfig(configPath);

    if (localConfig.extends) {
      const harnessConfig = loadHarnessConfig(localConfig.extends);
      return mergeConfigs(harnessConfig, localConfig);
    }

    return localConfig;
  }

  fatal(
    `No kaizen.json found and no --harness specified.\n` +
    `  Run with a harness:   kaizen --harness core-debug\n` +
    `  Or create a config:   kaizen init`,
  );
}

export { RESERVED_KEYS };
