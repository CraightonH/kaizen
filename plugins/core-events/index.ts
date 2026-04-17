import type { KaizenPlugin, KaizenConfig } from "../../src/types/plugin.js";
import { ServiceToken } from "../../src/types/plugin.js";

// ---------------------------------------------------------------------------
// Canonical event names
//
// Import EVENTS from this package to reference event names without magic strings.
// Other plugins that emit or subscribe to these events should declare
// depends: ["core-events"] (or depends: ["events"]) in their manifest.
// ---------------------------------------------------------------------------

export const EVENTS = {
  SESSION_START:   "session:start",
  SESSION_END:     "session:end",
  USER_MESSAGE:    "session:user_message",
  AGENT_RESPONSE:  "session:response",
  TOOL_BEFORE:     "tool:before",
  TOOL_AFTER:      "tool:after",
} as const;

// ---------------------------------------------------------------------------
// Payload types
//
// Import these from "core-events", not from "kaizen".
// The payload type lives with the plugin that defines the event contract.
// ---------------------------------------------------------------------------

export interface SessionContext {
  sessionId: string;
  config: KaizenConfig;
}

export interface UserMessageContext {
  sessionId: string;
  content: string;
}

export interface ResponseContext {
  sessionId: string;
  content: string;
}

export interface ToolCallContext {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResultContext {
  sessionId: string;
  tool: string;
  ok: boolean;
  output: string;
}

// ---------------------------------------------------------------------------
// Service token — lets consumer plugins retrieve core-events capabilities
// without re-importing the static EVENTS constant directly.
// ---------------------------------------------------------------------------

export interface CoreEventsService {
  readonly events: typeof EVENTS;
}

export const CoreEventsServiceToken = new ServiceToken<CoreEventsService>("CoreEventsService");

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: KaizenPlugin = {
  name: "core-events",
  apiVersion: "1.0.0",
  permissions: { tier: "trusted" },
  provides: ["events"],
  depends: [],

  async setup(ctx) {
    for (const name of Object.values(EVENTS)) {
      ctx.defineEvent(name);
    }
    ctx.registerService(CoreEventsServiceToken, { events: EVENTS });
  },
};

export default plugin;
