import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  addMarketplace, pullMarketplace, readCatalog, removeMarketplace,
} from "../core/marketplace.js";
import { installPlugin, installHarness } from "../core/plugin-installer.js";
import { loadKaizenGlobalConfig, marketplaceDir } from "../core/kaizen-config.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

export async function cmdMarketplaceAdd(args: { url: string; id?: string; local?: boolean }): Promise<number> {
  try {
    await addMarketplace(args.url, { ...(args.id ? { id: args.id } : {}), ...(args.local ? { local: true } : {}) });
    const id = args.id ?? args.url;
    const cat = await readCatalog(args.id ?? id);
    const plugins = cat.entries.filter((e) => e.kind === "plugin").length;
    const harnesses = cat.entries.filter((e) => e.kind === "harness").length;
    console.log(`Added marketplace '${id}' (${plugins} plugins, ${harnesses} harnesses).`);
    return 0;
  } catch (e) {
    console.error(`kaizen marketplace add: ${(e as Error).message}`);
    return 1;
  }
}

export async function cmdMarketplaceList(): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const refs = cfg.marketplaces ?? [];
  if (refs.length === 0) {
    console.log("No marketplaces added. Run `kaizen marketplace add <url>`.");
    return 0;
  }
  const rows = await Promise.all(refs.map(async (r) => {
    try {
      const cat = await readCatalog(r.id);
      const plugins = cat.entries.filter((e) => e.kind === "plugin").length;
      const harnesses = cat.entries.filter((e) => e.kind === "harness").length;
      return { id: r.id, plugins, harnesses, updated: r.updatedAt ?? "—", url: r.url };
    } catch {
      return { id: r.id, plugins: 0, harnesses: 0, updated: r.updatedAt ?? "—", url: r.url };
    }
  }));
  console.log("ID\tPLUGINS\tHARNESSES\tUPDATED\tURL");
  for (const row of rows) {
    console.log(`${row.id}\t${row.plugins}\t${row.harnesses}\t${row.updated}\t${row.url}`);
  }
  return 0;
}

export async function cmdMarketplaceRemove(args: { id: string; purgeLockfile?: boolean }): Promise<number> {
  try {
    await removeMarketplace(args.id);
    console.log(`Removed marketplace '${args.id}' (including installed plugins and harnesses).`);
    return 0;
  } catch (e) {
    console.error(`kaizen marketplace remove: ${(e as Error).message}`);
    return 1;
  }
}

export async function cmdMarketplaceUpdate(args: { id?: string }): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const targets = args.id ? [args.id] : (cfg.marketplaces ?? []).map((m) => m.id);
  let rc = 0;
  for (const id of targets) {
    try {
      await pullMarketplace(id);
      const refreshed = await refreshInstalled(id);
      const parts = [`Updated '${id}'`];
      if (refreshed.plugins > 0 || refreshed.harnesses > 0) {
        parts.push(`(re-materialized ${refreshed.plugins} plugin(s), ${refreshed.harnesses} harness(es))`);
      }
      if (refreshed.skipped.length > 0) {
        parts.push(`— skipped ${refreshed.skipped.length}: ${refreshed.skipped.join(", ")}`);
      }
      console.log(parts.join(" "));
    } catch (e) {
      console.error(`update '${id}' failed: ${(e as Error).message}`);
      rc = 1;
    }
  }
  return rc;
}

interface RefreshResult { plugins: number; harnesses: number; skipped: string[] }

/**
 * After a marketplace pull, re-materialize already-installed plugins and
 * harnesses from the new source. The git clone alone isn't what harnesses
 * load — they load from `<marketplaceDir>/plugins/<name>@<version>/` and
 * `<marketplaceDir>/harnesses/<name>/`. Without this step, `marketplace
 * update` is misleading: it refreshes the catalog but leaves runtime
 * artifacts frozen at consent time.
 */
async function refreshInstalled(id: string): Promise<RefreshResult> {
  const result: RefreshResult = { plugins: 0, harnesses: 0, skipped: [] };
  let cat: MarketplaceCatalog;
  try {
    cat = await readCatalog(id);
  } catch {
    return result;
  }

  const pluginsDir = join(marketplaceDir(id), "plugins");
  if (existsSync(pluginsDir)) {
    for (const dirent of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const at = dirent.name.lastIndexOf("@");
      if (at <= 0) continue;
      const name = dirent.name.slice(0, at);
      const version = dirent.name.slice(at + 1);
      const entry = cat.entries.find(
        (e): e is Extract<typeof e, { kind: "plugin" }> =>
          e.kind === "plugin" && e.name === name,
      );
      const ver = entry?.versions.find((v) => v.version === version);
      if (!entry || !ver) {
        result.skipped.push(`${name}@${version} (no longer in catalog)`);
        continue;
      }
      // Tarball/npm sources are content-addressable by version; nothing
      // to refresh until a new version is consented.
      if (ver.source.type !== "file") continue;
      try {
        await installPlugin(id, name, version, ver.source);
        result.plugins++;
      } catch (e) {
        result.skipped.push(`${name}@${version} (${(e as Error).message.split("\n")[0]})`);
      }
    }
  }

  const harnessesDir = join(marketplaceDir(id), "harnesses");
  if (existsSync(harnessesDir)) {
    for (const dirent of readdirSync(harnessesDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      const entry = cat.entries.find(
        (e): e is Extract<typeof e, { kind: "harness" }> =>
          e.kind === "harness" && e.name === name,
      );
      const ver = entry?.versions[0];
      if (!entry || !ver) {
        result.skipped.push(`${name} (no longer in catalog)`);
        continue;
      }
      try {
        await installHarness(id, name, ver.path);
        result.harnesses++;
      } catch (e) {
        result.skipped.push(`${name} (${(e as Error).message.split("\n")[0]})`);
      }
    }
  }

  return result;
}

export async function cmdMarketplaceBrowse(args: { id?: string }): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const refs = args.id
    ? (cfg.marketplaces ?? []).filter((m) => m.id === args.id)
    : (cfg.marketplaces ?? []);
  for (const r of refs) {
    const cat = await readCatalog(r.id);
    console.log(`\n# ${r.id} (${cat.name})`);
    console.log("KIND\tNAME\tVERSIONS\tDESCRIPTION");
    for (const e of cat.entries) {
      const vs = e.versions.map((v) => v.version).join(",");
      console.log(`${e.kind}\t${e.name}\t${vs}\t${e.description}`);
    }
  }
  return 0;
}
