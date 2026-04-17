import { readFileSync, writeFileSync, existsSync } from "fs";
import { parse, stringify } from "yaml";
import type { PluginPermissions, PermissionTier } from "../types/plugin.js";

export const LOCKFILE_SCHEMA_VERSION = 1;

export interface LockfileEntry {
  version: string;
  hash: string;
  tier: PermissionTier;
  consentedAt: string;
  consentedBy: string;
  consentMode?: "interactive" | "flag";
  permissions?: Omit<PluginPermissions, "tier">;
}

export interface PermissionsLockfile {
  schemaVersion: number;
  plugins: Record<string, LockfileEntry>;
}

export function readLockfile(path: string): PermissionsLockfile {
  if (!existsSync(path)) {
    return { schemaVersion: LOCKFILE_SCHEMA_VERSION, plugins: {} };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Lockfile '${path}' is not a valid YAML object.`);
  }
  const obj = parsed as PermissionsLockfile;
  if (obj.schemaVersion !== LOCKFILE_SCHEMA_VERSION) {
    throw new Error(
      `Lockfile '${path}' has unsupported schema version ${obj.schemaVersion}. Expected ${LOCKFILE_SCHEMA_VERSION}.`,
    );
  }
  if (!obj.plugins || typeof obj.plugins !== "object") {
    throw new Error(`Lockfile '${path}' missing or invalid 'plugins' field.`);
  }
  return obj;
}

export function writeLockfile(path: string, lf: PermissionsLockfile): void {
  const yaml = stringify(lf, { indent: 2, lineWidth: 100 });
  writeFileSync(path, yaml);
}

export function upsertPluginEntry(
  lf: PermissionsLockfile, pluginName: string, entry: LockfileEntry,
): PermissionsLockfile {
  return {
    ...lf,
    plugins: { ...lf.plugins, [pluginName]: entry },
  };
}

export function removePluginEntry(
  lf: PermissionsLockfile, pluginName: string,
): PermissionsLockfile {
  const { [pluginName]: _removed, ...rest } = lf.plugins;
  return { ...lf, plugins: rest };
}
