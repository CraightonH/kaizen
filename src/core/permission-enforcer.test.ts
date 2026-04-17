import { describe, test, expect } from "bun:test";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { PermissionError } from "./errors.js";

describe("PermissionEnforcer", () => {
  test("unregistered plugin denied", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow(PermissionError);
  });

  test("trusted tier denies all external ops", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "trusted" });
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow(/fs.read/);
    expect(() => e.check("p1", { kind: "net.connect", host: "a", port: 1 })).toThrow();
    expect(() => e.check("p1", { kind: "env.get", name: "X" })).toThrow();
    expect(() => e.check("p1", { kind: "exec.run", binary: "git" })).toThrow();
  });

  test("unscoped tier allows everything", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "unscoped" });
    expect(() => e.check("p1", { kind: "fs.read",   path: "/etc/passwd" })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "a", port: 1 })).not.toThrow();
    expect(() => e.check("p1", { kind: "import", module: "node:fs" })).not.toThrow();
  });

  test("scoped tier: fs.read glob allows matching path", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", fs: { read: ["./workspace/**"] } });
    expect(() => e.check("p1", { kind: "fs.read", path: "./workspace/a.txt" })).not.toThrow();
    expect(() => e.check("p1", { kind: "fs.read", path: "./workspace/sub/b.txt" })).not.toThrow();
    expect(() => e.check("p1", { kind: "fs.read", path: "./other/a.txt" })).toThrow();
  });

  test("scoped tier: fs.write disjoint from fs.read", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", fs: { read: ["./a/**"] } });
    expect(() => e.check("p1", { kind: "fs.write", path: "./a/b.txt" })).toThrow(/fs.write/);
  });

  test("scoped tier: net.connect exact host:port", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", net: { connect: ["api.example.com:443"] } });
    expect(() => e.check("p1", { kind: "net.connect", host: "api.example.com", port: 443 })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "api.example.com", port: 80 })).toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "evil.com", port: 443 })).toThrow();
  });

  test("scoped tier: net.connect subdomain wildcard", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", net: { connect: ["*.example.com:443"] } });
    expect(() => e.check("p1", { kind: "net.connect", host: "api.example.com", port: 443 })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "deep.api.example.com", port: 443 })).not.toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "example.com", port: 443 })).toThrow();
    expect(() => e.check("p1", { kind: "net.connect", host: "notexample.com", port: 443 })).toThrow();
  });

  test("scoped tier: net.connect full wildcard allows anything", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", net: { connect: ["*"] } });
    expect(() => e.check("p1", { kind: "net.connect", host: "anything.com", port: 12345 })).not.toThrow();
  });

  test("scoped tier: env allowlist exact match", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", env: ["FOO_KEY"] });
    expect(() => e.check("p1", { kind: "env.get", name: "FOO_KEY" })).not.toThrow();
    expect(() => e.check("p1", { kind: "env.get", name: "BAR_KEY" })).toThrow();
  });

  test("scoped tier: exec.binaries name match, * means any", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", exec: { binaries: ["git", "rg"] } });
    expect(() => e.check("p1", { kind: "exec.run", binary: "git" })).not.toThrow();
    expect(() => e.check("p1", { kind: "exec.run", binary: "rg" })).not.toThrow();
    expect(() => e.check("p1", { kind: "exec.run", binary: "bash" })).toThrow();

    const e2 = new PermissionEnforcer({ mode: "enforce" });
    e2.register("p2", { tier: "scoped", exec: { binaries: ["*"] } });
    expect(() => e2.check("p2", { kind: "exec.run", binary: "anything" })).not.toThrow();
  });

  test("scoped tier: events.subscribe patterns", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", events: { subscribe: ["core-lifecycle:tool:before", "other:*"] } });
    expect(() => e.check("p1", { kind: "events.subscribe", event: "core-lifecycle:tool:before" })).not.toThrow();
    expect(() => e.check("p1", { kind: "events.subscribe", event: "other:anything" })).not.toThrow();
    expect(() => e.check("p1", { kind: "events.subscribe", event: "third:event" })).toThrow();
  });

  test("non-unscoped tier: forbidden imports denied regardless of grants", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "scoped", fs: { read: ["/**"], write: ["/**"] } });
    expect(() => e.check("p1", { kind: "import", module: "node:fs" })).toThrow(/import/);
    expect(() => e.check("p1", { kind: "import", module: "node:child_process" })).toThrow();
    expect(() => e.check("p1", { kind: "import", module: "node:worker_threads" })).toThrow();
    expect(() => e.check("p1", { kind: "import", module: "bun:ffi" })).toThrow();
  });

  test("log-only mode records but does not throw", () => {
    const e = new PermissionEnforcer({ mode: "log-only" });
    e.register("p1", { tier: "trusted" });
    const records: unknown[] = [];
    e.onDenial((r) => records.push(r));
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).not.toThrow();
    expect(records.length).toBe(1);
  });

  test("deregister removes manifest", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", { tier: "unscoped" });
    e.deregister("p1");
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow();
  });

  test("default tier is trusted when omitted", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p1", {});
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).toThrow();
  });
});
