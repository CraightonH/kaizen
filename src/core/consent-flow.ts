import type { PluginPermissions } from "../types/plugin.js";
import type { PermissionsLockfile, LockfileEntry } from "./lockfile.js";

export interface ConsentInput {
  pluginName: string;
  version: string;
  hash: string;
  permissions: PluginPermissions;
  lockfile: PermissionsLockfile;
  interactive: boolean;
  allowUnscoped: boolean;
}

export type ConsentDecision =
  | { kind: "accept"; entry: LockfileEntry }          // already in lockfile, matches — proceed
  | { kind: "accept-and-record"; entry: LockfileEntry } // trusted tier, add to lockfile silently
  | { kind: "prompt-scoped"; entry: LockfileEntry }   // caller renders UAC; stamp consentMode then write
  | { kind: "prompt-unscoped"; entry: LockfileEntry } // caller renders loud UAC + typed confirm; stamp consentMode then write
  | { kind: "refuse"; reason: string };

/** Pure decision function. Performs no I/O. */
export function decideConsent(input: ConsentInput): ConsentDecision {
  const existing = input.lockfile.plugins[input.pluginName];
  const tier = input.permissions.tier ?? "trusted";

  if (existing) {
    if (existing.hash !== input.hash) {
      return { kind: "refuse", reason: `plugin '${input.pluginName}' hash differs from lockfile (expected ${existing.hash}, got ${input.hash}). Run 'kaizen plugin consent ${input.pluginName}' to re-consent.` };
    }
    if (!permissionsEqual(existing.permissions, stripTier(input.permissions))) {
      return { kind: "refuse", reason: `plugin '${input.pluginName}' declared permissions differ from lockfile. Run 'kaizen plugin review ${input.pluginName}' to inspect diff.` };
    }
    if (existing.tier !== tier) {
      return { kind: "refuse", reason: `plugin '${input.pluginName}' tier differs from lockfile (expected ${existing.tier}, got ${tier}).` };
    }
    return { kind: "accept", entry: existing };
  }

  // Not in lockfile.
  const nowEntry: LockfileEntry = {
    version: input.version,
    hash: input.hash,
    tier,
    consentedAt: new Date().toISOString(),
    consentedBy: process.env["USER"] ?? "unknown",
    permissions: stripTier(input.permissions),
  };

  if (tier === "trusted") return { kind: "accept-and-record", entry: nowEntry };

  if (tier === "scoped") {
    return input.interactive
      ? { kind: "prompt-scoped", entry: nowEntry }
      : { kind: "refuse", reason: `plugin '${input.pluginName}' requires SCOPED-tier consent. Run interactively, or pre-consent with: kaizen plugin consent ${input.pluginName} --harness <harness-path>` };
  }

  // tier === "unscoped"
  if (input.interactive) return { kind: "prompt-unscoped", entry: nowEntry };
  if (input.allowUnscoped) return { kind: "accept-and-record", entry: { ...nowEntry, consentMode: "flag" } };
  return { kind: "refuse", reason: `plugin '${input.pluginName}' is UNSCOPED; pass --allow-unscoped explicitly to consent from a non-interactive context.` };
}

function stripTier(p: PluginPermissions): Omit<PluginPermissions, "tier"> {
  const { tier: _tier, ...rest } = p;
  return rest;
}

function permissionsEqual(a?: Omit<PluginPermissions, "tier">, b?: Omit<PluginPermissions, "tier">): boolean {
  return JSON.stringify(normalizeSort(a ?? {})) === JSON.stringify(normalizeSort(b ?? {}));
}

export function normalizeSort(p: Omit<PluginPermissions, "tier">): unknown {
  return {
    fs: p.fs ? { read: [...(p.fs.read ?? [])].sort(), write: [...(p.fs.write ?? [])].sort() } : undefined,
    net: p.net ? { connect: [...(p.net.connect ?? [])].sort() } : undefined,
    env: p.env ? [...p.env].sort() : undefined,
    exec: p.exec ? { binaries: [...(p.exec.binaries ?? [])].sort() } : undefined,
    events: p.events ? { subscribe: [...(p.events.subscribe ?? [])].sort() } : undefined,
  };
}
