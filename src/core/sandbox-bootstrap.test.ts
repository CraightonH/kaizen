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
});
