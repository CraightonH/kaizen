import { randomUUID } from "crypto";
import type { KaizenPlugin, UiChannel, AgentMessage, Message } from "../../src/types/plugin.js";
import { CoreEventsServiceToken, type UserMessageContext, type ResponseContext } from "../core-events/index.js";

async function broadcast(channels: Iterable<UiChannel>, msg: AgentMessage): Promise<void> {
  await Promise.all([...channels].map((c) => c.send(msg).catch(() => {})));
}

const plugin: KaizenPlugin = {
  name: "core-lifecycle",
  apiVersion: "2.0.0",
  capabilities: {
    provides: ["core-lifecycle:lifecycle.drive"],
    consumes: [
      "core-lifecycle:executor.send",
      "core-lifecycle:ui.input",
      "core-lifecycle:ui.output",
      "core-events:service",
    ],
  },

  async setup(ctx) {
    ctx.defineCapability("core-lifecycle:lifecycle.drive", {
      cardinality: "one",
      description: "Drives the session loop via start(ctx).",
    });
    ctx.defineCapability("core-lifecycle:ui.input", {
      cardinality: "many",
      description: "Provides user-input channels to the session loop.",
    });
    ctx.defineCapability("core-lifecycle:ui.output", {
      cardinality: "many",
      description: "Renders session output to a destination.",
    });
    ctx.defineCapability("core-lifecycle:executor.send", {
      cardinality: "many",
      description: "Sends messages/tools to an executor backend.",
    });
    ctx.getService(CoreEventsServiceToken);
  },

  async start(ctx) {
    const { events } = ctx.getService(CoreEventsServiceToken);
    const providers = ctx.runtime.ui.list();

    // Accumulate channels from all providers. A provider's accept() may yield
    // lazily (terminal yields once; web could yield per-connection indefinitely).
    const activeChannels = new Set<UiChannel>();
    let stopAccepting = false;
    let pumpsDone = false;

    // Resolvers waiting for channel-added / pump-drained signals.
    let channelAddedResolvers: Array<() => void> = [];
    const notifyChannelAdded = () => {
      const rs = channelAddedResolvers;
      channelAddedResolvers = [];
      for (const r of rs) r();
    };

    const pumps: Promise<void>[] = providers.map(async (provider) => {
      try {
        for await (const channel of provider.accept()) {
          if (stopAccepting) {
            await channel.close().catch(() => {});
            break;
          }
          activeChannels.add(channel);
          notifyChannelAdded();
        }
      } catch (err) {
        ctx.log(`ui provider pump error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    const pumpsSettled = Promise.allSettled(pumps).then(() => {
      pumpsDone = true;
      notifyChannelAdded(); // unblock any waiter
    });

    const waitForChannelOrDrain = async (): Promise<void> => {
      if (activeChannels.size > 0 || pumpsDone) return;
      await new Promise<void>((resolve) => channelAddedResolvers.push(resolve));
    };

    // Give sync-yielding providers a chance to populate before deciding headless.
    await Promise.resolve();
    await waitForChannelOrDrain();

    // Headless: no channels, all providers done — exit cleanly without a session.
    if (activeChannels.size === 0 && pumpsDone) {
      await pumpsSettled;
      return;
    }

    // Shared session state — ONE session driven by races across all channels.
    const sessionId = randomUUID();
    const history: Message[] = [];
    const systemPrompt = ctx.config["systemPrompt"];
    if (typeof systemPrompt === "string") {
      history.push({ role: "system", content: systemPrompt });
    }
    await ctx.emit(events.SESSION_START, { sessionId, config: ctx.config });

    try {
      while (true) {
        if (activeChannels.size === 0) {
          if (pumpsDone) break;
          await waitForChannelOrDrain();
          continue;
        }

        // Race receives across all active channels.
        // TODO: losers remain as orphaned pending promises on their channels'
        // next message or close. Acceptable for phase 1 per plan (simplicity
        // over premature cancellation); real channels consume on receive() so
        // no message is lost — just a transient memory/resource footprint.
        const receives = [...activeChannels].map((c) =>
          c.receive().then(
            (msg) => ({ kind: "msg" as const, msg, channel: c }),
            (err: unknown) => ({ kind: "err" as const, err, channel: c }),
          ),
        );
        // A late-arriving channel should re-drive the race without waiting on
        // existing receives.
        const newChannelSignal = new Promise<{ kind: "new" }>((resolve) => {
          channelAddedResolvers.push(() => resolve({ kind: "new" }));
        });

        const first = await Promise.race<
          | { kind: "msg"; msg: import("../../src/types/plugin.js").UserMessage; channel: UiChannel }
          | { kind: "err"; err: unknown; channel: UiChannel }
          | { kind: "new" }
        >([...receives, newChannelSignal]);

        if (first.kind === "new") continue;
        if (first.kind === "err") {
          activeChannels.delete(first.channel);
          continue;
        }

        const userMsg = first.msg;
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
          await broadcast(activeChannels, { type: "tool_call", name: tc.name, args: tc.args });

          const result = await ctx.runtime.tools.execute(tc.name, tc.args);
          const output = result.error ?? result.output ?? JSON.stringify(result.data) ?? "";
          history.push({ role: "tool", content: output, tool_call_id: tc.id });

          await ctx.emit(events.TOOL_AFTER, { sessionId, tool: tc.name, ok: result.ok, output });
          await broadcast(activeChannels, { type: "tool_result", name: tc.name, ok: result.ok, output });
        }

        if (response.content) {
          await broadcast(activeChannels, { type: "text", content: respPayload.content + "\n" });
        }

        await ctx.runtime.pluginManager.drainPendingReloads();
      }
    } finally {
      stopAccepting = true;
      await ctx.emit(events.SESSION_END, { sessionId });
      await Promise.all([...activeChannels].map((c) => c.close().catch(() => {})));
      activeChannels.clear();
      await pumpsSettled;
    }
  },
};

export default plugin;
