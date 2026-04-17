import { randomUUID } from "crypto";
import type { KaizenPlugin, UiChannel, UserMessage, AgentMessage } from "../../src/types/plugin.js";
import { readStdinLine } from "../../src/core/stdin.js";

function createTerminalChannel(opts: {
  prompt: string;
  responsePrefix: string;
  initialPrompt?: string;
  oneShot?: boolean;
}): UiChannel {
  let firstReceive = true;

  return {
    id: randomUUID(),

    async receive(): Promise<UserMessage> {
      if (firstReceive && opts.initialPrompt) {
        firstReceive = false;
        return { type: "text", content: opts.initialPrompt };
      }
      firstReceive = false;

      if (opts.oneShot) throw new Error("one-shot complete");

      process.stdout.write(opts.prompt);
      const line = await readStdinLine();
      if (line === "") throw new Error("stdin closed");
      return { type: "text", content: line };
    },

    async send(msg: AgentMessage): Promise<void> {
      if (msg.type === "text") {
        process.stdout.write(`${opts.responsePrefix}${msg.content}`);
      } else if (msg.type === "text_delta") {
        process.stdout.write(msg.content);
      } else if (msg.type === "tool_call") {
        process.stdout.write(`\n[tool: ${msg.name}(${JSON.stringify(msg.args)})]\n`);
      } else if (msg.type === "tool_result") {
        process.stdout.write(`[result: ${msg.ok ? "ok" : "err"} ${msg.output}]\n`);
      } else if (msg.type === "error") {
        process.stderr.write(`[error: ${msg.message}]\n`);
      }
    },

    async close(): Promise<void> {
      // stdin lifecycle is managed by src/core/stdin.ts
    },
  };
}

const plugin: KaizenPlugin = {
  name: "core-ui-terminal",
  apiVersion: "2.0.0",
  permissions: { tier: "trusted" },
  capabilities: { provides: ["core-lifecycle:ui.input", "core-lifecycle:ui.output"] },

  async setup(ctx) {
    const prompt = (ctx.config["prompt"] as string | undefined) ?? "> ";
    const responsePrefix = (ctx.config["responsePrefix"] as string | undefined) ?? "";
    const initialPrompt = ctx.config["initial_prompt"] as string | undefined;
    const oneShot = Boolean(ctx.config["one_shot"] ?? (initialPrompt !== undefined));

    ctx.registerUi({
      async *accept() {
        yield createTerminalChannel({
          prompt,
          responsePrefix,
          ...(initialPrompt !== undefined ? { initialPrompt } : {}),
          oneShot,
        });
      },
    });
  },
};

export default plugin;
