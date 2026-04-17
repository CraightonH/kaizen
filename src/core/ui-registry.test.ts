import { describe, expect, test } from "bun:test";
import { UiRegistry } from "./ui-registry.js";
import type { UiProvider } from "../types/plugin.js";

const stubUi: UiProvider = {
  accept: async function* () {},
};

describe("UiRegistry multi-provider", () => {
  test("two registrations: both stored, list() returns them in registration order", () => {
    const r = new UiRegistry();
    const a: UiProvider = { accept: async function* () {} };
    const b: UiProvider = { accept: async function* () {} };
    r.register(a, "plugin-a");
    r.register(b, "plugin-b");
    expect(r.list()).toEqual([a, b]);
  });

  test("getFirst returns the first registered provider", () => {
    const r = new UiRegistry();
    const a: UiProvider = { accept: async function* () {} };
    const b: UiProvider = { accept: async function* () {} };
    r.register(a, "plugin-a");
    r.register(b, "plugin-b");
    expect(r.getFirst()).toBe(a);
  });

  test("getFirst fatal when none registered", () => {
    const r = new UiRegistry();
    expect(() => r.getFirst()).toThrow();
  });

  test("isRegistered true when at least one registered", () => {
    const r = new UiRegistry();
    expect(r.isRegistered()).toBe(false);
    r.register(stubUi, "a");
    expect(r.isRegistered()).toBe(true);
  });

  test("deregisterByPlugin removes only the targeted plugin's provider", () => {
    const r = new UiRegistry();
    const a: UiProvider = { accept: async function* () {} };
    const b: UiProvider = { accept: async function* () {} };
    r.register(a, "plugin-a");
    r.register(b, "plugin-b");
    r.deregisterByPlugin("plugin-a");
    expect(r.list()).toEqual([b]);
    expect(r.isRegistered()).toBe(true);
  });

  test("deregisterByPlugin no-op when name does not match", () => {
    const r = new UiRegistry();
    r.register(stubUi, "plugin-ui");
    r.deregisterByPlugin("plugin-other");
    expect(r.isRegistered()).toBe(true);
  });

  test("deregistered UI slot can be re-registered", () => {
    const r = new UiRegistry();
    r.register(stubUi, "plugin-ui");
    r.deregisterByPlugin("plugin-ui");
    expect(() => r.register(stubUi, "plugin-ui")).not.toThrow();
  });
});
