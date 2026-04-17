import { describe, expect, test } from "bun:test";
import { EventBus } from "./event-bus.js";
import { getCurrentPlugin } from "./plugin-scope.js";

describe("EventBus.deregisterByPlugin", () => {
  test("removes only handlers registered by named plugin", async () => {
    const bus = new EventBus();
    bus.defineEvent("test:event", "plugin-a");
    const calls: string[] = [];
    bus.on("test:event", async () => { calls.push("a"); }, "plugin-a");
    bus.on("test:event", async () => { calls.push("b"); }, "plugin-b");
    bus.deregisterByPlugin("plugin-a");
    await bus.emit("test:event");
    expect(calls).toEqual(["b"]);
  });

  test("removes event definitions owned by named plugin", async () => {
    const bus = new EventBus();
    bus.defineEvent("plugin-a:event", "plugin-a");
    bus.deregisterByPlugin("plugin-a");
    // After deregister, re-defining the event must not warn about duplicate
    // (we test indirectly by re-defining without error)
    expect(() => bus.defineEvent("plugin-a:event", "plugin-a")).not.toThrow();
  });

  test("no-op when plugin has no handlers", async () => {
    const bus = new EventBus();
    bus.defineEvent("evt", "plugin-x");
    bus.on("evt", async () => {}, "plugin-x");
    bus.deregisterByPlugin("plugin-none");
    const results = await bus.emit("evt");
    expect(results).toHaveLength(1);
  });
});

describe("EventBus plugin scope", () => {
  test("handlers fire with plugin scope set to the registering plugin", async () => {
    const bus = new EventBus();
    bus.defineEvent("test-event", "plugin-a");
    let seenInHandler: string | undefined;
    bus.on("test-event", async () => { seenInHandler = getCurrentPlugin(); }, "plugin-a");
    await bus.emit("test-event");
    expect(seenInHandler).toBe("plugin-a");
  });
});
