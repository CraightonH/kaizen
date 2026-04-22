import { describe, test, expect } from "bun:test";
import { synthesizeManifest } from "./manifest-synthesizer.js";
import type { CheckRecord } from "./permission-enforcer.js";

function rec(plugin: string, op: CheckRecord["op"]): CheckRecord {
  return { ts: 0, plugin, op, allowed: true };
}

describe("synthesizeManifest", () => {
  test("trusted when no external ops observed", () => {
    const m = synthesizeManifest("p1", []);
    expect(m.tier).toBe("trusted");
  });

  test("scoped with net+env when ops observed", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "net.connect", host: "api.example.com", port: 443 }),
      rec("p1", { kind: "env.get", name: "API_KEY" }),
    ];
    const m = synthesizeManifest("p1", records);
    expect(m.tier).toBe("scoped");
    expect(m.net?.connect).toContain("api.example.com:443");
    expect(m.env).toContain("API_KEY");
  });

  test("dedupes repeated ops", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "env.get", name: "K" }),
      rec("p1", { kind: "env.get", name: "K" }),
    ];
    expect(synthesizeManifest("p1", records).env).toEqual(["K"]);
  });

  test("ignores other plugins' records", () => {
    const records: CheckRecord[] = [
      rec("other", { kind: "env.get", name: "K" }),
    ];
    expect(synthesizeManifest("p1", records).tier).toBe("trusted");
  });

  test("fs.read paths collected verbatim (not collapsed to globs)", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "fs.read", path: "./workspace/a.txt" }),
      rec("p1", { kind: "fs.read", path: "./workspace/b.txt" }),
    ];
    const m = synthesizeManifest("p1", records);
    expect(m.fs?.read).toContain("./workspace/a.txt");
    expect(m.fs?.read).toContain("./workspace/b.txt");
  });

  test("exec binary collected by name", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "exec.run", binary: "git" }),
      rec("p1", { kind: "exec.run", binary: "rg" }),
    ];
    expect(synthesizeManifest("p1", records).exec?.binaries).toEqual(["git", "rg"]);
  });

  test("events.subscribe collected", () => {
    const records: CheckRecord[] = [
      rec("p1", { kind: "events.subscribe", event: "core-driver:tool:before" }),
    ];
    expect(synthesizeManifest("p1", records).events?.subscribe).toEqual(["core-driver:tool:before"]);
  });
});
