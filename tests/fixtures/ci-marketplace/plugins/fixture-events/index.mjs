// Minimal fixture mirroring core-events. Pre-defines the six canonical
// session events so fixture-driver and fixture-executor can emit them.
export const EVENTS = {
  SESSION_START:  "session:start",
  SESSION_END:    "session:end",
  USER_MESSAGE:   "session:user_message",
  AGENT_RESPONSE: "session:response",
  TOOL_BEFORE:    "tool:before",
  TOOL_AFTER:     "tool:after",
};

export default {
  name: "fixture-events",
  apiVersion: "2",
  async setup(ctx) {
    for (const name of Object.values(EVENTS)) ctx.defineEvent(name);
    // Also define test-local probes the spy plugin listens on.
    ctx.defineEvent("test:executor:send");
    ctx.defineEvent("test:ui:received");
    ctx.defineEvent("test:ui:sent");
    ctx.defineEvent("test:driver:start");
    ctx.defineEvent("test:driver:end");
  },
};
