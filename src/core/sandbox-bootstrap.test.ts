import { describe, test, expect, beforeAll } from "bun:test";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { initializeSandbox, resetSandboxForTesting } from "./sandbox-bootstrap.js";
import { runInPluginScope } from "./plugin-scope.js";

describe("sandbox-bootstrap", () => {
  test("require outside plugin scope is unchanged", () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    // Calling a normal require from outside ALS scope should not throw.
    const fs = require("node:fs");
    expect(typeof fs.readFileSync).toBe("function");
    resetSandboxForTesting();
  });

  test("require inside unscoped plugin scope permitted", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "unscoped" });
    await runInPluginScope("p1", async () => {
      const fs = require("node:fs");
      expect(typeof fs.readFileSync).toBe("function");
    });
    resetSandboxForTesting();
  });

  test("require inside trusted plugin scope denies node:fs (enforce mode)", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    await runInPluginScope("p1", async () => {
      expect(() => require("node:fs")).toThrow(/Permission denied/);
    });
    resetSandboxForTesting();
  });

  test("require inside trusted plugin scope logs but allows in log-only mode", async () => {
    const enforcer = new PermissionEnforcer({ mode: "log-only" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    const records: unknown[] = [];
    enforcer.onDenial((r) => records.push(r));
    await runInPluginScope("p1", async () => {
      expect(() => require("node:fs")).not.toThrow();
    });
    expect(records.length).toBeGreaterThan(0);
    resetSandboxForTesting();
  });

  test("process.env proxy inside scope returns undefined for ungranted keys", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", env: ["KAIZEN_TEST_ALLOWED"] });
    process.env["KAIZEN_TEST_ALLOWED"] = "yes";
    process.env["KAIZEN_TEST_DENIED"]  = "no";
    await runInPluginScope("p1", async () => {
      expect(process.env["KAIZEN_TEST_ALLOWED"]).toBe("yes");
      expect(process.env["KAIZEN_TEST_DENIED"]).toBeUndefined();
    });
    // outside scope, everything visible
    expect(process.env["KAIZEN_TEST_DENIED"]).toBe("no");
    resetSandboxForTesting();
  });

  test("global fetch checks net.connect grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", net: { connect: ["allowed.test:443"] } });
    await runInPluginScope("p1", async () => {
      await expect(fetch("https://denied.test/")).rejects.toThrow(/Permission denied/);
    });
    resetSandboxForTesting();
  });

  test("trusted plugin reads allow-listed PATH via proxy", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" }); // default allow-list
    initializeSandbox(enforcer);
    enforcer.register("p_allow", { tier: "trusted" });
    process.env.PATH ??= "/usr/bin";
    await runInPluginScope("p_allow", async () => {
      expect(typeof process.env.PATH).toBe("string");
      expect(process.env.PATH!.length).toBeGreaterThan(0);
    });
    resetSandboxForTesting();
  });

  test("trusted plugin sees undefined for non-allow-listed secret", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p_secret", { tier: "trusted" });
    process.env.AWS_TEST_SECRET = "shh";
    await runInPluginScope("p_secret", async () => {
      expect(process.env.AWS_TEST_SECRET).toBeUndefined();
    });
    delete process.env.AWS_TEST_SECRET;
    resetSandboxForTesting();
  });

  test("'in' check respects allow-list", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p_in", { tier: "trusted" });
    process.env.PATH ??= "/usr/bin";
    process.env.AWS_TEST_SECRET = "shh";
    await runInPluginScope("p_in", async () => {
      expect("PATH" in process.env).toBe(true);
      expect("AWS_TEST_SECRET" in process.env).toBe(false);
    });
    delete process.env.AWS_TEST_SECRET;
    resetSandboxForTesting();
  });

  test("Object.keys excludes non-allow-listed secret", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p_keys", { tier: "trusted" });
    process.env.PATH ??= "/usr/bin";
    process.env.AWS_TEST_SECRET = "shh";
    await runInPluginScope("p_keys", async () => {
      const keys = Object.keys(process.env);
      expect(keys).toContain("PATH");
      expect(keys).not.toContain("AWS_TEST_SECRET");
    });
    delete process.env.AWS_TEST_SECRET;
    resetSandboxForTesting();
  });
});
