import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { KaizenGlobalConfig } from "../types/plugin.js";
import { PROJECT_CONFIG, KAIZEN_HOME_CONFIG } from "../core/config.js";

function readProjectConfig(): Record<string, unknown> {
  if (!existsSync(PROJECT_CONFIG)) return {};
  try { return JSON.parse(readFileSync(PROJECT_CONFIG, "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

function readGlobalConfig(): KaizenGlobalConfig {
  if (!existsSync(KAIZEN_HOME_CONFIG)) return {};
  try { return JSON.parse(readFileSync(KAIZEN_HOME_CONFIG, "utf8")) as KaizenGlobalConfig; }
  catch { return {}; }
}

function writeProjectConfig(config: Record<string, unknown>): void {
  mkdirSync(dirname(PROJECT_CONFIG), { recursive: true });
  writeFileSync(PROJECT_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function writeGlobalConfig(config: KaizenGlobalConfig): void {
  mkdirSync(dirname(KAIZEN_HOME_CONFIG), { recursive: true });
  writeFileSync(KAIZEN_HOME_CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function coerceValue(raw: string, existing: unknown): unknown {
  if (typeof existing === "number") {
    const n = parseFloat(raw);
    return isNaN(n) ? raw : n;
  }
  if (typeof existing === "boolean") {
    return raw.toLowerCase() === "true";
  }
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw;
}

export function cmdConfigShow(pluginName?: string): number {
  const project = readProjectConfig();
  const global = readGlobalConfig();
  const globalDefaults = (global.defaults ?? {}) as Record<string, Record<string, unknown>>;

  const plugins = (project["plugins"] as string[] | undefined) ?? [];
  const allPluginNames = pluginName
    ? [pluginName]
    : [...new Set([
        ...plugins,
        ...Object.keys(project).filter((k) => k !== "plugins" && k !== "extends"),
        ...Object.keys(globalDefaults),
      ])];

  if (allPluginNames.length === 0) {
    console.log("No plugin configuration found.");
    return 0;
  }

  for (const name of allPluginNames) {
    const harness = (project[name] as Record<string, unknown> | undefined) ?? {};
    const gDefaults = globalDefaults[name] ?? {};
    const merged = { ...gDefaults, ...harness };

    console.log(`${name}:`);
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "object" && value !== null && "provider" in value) {
        const ref = value as { provider: string; ref: string };
        console.log(`  ${key.padEnd(20)} *** (provider: ${ref.provider}, ref: ${ref.ref})  [harness]`);
      } else {
        console.log(`  ${key.padEnd(20)} ${JSON.stringify(value)}  [${harness[key] !== undefined ? "harness" : "global"}]`);
      }
    }
    console.log();
  }
  return 0;
}

export function cmdConfigGet(pluginName: string | undefined, path: string | undefined): number {
  if (!pluginName || !path) {
    console.error("Usage: kaizen config get <plugin> <path>");
    return 2;
  }

  const project = readProjectConfig();
  const global = readGlobalConfig();
  const harness = (project[pluginName] as Record<string, unknown> | undefined) ?? {};
  const gDefaults = ((global.defaults as Record<string, Record<string, unknown>> | undefined)?.[pluginName]) ?? {};
  const merged = { ...gDefaults, ...harness };

  const value = getNestedValue(merged, path);
  if (value === undefined) {
    console.error(`Not found: ${pluginName}.${path}`);
    return 1;
  }

  if (typeof value === "object" && value !== null && "provider" in value) {
    const ref = value as { provider: string; ref: string };
    console.log(`*** (provider: ${ref.provider}, ref: ${ref.ref})`);
  } else {
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  }
  return 0;
}

export function cmdConfigSet(
  pluginName: string | undefined,
  path: string | undefined,
  value: string | undefined,
  flags: { global?: boolean },
): number {
  if (!pluginName || !path || value === undefined) {
    console.error("Usage: kaizen config set <plugin> <path> <value> [--global]");
    return 2;
  }

  if (flags.global) {
    const cfg = readGlobalConfig();
    if (!cfg.defaults) cfg.defaults = {};
    const defaults = cfg.defaults as Record<string, Record<string, unknown>>;
    if (!defaults[pluginName]) defaults[pluginName] = {};
    const existing = getNestedValue(defaults[pluginName]!, path);
    setNestedValue(defaults[pluginName]!, path, coerceValue(value, existing));
    writeGlobalConfig(cfg);
    console.log(`Set ${pluginName}.${path} in global config.`);
  } else {
    const cfg = readProjectConfig();
    if (typeof cfg[pluginName] !== "object" || cfg[pluginName] === null) {
      cfg[pluginName] = {};
    }
    const pluginCfg = cfg[pluginName] as Record<string, unknown>;
    const existing = getNestedValue(pluginCfg, path);
    setNestedValue(pluginCfg, path, coerceValue(value, existing));
    writeProjectConfig(cfg);
    console.log(`Set ${pluginName}.${path} in project config.`);
  }
  return 0;
}

export async function cmdConfigSetSecret(
  pluginName: string | undefined,
  key: string | undefined,
  flags: { global?: boolean; provider?: string },
): Promise<number> {
  if (!pluginName || !key) {
    console.error("Usage: kaizen config set-secret <plugin> <key> [--global] [--provider <name>]");
    return 2;
  }

  if (!process.stdin.isTTY) {
    console.error("kaizen config set-secret requires an interactive terminal");
    return 1;
  }

  process.stdout.write(`Enter value for ${pluginName}.${key}: `);

  const secretValue = await new Promise<string>((resolve) => {
    process.stdin.setRawMode?.(true);
    let input = "";
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        console.log();
        resolve(input);
      } else if (ch === "\u0003") {
        process.stdin.setRawMode?.(false);
        process.stdout.write("\n");
        process.exit(0);
      } else if (ch === "\u007f" || ch === "\b") {
        input = input.slice(0, -1);
      } else {
        input += ch;
      }
    };
    process.stdin.on("data", onData);
  });

  if (!secretValue) {
    console.error("Empty value — aborting.");
    return 1;
  }

  const providerName = flags.provider ?? "kaizen";

  if (providerName === "kaizen") {
    const { fileProvider } = await import("../../plugins/core-secrets/file-fallback.js");
    const ref = `${pluginName}-${key}`;
    if (!fileProvider.set) {
      console.error("File provider does not support writing secrets.");
      return 1;
    }
    await fileProvider.set(ref, secretValue);

    const refObj = { provider: "kaizen", ref };
    if (flags.global) {
      const cfg = readGlobalConfig();
      if (!cfg.defaults) cfg.defaults = {};
      const defaults = cfg.defaults as Record<string, Record<string, unknown>>;
      if (!defaults[pluginName]) defaults[pluginName] = {};
      defaults[pluginName][key] = refObj;
      writeGlobalConfig(cfg);
    } else {
      const cfg = readProjectConfig();
      if (typeof cfg[pluginName] !== "object" || cfg[pluginName] === null) cfg[pluginName] = {};
      (cfg[pluginName] as Record<string, unknown>)[key] = refObj;
      writeProjectConfig(cfg);
    }
    console.log(`Secret stored. Ref: ${JSON.stringify(refObj)}`);
    return 0;
  } else {
    console.error(`Provider '${providerName}' is not directly writable from CLI without a running kaizen session.`);
    return 1;
  }
}
