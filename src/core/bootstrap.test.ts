import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { bootstrapMissingPlugins } from "./bootstrap.js";
import { loadKaizenGlobalConfig, pluginInstallDir } from "./kaizen-config.js";
import { addMarketplace } from "./marketplace.js";
import { existsSync } from "fs";

let home: string;
let upstream: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(upstream, ".kaizen"), { recursive: true });
  mkdirSync(join(upstream, "plugins", "demo"), { recursive: true });
  writeFileSync(join(upstream, "plugins", "demo", "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", main: "index.mjs", type: "module" }));
  writeFileSync(join(upstream, "plugins", "demo", "index.mjs"),
    `export default { name: "demo", apiVersion: "2", async setup() {} };`);
  writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify({
    version: "1.0.0", name: "M", url: upstream,
    entries: [{ kind: "plugin", name: "demo", description: "",
      versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/demo" } }] }],
  }));
  await $`git init -q`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(upstream);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("bootstrapMissingPlugins", () => {
  it("adds missing marketplace from harness and installs missing plugin", async () => {
    const lockfilePath = join(home, "permissions.lock");
    const report = await bootstrapMissingPlugins(
      { plugins: ["m/demo@1.0.0"], marketplaces: [{ id: "m", url: upstream }] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: true },
    );
    expect(report.marketplacesAdded).toContain("m");
    expect(report.pluginsInstalled).toContain("m/demo@1.0.0");
    expect(existsSync(pluginInstallDir("m", "demo", "1.0.0"))).toBe(true);
    const cfg = await loadKaizenGlobalConfig();
    expect(cfg.marketplaces?.some((mk) => mk.id === "m")).toBe(true);
  });

  it("rejects shorthand refs in harness files", async () => {
    const lockfilePath = join(home, "permissions.lock");
    await expect(bootstrapMissingPlugins(
      { plugins: ["demo"], marketplaces: [] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: false },
    )).rejects.toThrow(/canonical/i);
  });

  it("--trust-lockfile + --non-interactive fails fast if lockfile missing a plugin", async () => {
    await addMarketplace(upstream, { id: "m", local: true });
    const lockfilePath = join(home, "permissions.lock");
    await expect(bootstrapMissingPlugins(
      { plugins: ["m/demo@1.0.0"], marketplaces: [] },
      { lockfilePath, trustLockfile: true, nonInteractive: true, allowUnscoped: false },
    )).rejects.toThrow(/not in lockfile/i);
  });

  it("version-less ref installs latest version (1.0.0 from fixture catalog)", async () => {
    await addMarketplace(upstream, { id: "m", local: true });
    const lockfilePath = join(home, "permissions.lock");
    const report = await bootstrapMissingPlugins(
      { plugins: ["m/demo"], marketplaces: [] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: false },
    );
    expect(report.pluginsInstalled).toContain("m/demo");
    expect(existsSync(pluginInstallDir("m", "demo", "1.0.0"))).toBe(true);
  });

  it("skips local-path plugin refs without attempting install", async () => {
    const lockfilePath = join(home, "permissions.lock");
    const report = await bootstrapMissingPlugins(
      { plugins: ["./some/local-plugin", "../other-plugin", "/abs/plugin"], marketplaces: [] },
      { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: false },
    );
    expect(report.pluginsInstalled).toHaveLength(0);
  });

  it("version-less ref skips reinstall on second bootstrap run", async () => {
    await addMarketplace(upstream, { id: "m", local: true });
    const lockfilePath = join(home, "permissions.lock");
    const opts = { lockfilePath, trustLockfile: false, nonInteractive: true, allowUnscoped: false };
    await bootstrapMissingPlugins({ plugins: ["m/demo"], marketplaces: [] }, opts);
    expect(existsSync(pluginInstallDir("m", "demo", "1.0.0"))).toBe(true);
    const report2 = await bootstrapMissingPlugins({ plugins: ["m/demo"], marketplaces: [] }, opts);
    expect(report2.pluginsInstalled).toHaveLength(0);
  });
});
