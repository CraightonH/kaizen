#!/usr/bin/env bun
/**
 * kaizen CLI entrypoint
 * Built-in plugins are statically imported so bun build --compile bundles them.
 */
import { bootstrap } from "./core/index.js";
import { loadKaizenConfig } from "./core/config.js";

import coreEvents from "core-events";
import coreLifecycle from "core-lifecycle";
import coreUiTerminal from "core-ui-terminal";
import coreCli from "core-cli";

const builtins = {
  [coreEvents.name]: coreEvents,
  [coreLifecycle.name]: coreLifecycle,
  [coreUiTerminal.name]: coreUiTerminal,
  [coreCli.name]: coreCli,
};

const kaizenConfig = loadKaizenConfig();

await bootstrap(kaizenConfig, builtins);
