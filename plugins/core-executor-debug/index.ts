/**
 * core-executor-debug
 *
 * An interactive executor for development. Instead of calling a real LLM,
 * it prints the incoming messages and tools to stderr so you can see exactly
 * what the session loop is handing it, then reads your response from stdin.
 * You play the role of the LLM.
 *
 * Usage in kaizen.json:
 *   {
 *     "plugins": ["core-events", "core-executor-debug", "core-ui-terminal", "core-lifecycle"],
 *     "core-executor-debug": { "color": true }
 *   }
 *
 * stdin is shared sequentially with core-ui-terminal: the UI reads your
 * "user message", then the debug executor reads your "LLM response". They
 * never wait simultaneously so there is no conflict.
 */

import type {
  KaizenPlugin,
  Message,
  ToolDefinition,
  LLMResponse,
  LLMStreamChunk,
} from "../../src/types/plugin.js";
import { readStdinLine } from "../../src/core/stdin.js";
import { EVENTS } from "../core-events/index.js";

// ---------------------------------------------------------------------------
// Formatting helpers — all output goes to stderr so it doesn't pollute
// the conversation channel
// ---------------------------------------------------------------------------

const RESET  = "\x1b[0m";
const DIM    = "\x1b[2m";
const BOLD   = "\x1b[1m";
const CYAN   = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN  = "\x1b[32m";
const BLUE   = "\x1b[34m";

function fmt(useColor: boolean, code: string, text: string): string {
  return useColor ? `${code}${text}${RESET}` : text;
}

function printMessages(messages: Message[], useColor: boolean): void {
  process.stderr.write(fmt(useColor, BOLD + CYAN, `Messages (${messages.length}):\n`));
  for (const msg of messages) {
    const roleLabel = fmt(useColor, BOLD, `[${msg.role}]`);
    if (msg.role === "tool") {
      process.stderr.write(`  ${roleLabel} ${fmt(useColor, DIM, `(id: ${msg.tool_call_id ?? "?"})`)} ${msg.content}\n`);
    } else if (msg.tool_calls?.length) {
      process.stderr.write(`  ${roleLabel} ${msg.content || fmt(useColor, DIM, "(no text)")}\n`);
      for (const tc of msg.tool_calls) {
        process.stderr.write(`    ${fmt(useColor, YELLOW, "→")} ${tc.name}(${JSON.stringify(tc.args)})\n`);
      }
    } else {
      const preview = msg.content.length > 120
        ? msg.content.slice(0, 120) + fmt(useColor, DIM, "…")
        : msg.content;
      process.stderr.write(`  ${roleLabel} ${preview}\n`);
    }
  }
}

function printTools(tools: ToolDefinition[], useColor: boolean): void {
  if (tools.length === 0) {
    process.stderr.write(fmt(useColor, DIM, "Tools: (none)\n"));
    return;
  }
  process.stderr.write(fmt(useColor, BOLD + GREEN, `Tools (${tools.length}):\n`));
  for (const tool of tools) {
    const params = Object.keys(tool.parameters.properties ?? {}).join(", ") || "none";
    process.stderr.write(
      `  ${fmt(useColor, GREEN, "•")} ${fmt(useColor, BOLD, tool.name)}(${params})` +
      (tool.description ? fmt(useColor, DIM, ` — ${tool.description}`) : "") +
      "\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Prompt helper — writes to stderr, reads from the shared stdin queue
// ---------------------------------------------------------------------------

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return readStdinLine();
}

// ---------------------------------------------------------------------------
// Core prompt logic — shared between send() and stream()
// ---------------------------------------------------------------------------

async function promptForResponse(
  messages: Message[],
  tools: ToolDefinition[],
  useColor: boolean,
  label: string,
): Promise<string> {
  process.stderr.write("\n");
  process.stderr.write(
    fmt(useColor, BOLD + BLUE, `┌─ debug-executor: ${label} `) +
    fmt(useColor, DIM, "─".repeat(Math.max(0, 54 - label.length))) +
    "\n",
  );
  printMessages(messages, useColor);
  process.stderr.write("\n");
  printTools(tools, useColor);
  process.stderr.write(fmt(useColor, BOLD + BLUE, "└" + "─".repeat(55)) + "\n\n");

  return readLine(fmt(useColor, BOLD + YELLOW, "LLM response> "));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: KaizenPlugin = {
  name: "core-executor-debug",
  apiVersion: "2.0.0",
  permissions: { tier: "scoped", events: { subscribe: ["session:*", "tool:*"] } },
  capabilities: {
    provides: ["core-lifecycle:executor.send"],
    consumes: ["core-events:service"],
  },

  config: {
    schema: {
      properties: {
        color: { type: "boolean" },
      },
    },
    defaults: { color: true },
  },

  async setup(ctx) {
    const useColor = (ctx.config["color"] as boolean | undefined) ?? true;

    // Subscribe to all canonical events and print them as they fire
    for (const [key, name] of Object.entries(EVENTS)) {
      ctx.on(name, async (payload) => {
        process.stderr.write(
          fmt(useColor, DIM, `  [event] ${name}`) +
          (payload !== undefined
            ? fmt(useColor, DIM, `  ${JSON.stringify(payload)}`)
            : "") +
          "\n",
        );
      });
    }

    ctx.registerExecutor({
      async send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
        const content = await promptForResponse(messages, tools, useColor, "send()");
        return { content, tool_calls: [], stop_reason: "end_turn" };
      },

      async *stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk> {
        const text = await promptForResponse(messages, tools, useColor, "stream()");
        yield { type: "text", text };
        yield { type: "done" };
      },
    });
  },
};

export default plugin;
