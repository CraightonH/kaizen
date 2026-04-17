import { readLockfile } from "../core/lockfile.js";

export async function runPluginAudit(args: { lockfilePath: string }): Promise<number> {
  const lf = readLockfile(args.lockfilePath);
  const entries = Object.entries(lf.plugins);
  if (entries.length === 0) {
    console.log("(no plugins in lockfile)");
    return 0;
  }
  console.log("Plugin                              Tier       Permissions");
  console.log("──────────────────────────────────────────────────────────");
  for (const [name, e] of entries) {
    const marker = e.tier === "unscoped" ? "⚠  " : "   ";
    const perms = summarize(e.permissions ?? {});
    console.log(`${marker}${name.padEnd(34)}${e.tier.padEnd(11)}${perms}`);
  }
  return 0;
}

function summarize(p: { fs?: unknown; net?: unknown; env?: string[]; exec?: unknown; events?: unknown }): string {
  const parts: string[] = [];
  if (p.fs) parts.push("fs");
  if (p.net) parts.push("net");
  if (p.env?.length) parts.push(`env[${p.env.length}]`);
  if (p.exec) parts.push("exec");
  if (p.events) parts.push("events");
  return parts.join(", ") || "(none)";
}
