import type { MarketplaceCatalog, PluginPermissions } from "../types/plugin.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { installPlugin } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import { readLockfile, writeLockfile, upsertPluginEntry } from "../core/lockfile.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { runUnifiedInstall } from "./install.js";

export interface UpdateArgs {
  ref?: string;             // undefined = update all installed
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

export async function runUpdate(args: UpdateArgs): Promise<number> {
  const cfg = await loadKaizenGlobalConfig();
  const catalogs: Record<string, MarketplaceCatalog> = {};
  for (const m of cfg.marketplaces ?? []) {
    try { catalogs[m.id] = await readCatalog(m.id); } catch {}
  }

  const lockfile = readLockfile(args.lockfilePath);
  const targets = args.ref
    ? [parseRef(args.ref)]
    : Object.keys(lockfile.plugins).map((n) => parseRef(n));

  let rc = 0;
  for (const parsed of targets) {
    try {
      const resolved = resolveRef(parsed, catalogs);
      if (resolved.entry.kind !== "plugin") continue;
      const name = resolved.entry.name;
      const latest = resolved.version;
      const lfEntry = lockfile.plugins[name];
      if (lfEntry && lfEntry.version === latest) continue;

      await installPlugin(resolved.marketplaceId, name, latest, resolved.pluginVersion!.source);
      const plugin = await loadPluginFromInstallDir(resolved.marketplaceId, name, latest);
      const permissions: PluginPermissions = plugin.permissions ?? { tier: "trusted" };
      const newHash = canonicalTierGrantHash(permissions);

      if (lfEntry && lfEntry.hash === newHash) {
        writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, name, {
          ...lfEntry, version: latest,
        }));
        console.log(`silently updated ${resolved.marketplaceId}/${name} → ${latest}`);
        continue;
      }

      const code = await runUnifiedInstall({
        ref: `${resolved.marketplaceId}/${name}@${latest}`,
        lockfilePath: args.lockfilePath,
        allowUnscoped: args.allowUnscoped,
        nonInteractive: args.nonInteractive,
      });
      if (code !== 0) rc = code;
    } catch (e) {
      console.error(`update failed for '${parsed.name}': ${(e as Error).message}`);
      rc = 1;
    }
  }
  return rc;
}
