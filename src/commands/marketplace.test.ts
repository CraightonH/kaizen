import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import {
  cmdMarketplaceAdd, cmdMarketplaceList, cmdMarketplaceBrowse, cmdMarketplaceRemove,
  cmdMarketplaceUpdate,
} from "./marketplace.js";
import { installPlugin, installHarness } from "../core/plugin-installer.js";
import { pluginInstallDir, harnessInstallDir } from "../core/kaizen-config.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

let home: string;
let upstream: string;

const catalog: MarketplaceCatalog = {
  version: "1.0.0", name: "Test", url: "local://test",
  entries: [{
    kind: "plugin", name: "demo", description: "a demo",
    versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/demo" } }],
  }],
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(upstream, ".kaizen"), { recursive: true });
  writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify(catalog));
  await $`git init -q`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(upstream);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("marketplace CLI commands", () => {
  it("add → list → browse → remove (happy path)", async () => {
    expect(await cmdMarketplaceAdd({ url: upstream, id: "test" })).toBe(0);
    expect(await cmdMarketplaceList()).toBe(0);
    expect(await cmdMarketplaceBrowse({ id: "test" })).toBe(0);
    expect(await cmdMarketplaceRemove({ id: "test" })).toBe(0);
    // After remove, list shows empty
    expect(await cmdMarketplaceList()).toBe(0);
  });

  it("add returns 1 on bad url", async () => {
    const code = await cmdMarketplaceAdd({ url: "/nonexistent/path", id: "bad" });
    expect(code).toBe(1);
  });

  it("update re-materializes installed plugins/harnesses from new upstream", async () => {
    // Seed a plugin and a harness in the upstream and commit.
    const pluginSrc = join(upstream, "plugins", "demo");
    mkdirSync(pluginSrc, { recursive: true });
    writeFileSync(join(pluginSrc, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", type: "module", main: "index.js" }));
    writeFileSync(join(pluginSrc, "index.js"),
      "export default { name: 'demo', apiVersion: '2', payload: 'v1', setup(){} };");
    const harnessPath = join(upstream, "harnesses", "h.json");
    mkdirSync(join(upstream, "harnesses"), { recursive: true });
    writeFileSync(harnessPath, JSON.stringify({ apiVersion: "1", name: "h", payload: "v1" }));
    const catWithHarness: MarketplaceCatalog = {
      ...catalog,
      entries: [
        ...catalog.entries,
        {
          kind: "harness", name: "h", description: "a harness",
          versions: [{ version: "1.0.0", path: "harnesses/h.json" }],
        },
      ],
    };
    writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify(catWithHarness));
    await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
    await $`git -c user.email=t@t -c user.name=t commit -qm seed`.cwd(upstream);

    expect(await cmdMarketplaceAdd({ url: upstream, id: "test" })).toBe(0);

    // Simulate consent: install the plugin and harness from current upstream.
    await installPlugin("test", "demo", "1.0.0", { type: "file", path: "plugins/demo" });
    await installHarness("test", "h", "harnesses/h.json");

    // Confirm v1 was bundled.
    const pluginDir = pluginInstallDir("test", "demo", "1.0.0");
    const distFirst = readFileSync(join(pluginDir, "dist", "index.js"), "utf8");
    expect(distFirst).toContain("v1");

    // Bump upstream content (same versions).
    writeFileSync(join(pluginSrc, "index.js"),
      "export default { name: 'demo', apiVersion: '2', payload: 'v2', setup(){} };");
    writeFileSync(harnessPath, JSON.stringify({ apiVersion: "1", name: "h", payload: "v2" }));
    await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
    await $`git -c user.email=t@t -c user.name=t commit -qm bump`.cwd(upstream);

    expect(await cmdMarketplaceUpdate({ id: "test" })).toBe(0);

    // Plugin: bundled output now reflects v2.
    expect(existsSync(join(pluginDir, "dist", "index.js"))).toBe(true);
    expect(readFileSync(join(pluginDir, "dist", "index.js"), "utf8")).toContain("v2");
    // Harness: kaizen.json reflects v2.
    const hJson = JSON.parse(readFileSync(join(harnessInstallDir("test", "h"), "kaizen.json"), "utf8"));
    expect(hJson.payload).toBe("v2");
  }, 60_000);
});
