import {
  addMarketplace, pullMarketplace, readCatalog, removeMarketplace,
} from "../core/marketplace.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";

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
      console.log(`Updated '${id}'.`);
    } catch (e) {
      console.error(`update '${id}' failed: ${(e as Error).message}`);
      rc = 1;
    }
  }
  return rc;
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
