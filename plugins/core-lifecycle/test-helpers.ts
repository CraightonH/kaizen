import type {
  UiChannel,
  UiProvider,
  UserMessage,
  AgentMessage,
  Executor,
  KaizenPlugin,
  KaizenConfig,
  Message,
  ToolDefinition,
  LLMResponse,
} from "../../src/types/plugin.js";
import { PluginManager } from "../../src/core/plugin-manager.js";
import { EventBus } from "../../src/core/event-bus.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { ExecutorRegistry } from "../../src/core/executor-registry.js";
import { UiRegistry } from "../../src/core/ui-registry.js";
import { CapabilityRegistry } from "../../src/core/capability-registry.js";
import { ServiceRegistry } from "../../src/core/service-registry.js";
import coreEvents from "../core-events/index.js";
import coreLifecycle from "./index.js";

export interface MockChannel {
  channel: UiChannel;
  sendUserMessage: (content: string) => void;
  sent: AgentMessage[];
  close: () => void;
  waitForSend: (predicate: (msg: AgentMessage) => boolean, timeoutMs?: number) => Promise<AgentMessage>;
}

export function makeMockChannel(id: string): MockChannel {
  const sent: AgentMessage[] = [];
  const sendWaiters: Array<(msg: AgentMessage) => void> = [];
  let pendingUserResolve: ((msg: UserMessage) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  const queue: UserMessage[] = [];
  let closed = false;

  const channel: UiChannel = {
    id,
    async receive() {
      if (closed) throw new Error("closed");
      if (queue.length > 0) return queue.shift()!;
      return new Promise<UserMessage>((resolve, reject) => {
        pendingUserResolve = resolve;
        pendingReject = reject;
      });
    },
    async send(msg) {
      sent.push(msg);
      const waiters = sendWaiters.splice(0, sendWaiters.length);
      for (const w of waiters) w(msg);
    },
    async close() {
      closed = true;
      const reject = pendingReject;
      pendingUserResolve = null;
      pendingReject = null;
      if (reject) reject(new Error("closed"));
    },
  };

  return {
    channel,
    sent,
    sendUserMessage(content) {
      if (pendingUserResolve) {
        const resolve = pendingUserResolve;
        pendingUserResolve = null;
        pendingReject = null;
        resolve({ type: "text", content });
      } else {
        queue.push({ type: "text", content });
      }
    },
    close() {
      closed = true;
      const reject = pendingReject;
      pendingUserResolve = null;
      pendingReject = null;
      if (reject) reject(new Error("closed"));
    },
    async waitForSend(predicate, timeoutMs = 2000) {
      // Check already-received messages first.
      for (const m of sent) if (predicate(m)) return m;
      return new Promise<AgentMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("waitForSend timeout"));
        }, timeoutMs);
        const check = (msg: AgentMessage) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            resolve(msg);
          } else {
            sendWaiters.push(check);
          }
        };
        sendWaiters.push(check);
      });
    },
  };
}

export function makeMockUiProvider(channels: UiChannel[], pluginName: string): KaizenPlugin {
  const provider: UiProvider = {
    async *accept() {
      for (const c of channels) yield c;
    },
  };
  return {
    name: pluginName,
    apiVersion: "2.0.0",
    capabilities: {
      provides: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"],
      consumes: [],
    },
    async setup(ctx) {
      ctx.registerUi(provider);
    },
  };
}

export function makeEchoExecutorPlugin(pluginName = "mock-executor"): KaizenPlugin {
  const executor: Executor = {
    async send(messages: Message[], _tools: ToolDefinition[]): Promise<LLMResponse> {
      const last = [...messages].reverse().find((m) => m.role === "user");
      return {
        content: `echo:${last?.content ?? ""}`,
        tool_calls: [],
        stop_reason: "end_turn",
      };
    },
    async *stream() {
      yield { type: "done" };
    },
  };
  return {
    name: pluginName,
    apiVersion: "2.0.0",
    capabilities: {
      provides: ["core-lifecycle:executor.send"],
      consumes: [],
    },
    async setup(ctx) {
      ctx.registerExecutor(executor);
    },
  };
}

export interface TestHarness {
  manager: PluginManager;
  lifecycleProvider: KaizenPlugin;
  lifecycleCtx: Parameters<NonNullable<KaizenPlugin["start"]>>[0];
  run: () => Promise<void>;
}

export async function makeTestHarness(opts: {
  uiProviderPlugins: KaizenPlugin[];
  executorPlugin?: KaizenPlugin;
  extraPlugins?: KaizenPlugin[];
  systemPrompt?: string;
}): Promise<TestHarness> {
  const executorPlugin = opts.executorPlugin ?? makeEchoExecutorPlugin();
  const extras = opts.extraPlugins ?? [];
  const builtins: Record<string, KaizenPlugin> = {
    "core-events": coreEvents,
    "core-lifecycle": coreLifecycle,
    [executorPlugin.name]: executorPlugin,
  };
  const pluginNames = ["core-events", executorPlugin.name];
  for (const ui of opts.uiProviderPlugins) {
    builtins[ui.name] = ui;
    pluginNames.push(ui.name);
  }
  for (const extra of extras) {
    builtins[extra.name] = extra;
    pluginNames.push(extra.name);
  }
  pluginNames.push("core-lifecycle");

  const config: KaizenConfig = {
    plugins: pluginNames,
    ...(opts.systemPrompt ? { "core-lifecycle": { systemPrompt: opts.systemPrompt } } : {}),
  };

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const executorRegistry = new ExecutorRegistry();
  const uiRegistry = new UiRegistry();
  const capabilityRegistry = new CapabilityRegistry();
  const serviceRegistry = new ServiceRegistry();

  const manager = new PluginManager(
    config,
    builtins,
    eventBus,
    toolRegistry,
    executorRegistry,
    uiRegistry,
    capabilityRegistry,
    serviceRegistry,
  );
  const { lifecycleProvider } = await manager.initialize();

  // Build a context for start() — use the same createPluginContext path plugin-manager uses.
  const { createPluginContext } = await import("../../src/core/context.js");
  const pluginConfig = (config[lifecycleProvider.name] as Record<string, unknown> | undefined) ?? {};
  const ctx = createPluginContext(
    lifecycleProvider.name,
    pluginConfig,
    eventBus,
    toolRegistry,
    executorRegistry,
    uiRegistry,
    capabilityRegistry,
    serviceRegistry,
    () => "READY",
    manager.getPublicApi(),
    manager.getLifecycleApi(),
  );

  return {
    manager,
    lifecycleProvider,
    lifecycleCtx: ctx,
    run: async () => {
      if (lifecycleProvider.start) {
        await lifecycleProvider.start(ctx);
      }
    },
  };
}
