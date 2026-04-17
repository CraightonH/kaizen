import type { KaizenPlugin } from "../../src/types/plugin.js";

const plugin: KaizenPlugin = {
  name: "core-plugin-manager",
  apiVersion: "1.0.0",
  provides: [],
  depends: [],

  async setup(ctx) {
    ctx.registerTool({
      name: "kaizen_load_plugin",
      description:
        "Load a kaizen plugin by name or path. The plugin will be available after the current turn completes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin package name or path (./relative or /absolute)" },
        },
        required: ["name"],
      },
      destructive: true,
      async execute(args) {
        const name = args["name"] as string;
        ctx.pluginManager.queueLoad(name);
        return { ok: true, output: `Plugin '${name}' queued for load at next turn boundary.` };
      },
    });

    ctx.registerTool({
      name: "kaizen_unload_plugin",
      description:
        "Unload a kaizen plugin by name. The plugin will be removed after the current turn completes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name to unload" },
        },
        required: ["name"],
      },
      destructive: true,
      async execute(args) {
        const name = args["name"] as string;
        ctx.pluginManager.queueUnload(name);
        return { ok: true, output: `Plugin '${name}' queued for unload at next turn boundary.` };
      },
    });

    ctx.registerTool({
      name: "kaizen_reload_plugin",
      description:
        "Reload a kaizen plugin by name — unloads the current version and loads the latest from disk. " +
        "Use this after editing a plugin's source code. Takes effect after the current turn completes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Plugin name or path to reload" },
        },
        required: ["name"],
      },
      destructive: true,
      async execute(args) {
        const name = args["name"] as string;
        ctx.pluginManager.queueReload(name);
        return { ok: true, output: `Plugin '${name}' queued for reload at next turn boundary.` };
      },
    });
  },
};

export default plugin;
