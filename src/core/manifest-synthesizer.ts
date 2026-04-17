import type { CheckRecord } from "./permission-enforcer.js";
import type { PluginPermissions } from "../types/plugin.js";

/**
 * Collapse a set of observed check records for one plugin into a minimal
 * permission manifest. Paths/hosts are listed verbatim — glob collapsing is
 * left to the author to do by hand (better signal than fuzzy heuristics).
 */
export function synthesizeManifest(pluginName: string, records: CheckRecord[]): PluginPermissions {
  const fsRead = new Set<string>();
  const fsWrite = new Set<string>();
  const netConnect = new Set<string>();
  const env = new Set<string>();
  const execBinaries = new Set<string>();
  const eventsSubscribe = new Set<string>();

  for (const r of records) {
    if (r.plugin !== pluginName) continue;
    switch (r.op.kind) {
      case "fs.read":          fsRead.add(r.op.path); break;
      case "fs.write":         fsWrite.add(r.op.path); break;
      case "net.connect":      netConnect.add(`${r.op.host}:${r.op.port}`); break;
      case "env.get":          env.add(r.op.name); break;
      case "exec.run":         execBinaries.add(r.op.binary); break;
      case "events.subscribe": eventsSubscribe.add(r.op.event); break;
      case "import":           /* imports checked at load, not synthesized */ break;
    }
  }

  const anyExternal = fsRead.size || fsWrite.size || netConnect.size || env.size || execBinaries.size || eventsSubscribe.size;
  if (!anyExternal) return { tier: "trusted" };

  const result: PluginPermissions = { tier: "scoped" };
  if (fsRead.size || fsWrite.size) {
    result.fs = {};
    if (fsRead.size)  result.fs.read  = [...fsRead].sort();
    if (fsWrite.size) result.fs.write = [...fsWrite].sort();
  }
  if (netConnect.size)      result.net    = { connect: [...netConnect].sort() };
  if (env.size)             result.env    = [...env].sort();
  if (execBinaries.size)    result.exec   = { binaries: [...execBinaries].sort() };
  if (eventsSubscribe.size) result.events = { subscribe: [...eventsSubscribe].sort() };
  return result;
}
