import { describe, it, expect } from "bun:test";
import { envAllowed, DEFAULT_ENV_ALLOWLIST, validateEnvAllowList } from "./env-allowlist.js";

describe("envAllowed", () => {
  it("matches exact names case-sensitively", () => {
    expect(envAllowed(["PATH"], "PATH")).toBe(true);
    expect(envAllowed(["PATH"], "PATHS")).toBe(false);
    expect(envAllowed(["PATH"], "path")).toBe(false);
    expect(envAllowed(["PATH"], "OTHER")).toBe(false);
  });

  it("matches prefix entries with trailing *", () => {
    expect(envAllowed(["LC_*"], "LC_ALL")).toBe(true);
    expect(envAllowed(["LC_*"], "LC_CTYPE")).toBe(true);
    expect(envAllowed(["LC_*"], "LC")).toBe(false);
    expect(envAllowed(["LC_*"], "MYLC_FOO")).toBe(false);
  });

  it("supports mixed exact + prefix entries", () => {
    expect(envAllowed(["PATH", "LC_*"], "PATH")).toBe(true);
    expect(envAllowed(["PATH", "LC_*"], "LC_ALL")).toBe(true);
    expect(envAllowed(["PATH", "LC_*"], "OTHER")).toBe(false);
  });

  it("empty list matches nothing", () => {
    expect(envAllowed([], "PATH")).toBe(false);
    expect(envAllowed([], "")).toBe(false);
  });

  it("default list contains expected entries", () => {
    expect(DEFAULT_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("HOME");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("LC_*");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("TMPDIR");
  });
});

describe("validateEnvAllowList", () => {
  const src = "test.json: defaults.env_allowlist";

  it("accepts an empty array", () => {
    expect(validateEnvAllowList([], src)).toEqual([]);
  });

  it("accepts exact-name entries", () => {
    expect(validateEnvAllowList(["PATH", "HOME"], src)).toEqual(["PATH", "HOME"]);
  });

  it("accepts trailing-* prefix entries", () => {
    expect(validateEnvAllowList(["LC_*", "PATH"], src)).toEqual(["LC_*", "PATH"]);
  });

  it("rejects non-array input", () => {
    expect(() => validateEnvAllowList("PATH", src)).toThrow(/must be an array/);
    expect(() => validateEnvAllowList({}, src)).toThrow(/must be an array/);
    expect(() => validateEnvAllowList(null, src)).toThrow(/must be an array/);
  });

  it("rejects non-string entries", () => {
    expect(() => validateEnvAllowList([42], src)).toThrow(/test\.json: defaults\.env_allowlist/);
    expect(() => validateEnvAllowList([null], src)).toThrow(/non-empty string/);
  });

  it("rejects empty-string entries", () => {
    expect(() => validateEnvAllowList([""], src)).toThrow(/non-empty string/);
  });

  it("rejects entries containing whitespace", () => {
    expect(() => validateEnvAllowList(["FOO BAR"], src)).toThrow(/whitespace/);
    expect(() => validateEnvAllowList(["FOO\t"], src)).toThrow(/whitespace/);
  });

  it("rejects entries with * not at end", () => {
    expect(() => validateEnvAllowList(["*FOO"], src)).toThrow(/\*FOO/);
    expect(() => validateEnvAllowList(["FOO*BAR"], src)).toThrow(/FOO\*BAR/);
  });

  it("rejects entries with multiple *", () => {
    expect(() => validateEnvAllowList(["FOO**"], src)).toThrow(/FOO\*\*/);
    expect(() => validateEnvAllowList(["*FOO*"], src)).toThrow(/\*FOO\*/);
  });

  it("rejects bare * (would be empty prefix)", () => {
    expect(() => validateEnvAllowList(["*"], src)).toThrow(/empty prefix/);
  });
});
