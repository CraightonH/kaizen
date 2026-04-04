import * as readline from "readline";
import { randomUUID } from "crypto";
import type { KaizenPlugin, UiChannel, UserMessage, AgentMessage } from "../../src/types/plugin.js";

function createTerminalChannel(): UiChannel {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return {
    id: randomUUID(),

    receive(): Promise<UserMessage> {
      return new Promise((resolve, reject) => {
        rl.once("line", (line) => resolve({ type: "text", content: line }));
        rl.once("close", () => reject(new Error("stdin closed")));
      });
    },

    async send(msg: AgentMessage): Promise<void> {
      if (msg.type === "text" || msg.type === "text_delta") {
        process.stdout.write(msg.content);
      } else if (msg.type === "tool_call") {
        process.stdout.write(`[tool: ${msg.name}(${JSON.stringify(msg.args)})]\n`);
      } else if (msg.type === "tool_result") {
        process.stdout.write(`[result: ${msg.ok ? "ok" : "err"} ${msg.output}]\n`);
      } else if (msg.type === "error") {
        process.stderr.write(`[error: ${msg.message}]\n`);
      }
    },

    async close(): Promise<void> {
      rl.close();
    },
  };
}

const plugin: KaizenPlugin = {
  name: "core-ui-terminal",
  apiVersion: "1.0.0",
  provides: ["ui"],
  depends: [],

  async setup(ctx) {
    ctx.registerUi({
      async *accept() {
        yield createTerminalChannel();
      },
    });
  },
};

export default plugin;
