import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { KaizenConfig } from "../types/plugin.js";
import { fatal, warn } from "./errors.js";

// Built-in harnesses are imported as JSON so they are bundled into the compiled
// binary. import.meta.url resolves to a virtual path inside the Bun binary and
// cannot be used for filesystem resolution at runtime.
import coreAnthropicHarness from "../../harnesses/core-anthropic/kaizen.json";
import coreDebugHarness from "../../harnesses/core-debug/kaizen.json";
import coreShellHarness from "../../harnesses/core-shell/kaizen.json";

const BUILTIN_HARNESSES: Record<string, KaizenConfig> = {
  "core-anthropic": coreAnthropicHarness as KaizenConfig,
  "core-debug": coreDebugHarness as KaizenConfig,
  "core-shell": coreShellHarness as KaizenConfig,
};

// Reserved top-level keys — not treated as plugin config namespaces.
const RESERVED_KEYS = new Set(["plugins", "extends"]);

// ---------------------------------------------------------------------------
// Harness resolution
//
// Accepts:
//   1. Built-in short name (e.g. "core-debug")
//   2. Local path (e.g. "./my-harness" or "./my-harness/kaizen.json")
//   3. URL — future (fetch at startup)
// ---------------------------------------------------------------------------

export function loadHarnessConfig(nameOrPath: string): KaizenConfig {
  // 1. Built-in by short name
  if (BUILTIN_HARNESSES[nameOrPath]) {
    return BUILTIN_HARNESSES[nameOrPath]!;
  }

  // 2. Local path
  if (nameOrPath.startsWith("./") || nameOrPath.startsWith("/") || nameOrPath.startsWith("../")) {
    let filePath = nameOrPath;
    // If it's a directory, look for kaizen.json inside
    if (!filePath.endsWith(".json")) {
      filePath = join(filePath, "kaizen.json");
    }
    if (!existsSync(filePath)) {
      fatal(`Harness not found at path: ${filePath}`);
    }
    return parseAndValidateHarness(filePath, nameOrPath);
  }

  // 3. URL — not yet implemented
  if (nameOrPath.startsWith("http://") || nameOrPath.startsWith("https://")) {
    fatal(
      `URL harnesses are not yet supported in this version.\n` +
      `Download the kaizen.json and use a local path instead.`,
    );
  }

  fatal(
    `Harness '${nameOrPath}' not found.\n` +
    `  Built-in harnesses: ${Object.keys(BUILTIN_HARNESSES).join(", ")}\n` +
    `  Local path: ./my-harness/kaizen.json\n` +
    `  URL: https://example.com/harness/kaizen.json (coming soon)`,
  );
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

export function loadKaizenConfig(path = "kaizen.json"): KaizenConfig {
  if (!existsSync(path)) {
    fatal(`kaizen.json not found at ${path}. Run 'kaizen init' to create one.`);
  }

  const config = parseConfigFile(path);

  if (!config["plugins"]) fatal(`kaizen.json is missing required field 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`kaizen.json 'plugins' must be an array.`);

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
