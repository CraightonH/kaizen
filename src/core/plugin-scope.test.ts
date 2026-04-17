import { describe, test, expect } from "bun:test";
import { runInPluginScope, getCurrentPlugin, hasPluginScope } from "./plugin-scope.js";

describe("plugin-scope", () => {
  test("getCurrentPlugin outside scope returns undefined", () => {
    expect(getCurrentPlugin()).toBeUndefined();
    expect(hasPluginScope()).toBe(false);
  });

  test("runInPluginScope sets current plugin", async () => {
    await runInPluginScope("p1", async () => {
      expect(getCurrentPlugin()).toBe("p1");
      expect(hasPluginScope()).toBe(true);
    });
    expect(getCurrentPlugin()).toBeUndefined();
  });

  test("scope survives async boundaries", async () => {
    const seen: string[] = [];
    await runInPluginScope("p1", async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(getCurrentPlugin() ?? "none");
      await Promise.resolve();
      seen.push(getCurrentPlugin() ?? "none");
    });
    expect(seen).toEqual(["p1", "p1"]);
  });

  test("nested scopes override (inner wins)", async () => {
    const seen: string[] = [];
    await runInPluginScope("outer", async () => {
      seen.push(getCurrentPlugin() ?? "none");
      await runInPluginScope("inner", async () => {
        seen.push(getCurrentPlugin() ?? "none");
      });
      seen.push(getCurrentPlugin() ?? "none");
    });
    expect(seen).toEqual(["outer", "inner", "outer"]);
  });
});
