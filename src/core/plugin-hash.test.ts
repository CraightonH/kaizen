import { describe, test, expect, afterEach, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computePluginHash, canonicalTierGrantHash } from "./plugin-hash.js";
import type { PluginPermissions } from "../types/plugin.js";

describe("computePluginHash", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("hashes package.json + main", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const hash = computePluginHash(dir);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("hash changes when source changes", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const h1 = computePluginHash(dir);
    writeFileSync(join(dir, "index.js"), "module.exports = { x: 1 };");
    const h2 = computePluginHash(dir);
    expect(h1).not.toBe(h2);
  });

  test("hash is deterministic across runs", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = { x: 1 };");
    expect(computePluginHash(dir)).toBe(computePluginHash(dir));
  });

  test("does not hash node_modules", () => {
    dir = mkdtempSync(join(tmpdir(), "kaizen-hash-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", main: "index.js" }));
    writeFileSync(join(dir, "index.js"), "module.exports = {};");
    const h1 = computePluginHash(dir);
    mkdirSync(join(dir, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "foo", "index.js"), "lots of data");
    const h2 = computePluginHash(dir);
    expect(h1).toBe(h2);
  });
});

describe("canonicalTierGrantHash", () => {
  const base: PluginPermissions = {
    tier: "scoped",
    fs: { read: ["a", "b"], write: ["c"] },
    net: { connect: ["x:1", "y:2"] },
    env: ["HOME"],
    exec: { binaries: ["git"] },
    events: { subscribe: ["core-driver:tool:before"] },
  };

  it("is stable under key reorder", () => {
    const reordered: PluginPermissions = {
      exec: { binaries: ["git"] },
      events: { subscribe: ["core-driver:tool:before"] },
      env: ["HOME"],
      net: { connect: ["x:1", "y:2"] },
      fs: { write: ["c"], read: ["a", "b"] },
      tier: "scoped",
    };
    expect(canonicalTierGrantHash(reordered)).toBe(canonicalTierGrantHash(base));
  });

  it("is stable under array reorder", () => {
    const shuffled: PluginPermissions = {
      ...base,
      fs: { read: ["b", "a"], write: ["c"] },
      net: { connect: ["y:2", "x:1"] },
    };
    expect(canonicalTierGrantHash(shuffled)).toBe(canonicalTierGrantHash(base));
  });

  it("changes when tier changes", () => {
    expect(canonicalTierGrantHash({ ...base, tier: "trusted" }))
      .not.toBe(canonicalTierGrantHash(base));
  });

  it("changes when a grant value changes", () => {
    expect(canonicalTierGrantHash({ ...base, env: ["HOME", "USER"] }))
      .not.toBe(canonicalTierGrantHash(base));
  });

  it("returns sha256:<64-hex>", () => {
    expect(canonicalTierGrantHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
