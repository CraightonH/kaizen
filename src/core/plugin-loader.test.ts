import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPluginFromInstallDir } from "./plugin-loader.js";
import { pluginInstallDir } from "./kaizen-config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("loadPluginFromInstallDir", () => {
  it("imports by absolute path from the install dir (no node_modules)", async () => {
    const dir = pluginInstallDir("m", "demo", "1.0.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", main: "index.mjs", type: "module" }));
    writeFileSync(join(dir, "index.mjs"),
      `export default { name: "demo", apiVersion: "2", async setup() {} };`);

    const plugin = await loadPluginFromInstallDir("m", "demo", "1.0.0");
    expect(plugin.name).toBe("demo");
    expect(plugin.apiVersion).toBe("2");
  });

  it("throws a clear error when install dir is missing", async () => {
    await expect(loadPluginFromInstallDir("m", "ghost", "9.9.9")).rejects.toThrow(/not installed/i);
  });
});
