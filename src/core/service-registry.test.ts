import { describe, it, expect } from "bun:test";
import { ServiceRegistry } from "./service-registry.js";

describe("ServiceRegistry", () => {
  describe("define", () => {
    it("accepts a name prefixed with the plugin's own name", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:thing", "owner", { description: "ok" });
      expect(reg.getSpec("owner:thing")).toEqual({ description: "ok" });
    });

    it("accepts a shared-namespace name (definer prefix need not match plugin name)", () => {
      const reg = new ServiceRegistry();
      reg.define("llm:complete", "openai-llm", { description: "shared contract" });
      expect(reg.getSpec("llm:complete")).toEqual({ description: "shared contract" });
    });

    it("accepts a name with no colon prefix", () => {
      const reg = new ServiceRegistry();
      reg.define("thing", "owner", { description: "x" });
      expect(reg.getSpec("thing")).toEqual({ description: "x" });
    });

    it("rejects an empty name", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.define("", "owner", { description: "x" })).toThrow(
        /Service name '' is invalid/,
      );
    });

    it("rejects a name containing whitespace", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.define("owner: bad", "owner", { description: "x" })).toThrow(
        /must be non-empty and contain no whitespace/,
      );
    });

    it("throws when a different plugin tries to redefine an existing service", () => {
      const reg = new ServiceRegistry();
      reg.define("llm:complete", "openai-llm", { description: "first" });
      expect(() =>
        reg.define("llm:complete", "anthropic-llm", { description: "second" }),
      ).toThrow(/already defined by plugin 'openai-llm'.*'anthropic-llm' cannot redefine/s);
    });

    it("throws when the same plugin redefines a service", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "first" });
      expect(() => reg.define("owner:x", "owner", { description: "second" })).toThrow(
        /already defined by plugin 'owner'/,
      );
    });
  });

  describe("provide", () => {
    it("throws when defining is missing", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.provide("owner:thing", "owner", {})).toThrow(
        /undefined service 'owner:thing'/,
      );
    });

    it("stores impl and returns it from use", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:paths", "owner", { description: "x" });
      const impl = { resolve: () => "/" };
      reg.provide("owner:paths", "owner", impl);
      expect(reg.use<typeof impl>("owner:paths")).toBe(impl);
    });

    it("throws on a second provider (cardinality one)", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.provide("owner:x", "owner", { a: 1 });
      expect(() => reg.provide("owner:x", "other", { a: 2 })).toThrow(
        /already has a provider/,
      );
    });
  });

  describe("consume", () => {
    it("records consumer intent without requiring a provider", () => {
      const reg = new ServiceRegistry();
      reg.consume("owner:thing", "consumer");
      expect(reg.consumersOf("owner:thing")).toEqual(["consumer"]);
    });

    it("deduplicates when the same plugin consumes twice", () => {
      const reg = new ServiceRegistry();
      reg.consume("owner:thing", "consumer");
      reg.consume("owner:thing", "consumer");
      expect(reg.consumersOf("owner:thing")).toEqual(["consumer"]);
    });
  });

  describe("use", () => {
    it("throws when no provider has registered", () => {
      const reg = new ServiceRegistry();
      expect(() => reg.use("owner:missing")).toThrow(/has no provider/);
    });

    it("returns the exact reference registered by provide", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:thing", "owner", { description: "x" });
      const obj = { id: Symbol() };
      reg.provide("owner:thing", "owner", obj);
      expect(reg.use<typeof obj>("owner:thing")).toBe(obj);
    });
  });

  describe("validateAll", () => {
    it("fatal when a consumed service is undefined", () => {
      const reg = new ServiceRegistry();
      reg.consume("missing:x", "consumer");
      expect(() => reg.validateAll()).toThrow(/undefined service 'missing:x'/);
    });

    it("fatal when a defined service has consumers but no provider", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.consume("owner:x", "consumer");
      expect(() => reg.validateAll()).toThrow(/No plugin provides service 'owner:x'/);
    });

    it("passes when defined, provided, and consumed correctly", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.provide("owner:x", "owner", {});
      reg.consume("owner:x", "consumer");
      expect(() => reg.validateAll()).not.toThrow();
    });

    it("passes when defined but unused (no consumers, no provider)", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      expect(() => reg.validateAll()).not.toThrow();
    });
  });

  describe("deregisterByPlugin", () => {
    it("removes definitions owned by that plugin", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.deregisterByPlugin("owner");
      expect(reg.getSpec("owner:x")).toBeUndefined();
    });

    it("removes provider + impl owned by that plugin", () => {
      const reg = new ServiceRegistry();
      reg.define("owner:x", "owner", { description: "x" });
      reg.provide("owner:x", "owner", { a: 1 });
      reg.deregisterByPlugin("owner");
      expect(reg.providersOf("owner:x")).toEqual([]);
      expect(() => reg.use("owner:x")).toThrow();
    });

    it("removes the plugin from consumer lists", () => {
      const reg = new ServiceRegistry();
      reg.consume("owner:x", "consumer-a");
      reg.consume("owner:x", "consumer-b");
      reg.deregisterByPlugin("consumer-a");
      expect(reg.consumersOf("owner:x")).toEqual(["consumer-b"]);
    });

    it("leaves unrelated entries intact", () => {
      const reg = new ServiceRegistry();
      reg.define("a:x", "a", { description: "" });
      reg.define("b:y", "b", { description: "" });
      reg.deregisterByPlugin("a");
      expect(reg.getSpec("a:x")).toBeUndefined();
      expect(reg.getSpec("b:y")).toBeDefined();
    });
  });

  describe("list", () => {
    it("returns entries with populated provider/consumer arrays", () => {
      const reg = new ServiceRegistry();
      reg.define("a:x", "a", { description: "test" });
      reg.provide("a:x", "a", {});
      reg.consume("a:x", "b");
      const entries = reg.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.definedBy).toBe("a");
      expect(entries[0]!.providers).toEqual(["a"]);
      expect(entries[0]!.consumers).toEqual(["b"]);
    });
  });
});
