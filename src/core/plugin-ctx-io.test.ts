import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { createCtxIo } from "./plugin-ctx-io.js";
import { runInPluginScope } from "./plugin-scope.js";
import { initializeSandbox, resetSandboxForTesting } from "./sandbox-bootstrap.js";

describe("createCtxIo", () => {
  afterEach(() => resetSandboxForTesting());

  test("ctx.fs.readText reads within grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaizen-ctx-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", fs: { read: [`${dir}/**`] } });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      expect(await ctx.fs.readText(join(dir, "a.txt"))).toBe("hello");
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("ctx.fs.readText throws outside grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaizen-ctx-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      await expect(ctx.fs.readText(join(dir, "a.txt"))).rejects.toThrow(/Permission denied/);
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("ctx.secrets.get honors env grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", env: ["KAIZEN_CTX_ALLOWED"] });
    process.env["KAIZEN_CTX_ALLOWED"] = "yes";
    process.env["KAIZEN_CTX_DENIED"]  = "no";
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      expect(ctx.secrets.get("KAIZEN_CTX_ALLOWED")).toBe("yes");
      expect(ctx.secrets.get("KAIZEN_CTX_DENIED")).toBeUndefined();
    });
  });

  test("ctx.exec.run denied without grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "trusted" });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      await expect(ctx.exec.run("echo", ["hi"])).rejects.toThrow(/Permission denied/);
    });
  });

  test("ctx.exec.run permitted with grant", async () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    initializeSandbox(enforcer);
    enforcer.register("p1", { tier: "scoped", exec: { binaries: ["echo"] } });
    const ctx = createCtxIo("p1", enforcer);
    await runInPluginScope("p1", async () => {
      const result = await ctx.exec.run("echo", ["hello-world"]);
      expect(result.stdout.trim()).toBe("hello-world");
      expect(result.exitCode).toBe(0);
    });
  });

  test("ctx.log prefixes with plugin name", () => {
    const enforcer = new PermissionEnforcer({ mode: "enforce" });
    enforcer.register("p1", { tier: "trusted" });
    const ctx = createCtxIo("p1", enforcer);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(" ")); };
    try {
      ctx.log.info("hello");
    } finally { console.log = origLog; }
    expect(logs[0]).toContain("[p1]");
    expect(logs[0]).toContain("hello");
  });
});
