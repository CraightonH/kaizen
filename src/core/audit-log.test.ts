import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuditLog } from "./audit-log.js";

describe("AuditLog", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("writes JSONL record", async () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-audit-"));
    const log = new AuditLog({ rootDir: dir, sessionId: "abc" });
    log.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "x" }, reason: "nope" });
    await log.flush();
    const content = readFileSync(join(dir, "abc.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.plugin).toBe("p1");
    expect(parsed.reason).toBe("nope");
  });

  test("appends multiple records", async () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-audit-"));
    const log = new AuditLog({ rootDir: dir, sessionId: "abc" });
    log.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "x" }, reason: "a" });
    log.record({ ts: 2, plugin: "p2", op: { kind: "fs.read", path: "y" }, reason: "b" });
    await log.flush();
    const lines = readFileSync(join(dir, "abc.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  test("disabled mode writes nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-audit-"));
    const log = new AuditLog({ rootDir: dir, sessionId: "abc", enabled: false });
    log.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "x" }, reason: "nope" });
    await log.flush();
    expect(() => readFileSync(join(dir, "abc.jsonl"), "utf8")).toThrow();
  });
});
