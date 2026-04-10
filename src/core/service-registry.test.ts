import { describe, expect, test } from "bun:test";
import { ServiceToken } from "./service-registry.js";

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
