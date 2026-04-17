import { createRequire } from "module";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { readLockfile, writeLockfile, upsertPluginEntry, type LockfileEntry } from "../core/lockfile.js";
import { computePluginHash } from "../core/plugin-hash.js";
import { renderScopedUAC, renderUnscopedUAC } from "../core/uac-renderer.js";
import { decideConsent } from "../core/consent-flow.js";
import { readStdinLine } from "../core/stdin.js";
import type { KaizenPlugin, PluginPermissions } from "../types/plugin.js";

export interface InstallArgs {
  pluginName: string;
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
}

export async function runInstall(args: InstallArgs): Promise<number> {
  const pluginDir = resolvePluginDir(args.pluginName);
  if (!pluginDir) {
    console.error(`kaizen install: could not resolve plugin '${args.pluginName}'.`);
    return 1;
  }

  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { version?: string; main?: string };
  const version = pkg.version ?? "unknown";
  const hash = computePluginHash(pluginDir);

  const req = createRequire(process.execPath);
  const mod = req(pluginDir) as { default?: KaizenPlugin };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== "object") {
    console.error(`kaizen install: plugin '${args.pluginName}' has no default export.`);
    return 1;
  }
  const permissions: PluginPermissions = plugin.permissions ?? { tier: "trusted" };

  const lockfile = readLockfile(args.lockfilePath);
  const decision = decideConsent({
    pluginName: args.pluginName,
    version,
    hash,
    permissions,
    lockfile,
    interactive: !args.nonInteractive && process.stdin.isTTY === true,
    allowUnscoped: args.allowUnscoped,
  });

  switch (decision.kind) {
    case "accept":
      console.log(`kaizen install: plugin '${args.pluginName}' already in lockfile (no changes).`);
      return 0;

    case "accept-and-record": {
      const updated = upsertPluginEntry(lockfile, args.pluginName, decision.entry);
      writeLockfile(args.lockfilePath, updated);
      console.log(`kaizen install: plugin '${args.pluginName}' recorded (tier: ${decision.entry.tier}).`);
      return 0;
    }

    case "prompt-scoped": {
      const source = `npm:${args.pluginName}@${version}`;
      process.stdout.write(renderScopedUAC({ pluginName: args.pluginName, version, source, permissions }) + "\n> ");
      const answer = (await readStdinLine()).trim().toLowerCase();
      if (answer === "a" || answer === "accept") {
        const entry = toEntry(version, hash, permissions);
        const updated = upsertPluginEntry(lockfile, args.pluginName, entry);
        writeLockfile(args.lockfilePath, updated);
        console.log(`kaizen install: plugin '${args.pluginName}' accepted and recorded.`);
        return 0;
      }
      console.log(`kaizen install: plugin '${args.pluginName}' rejected.`);
      return 1;
    }

    case "prompt-unscoped": {
      const source = `npm:${args.pluginName}@${version}`;
      process.stdout.write(renderUnscopedUAC({ pluginName: args.pluginName, version, source, permissions }) + "\n> ");
      const typed = (await readStdinLine()).trim();
      if (typed !== args.pluginName) {
        console.log(`kaizen install: plugin '${args.pluginName}' rejected (confirmation did not match).`);
        return 1;
      }
      const entry: LockfileEntry = { ...toEntry(version, hash, permissions), consentMode: "interactive" };
      const updated = upsertPluginEntry(lockfile, args.pluginName, entry);
      writeLockfile(args.lockfilePath, updated);
      console.log(`kaizen install: plugin '${args.pluginName}' accepted as UNSCOPED and recorded.`);
      return 0;
    }

    case "refuse":
      console.error(`kaizen install: refused. ${decision.reason}`);
      return 1;
  }
}

function toEntry(version: string, hash: string, permissions: PluginPermissions): LockfileEntry {
  const tier = (permissions.tier ?? "trusted") as "trusted" | "scoped" | "unscoped";
  return {
    version,
    hash,
    tier,
    consentedAt: new Date().toISOString(),
    consentedBy: process.env["USER"] ?? "unknown",
    permissions: stripTier(permissions),
  };
}

function stripTier(p: PluginPermissions): Omit<PluginPermissions, "tier"> {
  const { tier: _t, ...rest } = p;
  return rest;
}

function resolvePluginDir(name: string): string | null {
  const req = createRequire(process.execPath);
  try {
    const resolved = req.resolve(name);
    return dirname(resolved);
  } catch {
    return null;
  }
}
