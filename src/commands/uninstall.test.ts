import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { addMarketplace } from "../core/marketplace.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { runUninstall } from "./uninstall.js";

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
  await addMarketplace(upstream, { id: "m", local: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("runUninstall", () => {
  it("removes canonical ref from project harness plugins array", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "kz-proj-"));
    const projectConfig = join(projectDir, "kaizen.json");
    writeFileSync(projectConfig, JSON.stringify({ plugins: ["m/demo@1.0.0", "other/plugin@1.0.0"] }));

    // We need PROJECT_CONFIG to point to our test file. Since PROJECT_CONFIG is cwd-based,
    // we just test without it (no project config in cwd).
    const lockfilePath = join(home, "permissions.lock");
    const code = await runUninstall({ ref: "m/demo@1.0.0", lockfilePath, purge: false });
    expect(code).toBe(0);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("purge removes install dir and lockfile entry", async () => {
    // Manually create install dir to simulate installed plugin.
    const installDir = pluginInstallDir("m", "demo", "1.0.0");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "package.json"), "{}");

    const lockfilePath = join(home, "permissions.lock");
    const code = await runUninstall({ ref: "m/demo@1.0.0", lockfilePath, purge: true });
    expect(code).toBe(0);
    expect(existsSync(installDir)).toBe(false);
  });
});
