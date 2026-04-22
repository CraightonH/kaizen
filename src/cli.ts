#!/usr/bin/env bun
/**
 * kaizen CLI entrypoint
 * The binary ships with zero built-in plugins. All plugins load dynamically
 * through the marketplace install path (~/.kaizen/marketplaces/<id>/).
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { bootstrap } from "./core/index.js";
import { resolveConfig, findProjectConfig, resolveHarness, PROJECT_DIR, PROJECT_CONFIG, KAIZEN_HOME, KAIZEN_HOME_CONFIG } from "./core/config.js";
import { readFileSync } from "fs";
import { fatal } from "./core/errors.js";
import { deriveLockfilePath } from "./core/lockfile-path.js";
import {
  readLocalConfig,
  writeLocalConfig,
  cmdPluginList,
} from "./commands/manage.js";
import { runPluginConsent } from "./commands/plugin-consent.js";
import { runPluginReview } from "./commands/plugin-review.js";
import { runPluginAudit } from "./commands/plugin-audit.js";
import { registerHostApi } from "./core/host-api-register.js";
import { KaizenError } from "./core/errors.js";

// Register the `kaizen/types` virtual module for plugin imports.
// Must run before any dynamic plugin import (bootstrap, plugin dev,
// capability list, tests, etc.).
registerHostApi();

// Top-level error handling: KaizenError is a user-facing error; print the
// message and exit 1 without a stack trace. Anything else is a bug and
// gets the full stack.
function handleFatal(err: unknown): never {
  if (err instanceof KaizenError) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
process.on("uncaughtException", handleFatal);
process.on("unhandledRejection", handleFatal);

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

function resolveHarnessJsonPath(opts: { harness?: string; extendsOverride?: string; configPath?: string }): string {
  if (opts.harness) return resolveHarness(opts.harness).kaizenJsonPath;
  if (opts.extendsOverride) return resolveHarness(opts.extendsOverride).kaizenJsonPath;
  // Fallback: read extends out of the local (or global) config and resolve it.
  const activePath = opts.configPath ?? findProjectConfig() ??
    (existsSync(KAIZEN_HOME_CONFIG) ? KAIZEN_HOME_CONFIG : null);
  if (activePath) {
    try {
      const raw = JSON.parse(readFileSync(activePath, "utf8")) as { extends?: unknown };
      if (typeof raw.extends === "string") return resolveHarness(raw.extends).kaizenJsonPath;
    } catch { /* resolveConfig will raise the right error */ }
  }
  return fatal(
    `this command requires an active harness. Pass --harness <marketplace>/<name>@<version>, ` +
    `or set 'extends' in kaizen.json. See docs/concepts/harnesses.md.`,
  );
}

const DEFAULT_PLUGINS = {
  plugins: [
    "official/core-events@0.1.0",
    "official/core-executor-anthropic@0.1.0",
    "official/core-ui-terminal@0.1.0",
    "official/core-cli@0.1.0",
    "official/core-driver@0.1.0",
  ],
  "core-executor-anthropic": {
    model: "claude-opus-4-6",
  },
  "core-cli": {
    clis: [] as string[],
    allow_destructive: false,
    subprocess_timeout_ms: 30000,
  },
};

// ---------------------------------------------------------------------------
// Subcommand: kaizen --help | -h | help
// ---------------------------------------------------------------------------

if (subcommand === "--help" || subcommand === "-h" || subcommand === "help" || (subcommand === undefined && (rawArgs.includes("--help") || rawArgs.includes("-h")))) {
  console.log(`kaizen — platform for composable LLM harnesses

Usage:
  kaizen --harness <ref> [prompt]       run a harness (prompts for consent first run)
  kaizen run [prompt]                   run the active harness
  kaizen <subcommand> [args]

Subcommands:
  init [--global]                       scaffold kaizen.json (project or ~/.kaizen/)
  install <ref> [--allow-unscoped]      install a plugin or harness
  uninstall <ref> [--purge]             uninstall a plugin
  update [<ref>]                        update plugins
  plugin {list|consent|review|audit|dev|create|validate}
  marketplace {add|list|remove|update|browse|create|validate}
  capability {list|show <name>}
  config {show|get|set|set-secret}

Flags:
  --harness <ref>                       harness ref (marketplace/name@version)
  --config <path>                       alternate kaizen.json path
  --trust-lockfile                      reuse existing lockfile; no prompts
  --non-interactive                     refuse any prompt-requiring consent
  --allow-unscoped                      permit non-interactive UNSCOPED consent
  --allow-destructive                   enable destructive CLI tools
  --help, -h                            show this help

Environment:
  KAIZEN_HOME                           state dir (default ~/.kaizen)
  KAIZEN_SANDBOX_MODE=log-only          permission enforcer logs instead of throws

See docs/concepts/harnesses.md for harness configuration.`);
  process.exit(0);
}

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
// Subcommand: kaizen config show|get|set|set-secret
// ---------------------------------------------------------------------------

