import { existsSync, mkdirSync, symlinkSync, readFileSync, rmSync, lstatSync } from "fs";
import { basename, join, isAbsolute } from "path";
import { $ } from "bun";
import type { MarketplaceCatalog, MarketplaceRef } from "../types/plugin.js";
import {
  ensureKaizenHome, loadKaizenGlobalConfig, saveKaizenGlobalConfig,
  marketplaceDir, marketplaceRepoDir,
} from "./kaizen-config.js";

export class MarketplaceCatalogInvalidError extends Error {
  constructor(msg: string) { super(msg); this.name = "MarketplaceCatalogInvalidError"; }
}

export interface AddMarketplaceOpts {
  id?: string;
  /** Treat `url` as an absolute local directory; symlink rather than clone. */
  local?: boolean;
}

export async function addMarketplace(url: string, opts: AddMarketplaceOpts = {}): Promise<void> {
  await ensureKaizenHome();
  const id = opts.id ?? deriveId(url);
  const mDir = marketplaceDir(id);
  const repoDir = marketplaceRepoDir(id);

  const cfg = await loadKaizenGlobalConfig();
  cfg.marketplaces ??= [];

  // Idempotency.
  if (cfg.marketplaces.some((m) => m.id === id)) return;

  mkdirSync(mDir, { recursive: true });
  if (opts.local || isAbsolute(url)) {
    if (!existsSync(url)) throw new Error(`local marketplace path not found: ${url}`);
    symlinkSync(url, repoDir);
  } else {
    await $`git clone --depth=1 ${url} ${repoDir}`.quiet();
  }

  const cat = await readCatalog(id);
  validateCatalog(cat);

  const ref: MarketplaceRef = { id, url, updatedAt: new Date().toISOString() };
  cfg.marketplaces.push(ref);
  await saveKaizenGlobalConfig(cfg);
}

export async function pullMarketplace(id: string): Promise<void> {
  const repoDir = marketplaceRepoDir(id);
  if (!existsSync(repoDir)) throw new Error(`marketplace '${id}' is not added`);
  if (lstatSync(repoDir).isSymbolicLink()) return; // no-op for local dev
  await $`git -C ${repoDir} pull --depth=1 --ff-only`.quiet();

  const cfg = await loadKaizenGlobalConfig();
  const ref = cfg.marketplaces?.find((m) => m.id === id);
  if (ref) {
    ref.updatedAt = new Date().toISOString();
    await saveKaizenGlobalConfig(cfg);
  }
}

export async function removeMarketplace(id: string): Promise<void> {
  const cfg = await loadKaizenGlobalConfig();
  cfg.marketplaces = (cfg.marketplaces ?? []).filter((m) => m.id !== id);
  await saveKaizenGlobalConfig(cfg);
  rmSync(marketplaceDir(id), { recursive: true, force: true });
}

export async function readCatalog(id: string): Promise<MarketplaceCatalog> {
  const path = join(marketplaceRepoDir(id), ".kaizen", "marketplace.json");
  if (!existsSync(path)) {
    throw new MarketplaceCatalogInvalidError(`catalog not found at ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const cat = raw as MarketplaceCatalog;
  validateCatalog(cat);
  return cat;
}

export function validateCatalog(cat: MarketplaceCatalog): void {
  if (!cat || typeof cat !== "object") throw new MarketplaceCatalogInvalidError("not an object");
  if (cat.version !== "1.0.0") throw new MarketplaceCatalogInvalidError(`unsupported version: ${cat.version}`);
  if (typeof cat.name !== "string") throw new MarketplaceCatalogInvalidError("missing name");
  if (typeof cat.url !== "string") throw new MarketplaceCatalogInvalidError("missing url");
  if (!Array.isArray(cat.entries)) throw new MarketplaceCatalogInvalidError("entries must be an array");

  const seen = new Set<string>();
  for (const e of cat.entries) {
    if (e.kind !== "plugin" && e.kind !== "harness") {
      throw new MarketplaceCatalogInvalidError(`unknown entry kind: ${(e as { kind: string }).kind}`);
    }
    if (typeof e.name !== "string" || !/^[a-z0-9-]+$/.test(e.name)) {
      throw new MarketplaceCatalogInvalidError(`invalid entry name: ${e.name}`);
    }
    if (seen.has(e.name)) {
      throw new MarketplaceCatalogInvalidError(`duplicate entry name: ${e.name}`);
    }
    seen.add(e.name);
    if (!Array.isArray(e.versions) || e.versions.length === 0) {
      throw new MarketplaceCatalogInvalidError(`entry '${e.name}' has no versions`);
    }
  }
}

export function shouldRefresh(ref: MarketplaceRef, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false;
  if (!ref.updatedAt) return true;
  const ageMs = Date.now() - new Date(ref.updatedAt).getTime();
  return ageMs > ttlSeconds * 1000;
}

/** Fire-and-forget background pull. Swallows errors (logs only). */
export function refreshInBackground(id: string, log?: (m: string) => void): void {
  pullMarketplace(id).catch((e) => log?.(`marketplace refresh '${id}' failed: ${String(e)}`));
}

function deriveId(url: string): string {
  const base = basename(url).replace(/\.git$/, "");
  return base || "marketplace";
}
