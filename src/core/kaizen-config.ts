import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { KaizenGlobalConfig } from "../types/plugin.js";

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
