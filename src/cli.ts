#!/usr/bin/env bun
/**
 * kaizen CLI entrypoint
 * Built-in plugins are statically imported so bun build --compile bundles them.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { bootstrap } from "./core/index.js";
import { resolveConfig } from "./core/config.js";
import { fatal } from "./core/errors.js";

import coreEvents from "core-events";
import coreLifecycle from "core-lifecycle";
import coreUiTerminal from "core-ui-terminal";
import coreExecutorAnthropic from "core-executor-anthropic";
import coreExecutorDebug from "core-executor-debug";
import coreExecutorShell from "core-executor-shell";
import kaizenPluginTimestamps from "kaizen-plugin-timestamps";
import coreCli from "core-cli";

const builtins = {
  [coreEvents.name]: coreEvents,
  [coreLifecycle.name]: coreLifecycle,
  [coreUiTerminal.name]: coreUiTerminal,
  [coreExecutorAnthropic.name]: coreExecutorAnthropic,
  [coreExecutorDebug.name]: coreExecutorDebug,
  [coreExecutorShell.name]: coreExecutorShell,
  [kaizenPluginTimestamps.name]: kaizenPluginTimestamps,
  [coreCli.name]: coreCli,
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rawArgs.indexOf(name);
  return i !== -1 ? rawArgs[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return rawArgs.includes(name);
}

const subcommand = rawArgs[0];

// ---------------------------------------------------------------------------
// kaizen.json helpers (for add/remove/list)
// ---------------------------------------------------------------------------

const CONFIG_PATH = "kaizen.json";

function readLocalConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    fatal(
      `No kaizen.json found. Run 'kaizen init' to create one, ` +
      `or use a harness: kaizen --harness core-anthropic`,
    );
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function writeLocalConfig(config: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

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
    process.exit(0);
  }

  clis.push(cliName);
  setCliList(config, clis);
  writeLocalConfig(config);
  console.log(`Added '${cliName}' to core-cli.clis in kaizen.json.`);
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
    process.exit(0);
  }

  setCliList(config, filtered);
  writeLocalConfig(config);
  console.log(`Removed '${cliName}' from core-cli.clis in kaizen.json.`);
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
// Subcommand: kaizen init
// ---------------------------------------------------------------------------

if (subcommand === "init") {
  if (existsSync(CONFIG_PATH)) {
    console.log("kaizen.json already exists.");
    process.exit(0);
  }

  const defaultConfig = {
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

  writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");
  console.log("Created kaizen.json. Run 'kaizen add <cli>' to register CLI tools.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen run [prompt]
// ---------------------------------------------------------------------------

// Parse remaining run args — anything not consumed above as a subcommand.
// Handles both `kaizen run [opts] [prompt]` and `kaizen [opts]` (implicit run).
// Flags with values: --harness <val>, --config <val>
// Boolean flags: --allow-destructive
// Positional: "run" keyword (consumed), then optional prompt string

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
      i++; // unknown flag, skip
    } else {
      positional.push(arg);
      i++;
    }
  }

  // First positional is "run" keyword (consumed), second is the prompt
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

// Inject allow_destructive override
if (parsed.allowDestructive) {
  const cliConfig = (kaizenConfig["core-cli"] as Record<string, unknown> | undefined) ?? {};
  cliConfig["allow_destructive"] = true;
  kaizenConfig["core-cli"] = cliConfig;
}

// Inject single-prompt + one-shot into ui config
if (parsed.prompt) {
  const uiConfig = (kaizenConfig["core-ui-terminal"] as Record<string, unknown> | undefined) ?? {};
  uiConfig["initial_prompt"] = parsed.prompt;
  uiConfig["one_shot"] = true;
  kaizenConfig["core-ui-terminal"] = uiConfig;
}

await bootstrap(kaizenConfig, builtins);
