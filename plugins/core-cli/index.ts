// TODO: implement in Step 6 (DESIGN.md)
// provides: []  depends: ['lifecycle']
// CLI introspection engine. Registers tools from --help output.
// Handles `kaizen add <cli>`. Destructive guard via tool:before hook.
import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-cli",
  apiVersion: "1.0.0",
  provides: [],
  depends: ["lifecycle"],
  async setup(_ctx) {
    throw new Error("core-cli: not implemented");
  },
};

export default plugin;
