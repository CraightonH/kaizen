#!/usr/bin/env bun
/**
 * kaizen CLI entrypoint
 * Built-in plugins are statically imported so bun build --compile bundles them.
 */
import { bootstrap } from "./core/index.js";
import { resolveConfig } from "./core/config.js";

import coreEvents from "core-events";
import coreLifecycle from "core-lifecycle";
import coreUiTerminal from "core-ui-terminal";
import coreExecutorDebug from "core-executor-debug";
import coreExecutorShell from "core-executor-shell";
import kaizenPluginTimestamps from "kaizen-plugin-timestamps";
import coreCli from "core-cli";

const builtins = {
  [coreEvents.name]: coreEvents,
  [coreLifecycle.name]: coreLifecycle,
  [coreUiTerminal.name]: coreUiTerminal,
  [coreExecutorDebug.name]: coreExecutorDebug,
  [coreExecutorShell.name]: coreExecutorShell,
  [kaizenPluginTimestamps.name]: kaizenPluginTimestamps,
  [coreCli.name]: coreCli,
};

// ---------------------------------------------------------------------------
// Arg parsing — minimal, no dep
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const harness = flag("--harness");
const configPath = flag("--config");

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const kaizenConfig = resolveConfig({
  ...(harness !== undefined ? { harness } : {}),
  ...(configPath !== undefined ? { configPath } : {}),
});

await bootstrap(kaizenConfig, builtins);
