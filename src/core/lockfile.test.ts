import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readLockfile, writeLockfile, upsertPluginEntry } from "./lockfile.js";
import type { LockfileEntry } from "./lockfile.js";

describe("lockfile", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("read missing file returns empty lockfile", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-lock-"));
    const lf = readLockfile(join(dir, "kaizen.permissions.lock"));
    expect(lf.schemaVersion).toBe(1);
    expect(lf.plugins).toEqual({});
  });

  test("write then read roundtrips", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-lock-"));
    const path = join(dir, "lock.yaml");
    const entry: LockfileEntry = {
      version: "1.2.3",
      hash: "sha256:abc",
      tier: "scoped",
      consentedAt: "2026-04-17T00:00:00Z",
      consentedBy: "tester",
      permissions: { net: { connect: ["api.example.com:443"] }, env: ["FOO"] },
    };
    writeLockfile(path, { schemaVersion: 1, plugins: { "my-plugin": entry } });
    const lf = readLockfile(path);
    expect(lf.plugins["my-plugin"]).toEqual(entry);
  });

  test("upsertPluginEntry adds new", () => {
    const lf = { schemaVersion: 1, plugins: {} };
    const e: LockfileEntry = {
      version: "1.0", hash: "sha256:x", tier: "trusted",
      consentedAt: "t", consentedBy: "u",
    };
    const updated = upsertPluginEntry(lf, "p1", e);
    expect(updated.plugins["p1"]).toEqual(e);
  });

  test("upsertPluginEntry replaces existing", () => {
    const lf = {
      schemaVersion: 1,
      plugins: {
        p1: { version: "1.0", hash: "sha256:x", tier: "trusted" as const,
              consentedAt: "t", consentedBy: "u" },
      },
    };
    const e2: LockfileEntry = {
      version: "2.0", hash: "sha256:y", tier: "scoped",
      consentedAt: "t2", consentedBy: "u",
    };
    const updated = upsertPluginEntry(lf, "p1", e2);
    expect(updated.plugins["p1"]).toEqual(e2);
  });

  test("rejects invalid schema version", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-lock-"));
    const path = join(dir, "lock.yaml");
    writeFileSync(path, "schemaVersion: 999\nplugins: {}\n");
    expect(() => readLockfile(path)).toThrow(/schema version/i);
  });
});
