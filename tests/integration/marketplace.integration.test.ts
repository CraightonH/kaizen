import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { addMarketplace } from "../../src/core/marketplace.js";
import { runUnifiedInstall } from "../../src/commands/install.js";
import { runUninstall } from "../../src/commands/uninstall.js";
import { pluginInstallDir } from "../../src/core/kaizen-config.js";

describe("integration: local git marketplace, file-source plugin", () => {
  let home: string; let upstream: string; let project: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kz-home-"));
    upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
    project = mkdtempSync(join(tmpdir(), "kz-proj-"));
    process.env.KAIZEN_HOME_OVERRIDE = home;

    mkdirSync(join(upstream, "plugins", "demo"), { recursive: true });
    writeFileSync(join(upstream, "plugins", "demo", "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", main: "index.mjs", type: "module" }));
    writeFileSync(join(upstream, "plugins", "demo", "index.mjs"),
      `export default { name: "demo", apiVersion: "2", async setup() {} };`);
    mkdirSync(join(upstream, ".kaizen"), { recursive: true });
    writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify({
      version: "1.0.0", name: "Local", url: upstream,
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
    rmSync(project, { recursive: true, force: true });
    delete process.env.KAIZEN_HOME_OVERRIDE;
  });

  it("add → install → uninstall --purge", async () => {
    await addMarketplace(upstream, { id: "local" });
    const lock = join(project, "kaizen.permissions.lock");

    const code = await runUnifiedInstall({
      ref: "local/demo@1.0.0", lockfilePath: lock,
      allowUnscoped: false, nonInteractive: true,
    });
    expect(code).toBe(0);
    expect(existsSync(pluginInstallDir("local", "demo", "1.0.0"))).toBe(true);

    const code2 = await runUninstall({ ref: "local/demo@1.0.0", lockfilePath: lock, purge: true });
    expect(code2).toBe(0);
    expect(existsSync(pluginInstallDir("local", "demo", "1.0.0"))).toBe(false);
  });
});
