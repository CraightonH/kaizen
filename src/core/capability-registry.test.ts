import { describe, test, expect } from "bun:test";
import { CapabilityRegistry } from "./capability-registry.js";

describe("CapabilityRegistry", () => {
  test("define + getSpec round-trips", () => {
    const r = new CapabilityRegistry();
    r.define("core-driver:ui.input", "core-driver", {
      cardinality: "many", description: "User input source"
    });
    const spec = r.getSpec("core-driver:ui.input");
    expect(spec?.cardinality).toBe("many");
    expect(spec?.description).toBe("User input source");
  });

  test("owner prefix must match defining plugin", () => {
    const r = new CapabilityRegistry();
    expect(() => r.define("foo:bar", "not-foo", {
      cardinality: "one", description: ""
    })).toThrow(/must be prefixed with plugin name 'not-foo'/);
  });

  test("duplicate define logs and ignores second", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "first" });
    r.define("p:x", "p", { cardinality: "many", description: "second" });
    expect(r.getSpec("p:x")?.description).toBe("first");
  });

  test("provider + consumer tracking", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "many", description: "" });
    r.addProvider("p:x", "a");
    r.addProvider("p:x", "b");
    r.addConsumer("p:x", "c");
    expect(r.providersOf("p:x")).toEqual(["a", "b"]);
    expect(r.consumersOf("p:x")).toEqual(["c"]);
  });

  test("validateCardinality one: exactly one ok", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "" });
    r.addProvider("p:x", "a");
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).not.toThrow();
  });

  test("validateCardinality one: zero providers throws if consumed", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "" });
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).toThrow(/No plugin provides/);
  });

  test("validateCardinality one: two providers throws", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "one", description: "" });
    r.addProvider("p:x", "a");
    r.addProvider("p:x", "b");
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).toThrow(/Multiple plugins provide/);
  });

  test("validateCardinality many: zero/one/two all ok", () => {
    const r = new CapabilityRegistry();
    r.define("p:x", "p", { cardinality: "many", description: "" });
    r.addConsumer("p:x", "c");
    expect(() => r.validateAll()).not.toThrow();
    r.addProvider("p:x", "a");
    expect(() => r.validateAll()).not.toThrow();
    r.addProvider("p:x", "b");
    expect(() => r.validateAll()).not.toThrow();
  });

  test("validateAll: undefined capability in consumer throws", () => {
    const r = new CapabilityRegistry();
    r.addConsumer("p:undefined", "c");
    expect(() => r.validateAll()).toThrow(/undefined capability 'p:undefined'/);
  });

  test("validateAll: undefined capability in provider throws", () => {
    const r = new CapabilityRegistry();
    r.addProvider("p:undefined", "a");
    expect(() => r.validateAll()).toThrow(/undefined capability 'p:undefined'/);
  });

  test("resolveName: canonical passes through", () => {
    const r = new CapabilityRegistry();
    expect(r.resolveName("core-driver:ui.input", {})).toBe("core-driver:ui.input");
  });

  test("resolveName: alias resolves", () => {
    const r = new CapabilityRegistry();
    const aliases = { "ui.input": "core-driver:ui.input" };
    expect(r.resolveName("ui.input", aliases)).toBe("core-driver:ui.input");
  });

  test("list: returns all defined capabilities", () => {
    const r = new CapabilityRegistry();
    r.define("a:x", "a", { cardinality: "one", description: "X" });
    r.define("b:y", "b", { cardinality: "many", description: "Y" });
    const names = r.list().map((c) => c.name).sort();
    expect(names).toEqual(["a:x", "b:y"]);
  });

  test("deregisterByPlugin removes defines/providers/consumers", () => {
    const r = new CapabilityRegistry();
    r.define("a:x", "a", { cardinality: "many", description: "" });
    r.addProvider("a:x", "a");
    r.addConsumer("a:x", "b");
    r.deregisterByPlugin("a");
    expect(r.getSpec("a:x")).toBeUndefined();
    expect(r.providersOf("a:x")).toEqual([]);
    r.deregisterByPlugin("b");
    expect(r.consumersOf("a:x")).toEqual([]);
  });
});
