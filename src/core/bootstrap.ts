import type { KaizenConfig, MarketplaceRef, MarketplaceCatalog } from "../types/plugin.js";
import { loadKaizenGlobalConfig } from "./kaizen-config.js";
import { addMarketplace, readCatalog } from "./marketplace.js";
import { parseRef, resolveRef } from "./ref-resolver.js";
import { readLockfile } from "./lockfile.js";
import { runUnifiedInstall } from "../commands/install.js";
import { isInstalled } from "./plugin-manager.js";

export interface BootstrapOpts {
  lockfilePath: string;
  trustLockfile: boolean;
  nonInteractive: boolean;
  allowUnscoped: boolean;
}

export interface BootstrapReport {
  marketplacesAdded: string[];
  pluginsInstalled: string[];
}

export async function bootstrapMissingPlugins(
  harness: KaizenConfig, opts: BootstrapOpts,
): Promise<BootstrapReport> {
  const report: BootstrapReport = { marketplacesAdded: [], pluginsInstalled: [] };

  // 1. Add any missing marketplaces listed in the harness.
  const global = await loadKaizenGlobalConfig();
  const knownIds = new Set((global.marketplaces ?? []).map((m) => m.id));
  const harnessMarkets: MarketplaceRef[] = (harness.marketplaces as MarketplaceRef[] | undefined) ?? [];

  for (const m of harnessMarkets) {
    if (knownIds.has(m.id)) continue;
    try {
      console.log(`Adding marketplace ${m.id} from ${m.url}`);
      await addMarketplace(m.url, { id: m.id });
      report.marketplacesAdded.push(m.id);
    } catch (e) {
      const needed = (harness.plugins ?? []).some((p) => p.startsWith(`${m.id}/`));
      if (needed) {
        throw new Error(`cannot add marketplace ${m.id} from ${m.url}: ${(e as Error).message}`);
      }
      console.warn(`warning: marketplace ${m.id} could not be added: ${(e as Error).message}`);
    }
  }

  // 2. Install missing plugins.
  const lockfile = readLockfile(opts.lockfilePath);
  let catalogs: Record<string, MarketplaceCatalog> | undefined;

  for (const refStr of harness.plugins ?? []) {
    const parsed = parseRef(refStr);

    if (parsed.kind === "shorthand") {
      throw new Error(
        `harness plugin ref '${refStr}' is shorthand. ` +
        `Harness plugin refs must be canonical '<marketplace>/<name>[@<version>]'.`,
      );
    }

    let marketplaceId: string;
    let name: string;
    let version: string | undefined;
    if (parsed.kind === "marketplace") {
      marketplaceId = parsed.marketplaceId;
      name = parsed.name;
      version = parsed.version;
    } else {
      // legacy-npm
      marketplaceId = "official";
      name = parsed.name.replace(/^kaizen-plugin-/, "");
      version = undefined;
      // resolveRef strips the same prefix from parsed.name independently; both strip the same prefix once.
    }

    // Version-less ref: resolve against the catalog to get the concrete version
    // so we can use the isInstalled short-circuit below.
    if (!version) {
      if (!catalogs) {
        catalogs = {};
        for (const m of global.marketplaces ?? []) {
          try { catalogs[m.id] = await readCatalog(m.id); } catch { /* skip bad */ }
        }
      }
      try {
        version = resolveRef(parsed, catalogs).version;
      } catch (e) {
        throw new Error(`cannot resolve version for harness ref '${refStr}': ${(e as Error).message}`);
      }
    }

    if (await isInstalled(marketplaceId, name, version)) continue;

    if (opts.trustLockfile) {
      if (!lockfile.plugins[name]) {
        throw new Error(`plugin '${name}' not in lockfile (trust-lockfile mode); run 'kaizen install ${refStr}' first`);
      }
    }

    const code = await runUnifiedInstall({
      ref: refStr,
      lockfilePath: opts.lockfilePath,
      allowUnscoped: opts.allowUnscoped,
      nonInteractive: opts.nonInteractive,
    });
    if (code !== 0) throw new Error(`bootstrap install failed for ${refStr}`);
    report.pluginsInstalled.push(refStr);
  }

  return report;
}
