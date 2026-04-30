import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveEnvAllowList } from "./index.js";
import { DEFAULT_ENV_ALLOWLIST } from "./env-allowlist.js";

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-init-"));
  origHome = process.env.KAIZEN_HOME_OVERRIDE;
  process.env.KAIZEN_HOME_OVERRIDE = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
  else process.env.KAIZEN_HOME_OVERRIDE = origHome;
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

function writeUserCfg(obj: unknown) {
  const path = join(home, "kaizen.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

describe("resolveEnvAllowList — precedence", () => {
  it("uses default env_allowlist when neither user nor harness specifies one", async () => {
    const result = await resolveEnvAllowList({ plugins: [] });
    expect(result).toBe(DEFAULT_ENV_ALLOWLIST);
  });

  it("user defaults.env_allowlist overrides default when harness has none", async () => {
    writeUserCfg({ defaults: { env_allowlist: ["MY_*"] } });
    const result = await resolveEnvAllowList({ plugins: [] });
    expect(result).toEqual(["MY_*"]);
  });

  it("harness env_allowlist beats user env_allowlist", async () => {
    writeUserCfg({ defaults: { env_allowlist: ["A_*"] } });
    const result = await resolveEnvAllowList({ plugins: [], env_allowlist: ["B_*"] });
    expect(result).toEqual(["B_*"]);
  });

  it("explicit empty harness env_allowlist disables passthrough", async () => {
    writeUserCfg({ defaults: { env_allowlist: ["A_*"] } });
    const result = await resolveEnvAllowList({ plugins: [], env_allowlist: [] });
    expect(result).toEqual([]);
  });

  it("explicit empty user env_allowlist disables passthrough (no harness override)", async () => {
    writeUserCfg({ defaults: { env_allowlist: [] } });
    const result = await resolveEnvAllowList({ plugins: [] });
    expect(result).toEqual([]);
  });

  it("falls back to default when global config load fails", async () => {
    // Write malformed JSON to force load failure
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "kaizen.json"), "{ not json", "utf8");
    const result = await resolveEnvAllowList({ plugins: [] });
    expect(result).toBe(DEFAULT_ENV_ALLOWLIST);
  });
});
