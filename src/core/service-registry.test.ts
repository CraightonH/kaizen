import { describe, expect, test } from "bun:test";
import { ServiceToken, ServiceRegistry } from "./service-registry.js";

describe("ServiceToken", () => {
  test("label property matches constructor arg", () => {
    const token = new ServiceToken<string>("MyService");
    expect(token.label).toBe("MyService");
  });

  test("two tokens with same label are distinct objects (FR3)", () => {
    const a = new ServiceToken<string>("Svc");
    const b = new ServiceToken<string>("Svc");
    expect(a).not.toBe(b);
  });

  test("label is stable when token is passed by reference", () => {
    const token = new ServiceToken<string>("Svc");
    const ref: ServiceToken<string> = token;
    expect(ref.label).toBe("Svc");
  });
});

describe("ServiceRegistry", () => {
  test("register then get returns impl typed correctly", () => {
    const token = new ServiceToken<{ greet(): string }>("Greeter");
    const impl = { greet: () => "hello" };
    const registry = new ServiceRegistry();
    registry.register(token, impl);
    expect(registry.get(token)).toBe(impl);
    expect(registry.get(token).greet()).toBe("hello");
  });

  test("get unregistered token throws named not-found error", () => {
    const token = new ServiceToken<string>("MissingService");
    const registry = new ServiceRegistry();
    expect(() => registry.get(token)).toThrow(
      "Service 'MissingService' not found. Ensure the provider plugin is listed in depends[] before this plugin.",
    );
  });

  test("duplicate registration throws named duplicate error", () => {
    const token = new ServiceToken<string>("DupeService");
    const registry = new ServiceRegistry();
    registry.register(token, "first");
    expect(() => registry.register(token, "second")).toThrow(
      "Service 'DupeService' is already registered. Each service token may only have one provider.",
    );
  });

  test("two tokens with same label are distinct keys (FR3)", () => {
    const tokenA = new ServiceToken<string>("Svc");
    const tokenB = new ServiceToken<string>("Svc");
    const registry = new ServiceRegistry();
    registry.register(tokenA, "implA");
    registry.register(tokenB, "implB");
    expect(registry.get(tokenA)).toBe("implA");
    expect(registry.get(tokenB)).toBe("implB");
  });

  test("registering undefined as impl is valid and retrievable", () => {
    const token = new ServiceToken<undefined>("NullService");
    const registry = new ServiceRegistry();
    registry.register(token, undefined);
    expect(registry.get(token)).toBeUndefined();
  });

  test("fresh registry instance has no services (per-bootstrap isolation)", () => {
    const token = new ServiceToken<string>("IsolatedService");
    const r1 = new ServiceRegistry();
    r1.register(token, "value");
    const r2 = new ServiceRegistry();
    expect(() => r2.get(token)).toThrow("not found");
  });
});
