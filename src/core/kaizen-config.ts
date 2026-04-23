import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { KaizenGlobalConfig, MarketplaceCatalog } from "../types/plugin.js";
import { parseRef, resolveRef } from "./ref-resolver.js";
import { readCatalog } from "./marketplace.js";
import { installHarness } from "./plugin-installer.js";
import { fatal } from "./errors.js";

/** Test hook: KAIZEN_HOME_OVERRIDE redirects `~/.kaizen` for a single process. */
export function kaizenHome(): string {
  return process.env.KAIZEN_HOME_OVERRIDE ?? join(homedir(), ".kaizen");
}

export function kaizenHomeConfigPath(): string {
  return join(kaizenHome(), "kaizen.json");
}

export function marketplacesDir(): string {
  return join(kaizenHome(), "marketplaces");
}

export function marketplaceDir(id: string): string {
  return join(marketplacesDir(), id);
}

export function marketplaceRepoDir(id: string): string {
  return join(marketplaceDir(id), "repo");
}

export function pluginInstallDir(id: string, name: string, version: string): string {
  return join(marketplaceDir(id), "plugins", `${name}@${version}`);
}

export function harnessInstallDir(id: string, name: string): string {
  return join(marketplaceDir(id), "harnesses", name);
}

export async function ensureKaizenHome(): Promise<void> {
  mkdirSync(marketplacesDir(), { recursive: true });
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "defaults",
  "marketplaces",
  "marketplaceUpdateTTL",
]);
const ALLOWED_DEFAULTS_KEYS = new Set(["harness", "plugin_config"]);

export async function loadKaizenGlobalConfig(): Promise<KaizenGlobalConfig> {
  const path = kaizenHomeConfigPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;

  if ("plugins" in obj) {
    throw new Error(
      `${path}: top-level 'plugins' key is not allowed. The plugin set is defined by the harness; ` +
      `user config cannot add, remove, or replace plugins. Remove the 'plugins' key. See docs/concepts/configuration.md.`,
    );
  }
  if ("extends" in obj) {
    throw new Error(
      `${path}: top-level 'extends' has been replaced by 'defaults.harness'. ` +
      `Move the value under \`defaults\` and try again.`,
    );
  }
  if ("default_harness" in obj) {
    throw new Error(
      `${path}: top-level 'default_harness' is not allowed — nest it as 'defaults.harness'.`,
    );
  }
  if ("plugin_config" in obj) {
    throw new Error(
      `${path}: top-level 'plugin_config' is not allowed — nest it as 'defaults.plugin_config'.`,
    );
  }
  const unknownKeys = Object.keys(obj).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${path}: unknown top-level keys: ${unknownKeys.join(", ")}. ` +
      `Allowed keys: ${[...ALLOWED_TOP_LEVEL_KEYS].join(", ")}.`,
    );
  }

  if (obj.defaults !== undefined) {
    if (typeof obj.defaults !== "object" || obj.defaults === null || Array.isArray(obj.defaults)) {
      throw new Error(`${path}: 'defaults' must be an object.`);
    }
    const defaults = obj.defaults as Record<string, unknown>;
    const unknownDefaultsKeys = Object.keys(defaults).filter((k) => !ALLOWED_DEFAULTS_KEYS.has(k));
    if (unknownDefaultsKeys.length > 0) {
      throw new Error(
        `${path}: unknown keys under 'defaults': ${unknownDefaultsKeys.join(", ")}. ` +
        `Allowed: ${[...ALLOWED_DEFAULTS_KEYS].join(", ")}. ` +
        `If these are plugin names, move them under 'defaults.plugin_config'.`,
      );
    }
    if (defaults.harness !== undefined && typeof defaults.harness !== "string") {
      throw new Error(`${path}: 'defaults.harness' must be a string.`);
    }
    if (defaults.plugin_config !== undefined) {
      if (typeof defaults.plugin_config !== "object" || defaults.plugin_config === null || Array.isArray(defaults.plugin_config)) {
        throw new Error(`${path}: 'defaults.plugin_config' must be an object.`);
      }
      for (const [name, value] of Object.entries(defaults.plugin_config)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error(`${path}: 'defaults.plugin_config.${name}' must be an object.`);
        }
      }
    }
  }

  return obj as KaizenGlobalConfig;
}

/**
 * Does this string look like a marketplace harness ref (e.g. `official/foo@1.0.0`)?
 * Excludes local paths and raw URLs.
 */
export function looksLikeHarnessRef(s: string): boolean {
  if (s.startsWith("./") || s.startsWith("/") || s.startsWith("../")) return false;
  if (/^https?:\/\//i.test(s)) return false;
  return s.includes("/");
}

/**
 * Resolve a marketplace harness ref to a concrete kaizen.json path on disk,
 * installing the harness bits under `~/.kaizen/marketplaces/<id>/harnesses/<name>/`
 * if not already present.
 */
export async function materializeHarnessRef(ref: string): Promise<string> {
  const cfg = await loadKaizenGlobalConfig();
  const catalogs: Record<string, MarketplaceCatalog> = {};
  for (const m of cfg.marketplaces ?? []) {
    try { catalogs[m.id] = await readCatalog(m.id); } catch { /* ignore */ }
  }
  const r = resolveRef(parseRef(ref), catalogs);
  if (r.entry.kind !== "harness") {
    fatal(`harness ref '${ref}' does not resolve to a harness entry`);
  }
  const hv = r.entry.versions.find((v) => v.version === r.version)!;
  await installHarness(r.marketplaceId, r.entry.name, hv.path);
  return join(harnessInstallDir(r.marketplaceId, r.entry.name), "kaizen.json");
}

/** Atomic: write to `kaizen.json.tmp` then rename. */
export async function saveKaizenGlobalConfig(cfg: KaizenGlobalConfig): Promise<void> {
  await ensureKaizenHome();
  const path = kaizenHomeConfigPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}
