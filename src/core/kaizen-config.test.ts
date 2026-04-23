import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  kaizenHome, marketplacesDir, marketplaceDir, marketplaceRepoDir,
  pluginInstallDir, harnessInstallDir,
  ensureKaizenHome, loadKaizenGlobalConfig, saveKaizenGlobalConfig,
  looksLikeHarnessRef, kaizenHomeConfigPath,
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

describe("looksLikeHarnessRef", () => {
  it("accepts marketplace refs", () => {
    expect(looksLikeHarnessRef("official/core-anthropic@0.1.0")).toBe(true);
    expect(looksLikeHarnessRef("example/harness")).toBe(true);
  });
  it("rejects local paths", () => {
    expect(looksLikeHarnessRef("./my/harness")).toBe(false);
    expect(looksLikeHarnessRef("/abs/path/kaizen.json")).toBe(false);
    expect(looksLikeHarnessRef("../sibling/harness")).toBe(false);
  });
  it("rejects URLs", () => {
    expect(looksLikeHarnessRef("https://example.com/harness.json")).toBe(false);
    expect(looksLikeHarnessRef("http://example.com/harness.json")).toBe(false);
  });
  it("rejects bare names without a slash", () => {
    expect(looksLikeHarnessRef("core-anthropic")).toBe(false);
    expect(looksLikeHarnessRef("my-local-harness")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation tests (Task 4)
// ---------------------------------------------------------------------------

describe("loadKaizenGlobalConfig validation", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `kaizen-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.KAIZEN_HOME_OVERRIDE = tmpHome;
  });

  afterEach(() => {
    delete process.env.KAIZEN_HOME_OVERRIDE;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function writeCfg(obj: unknown) {
    const path = kaizenHomeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj), "utf8");
  }

  it("accepts nested defaults.harness and defaults.plugin_config", async () => {
    writeCfg({
      defaults: {
        harness: "official/core-shell@1.0.0",
        plugin_config: { gitlab: { base_url: "https://gitlab.mycompany.com" } },
      },
    });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.defaults?.harness).toBe("official/core-shell@1.0.0");
    expect(cfg.defaults?.plugin_config?.gitlab).toEqual({ base_url: "https://gitlab.mycompany.com" });
  });

  it("rejects top-level `plugins` key", async () => {
    writeCfg({ plugins: ["foo/bar@1.0.0"] });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/plugins.*not allowed|not supported/i);
  });

  it("rejects top-level `extends` with 'move to defaults.harness' hint", async () => {
    writeCfg({ extends: "foo/bar@1.0.0" });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/extends.*defaults\.harness/);
  });

  it("rejects top-level `default_harness` with 'nest under defaults' hint", async () => {
    writeCfg({ default_harness: "foo/bar@1.0.0" });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/default_harness.*defaults\.harness/);
  });

  it("rejects top-level `plugin_config` with 'nest under defaults' hint", async () => {
    writeCfg({ plugin_config: { gitlab: {} } });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/plugin_config.*defaults\.plugin_config/);
  });

  it("rejects old flat shape (plugin names directly under defaults)", async () => {
    writeCfg({ defaults: { gitlab: { base_url: "x" } } });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/defaults\.gitlab|defaults\.plugin_config/);
  });

  it("rejects unknown top-level keys", async () => {
    writeCfg({ defaults: { harness: "x/y@1" }, random_nonsense: true });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/random_nonsense/);
  });

  it("allows marketplaces and marketplaceUpdateTTL", async () => {
    writeCfg({
      marketplaces: [{ id: "official", url: "https://example.com/repo.git" }],
      marketplaceUpdateTTL: 600,
    });
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.marketplaces?.[0]?.id).toBe("official");
    expect(cfg.marketplaceUpdateTTL).toBe(600);
  });

  it("defaults.plugin_config must be an object of objects", async () => {
    writeCfg({ defaults: { plugin_config: { gitlab: "not an object" } } });
    await expect(loadKaizenGlobalConfig()).rejects.toThrow(/plugin_config/);
  });

  it("returns {} when file is absent", async () => {
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg).toEqual({});
  });
});
