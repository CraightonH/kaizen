import { describe, expect, test } from "bun:test";
import { ExecutorRegistry } from "./executor-registry.js";
import type { Executor } from "../types/plugin.js";

function stub(): Executor {
  return {
    send: async () => ({ content: "", tool_calls: [], stop_reason: "end_turn" }),
    stream: async function* () { yield { type: "done" }; },
  };
}

describe("ExecutorRegistry multi-provider", () => {
  test("two registrations: both stored in registration order", () => {
    const r = new ExecutorRegistry();
    const a = stub(), b = stub();
    r.register(a, "a"); r.register(b, "b");
    expect(r.list()).toEqual([a, b]);
  });

  test("getFirst returns first registered", () => {
    const r = new ExecutorRegistry();
    const a = stub(), b = stub();
    r.register(a, "a"); r.register(b, "b");
    expect(r.getFirst()).toBe(a);
  });

  test("getFirst fatal when none registered", () => {
    const r = new ExecutorRegistry();
    expect(() => r.getFirst()).toThrow();
  });

  test("isRegistered true when at least one", () => {
    const r = new ExecutorRegistry();
    expect(r.isRegistered()).toBe(false);
    r.register(stub(), "a");
    expect(r.isRegistered()).toBe(true);
  });

  test("deregisterByPlugin removes only the targeted plugin's executor", () => {
    const r = new ExecutorRegistry();
    const a = stub(), b = stub();
    r.register(a, "a"); r.register(b, "b");
    r.deregisterByPlugin("a");
    expect(r.list()).toEqual([b]);
  });

  test("deregisterByPlugin no-op when name does not match", () => {
    const r = new ExecutorRegistry();
    r.register(stub(), "a");
    r.deregisterByPlugin("other");
    expect(r.isRegistered()).toBe(true);
  });

  test("deregistered slot can be re-registered", () => {
    const r = new ExecutorRegistry();
    r.register(stub(), "a");
    r.deregisterByPlugin("a");
    expect(() => r.register(stub(), "a")).not.toThrow();
  });
});
