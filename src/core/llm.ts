import { generateText, streamText, jsonSchema, dynamicTool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  Message,
  ToolDefinition,
  LLMResponse,
  LLMStreamChunk,
  ToolCall,
} from "../types/plugin.js";

interface ProviderConfig {
  adapter: "anthropic" | "openai" | "google" | "mistral";
  model: string;
  api_key_env?: string;
  api_key?: string;
  baseURL?: string;
}
import { fatal } from "./errors.js";

// ---------------------------------------------------------------------------
// Message conversion: kaizen Message[] → AI SDK ModelMessage[]
// ---------------------------------------------------------------------------

function findToolName(messages: Message[], toolCallId: string): string {
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      const tc = msg.tool_calls.find((t) => t.id === toolCallId);
      if (tc) return tc.name;
    }
  }
  return "unknown";
}

function toAiSdkMessages(messages: Message[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "system" || msg.role === "user") {
      return { role: msg.role, content: msg.content };
    }

    if (msg.role === "assistant") {
      if (!msg.tool_calls?.length) {
        return { role: "assistant", content: msg.content };
      }
      const parts: unknown[] = [];
      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.name, args: tc.args });
      }
      return { role: "assistant", content: parts };
    }

    // role === "tool"
    const toolCallId = msg.tool_call_id ?? "";
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: findToolName(messages, toolCallId),
          result: msg.content,
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Tool conversion: ToolDefinition[] → AI SDK ToolSet
//
// AI SDK v6 uses dynamicTool({ description, inputSchema }) for schema-driven tools.
// We handle execution in ToolRegistry — the AI SDK never calls execute().
// `execute` is TS-required but optional at runtime; cast through unknown to satisfy
// the type checker without providing a dummy function.
// ---------------------------------------------------------------------------

function toAiSdkTools(tools: ToolDefinition[]): Record<string, unknown> {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      dynamicTool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters),
      } as unknown as Parameters<typeof dynamicTool>[0]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

function createModel(config: ProviderConfig) {
  const apiKey =
    config.api_key ??
    (config.api_key_env ? process.env[config.api_key_env] : undefined);

  switch (config.adapter) {
    case "anthropic": {
      const provider = createAnthropic(apiKey ? { apiKey } : {});
      return provider(config.model);
    }
    case "openai":
    case "google":
    case "mistral": {
      // google and mistral also expose OpenAI-compatible endpoints; baseURL handles routing
      const provider = createOpenAI({
        apiKey: apiKey ?? "no-key",
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      });
      return provider(config.model);
    }
    default:
      fatal(`Unknown provider adapter '${(config as ProviderConfig).adapter}'.`);
  }
}

// ---------------------------------------------------------------------------
// LLM runtime
//
// AI SDK v6: default stopWhen is stepCountIs(1) — one LLM call, no auto tool execution.
// Tool results use `input` on DynamicToolCall (renamed from `args` in v4).
// Message/tool types are cast through unknown to bridge our simplified types
// to the AI SDK's strict ModelMessage/ToolSet generics.
// ---------------------------------------------------------------------------

export function createLLMRuntime(config: ProviderConfig) {
  const model = createModel(config);

  return {
    async send(messages: Message[], tools: ToolDefinition[]): Promise<LLMResponse> {
      const aiTools = tools.length > 0 ? toAiSdkTools(tools) : undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await generateText({
        model,
        messages: toAiSdkMessages(messages) as any,
        ...(aiTools !== undefined ? { tools: aiTools as any } : {}),
      });

      const mappedToolCalls: ToolCall[] = (result.toolCalls ?? []).map((tc) => {
        const raw = tc as unknown as { toolCallId: string; toolName: string; input: unknown };
        return {
          id: raw.toolCallId,
          name: raw.toolName,
          args: (raw.input ?? {}) as Record<string, unknown>,
        };
      });

      return {
        content: result.text,
        tool_calls: mappedToolCalls,
        stop_reason: result.finishReason,
      };
    },

    async *stream(messages: Message[], tools: ToolDefinition[]): AsyncIterable<LLMStreamChunk> {
      const aiTools = tools.length > 0 ? toAiSdkTools(tools) : undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { textStream } = streamText({
        model,
        messages: toAiSdkMessages(messages) as any,
        ...(aiTools !== undefined ? { tools: aiTools as any } : {}),
      });

      for await (const chunk of textStream) {
        yield { type: "text", text: chunk };
      }

      yield { type: "done" };
    },
  };
}
