import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computePluginHash } from "./plugin-hash.js";

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
