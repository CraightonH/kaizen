import { describe, expect, test } from "bun:test";
import { ExecutorRegistry } from "./executor-registry.js";
import type { Executor } from "../types/plugin.js";

const stubExecutor: Executor = {
  send: async () => ({ content: "", tool_calls: [], stop_reason: "end_turn" }),
  stream: async function* () { yield { type: "done" }; },
};

describe("ExecutorRegistry.deregisterByPlugin", () => {
  test("removes executor registered by named plugin", () => {
    const registry = new ExecutorRegistry();
    registry.register(stubExecutor, "plugin-exec");
    registry.deregisterByPlugin("plugin-exec");
    expect(registry.isRegistered()).toBe(false);
  });

  test("no-op when plugin name does not match", () => {
    const registry = new ExecutorRegistry();
    registry.register(stubExecutor, "plugin-exec");
    registry.deregisterByPlugin("plugin-other");
    expect(registry.isRegistered()).toBe(true);
  });

  test("deregistered executor slot can be re-registered", () => {
    const registry = new ExecutorRegistry();
    registry.register(stubExecutor, "plugin-exec");
    registry.deregisterByPlugin("plugin-exec");
    expect(() => registry.register(stubExecutor, "plugin-exec")).not.toThrow();
  });
});
