import type { KaizenPlugin } from "../../src/types/plugin.js";
import { EVENTS } from "../core-events/index.js";
import type { UserMessageContext, ResponseContext } from "../core-events/index.js";

const plugin: KaizenPlugin = {
  name: "kaizen-plugin-timestamps",
  apiVersion: "1.0.0",
  provides: [],
  depends: ["events"],

  async setup(ctx) {
    ctx.on(EVENTS.USER_MESSAGE, async (payload) => {
      const { content } = payload as UserMessageContext;
      ctx.log(`[${new Date().toISOString()}] user: ${content}`);
    });

    ctx.on(EVENTS.AGENT_RESPONSE, async (payload) => {
      const { content } = payload as ResponseContext;
      ctx.log(`[${new Date().toISOString()}] agent: ${content}`);
    });
  },
};

export default plugin;
