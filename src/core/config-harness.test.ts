import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveHarness, resolveHarnessOrFatal } from "./config.js";

let tmp: string;
let cwdOrig: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kz-resolve-"));
  cwdOrig = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdOrig);
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveHarness", () => {
  test("resolves a project-scoped bare name", () => {
    const dir = join(tmp, ".kaizen", "harnesses", "dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: [] }));
    const resolved = resolveHarness("dev");
    expect(resolved.kaizenJsonPath).toBe(join(".kaizen", "harnesses", "dev", "kaizen.json"));
    expect(Array.isArray(resolved.config.plugins)).toBe(true);
  });

  test("resolves an explicit absolute path", () => {
    const dir = join(tmp, "hx");
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, "kaizen.json");
    writeFileSync(jsonPath, JSON.stringify({ plugins: [] }));
    const resolved = resolveHarness(jsonPath);
    expect(resolved.kaizenJsonPath).toBe(jsonPath);
  });

  test("resolves a relative path to a directory", () => {
    const dir = join(tmp, "hrel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: [] }));
    const resolved = resolveHarness("./hrel");
    expect(resolved.kaizenJsonPath.endsWith("hrel/kaizen.json")).toBe(true);
  });

  test("rejects URL", () => {
    expect(() => resolveHarness("https://example.com/kaizen.json")).toThrow();
  });

  test("reports helpful error when not found", () => {
    expect(() => resolveHarness("nonexistent-harness")).toThrow(/not found/);
  });
});

describe("resolveHarnessOrFatal", () => {
  test("errors when no harness provided", () => {
    expect(() => resolveHarnessOrFatal({})).toThrow(/harness is required/i);
  });

  test("succeeds with explicit harness name", () => {
    const dir = join(tmp, ".kaizen", "harnesses", "dev");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: ["a"] }));
    const { config } = resolveHarnessOrFatal({ harness: "dev" });
    expect(config.plugins).toEqual(["a"]);
  });

  test("succeeds with extendsOverride", () => {
    const dir = join(tmp, ".kaizen", "harnesses", "base");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: ["x"] }));
    const { config } = resolveHarnessOrFatal({ extendsOverride: "base" });
    expect(config.plugins).toEqual(["x"]);
  });

  test("harness plugins are returned unchanged (no project-config overlay)", () => {
    const dir = join(tmp, ".kaizen", "harnesses", "official");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kaizen.json"), JSON.stringify({ plugins: ["official/core-cli@0.1.0"] }));
    // Even if a project .kaizen/kaizen.json exists, it is NOT merged into the harness config.
    mkdirSync(join(tmp, ".kaizen"), { recursive: true });
    writeFileSync(join(tmp, ".kaizen", "kaizen.json"), JSON.stringify({ plugins: ["evil/injected@0.0.0"] }));
    const { config } = resolveHarnessOrFatal({ harness: "official" });
    expect(config.plugins).toEqual(["official/core-cli@0.1.0"]);
    expect(JSON.stringify(config)).not.toContain("evil/injected");
  });
});
