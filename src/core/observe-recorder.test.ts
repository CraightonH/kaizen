import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ObserveRecorder } from "./observe-recorder.js";

describe("ObserveRecorder", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("writes each record to JSONL", () => {
    dir = mkdtempSync(join(tmpdir(), "obs-"));
    const r = new ObserveRecorder(dir, "s1");
    r.record({ ts: 1, plugin: "p1", op: { kind: "fs.read", path: "a" }, allowed: true });
    r.record({ ts: 2, plugin: "p1", op: { kind: "env.get", name: "K" }, allowed: false, reason: "nope" });
    r.flushSync();
    const lines = readFileSync(r.path_(), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).allowed).toBe(true);
    expect(JSON.parse(lines[1]!).allowed).toBe(false);
  });
});
