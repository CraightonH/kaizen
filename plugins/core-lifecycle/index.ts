import { randomUUID } from "crypto";
import type { KaizenPlugin, PluginContext, UiChannel, Message } from "../../src/types/plugin.js";
import { CoreEventsServiceToken, type CoreEventsService, type UserMessageContext, type ResponseContext } from "../core-events/index.js";

async function runSession(channel: UiChannel, ctx: PluginContext, events: CoreEventsService["events"]): Promise<void> {
  const sessionId = randomUUID();
  const history: Message[] = [];

  const systemPrompt = ctx.config["systemPrompt"];
  if (typeof systemPrompt === "string") {
    history.push({ role: "system", content: systemPrompt });
  }

  await ctx.emit(events.SESSION_START, { sessionId, config: ctx.config });

  try {
    while (true) {
      let userMsg;
      try {
        userMsg = await channel.receive();
      } catch {
        break;
      }

      const msgPayload: UserMessageContext = { sessionId, content: userMsg.content };
      await ctx.emit(events.USER_MESSAGE, msgPayload);
      history.push({ role: "user", content: msgPayload.content });

      const tools = ctx.runtime.tools.list();
      const response = await ctx.runtime.executor.send(history, tools);

      const respPayload: ResponseContext = { sessionId, content: response.content };
      if (response.content) {
        await ctx.emit(events.AGENT_RESPONSE, respPayload);
      }

      history.push({
        role: "assistant",
        content: respPayload.content,
        ...(response.tool_calls.length > 0 ? { tool_calls: response.tool_calls } : {}),
      });

      for (const tc of response.tool_calls) {
        await ctx.emit(events.TOOL_BEFORE, { sessionId, tool: tc.name, args: tc.args });
        await channel.send({ type: "tool_call", name: tc.name, args: tc.args });

        const result = await ctx.runtime.tools.execute(tc.name, tc.args);
        const output = result.error ?? result.output ?? JSON.stringify(result.data) ?? "";
        history.push({ role: "tool", content: output, tool_call_id: tc.id });

        await ctx.emit(events.TOOL_AFTER, { sessionId, tool: tc.name, ok: result.ok, output });
        await channel.send({ type: "tool_result", name: tc.name, ok: result.ok, output });
      }

      if (response.content) {
        await channel.send({ type: "text", content: respPayload.content + "\n" });
      }

      await ctx.runtime.pluginManager.drainPendingReloads();
    }
  } finally {
    await ctx.emit(events.SESSION_END, { sessionId });
    await channel.close();
  }
}

const plugin: KaizenPlugin = {
  name: "core-lifecycle",
  apiVersion: "1.0.0",
  provides: ["lifecycle"],
  depends: ["events", "executor", "ui"],

  async setup(ctx) {
    ctx.getService(CoreEventsServiceToken); // validates CoreEventsService is available
  },

  async start(ctx) {
    const { events } = ctx.getService(CoreEventsServiceToken);
    const sessions: Promise<void>[] = [];
    for await (const channel of ctx.runtime.ui.accept()) {
      sessions.push(
        runSession(channel, ctx, events).catch((err: unknown) => {
          ctx.log(`session ${channel.id} error: ${err instanceof Error ? err.message : String(err)}`);
        }),
      );
    }
    await Promise.all(sessions);
  },
};

export default plugin;
