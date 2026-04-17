import type { PluginPermissions, PermissionOp } from "../types/plugin.js";
import { PermissionError } from "./errors.js";

export type EnforcerMode = "enforce" | "log-only" | "observe";

export interface DenialRecord {
  ts: number;
  plugin: string;
  op: PermissionOp;
  reason: string;
}

export type DenialListener = (record: DenialRecord) => void;

export type CheckRecord = {
  ts: number; plugin: string; op: PermissionOp; allowed: boolean; reason?: string | undefined;
};
export type CheckListener = (record: CheckRecord) => void;

const FORBIDDEN_IMPORTS_NON_UNSCOPED = new Set<string>([
  "node:fs", "fs", "node:fs/promises", "fs/promises",
  "node:child_process", "child_process",
  "node:worker_threads", "worker_threads",
  "node:vm", "vm",
  "node:module", "module",
  "node:net", "net",
  "node:dgram", "dgram",
  "node:dns", "dns",
  "node:http", "http",
  "node:https", "https",
  "node:http2", "http2",
  "node:cluster", "cluster",
  "bun:ffi",
  "bun:sqlite",
]);

export class PermissionEnforcer {
  private mode: EnforcerMode;
  private readonly manifests = new Map<string, PluginPermissions>();
  private readonly listeners: DenialListener[] = [];
  private readonly checkListeners: CheckListener[] = [];

  constructor(opts: { mode: EnforcerMode }) {
    this.mode = opts.mode;
  }

  setMode(mode: EnforcerMode): void { this.mode = mode; }
  getMode(): EnforcerMode { return this.mode; }

  register(plugin: string, permissions: PluginPermissions): void {
    this.manifests.set(plugin, { tier: permissions.tier ?? "trusted", ...permissions });
  }

  deregister(plugin: string): void { this.manifests.delete(plugin); }

  onDenial(listener: DenialListener): void { this.listeners.push(listener); }
  onCheck(listener: CheckListener): void { this.checkListeners.push(listener); }

  check(plugin: string, op: PermissionOp): void {
    const reason = this.evaluate(plugin, op);
    const allowed = reason === null;
    if (this.mode === "observe") {
      const rec: CheckRecord = { ts: Date.now(), plugin, op, allowed };
      if (reason !== null) rec.reason = reason;
      for (const l of this.checkListeners) l(rec);
      return;  // observe never throws, always allows
    }
    if (allowed) return;
    const record: DenialRecord = { ts: Date.now(), plugin, op, reason: reason! };
    for (const l of this.listeners) l(record);
    if (this.mode === "enforce") throw new PermissionError(plugin, op.kind, reason!);
  }

  /** Returns a denial reason string, or null if permitted. */
  private evaluate(plugin: string, op: PermissionOp): string | null {
    const m = this.manifests.get(plugin);
    if (!m) return `plugin '${plugin}' is not registered with the enforcer`;

    const tier = m.tier ?? "trusted";
    if (tier === "unscoped") return null;

    if (op.kind === "import") {
      return FORBIDDEN_IMPORTS_NON_UNSCOPED.has(op.module)
        ? `module '${op.module}' is forbidden in tier '${tier}'`
        : null;
    }

    if (tier === "trusted") return `tier 'trusted' permits no external ops (attempted ${op.kind})`;

    // tier === "scoped" — check grant lists
    switch (op.kind) {
      case "fs.read":  return matchesGlob(m.fs?.read  ?? [], op.path) ? null : `path '${op.path}' not in fs.read grants`;
      case "fs.write": return matchesGlob(m.fs?.write ?? [], op.path) ? null : `path '${op.path}' not in fs.write grants`;
      case "net.connect": {
        const target = `${op.host}:${op.port}`;
        return matchesNet(m.net?.connect ?? [], op.host, op.port)
          ? null : `host '${target}' not in net.connect grants`;
      }
      case "env.get":
        return (m.env ?? []).includes(op.name) ? null : `env var '${op.name}' not in env grants`;
      case "exec.run": {
        const binaries = m.exec?.binaries ?? [];
        if (binaries.includes("*") || binaries.includes(op.binary)) return null;
        return `binary '${op.binary}' not in exec.binaries grants`;
      }
      case "events.subscribe":
        return matchesEvent(m.events?.subscribe ?? [], op.event)
          ? null : `event '${op.event}' not in events.subscribe grants`;
    }
  }
}

// Glob match (minimal): supports **, *, ?; matches full string.
function matchesGlob(patterns: string[], path: string): boolean {
  if (patterns.length === 0) return false;
  for (const pat of patterns) {
    const rx = globToRegex(pat);
    if (rx.test(path)) return true;
  }
  return false;
}

function globToRegex(pat: string): RegExp {
  let rx = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*" && pat[i + 1] === "*") {  // **
      rx += ".*"; i++;
    } else if (c === "*") {
      rx += "[^/]*";
    } else if (c === "?") {
      rx += "[^/]";
    } else if (/[.+^${}()|\\[\]]/.test(c)) {
      rx += "\\" + c;
    } else {
      rx += c;
    }
  }
  rx += "$";
  return new RegExp(rx);
}

function matchesNet(patterns: string[], host: string, port: number): boolean {
  for (const pat of patterns) {
    if (pat === "*") return true;
    const [patHost, patPort] = splitHostPort(pat);
    if (patPort !== "*" && Number(patPort) !== port) continue;
    if (patHost === "*") return true;
    if (patHost.startsWith("*.")) {
      const suffix = patHost.slice(2);
      if (host.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (patHost === host) return true;
  }
  return false;
}

function splitHostPort(pat: string): [string, string] {
  const idx = pat.lastIndexOf(":");
  if (idx < 0) return [pat, "*"];
  return [pat.slice(0, idx), pat.slice(idx + 1)];
}

function matchesEvent(patterns: string[], event: string): boolean {
  for (const pat of patterns) {
    if (pat === event) return true;
    if (pat.endsWith(":*")) {
      const prefix = pat.slice(0, -1);
      if (event.startsWith(prefix)) return true;
    }
    if (pat === "*" || pat === "*:*") return true;
  }
  return false;
}
