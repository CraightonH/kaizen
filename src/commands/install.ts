import { readFileSync } from "fs";
import { join } from "path";
import type { PluginPermissions, MarketplaceCatalog } from "../types/plugin.js";
import { parseRef, resolveRef } from "../core/ref-resolver.js";
import { loadKaizenGlobalConfig } from "../core/kaizen-config.js";
import { readCatalog } from "../core/marketplace.js";
import { installPlugin, installHarness } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { readLockfile, writeLockfile, upsertPluginEntry, type LockfileEntry } from "../core/lockfile.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { renderScopedUAC, renderUnscopedUAC } from "../core/uac-renderer.js";
import { decideConsent } from "../core/consent-flow.js";
import { readStdinLine } from "./cli-readline.js";
import { mergePluginConfig, separateSecrets } from "../core/config-merge.js";
import { validateConfig, validateSchemaItself } from "../core/config-validator.js";

export interface UnifiedInstallArgs {
  ref: string;
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

export async function runUnifiedInstall(args: UnifiedInstallArgs): Promise<number> {
  const parsed = parseRef(args.ref);
  const catalogs = await loadAllCatalogs();
  const resolved = resolveRef(parsed, catalogs);

  if (resolved.entry.kind === "harness") {
    const hv = resolved.entry.versions.find((v) => v.version === resolved.version)!;
    await installHarness(resolved.marketplaceId, resolved.entry.name, hv.path);
    console.log(`installed harness ${resolved.marketplaceId}/${resolved.entry.name}@${resolved.version}`);
    return 0;
  }

  // plugin
  const pv = resolved.pluginVersion!;
  await installPlugin(resolved.marketplaceId, resolved.entry.name, resolved.version, pv.source);

  const dir = pluginInstallDir(resolved.marketplaceId, resolved.entry.name, resolved.version);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
  const version = pkg.version ?? resolved.version;
  const plugin = await loadPluginFromInstallDir(resolved.marketplaceId, resolved.entry.name, resolved.version);

  // Install-time config validation
  if (plugin.config?.schema) {
    if (!validateSchemaItself(plugin.config.schema)) {
      console.error(`plugin '${plugin.name}': config.schema is not valid JSON Schema`);
      return 1;
    }
    const merged = mergePluginConfig(plugin.config, {}, {});
    const { config: nonSecretConfig } = separateSecrets(merged, plugin.config.secrets ?? []);
    const errors = validateConfig(plugin.config.schema, nonSecretConfig);
    if (errors.length > 0) {
      console.error(`plugin '${plugin.name}' config invalid:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}`);
      return 1;
    }
  }

  const permissions: PluginPermissions = plugin.permissions ?? { tier: "trusted" };
  const hash = canonicalTierGrantHash(permissions);

  const lockfile = readLockfile(args.lockfilePath);
  const decision = decideConsent({
    pluginName: resolved.entry.name,
    version, hash, permissions, lockfile,
    interactive: !args.nonInteractive && process.stdin.isTTY === true,
    allowUnscoped: args.allowUnscoped,
  });

  const canonical = `${resolved.marketplaceId}/${resolved.entry.name}@${resolved.version}`;

  switch (decision.kind) {
    case "accept":
      console.log(`plugin '${resolved.entry.name}' already in lockfile (no changes).`);
      return 0;

    case "accept-and-record": {
      writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, resolved.entry.name, decision.entry));
      console.log(`plugin '${resolved.entry.name}' recorded (tier: ${decision.entry.tier}).`);
      return 0;
    }

    case "prompt-scoped": {
      const source = `${resolved.marketplaceId}:${resolved.entry.name}@${version}`;
      process.stdout.write(renderScopedUAC({ pluginName: resolved.entry.name, version, source, permissions }) + "\n> ");
      const answer = (await readStdinLine()).trim().toLowerCase();
      if (answer === "a" || answer === "accept") {
        writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, resolved.entry.name, decision.entry));
        console.log(`plugin '${resolved.entry.name}' accepted and recorded.`);
        return 0;
      }
      console.log(`plugin '${resolved.entry.name}' rejected.`);
      return 1;
    }

    case "prompt-unscoped": {
      const source = `${resolved.marketplaceId}:${resolved.entry.name}@${version}`;
      process.stdout.write(renderUnscopedUAC({ pluginName: resolved.entry.name, version, source, permissions }) + "\n> ");
      const typed = (await readStdinLine()).trim();
      if (typed !== resolved.entry.name) {
        console.log(`plugin '${resolved.entry.name}' rejected (confirmation did not match).`);
        return 1;
      }
      const entry: LockfileEntry = { ...decision.entry, consentMode: "interactive" };
      writeLockfile(args.lockfilePath, upsertPluginEntry(lockfile, resolved.entry.name, entry));
      console.log(`plugin '${resolved.entry.name}' accepted as UNSCOPED and recorded.`);
      return 0;
    }

    case "refuse":
      console.error(`install refused: ${decision.reason}`);
      return 1;
  }
}

async function loadAllCatalogs(): Promise<Record<string, MarketplaceCatalog>> {
  const cfg = await loadKaizenGlobalConfig();
  const out: Record<string, MarketplaceCatalog> = {};
  for (const ref of cfg.marketplaces ?? []) {
    try { out[ref.id] = await readCatalog(ref.id); } catch { /* skip bad */ }
  }
  return out;
}

/** @deprecated use runUnifiedInstall. Retained for one release for cli.ts callers. */
export async function runInstall(args: { pluginName: string; lockfilePath: string; allowUnscoped: boolean; nonInteractive: boolean }): Promise<number> {
  return runUnifiedInstall({
    ref: args.pluginName,
    lockfilePath: args.lockfilePath,
    allowUnscoped: args.allowUnscoped,
    nonInteractive: args.nonInteractive,
  });
}
