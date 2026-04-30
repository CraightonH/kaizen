import { describe, test, expect } from "bun:test";
import { PermissionEnforcer } from "./permission-enforcer.js";
import { PermissionError } from "./errors.js";
import { DEFAULT_ENV_ALLOWLIST } from "./env-allowlist.js";

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
    e.register("p1", { tier: "scoped", events: { subscribe: ["core-driver:tool:before", "other:*"] } });
    expect(() => e.check("p1", { kind: "events.subscribe", event: "core-driver:tool:before" })).not.toThrow();
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

  test("observe mode notifies onCheck for both allows and denies", () => {
    const e = new PermissionEnforcer({ mode: "observe" });
    e.register("p1", { tier: "scoped", env: ["OK"] });
    const checks: { allowed: boolean; op: string }[] = [];
    e.onCheck((r) => checks.push({ allowed: r.allowed, op: r.op.kind }));
    e.check("p1", { kind: "env.get", name: "OK" });
    e.check("p1", { kind: "env.get", name: "DENY" });
    expect(checks).toEqual([
      { allowed: true,  op: "env.get" },
      { allowed: false, op: "env.get" },
    ]);
  });

  test("observe mode never throws", () => {
    const e = new PermissionEnforcer({ mode: "observe" });
    e.register("p1", { tier: "trusted" });
    expect(() => e.check("p1", { kind: "fs.read", path: "x" })).not.toThrow();
  });
});

describe("PermissionEnforcer — env allow-list", () => {
  test("trusted plugin: allow-listed env permitted", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "trusted" });
    expect(() =>
      e.check("p", { kind: "env.get", name: "PATH" }),
    ).not.toThrow();
  });

  test("trusted plugin: non-allow-listed env denied", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "trusted" });
    expect(() =>
      e.check("p", { kind: "env.get", name: "AWS_SECRET" }),
    ).toThrow(/tier 'trusted' permits no external ops/);
  });

  test("trusted plugin + empty allow-list: PATH denied", () => {
    const e = new PermissionEnforcer({ mode: "enforce", envAllowList: [] });
    e.register("p", { tier: "trusted" });
    expect(() =>
      e.check("p", { kind: "env.get", name: "PATH" }),
    ).toThrow(/tier 'trusted' permits no external ops/);
  });

  test("scoped plugin: declared env grants still permitted", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "scoped", env: ["DB_URL"] });
    expect(() => e.check("p", { kind: "env.get", name: "DB_URL" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "PATH" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "OTHER" })).toThrow(/not in env grants/);
  });

  test("scoped plugin + custom allow-list replaces default", () => {
    const e = new PermissionEnforcer({ mode: "enforce", envAllowList: ["MY_*"] });
    e.register("p", { tier: "scoped" });
    expect(() => e.check("p", { kind: "env.get", name: "MY_FOO" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "PATH" })).toThrow(/not in env grants/);
  });

  test("unscoped plugin: all env permitted regardless of allow-list", () => {
    const e = new PermissionEnforcer({ mode: "enforce", envAllowList: [] });
    e.register("p", { tier: "unscoped" });
    expect(() => e.check("p", { kind: "env.get", name: "PATH" })).not.toThrow();
    expect(() => e.check("p", { kind: "env.get", name: "AWS_SECRET" })).not.toThrow();
  });

  test("default constructor uses DEFAULT_ENV_ALLOWLIST", () => {
    const e = new PermissionEnforcer({ mode: "enforce" });
    e.register("p", { tier: "trusted" });
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
      expect(() => e.check("p", { kind: "env.get", name })).not.toThrow();
    }
    expect(() => e.check("p", { kind: "env.get", name: "LC_ALL" })).not.toThrow();
    expect(DEFAULT_ENV_ALLOWLIST).toContain("LC_*");
  });
});
