import { describe, expect, test } from "bun:test";
import { UiRegistry } from "./ui-registry.js";
import type { UiProvider } from "../types/plugin.js";

const stubUi: UiProvider = {
  accept: async function* () {},
};

describe("UiRegistry.deregisterByPlugin", () => {
  test("removes UI provider registered by named plugin", () => {
    const registry = new UiRegistry();
    registry.register(stubUi, "plugin-ui");
    registry.deregisterByPlugin("plugin-ui");
    expect(registry.isRegistered()).toBe(false);
  });

  test("no-op when plugin name does not match", () => {
    const registry = new UiRegistry();
    registry.register(stubUi, "plugin-ui");
    registry.deregisterByPlugin("plugin-other");
    expect(registry.isRegistered()).toBe(true);
  });

  test("deregistered UI slot can be re-registered", () => {
    const registry = new UiRegistry();
    registry.register(stubUi, "plugin-ui");
    registry.deregisterByPlugin("plugin-ui");
    expect(() => registry.register(stubUi, "plugin-ui")).not.toThrow();
  });
});
