import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, relative, sep } from "path";
import { createHash } from "crypto";
import type { PluginPermissions } from "../types/plugin.js";

/**
 * Hash a plugin package. Recursively walks the plugin directory, ignoring
 * node_modules and dotfiles, sorting paths for determinism. Returns
 * `sha256:<hex>`.
 */
export function computePluginHash(pluginDir: string): string {
  const files = collectFiles(pluginDir).sort();
  const hash = createHash("sha256");
  for (const absPath of files) {
    const rel = relative(pluginDir, absPath).split(sep).join("/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(absPath));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * SHA-256 of a canonical serialization of { tier, permissions-minus-tier }:
 * object keys sorted; arrays sorted. Any change (value, presence, tier) flips
 * the hash. Silent updates only apply when hash is byte-equal.
 */
export function canonicalTierGrantHash(perms: PluginPermissions): string {
  const canon = canonicalize({
    tier: perms.tier ?? "trusted",
    permissions: stripTier(perms),
  });
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}

function stripTier(p: PluginPermissions): Omit<PluginPermissions, "tier"> {
  const { tier: _tier, ...rest } = p;
  return rest;
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    const sorted = [...v].map(canonicalize).sort();
    return "[" + sorted.join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...collectFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
