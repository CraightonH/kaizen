import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installPlugin, installHarness } from "./plugin-installer.js";
import { pluginInstallDir, harnessInstallDir, marketplaceRepoDir } from "./kaizen-config.js";

let home: string;
let upstream: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  // Simulate an "added" marketplace whose repo is the upstream dir (symlink).
  mkdirSync(join(home, "marketplaces", "m"), { recursive: true });
  symlinkSync(upstream, marketplaceRepoDir("m"), "dir");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("installPlugin — file source", () => {
  it("copies plugin contents into pluginInstallDir", async () => {
    const pluginSrc = join(upstream, "plugins", "demo");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(join(pluginSrc, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(pluginSrc, "index.js"), "export default { name: 'demo', apiVersion: '2', setup(){} };");

    await installPlugin("m", "demo", "1.0.0",
      { type: "file", path: "plugins/demo" });

    const target = pluginInstallDir("m", "demo", "1.0.0");
    expect(existsSync(join(target, "package.json"))).toBe(true);
    expect(existsSync(join(target, "index.js"))).toBe(true);
  });
});

describe("installHarness", () => {
  it("copies the harness JSON into harnessInstallDir/kaizen.json", async () => {
    const hSrc = join(upstream, "harnesses", "anth.json");
    mkdirSync(join(upstream, "harnesses"), { recursive: true });
    const doc = { plugins: ["official/timestamps@1.0.0"] };
    writeFileSync(hSrc, JSON.stringify(doc));

    await installHarness("m", "anthropic-default", "harnesses/anth.json");

    const target = join(harnessInstallDir("m", "anthropic-default"), "kaizen.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(doc);
  });
});
