// TODO: implement in Step 5 (DESIGN.md)
// provides: ['ui']
// Hooks session:loop (stdin readline) and response:before (stdout).
import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-ui-terminal",
  apiVersion: "1.0.0",
  provides: ["ui"],
  depends: [],
  async setup(_ctx) {
    throw new Error("core-ui-terminal: not implemented");
  },
};

export default plugin;
