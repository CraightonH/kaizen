import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "./tool-registry.js";

const noop = async () => ({ ok: true as const });

describe("ToolRegistry.deregisterByPlugin", () => {
  test("removes only tools registered by the named plugin", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "a", description: "", parameters: {}, execute: noop }, "plugin-a");
    registry.register({ name: "b", description: "", parameters: {}, execute: noop }, "plugin-b");
    registry.register({ name: "c", description: "", parameters: {}, execute: noop }, "plugin-a");
    registry.deregisterByPlugin("plugin-a");
    expect(registry.list().map((t) => t.name)).toEqual(["b"]);
  });

  test("no-op when plugin has no registered tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "x", description: "", parameters: {}, execute: noop }, "plugin-x");
    registry.deregisterByPlugin("plugin-none");
    expect(registry.list().map((t) => t.name)).toEqual(["x"]);
  });

  test("deregistered tool name can be re-registered", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "t", description: "", parameters: {}, execute: noop }, "plugin-a");
    registry.deregisterByPlugin("plugin-a");
    registry.register({ name: "t", description: "new", parameters: {}, execute: noop }, "plugin-a");
    expect(registry.list()[0]?.description).toBe("new");
  });
});
