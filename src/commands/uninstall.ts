import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { PROJECT_CONFIG } from "../core/config.js";
import { readLockfile, writeLockfile, removePluginEntry } from "../core/lockfile.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { pluginInstallDir } from "../core/kaizen-config.js";

export interface UninstallArgs {
  ref: string;
  lockfilePath: string;
  purge: boolean;
}

export async function runUninstall(args: UninstallArgs): Promise<number> {
  const parsed = parseRef(args.ref);
  const cfg = await loadKaizenGlobalConfig();
  const catalogs: Record<string, import("../types/plugin.js").MarketplaceCatalog> = {};
  for (const m of cfg.marketplaces ?? []) {
    try { catalogs[m.id] = await readCatalog(m.id); } catch {}
  }

  let name: string = parsed.kind === "legacy-npm" ? parsed.name.replace(/^kaizen-plugin-/, "") : parsed.name;
  let canonicalPrefix: string | undefined;
  try {
    const r = resolveRef(parsed, catalogs);
    name = r.entry.name;
    canonicalPrefix = `${r.marketplaceId}/${r.entry.name}@`;

    if (args.purge) {
      rmSync(pluginInstallDir(r.marketplaceId, r.entry.name, r.version), { recursive: true, force: true });
    }
  } catch { /* uninstall still removes from harness + lockfile */ }

  // Remove from project harness.
  if (existsSync(PROJECT_CONFIG)) {
    const h = JSON.parse(readFileSync(PROJECT_CONFIG, "utf8")) as { plugins?: string[] };
    const before = h.plugins?.length ?? 0;
    h.plugins = (h.plugins ?? []).filter((p) =>
      p !== name && (canonicalPrefix ? !p.startsWith(canonicalPrefix) : true),
    );
    if ((h.plugins?.length ?? 0) !== before) {
      writeFileSync(PROJECT_CONFIG, JSON.stringify(h, null, 2) + "\n", "utf8");
    }
  }

  // Remove from lockfile when --purge.
  if (args.purge) {
    const lf = readLockfile(args.lockfilePath);
    writeLockfile(args.lockfilePath, removePluginEntry(lf, name));
  }

  console.log(`uninstalled ${name}${args.purge ? " (purged bits + lockfile)" : ""}`);
  return 0;
}
