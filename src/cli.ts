#!/usr/bin/env bun
/**
 * kaizen CLI entrypoint
 * Built-in plugins are statically imported so bun build --compile bundles them.
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { bootstrap } from "./core/index.js";
import { resolveConfig, PROJECT_DIR, PROJECT_CONFIG, KAIZEN_HOME, KAIZEN_HOME_CONFIG } from "./core/config.js";
import { fatal } from "./core/errors.js";
import {
  readLocalConfig,
  writeLocalConfig,
  cmdApply,
  cmdInstall,
  cmdPluginInstall,
  cmdPluginRemove,
  cmdPluginList,
} from "./commands/manage.js";

import coreEvents from "core-events";
import coreLifecycle from "core-lifecycle";
import coreUiTerminal from "core-ui-terminal";
import coreExecutorAnthropic from "core-executor-anthropic";
import coreExecutorDebug from "core-executor-debug";
import coreExecutorShell from "core-executor-shell";
import kaizenPluginTimestamps from "kaizen-plugin-timestamps";
import coreCli from "core-cli";
import corePluginManager from "core-plugin-manager";

const builtins = {
  [coreEvents.name]: coreEvents,
  [coreLifecycle.name]: coreLifecycle,
  [coreUiTerminal.name]: coreUiTerminal,
  [coreExecutorAnthropic.name]: coreExecutorAnthropic,
  [coreExecutorDebug.name]: coreExecutorDebug,
  [coreExecutorShell.name]: coreExecutorShell,
  [kaizenPluginTimestamps.name]: kaizenPluginTimestamps,
  [coreCli.name]: coreCli,
  [corePluginManager.name]: corePluginManager,
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const subcommand = rawArgs[0];

function getCliList(config: Record<string, unknown>): string[] {
  const cliConfig = config["core-cli"] as Record<string, unknown> | undefined;
  return (cliConfig?.["clis"] as string[] | undefined) ?? [];
}

function setCliList(config: Record<string, unknown>, clis: string[]): void {
  if (typeof config["core-cli"] !== "object" || config["core-cli"] === null) {
    config["core-cli"] = {};
  }
  (config["core-cli"] as Record<string, unknown>)["clis"] = clis;
}

const DEFAULT_PLUGINS = {
  plugins: [
    "core-events",
    "core-executor-anthropic",
    "core-ui-terminal",
    "core-cli",
    "core-lifecycle",
  ],
  "core-executor-anthropic": {
    model: "claude-opus-4-6",
    api_key_env: "ANTHROPIC_API_KEY",
  },
  "core-cli": {
    clis: [] as string[],
    allow_destructive: false,
    subprocess_timeout_ms: 30000,
  },
};

// ---------------------------------------------------------------------------
// Subcommand: kaizen init [--global]
// ---------------------------------------------------------------------------

if (subcommand === "init") {
  const isGlobal = rawArgs.includes("--global");

  if (isGlobal) {
    if (existsSync(KAIZEN_HOME_CONFIG)) {
      console.log(`~/.kaizen/kaizen.json already exists.`);
      process.exit(0);
    }
    mkdirSync(KAIZEN_HOME, { recursive: true });
    writeFileSync(KAIZEN_HOME_CONFIG, JSON.stringify(DEFAULT_PLUGINS, null, 2) + "\n", "utf8");
    console.log(`Created ~/.kaizen/kaizen.json`);
  } else {
    if (existsSync(PROJECT_CONFIG)) {
      console.log(`.kaizen/kaizen.json already exists.`);
      process.exit(0);
    }
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(PROJECT_CONFIG, JSON.stringify(DEFAULT_PLUGINS, null, 2) + "\n", "utf8");
    console.log(`Created .kaizen/kaizen.json`);
  }

  console.log(`Run 'kaizen add <cli>' to register CLI tools.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen add <cli>
// ---------------------------------------------------------------------------

if (subcommand === "add") {
  const cliName = rawArgs[1];
  if (!cliName) fatal("Usage: kaizen add <cli-name>");
  const config = readLocalConfig();
  const clis = getCliList(config);
  if (clis.includes(cliName)) {
    console.log(`'${cliName}' is already registered.`);
  } else {
    clis.push(cliName);
    setCliList(config, clis);
    writeLocalConfig(config);
    console.log(`Added '${cliName}' to core-cli.clis.`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen remove <cli>
// ---------------------------------------------------------------------------

if (subcommand === "remove") {
  const cliName = rawArgs[1];
  if (!cliName) fatal("Usage: kaizen remove <cli-name>");
  const config = readLocalConfig();
  const clis = getCliList(config);
  const filtered = clis.filter((c) => c !== cliName);
  if (filtered.length === clis.length) {
    console.log(`'${cliName}' is not registered.`);
  } else {
    setCliList(config, filtered);
    writeLocalConfig(config);
    console.log(`Removed '${cliName}' from core-cli.clis.`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen list
// ---------------------------------------------------------------------------

if (subcommand === "list") {
  const config = readLocalConfig();
  const clis = getCliList(config);
  if (clis.length === 0) {
    console.log("No CLIs registered. Use 'kaizen add <cli>' to add one.");
  } else {
    console.log("Registered CLIs:");
    for (const cli of clis) console.log(`  - ${cli}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen apply
// ---------------------------------------------------------------------------

if (subcommand === "apply") {
  cmdApply(builtins);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen install <harness>
// ---------------------------------------------------------------------------

if (subcommand === "install") {
  cmdInstall(rawArgs[1]);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen plugin <sub> [args]
// ---------------------------------------------------------------------------

if (subcommand === "plugin") {
  const pluginSub = rawArgs[1];
  switch (pluginSub) {
    case "install":
      cmdPluginInstall(rawArgs[2]);
      break;
    case "remove":
      cmdPluginRemove(rawArgs[2], rawArgs.includes("--uninstall"));
      break;
    case "list":
      cmdPluginList(builtins);
      break;
    default:
      console.error("Usage: kaizen plugin install|remove|list [args]");
      process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen run [prompt]  (also: kaizen [flags])
// ---------------------------------------------------------------------------

const FLAGS_WITH_VALUE = new Set(["--harness", "--config"]);

function parseRunArgs(args: string[]): {
  harness?: string;
  configPath?: string;
  allowDestructive: boolean;
  prompt?: string;
} {
  let harness: string | undefined;
  let configPath: string | undefined;
  let allowDestructive = false;
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (FLAGS_WITH_VALUE.has(arg)) {
      const val = args[i + 1] ?? "";
      if (arg === "--harness") harness = val;
      if (arg === "--config") configPath = val;
      i += 2;
    } else if (arg === "--allow-destructive") {
      allowDestructive = true;
      i++;
    } else if (arg.startsWith("--")) {
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }

  const firstPositional = positional[0];
  const prompt = firstPositional === "run" ? positional[1] : firstPositional;

  return {
    ...(harness !== undefined ? { harness } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    allowDestructive,
    ...(prompt !== undefined ? { prompt } : {}),
  };
}

const parsed = parseRunArgs(rawArgs);

const kaizenConfig = resolveConfig({
  ...(parsed.harness !== undefined ? { harness: parsed.harness } : {}),
  ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
});

if (parsed.allowDestructive) {
  const cliConfig = (kaizenConfig["core-cli"] as Record<string, unknown> | undefined) ?? {};
  cliConfig["allow_destructive"] = true;
  kaizenConfig["core-cli"] = cliConfig;
}

if (parsed.prompt) {
  const uiConfig = (kaizenConfig["core-ui-terminal"] as Record<string, unknown> | undefined) ?? {};
  uiConfig["initial_prompt"] = parsed.prompt;
  uiConfig["one_shot"] = true;
  kaizenConfig["core-ui-terminal"] = uiConfig;
}

await bootstrap(kaizenConfig, builtins);
