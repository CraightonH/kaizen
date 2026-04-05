/**
 * kaizen management commands:
 *   apply                     — install missing plugins from kaizen.json
 *   install <harness>         — install a harness package + update kaizen.json
 *   plugin install <pkg>      — install a plugin package globally
 *   plugin remove <name>      — remove a plugin from kaizen.json (+ optionally uninstall)
 *   plugin list               — list plugins with install status
 */

import { createRequire } from "module";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { RESOLVE_PATHS } from "../core/loader.js";
import type { KaizenPlugin } from "../types/plugin.js";

const CONFIG_PATH = "kaizen.json";
const INSTALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// kaizen.json helpers
// ---------------------------------------------------------------------------

export function readLocalConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    console.error("No kaizen.json found. Run 'kaizen init' to create one.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

export function writeLocalConfig(config: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getPlugins(config: Record<string, unknown>): string[] {
  return (config["plugins"] as string[] | undefined) ?? [];
}

// ---------------------------------------------------------------------------
// Package management
// ---------------------------------------------------------------------------

function isBuiltin(name: string, builtins: Record<string, KaizenPlugin>): boolean {
  return Object.prototype.hasOwnProperty.call(builtins, name);
}

function isInstalled(name: string): boolean {
  const req = createRequire(process.execPath);
  try {
    req.resolve(name, { paths: RESOLVE_PATHS });
    return true;
  } catch {
    return false;
  }
}

function bunAddGlobal(pkg: string): boolean {
  const result = spawnSync("bun", ["add", "--global", pkg], {
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  return result.status === 0;
}

function bunRemoveGlobal(pkg: string): boolean {
  const result = spawnSync("bun", ["remove", "--global", pkg], {
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  return result.status === 0;
}

function getInstalledVersion(name: string): string {
  const req = createRequire(process.execPath);
  try {
    const resolved = req.resolve(name + "/package.json", { paths: RESOLVE_PATHS });
    const pkg = JSON.parse(readFileSync(resolved, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    // Try resolving the module and walking up to find package.json
    try {
      const main = req.resolve(name, { paths: RESOLVE_PATHS });
      // Walk up from resolved path to find package.json
      let dir = join(main, "..");
      for (let i = 0; i < 5; i++) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
          return pkg.version ?? "unknown";
        }
        dir = join(dir, "..");
      }
    } catch { /* ignore */ }
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// kaizen apply
// ---------------------------------------------------------------------------

export function cmdApply(builtins: Record<string, KaizenPlugin>): void {
  const config = readLocalConfig();
  const plugins = getPlugins(config);

  if (plugins.length === 0) {
    console.log("No plugins configured in kaizen.json.");
    return;
  }

  console.log("Checking plugins...\n");

  const missing: string[] = [];
  for (const name of plugins) {
    if (isBuiltin(name, builtins)) {
      console.log(`  ✓ ${name}  (built-in)`);
    } else if (isInstalled(name)) {
      const ver = getInstalledVersion(name);
      console.log(`  ✓ ${name}  ${ver}`);
    } else {
      console.log(`  ✗ ${name}  NOT INSTALLED`);
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    console.log("\nAll plugins are installed.");
    return;
  }

  console.log(`\nInstalling ${missing.length} missing plugin(s)...\n`);

  let failed = 0;
  for (const name of missing) {
    console.log(`Installing ${name}...`);
    const ok = bunAddGlobal(name);
    if (!ok) {
      console.error(`Plugin install failed for '${name}'. Check the package name and your connection.`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} plugin(s) failed to install.`);
    process.exit(1);
  }

  console.log("\nAll plugins installed.");
}

// ---------------------------------------------------------------------------
// kaizen install <harness>
// ---------------------------------------------------------------------------

export function cmdInstall(harnessArg: string | undefined): void {
  if (!harnessArg) {
    console.error("Usage: kaizen install <url-or-path>");
    console.error("  kaizen install https://example.com/harness/kaizen.json");
    console.error("  kaizen install ./my-harness");
    console.error("  kaizen install core-debug  (built-in short name)");
    process.exit(1);
  }

  // Update or create local kaizen.json to extend the given harness
  if (existsSync(CONFIG_PATH)) {
    const config = readLocalConfig();
    config["extends"] = harnessArg;
    writeLocalConfig(config);
    console.log(`Updated kaizen.json: extends = "${harnessArg}"`);
  } else {
    writeLocalConfig({ extends: harnessArg });
    console.log(`Created kaizen.json: extends = "${harnessArg}"`);
  }
  console.log(`Run 'kaizen apply' to install any missing plugins.`);
}

// ---------------------------------------------------------------------------
// kaizen plugin install <pkg>
// ---------------------------------------------------------------------------

export function cmdPluginInstall(pkgArg: string | undefined): void {
  if (!pkgArg) {
    console.error("Usage: kaizen plugin install <package-name>");
    process.exit(1);
  }

  console.log(`Installing ${pkgArg}...\n`);
  const ok = bunAddGlobal(pkgArg);
  if (!ok) {
    console.error(`Install failed. Check the package name and your connection.`);
    process.exit(1);
  }

  // Try to load the plugin to get its name, then add to kaizen.json
  if (existsSync(CONFIG_PATH)) {
    const req = createRequire(process.execPath);
    let pluginName: string | undefined;
    try {
      const resolved = req.resolve(pkgArg, { paths: RESOLVE_PATHS });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = req(resolved) as { default?: { name?: string } };
      pluginName = mod.default?.name;
    } catch { /* couldn't load — skip auto-add */ }

    if (pluginName) {
      const config = readLocalConfig();
      const plugins = getPlugins(config);
      if (!plugins.includes(pluginName)) {
        plugins.push(pluginName);
        config["plugins"] = plugins;
        writeLocalConfig(config);
        console.log(`Added '${pluginName}' to plugins in kaizen.json.`);
      } else {
        console.log(`'${pluginName}' is already in kaizen.json plugins.`);
      }
    }
  }

  console.log(`\n${pkgArg} installed.`);
}

// ---------------------------------------------------------------------------
// kaizen plugin remove <name>
// ---------------------------------------------------------------------------

export function cmdPluginRemove(nameArg: string | undefined, uninstall: boolean): void {
  if (!nameArg) {
    console.error("Usage: kaizen plugin remove <plugin-name> [--uninstall]");
    process.exit(1);
  }

  if (existsSync(CONFIG_PATH)) {
    const config = readLocalConfig();
    const plugins = getPlugins(config);
    const filtered = plugins.filter((p) => p !== nameArg);
    if (filtered.length < plugins.length) {
      config["plugins"] = filtered;
      writeLocalConfig(config);
      console.log(`Removed '${nameArg}' from kaizen.json plugins.`);
    } else {
      console.log(`'${nameArg}' not found in kaizen.json plugins.`);
    }
  }

  if (uninstall) {
    console.log(`Uninstalling ${nameArg}...`);
    bunRemoveGlobal(nameArg);
  }
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
    let status: string;
    if (isBuiltin(name, builtins)) {
      status = "built-in";
    } else if (isInstalled(name)) {
      status = getInstalledVersion(name);
    } else {
      status = "NOT INSTALLED";
    }
    rows.push([name, status]);
    if (name.length > maxLen) maxLen = name.length;
  }

  for (const [name, status] of rows) {
    const pad = " ".repeat(maxLen - name.length + 2);
    const marker = status === "NOT INSTALLED" ? "✗" : "✓";
    console.log(`  ${marker} ${name}${pad}${status}`);
  }
}