if (subcommand === "config") {
  const { cmdConfigShow, cmdConfigGet, cmdConfigSet, cmdConfigSetSecret } = await import("./commands/config.js");
  const sub = rawArgs[1];
  const rest = rawArgs.slice(2);
  const isGlobal = rest.includes("--global");
  const providerIdx = rest.indexOf("--provider");
  const provider = providerIdx >= 0 ? rest[providerIdx + 1] : undefined;

  let code = 0;
  if (sub === "show") {
    code = cmdConfigShow(rest.find((a) => !a.startsWith("--")));
  } else if (sub === "get") {
    const [plugin, path] = rest.filter((a) => !a.startsWith("--"));
    code = cmdConfigGet(plugin, path);
  } else if (sub === "set") {
    const nonFlags = rest.filter((a) => !a.startsWith("--"));
    code = cmdConfigSet(nonFlags[0], nonFlags[1], nonFlags[2], { global: isGlobal });
  } else if (sub === "set-secret") {
    const [plugin, key] = rest.filter((a) => !a.startsWith("--"));
    code = await cmdConfigSetSecret(plugin, key, { global: isGlobal, ...(provider !== undefined ? { provider } : {}) });
  } else {
    console.error("Usage: kaizen config {show|get|set|set-secret} [args]");
    code = 2;
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen marketplace <sub> [args]
// ---------------------------------------------------------------------------

if (subcommand === "marketplace") {
  const {
    cmdMarketplaceAdd, cmdMarketplaceList, cmdMarketplaceRemove,
    cmdMarketplaceUpdate, cmdMarketplaceBrowse,
  } = await import("./commands/marketplace.js");
  const sub = rawArgs[1];
  const rest = rawArgs.slice(2);
  const idIdx = rest.indexOf("--id");
  const id = idIdx >= 0 ? rest[idIdx + 1] : undefined;

  if (sub === "create") {
    const { runMarketplaceCreate } = await import("./commands/marketplace-create.js");
    const targetPath = rawArgs[2] ?? ".";
    const code = await runMarketplaceCreate(targetPath, { defaults: rawArgs.includes("--defaults") });
    process.exit(code);
  }

  if (sub === "validate") {
    const { runMarketplaceValidate } = await import("./commands/marketplace-validate.js");
    const targetPath = rawArgs[2] ?? ".";
    const code = await runMarketplaceValidate(targetPath);
    process.exit(code);
  }

  let code = 0;
  switch (sub) {
    case "add": {
      const url = rest.find((a) => !a.startsWith("--") && a !== id);
      if (!url) { console.error("usage: kaizen marketplace add <url> [--id <id>]"); process.exit(2); }
      code = await cmdMarketplaceAdd({ url, ...(id ? { id } : {}) });
      break;
    }
    case "list":
      code = await cmdMarketplaceList();
      break;
    case "remove": {
      const target = rest.find((a) => !a.startsWith("--"));
      if (!target) { console.error("usage: kaizen marketplace remove <id>"); process.exit(2); }
      code = await cmdMarketplaceRemove({ id: target });
      break;
    }
    case "update": {
      const target = rest.find((a) => !a.startsWith("--"));
      code = await cmdMarketplaceUpdate(target ? { id: target } : {});
      break;
    }
    case "browse": {
      const target = rest.find((a) => !a.startsWith("--"));
      code = await cmdMarketplaceBrowse(target ? { id: target } : {});
      break;
    }
    default:
      console.error("Usage: kaizen marketplace {add|list|remove|update|browse|create|validate} [args]");
      code = 2;
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen install <ref> [--allow-unscoped] [--non-interactive]
// ---------------------------------------------------------------------------

if (subcommand === "install") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  if (!ref) { console.error("usage: kaizen install <ref> [--allow-unscoped] [--non-interactive]"); process.exit(2); }
  // Harness installs don't need an active harness context; plugin installs do.
  // Defer resolution so `kaizen install <harness-ref>` works from a bare setup.
  let lockfilePath = "";
  try {
    lockfilePath = deriveLockfilePath(resolveHarnessJsonPath({}));
  } catch { /* resolved lazily inside runUnifiedInstall only for plugin installs */ }
  const { runUnifiedInstall } = await import("./commands/install.js");
  const code = await runUnifiedInstall({
    ref,
    lockfilePath,
    allowUnscoped: rest.includes("--allow-unscoped"),
    nonInteractive: rest.includes("--non-interactive"),
  });
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen uninstall <ref> [--purge]
// ---------------------------------------------------------------------------

if (subcommand === "uninstall") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  if (!ref) { console.error("usage: kaizen uninstall <ref> [--purge]"); process.exit(2); }
  const harnessJsonPath = resolveHarnessJsonPath({});
  const lockfilePath = deriveLockfilePath(harnessJsonPath);
  const { runUninstall } = await import("./commands/uninstall.js");
  const code = await runUninstall({
    ref,
    lockfilePath,
    purge: rest.includes("--purge"),
  });
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen update [<ref>] [--allow-unscoped] [--non-interactive]
// ---------------------------------------------------------------------------

if (subcommand === "update") {
  const rest = rawArgs.slice(1);
  const ref = rest.find((a) => !a.startsWith("--"));
  const harnessJsonPath = resolveHarnessJsonPath({});
  const lockfilePath = deriveLockfilePath(harnessJsonPath);
  const { runUpdate } = await import("./commands/update.js");
  const code = await runUpdate({
    ...(ref ? { ref } : {}),
    lockfilePath,
    allowUnscoped: rest.includes("--allow-unscoped"),
    nonInteractive: rest.includes("--non-interactive"),
  });
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen plugin <sub> [args]
// ---------------------------------------------------------------------------

if (subcommand === "plugin") {
  const pluginSub = rawArgs[1];
  const rest = rawArgs.slice(2);
  const name = rest.find((a) => !a.startsWith("--"));

  if (pluginSub === "dev" && rest.includes("--observe")) {
    const { runPluginDevObserve } = await import("./commands/plugin-dev.js");
    const { readFileSync } = await import("fs");
    const { resolveConfig: resolveConfigInner } = await import("./core/config.js");
    const nameArg = rest.find((a) => !a.startsWith("--"));
    if (!nameArg) {
      console.error("usage: kaizen plugin dev --observe <plugin-dir>");
      process.exit(2);
    }
    const pluginDir = nameArg.startsWith(".") || nameArg.startsWith("/")
      ? nameArg
      : join(process.cwd(), nameArg);
    const pluginName = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).name as string;
    const outDir = join(pluginDir, ".kaizen");
    // Honor --harness flag if provided
    const harnessIdx = rest.indexOf("--harness");
    const devHarnessArg = harnessIdx !== -1 ? rest[harnessIdx + 1] : undefined;
    const devConfig = resolveConfigInner(devHarnessArg !== undefined ? { harness: devHarnessArg } : {});
    const devHarnessJsonPath = resolveHarnessJsonPath(devHarnessArg !== undefined ? { harness: devHarnessArg } : {});
    const devLockfilePath = deriveLockfilePath(devHarnessJsonPath);
    const code = await runPluginDevObserve({ pluginName, pluginDir, outDir, kaizenConfig: devConfig, lockfilePath: devLockfilePath });
    process.exit(code);
  }

  // list/create/validate don't need an active harness; consent/review/audit do.
  const needsHarness = pluginSub === "consent" || pluginSub === "review" || pluginSub === "audit";
  const lockfilePath = needsHarness ? deriveLockfilePath(resolveHarnessJsonPath({})) : "";

  if (pluginSub === "consent" && name) {
    const code = await runPluginConsent({
      pluginName: name,
      lockfilePath,
      allowUnscoped: rest.includes("--allow-unscoped"),
      nonInteractive: rest.includes("--non-interactive"),
    });
    process.exit(code);
  }
  if (pluginSub === "review" && name) {
    const code = await runPluginReview({ pluginName: name, lockfilePath });
    process.exit(code);
  }
  if (pluginSub === "audit") {
    const code = await runPluginAudit({ lockfilePath });
    process.exit(code);
  }

  if (pluginSub === "create") {
    const { runPluginCreate } = await import("./commands/plugin-create.js");
    const targetPath = name ?? ".";
    const code = await runPluginCreate(targetPath, { defaults: rest.includes("--defaults") });
    process.exit(code);
  }

  if (pluginSub === "validate") {
    const { runPluginValidate } = await import("./commands/plugin-validate.js");
    const targetPath = name ?? ".";
    const code = await runPluginValidate(targetPath);
    process.exit(code);
  }

  switch (pluginSub) {
    case "list":
      cmdPluginList();
      break;
    case "install":
    case "remove":
      console.error(
        `'kaizen plugin ${pluginSub}' has been removed.\n` +
        `  Install a plugin:   kaizen install <marketplace>/<name>@<version>\n` +
        `  Uninstall a plugin: kaizen uninstall <marketplace>/<name>@<version>`,
      );
      process.exit(2);
      break;
    default:
      console.error("Usage: kaizen plugin {list|consent|review|audit|dev|create|validate} [args]");
      process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subcommand: kaizen capability list|show <name>
// ---------------------------------------------------------------------------

if (subcommand === "capability") {
  const sub = rawArgs[1];
  const { capabilityList, capabilityShow } = await import("./commands/capability.js");
  const { initializePluginSystem } = await import("./core/index.js");
  const harnessJsonPath = resolveHarnessJsonPath({});
  const lockfilePath = deriveLockfilePath(harnessJsonPath);
  const cfg = resolveConfig({});
  const { serviceRegistry } = await initializePluginSystem(cfg, { lockfilePath });
  if (sub === "list") {
    capabilityList(serviceRegistry);
  } else if (sub === "show") {
    const name = rawArgs[2];
    if (!name) {
      console.error("Usage: kaizen capability show <name>");
      process.exit(1);
    }
    capabilityShow(serviceRegistry, name);
  } else {
    console.error("Usage: kaizen capability list|show <name>");
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

if (parsed.harness !== undefined && /^https?:\/\//i.test(parsed.harness)) {
  fatal("raw URL harnesses are not supported — publish the harness in a marketplace and use --harness <id>/<name>@<version>");
}

const trustLockfile = rawArgs.includes("--trust-lockfile");
const nonInteractive = rawArgs.includes("--non-interactive");
const allowUnscopedFlag = rawArgs.includes("--allow-unscoped");

const { looksLikeHarnessRef, materializeHarnessRef } = await import("./core/kaizen-config.js");

// Materialize a marketplace-ref --harness to a concrete path.
let harnessArg = parsed.harness;
if (harnessArg !== undefined && looksLikeHarnessRef(harnessArg)) {
  harnessArg = await materializeHarnessRef(harnessArg);
}

// Materialize a marketplace-ref `extends` in the local (or home) config,
// so resolveConfig can stay sync.
let extendsOverride: string | undefined;
if (harnessArg === undefined) {
  const activePath = parsed.configPath ?? findProjectConfig() ??
    (existsSync(KAIZEN_HOME_CONFIG) ? KAIZEN_HOME_CONFIG : null);
  if (activePath) {
    try {
      const raw = JSON.parse(readFileSync(activePath, "utf8")) as { extends?: unknown };
      const ext = typeof raw.extends === "string" ? raw.extends : null;
      if (ext && looksLikeHarnessRef(ext)) {
        extendsOverride = await materializeHarnessRef(ext);
      }
    } catch { /* ignore; resolveConfig will surface parse errors */ }
  }
}

const harnessJsonPath = resolveHarnessJsonPath({
  ...(harnessArg !== undefined ? { harness: harnessArg } : {}),
  ...(extendsOverride !== undefined ? { extendsOverride } : {}),
  ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
});
const lockfilePath = deriveLockfilePath(harnessJsonPath);

const kaizenConfig = resolveConfig({
  ...(harnessArg !== undefined ? { harness: harnessArg } : {}),
  ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
  ...(extendsOverride !== undefined ? { extendsOverride } : {}),
});

// Bootstrap any missing marketplaces + plugins referenced by the harness.
if ((kaizenConfig.marketplaces as unknown[])?.length || ((kaizenConfig.plugins as string[] | undefined) ?? []).some((p: string) => p.includes("/"))) {
  const { bootstrapMissingPlugins } = await import("./core/bootstrap.js");
  await bootstrapMissingPlugins(kaizenConfig, {
    lockfilePath,
    trustLockfile, nonInteractive, allowUnscoped: allowUnscopedFlag,
  });
}

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

// Background marketplace refresh (non-blocking).
{
  const { loadKaizenGlobalConfig: loadGlobal2 } = await import("./core/kaizen-config.js");
  const { shouldRefresh, refreshInBackground } = await import("./core/marketplace.js");
  const globalCfg = await loadGlobal2();
  const ttl = globalCfg.marketplaceUpdateTTL ?? 900;
  for (const m of globalCfg.marketplaces ?? []) {
    if (shouldRefresh(m, ttl)) refreshInBackground(m.id);
  }
}

await bootstrap(kaizenConfig, lockfilePath);
