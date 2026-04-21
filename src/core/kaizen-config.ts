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

export async function loadKaizenGlobalConfig(): Promise<KaizenGlobalConfig> {
  const path = kaizenHomeConfigPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object.`);
  }
  return parsed as KaizenGlobalConfig;
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
