import { createRequire } from "module";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { readLockfile } from "../core/lockfile.js";
import { computePluginHash } from "../core/plugin-hash.js";
import type { KaizenPlugin } from "../types/plugin.js";

export async function runPluginReview(args: { pluginName: string; lockfilePath: string }): Promise<number> {
  const lf = readLockfile(args.lockfilePath);
  const entry = lf.plugins[args.pluginName];

  const pluginDir = resolvePluginDir(args.pluginName);
  if (!pluginDir) {
    console.error(`plugin review: could not resolve plugin '${args.pluginName}'.`);
    return 1;
  }
  const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")) as { version?: string };
  const hash = computePluginHash(pluginDir);
  const req = createRequire(process.execPath);
  const plugin = (req(pluginDir) as { default?: KaizenPlugin }).default;
  const declared = plugin?.permissions ?? { tier: "trusted" };

  console.log(`Plugin: ${args.pluginName}`);
  console.log(`  Declared version:     ${pkg.version ?? "unknown"}`);
  console.log(`  Declared hash:        ${hash}`);
  console.log(`  Declared tier:        ${declared.tier ?? "trusted"}`);
  console.log(`  Declared permissions: ${JSON.stringify(declared)}`);
  console.log();
  if (!entry) {
    console.log("  Lockfile entry:       (none — not yet consented)");
    return 0;
  }
  console.log(`  Lockfile version:     ${entry.version}`);
  console.log(`  Lockfile hash:        ${entry.hash}`);
  console.log(`  Lockfile tier:        ${entry.tier}`);
  console.log(`  Lockfile permissions: ${JSON.stringify(entry.permissions ?? {})}`);
  console.log(`  Consented:            ${entry.consentedAt} by ${entry.consentedBy}`);
  console.log();
  const drift: string[] = [];
  if (entry.hash !== hash) drift.push("hash");
  if (entry.tier !== (declared.tier ?? "trusted")) drift.push("tier");
  if (JSON.stringify(entry.permissions ?? {}) !== JSON.stringify({ ...declared, tier: undefined })) drift.push("permissions");
  if (drift.length === 0) console.log("  Status: IN SYNC.");
  else console.log(`  Status: DRIFT in ${drift.join(", ")}. Run 'kaizen plugin consent ${args.pluginName}' to re-consent.`);
  return 0;
}

function resolvePluginDir(name: string): string | null {
  const req = createRequire(process.execPath);
  try { return dirname(req.resolve(name)); } catch { return null; }
}
