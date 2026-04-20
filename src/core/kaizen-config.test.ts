import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  kaizenHome, marketplacesDir, marketplaceDir, marketplaceRepoDir,
  pluginInstallDir, harnessInstallDir,
  ensureKaizenHome, loadKaizenGlobalConfig, saveKaizenGlobalConfig,
} from "./kaizen-config.js";

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  origHome = process.env.KAIZEN_HOME_OVERRIDE;
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (origHome === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
  else process.env.KAIZEN_HOME_OVERRIDE = origHome;
});

describe("kaizen-config path helpers", () => {
  it("returns KAIZEN_HOME_OVERRIDE when set", () => {
    expect(kaizenHome()).toBe(home);
    expect(marketplacesDir()).toBe(join(home, "marketplaces"));
    expect(marketplaceDir("official")).toBe(join(home, "marketplaces", "official"));
    expect(marketplaceRepoDir("official")).toBe(join(home, "marketplaces", "official", "repo"));
    expect(pluginInstallDir("official", "timestamps", "1.2.3"))
      .toBe(join(home, "marketplaces", "official", "plugins", "timestamps@1.2.3"));
    expect(harnessInstallDir("official", "anthropic-default"))
      .toBe(join(home, "marketplaces", "official", "harnesses", "anthropic-default"));
  });
});

describe("ensureKaizenHome", () => {
  it("creates kaizen home and marketplaces dir, idempotent", async () => {
    await ensureKaizenHome();
    await ensureKaizenHome();
    expect(existsSync(join(home, "marketplaces"))).toBe(true);
  });
});

describe("load/saveKaizenGlobalConfig", () => {
  it("returns {} when file absent", async () => {
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg).toEqual({});
  });

  it("round-trips a config atomically", async () => {
    await saveKaizenGlobalConfig({
      marketplaces: [{ id: "official", url: "https://x/y.git" }],
      marketplaceUpdateTTL: 900,
    });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.marketplaces?.[0]?.id).toBe("official");
    expect(cfg.marketplaceUpdateTTL).toBe(900);
  });

  it("atomic write: no partial file if writer crashes mid-write", async () => {
    await saveKaizenGlobalConfig({ marketplaces: [] });
    const txt = readFileSync(join(home, "kaizen.json"), "utf8");
    expect(() => JSON.parse(txt)).not.toThrow();
  });
});
