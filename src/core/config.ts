import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { KaizenConfig, GlobalConfig } from "../types/plugin.js";
import { fatal, warn } from "./errors.js";

const RESERVED_KEYS = new Set(["provider", "plugins"]);

export function loadKaizenConfig(path = "kaizen.json"): KaizenConfig {
  if (!existsSync(path)) {
    fatal(`kaizen.json not found at ${path}. Run 'kaizen init' to create one.`);
  }

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

  if (!config["provider"]) fatal(`kaizen.json is missing required field 'provider'.`);
  if (!config["plugins"]) fatal(`kaizen.json is missing required field 'plugins'.`);
  if (!Array.isArray(config["plugins"])) fatal(`kaizen.json 'plugins' must be an array.`);

  // Validate no null/undefined entries in any array value
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      if (value.some((v) => v === null || v === undefined)) {
        fatal(
          `Config error: '${key}' array in kaizen.json contains null/undefined entries. Check your kaizen.json.`,
        );
      }
    }
  }

  return config as KaizenConfig;
}

export function loadGlobalConfig(): GlobalConfig {
  const path = join(homedir(), ".kaizen", "config.json");

  if (!existsSync(path)) {
    warn(
      `No global config found at ${path}. Run 'kaizen init' to configure providers.`,
    );
    return { providers: {} };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fatal(
      `Failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fatal(`${path} must be a JSON object.`);
  }

  return raw as GlobalConfig;
}

export { RESERVED_KEYS };
