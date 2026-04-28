import { readFileSync } from "fs";
import { join } from "path";
import type { KaizenConfig, MarketplaceCatalog } from "../types/plugin.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { installPlugin } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { isInstalled } from "../core/plugin-manager.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { decideConsent } from "../core/consent-flow.js";
import { readLockfile, writeLockfile, upsertPluginEntry } from "../core/lockfile.js";

export type ConsentAllOutcome =
  | { status: "consented"; ref: string; tier: string }
  | { status: "already";   ref: string; tier: string }
  | { status: "refused";   ref: string; reason: string }
  | { status: "skipped";   ref: string };

export async function runPluginConsentAll(args: {
  harnessConfig: KaizenConfig;
  harnessJsonPath: string;
  lockfilePath: string;
}): Promise<number> {
  const outcomes: ConsentAllOutcome[] = [];
  const catalogs = await loadCatalogs();

  for (const refStr of args.harnessConfig.plugins ?? []) {
    if (refStr.startsWith("./") || refStr.startsWith("../") || refStr.startsWith("/")) {
      outcomes.push({ status: "skipped", ref: refStr });
      continue;
    }

    try {
      const parsed = parseRef(refStr);
      const resolved = resolveRef(parsed, catalogs);

      if (resolved.entry.kind === "harness") {
        outcomes.push({ status: "skipped", ref: refStr });
        continue;
      }

      const { marketplaceId, version } = resolved;
      const name = resolved.entry.name;

      if (!(await isInstalled(marketplaceId, name, version))) {
        await installPlugin(marketplaceId, name, version, resolved.pluginVersion!.source);
      }

      const dir = pluginInstallDir(marketplaceId, name, version);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      const pkgVersion = pkg.version ?? version;
      const plugin = await loadPluginFromInstallDir(marketplaceId, name, version);
      const permissions = plugin.permissions ?? { tier: "trusted" as const };
      const hash = canonicalTierGrantHash(permissions);
      const lockfile = readLockfile(args.lockfilePath);
      const tier = permissions.tier ?? "trusted";

      const decision = decideConsent({
        pluginName: name, version: pkgVersion, hash, permissions, lockfile,
        interactive: false, allowUnscoped: true, allowScoped: true,
      });

      if (decision.kind === "accept") {
        outcomes.push({ status: "already", ref: refStr, tier });
      } else if (decision.kind === "accept-and-record") {
        writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, name, decision.entry));
        outcomes.push({ status: "consented", ref: refStr, tier });
      } else if (decision.kind === "refuse") {
        outcomes.push({ status: "refused", ref: refStr, reason: decision.reason });
      } else {
        // prompt-scoped / prompt-unscoped — non-interactive, treat as refused
        outcomes.push({ status: "refused", ref: refStr, reason: `interactive consent required (${decision.kind})` });
      }
    } catch (e) {
      outcomes.push({ status: "refused", ref: refStr, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log(formatSummary(args.harnessJsonPath, outcomes));
  return outcomes.some((o) => o.status === "refused") ? 1 : 0;
}

export function formatSummary(harnessPath: string, outcomes: ConsentAllOutcome[]): string {
  const lines: string[] = [`\nplugin consent --all  (harness: ${harnessPath})\n`];

  for (const o of outcomes) {
    if (o.status === "consented") lines.push(`  ✓ consented   ${o.ref.padEnd(45)} (${o.tier})`);
    if (o.status === "already")   lines.push(`  ○ already     ${o.ref.padEnd(45)} (${o.tier})`);
    if (o.status === "skipped")   lines.push(`  - skipped     ${o.ref}`);
    if (o.status === "refused") {
      lines.push(`  ✗ refused     ${o.ref}`);
      lines.push(`    reason: ${o.reason}`);
    }
  }

  const consented = outcomes.filter((o) => o.status === "consented").length;
  const already   = outcomes.filter((o) => o.status === "already").length;
  const refused   = outcomes.filter((o) => o.status === "refused").length;
  const skipped   = outcomes.filter((o) => o.status === "skipped").length;

  const parts = [
    consented && `${consented} consented`,
    already   && `${already} already consented`,
    refused   && `${refused} refused`,
    skipped   && `${skipped} skipped`,
  ].filter(Boolean);

  lines.push(`\n${outcomes.length} plugins: ${parts.join(", ")}.`);
  return lines.join("\n");
}

async function loadCatalogs(): Promise<Record<string, MarketplaceCatalog>> {
  const cfg = await loadKaizenGlobalConfig();
  const out: Record<string, MarketplaceCatalog> = {};
  for (const ref of cfg.marketplaces ?? []) {
    try { out[ref.id] = await readCatalog(ref.id); } catch (e) { console.warn(`[kaizen] warn: could not load catalog '${ref.id}': ${(e as Error).message}`); }
  }
  return out;
}
