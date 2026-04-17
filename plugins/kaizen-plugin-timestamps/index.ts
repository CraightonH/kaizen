import type { KaizenPlugin } from "../../src/types/plugin.js";
import { EVENTS } from "../core-events/index.js";
import type { UserMessageContext, ResponseContext } from "../core-events/index.js";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-timestamps",
  apiVersion: "2.0.0",
  capabilities: { consumes: ["core-lifecycle:lifecycle.drive"] },

  async setup(ctx) {
    ctx.on(EVENTS.USER_MESSAGE, async (payload) => {
      const msg = payload as UserMessageContext;
      msg.content = `[${new Date().toISOString()}] ${msg.content}`;
    });

    ctx.on(EVENTS.AGENT_RESPONSE, async (payload) => {
      const msg = payload as ResponseContext;
      msg.content = `[${new Date().toISOString()}] ${msg.content}`;
    });
  },
};

export default plugin;
