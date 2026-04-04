// TODO: implement in Step 4 (DESIGN.md)
// provides: ['lifecycle']
// Handles __core:ready, drives the session loop, defines default event set.
import type { KaizenPlugin } from "kaizen/src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-lifecycle",
  apiVersion: "1.0.0",
  provides: ["lifecycle"],
  depends: [],
  async setup(_ctx) {
    throw new Error("core-lifecycle: not implemented");
  },
  async start(_ctx) {
    throw new Error("core-lifecycle: not implemented");
  },
};

export default plugin;
