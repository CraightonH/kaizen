/**
 * kaizen management commands:
 *   plugin list               — list plugins with install status
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { findProjectConfig, PROJECT_CONFIG } from "../core/config.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { parseRef } from "../core/ref-resolver.js";
import type { KaizenPlugin } from "../types/plugin.js";

// ---------------------------------------------------------------------------
// kaizen.json helpers
// ---------------------------------------------------------------------------

export function readLocalConfig(): Record<string, unknown> {
  const configPath = findProjectConfig();
  if (!configPath) {
    console.error("No .kaizen/kaizen.json found. Run 'kaizen init' to create one.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

export function writeLocalConfig(config: Record<string, unknown>): void {
  writeFileSync(PROJECT_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getPlugins(config: Record<string, unknown>): string[] {
  return (config["plugins"] as string[] | undefined) ?? [];
}

// ---------------------------------------------------------------------------
// Install status
// ---------------------------------------------------------------------------

interface InstallStatus {
  status: "built-in" | "installed" | "NOT INSTALLED";
  version: string;
}

function statusFor(
  name: string,
  builtins: Record<string, KaizenPlugin>,
): InstallStatus {
  if (Object.prototype.hasOwnProperty.call(builtins, name)) {
    return { status: "built-in", version: "" };
  }

  try {
    const parsed = parseRef(name);
    if (parsed.kind === "marketplace" && parsed.version) {
      const dir = pluginInstallDir(parsed.marketplaceId, parsed.name, parsed.version);
      if (existsSync(join(dir, "package.json"))) {
        return { status: "installed", version: parsed.version };
      }
      return { status: "NOT INSTALLED", version: parsed.version };
    }
  } catch { /* not a canonical ref */ }

  return { status: "NOT INSTALLED", version: "" };
}

// ---------------------------------------------------------------------------
// kaizen plugin list
// ---------------------------------------------------------------------------

export function cmdPluginList(builtins: Record<string, KaizenPlugin>): void {
  const config = readLocalConfig();
  const plugins = getPlugins(config);

  if (plugins.length === 0) {
    console.log("No plugins configured in kaizen.json.");
    return;
  }

  const rows: Array<[string, string]> = [];
  let maxLen = 0;

  for (const name of plugins) {
    const s = statusFor(name, builtins);
    const label =
      s.status === "built-in" ? "built-in"
      : s.status === "NOT INSTALLED" ? (s.version ? `NOT INSTALLED (${s.version})` : "NOT INSTALLED")
      : s.version;
    rows.push([name, label]);
    if (name.length > maxLen) maxLen = name.length;
  }

  for (const [name, status] of rows) {
    const pad = " ".repeat(maxLen - name.length + 2);
    const marker = status.startsWith("NOT INSTALLED") ? "✗" : "✓";
    console.log(`  ${marker} ${name}${pad}${status}`);
  }
}
