/**
 * core-executor-shell
 *
 * An executor that runs the user's message as a shell command and returns
 * the output. Not a chat — a showcase of the executor abstraction: same
 * lifecycle and UI plugins, shell as the "intelligence".
 *
 * ⚠ Runs arbitrary commands. Local dev and demo use only.
 *
 * Config:
 *   cwd   — working directory (default: process.cwd())
 *   shell — shell binary     (default: "bash")
 */

import { execSync } from "child_process";
import type { KaizenPlugin, Message, LLMResponse, LLMStreamChunk, ToolDefinition } from "../../src/types/plugin.js";

function runCommand(command: string, cwd: string, shell: string): string {
  if (!command) return "(empty command)";

  try {
    return (
      execSync(command, {
        cwd,
        shell,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trimEnd() || "(no output)"
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const out = [e.stdout?.trimEnd(), e.stderr?.trimEnd()].filter(Boolean).join("\n");
    return out || `(exit ${e.status ?? 1})`;
  }
}

const plugin: KaizenPlugin = {
  name: "core-executor-shell",
  apiVersion: "1.0.0",
  provides: ["executor"],
  depends: [],
  permissions: {
    tier: "unscoped",
    exec: { binaries: ["*"] }, // informational; not enforced at unscoped tier
  },

  async setup(ctx) {
    const cwd = (ctx.config["cwd"] as string | undefined) ?? process.cwd();
    const shell = (ctx.config["shell"] as string | undefined) ?? "bash";

    const exec = (messages: Message[]): string => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      return runCommand(lastUser?.content.trim() ?? "", cwd, shell);
    };

    ctx.registerExecutor({
      async send(messages: Message[], _tools: ToolDefinition[]): Promise<LLMResponse> {
        return { content: exec(messages), tool_calls: [], stop_reason: "end_turn" };
      },

      async *stream(messages: Message[], _tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk> {
        yield { type: "text", text: exec(messages) };
        yield { type: "done" };
      },
    });
  },
};

export default plugin;
