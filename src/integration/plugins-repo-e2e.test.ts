/**
 * End-to-end integration test against the real kaizen-official-plugins repo.
 *
 * Exercises the actual install flow: seeds a tmp KAIZEN_HOME, registers
 * the sibling checkout as a local marketplace, installs a plugin through
 * the standard flow, and loads it via the runtime loader.
 *
 * Skips when the sibling repo is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { addMarketplace, readCatalog } from "../core/marketplace.js";
import { installPlugin, installHarness } from "../core/plugin-installer.js";
import { loadPluginFromInstallDir } from "../core/plugin-loader.js";
import {
  pluginInstallDir, harnessInstallDir, marketplaceRepoDir,
} from "../core/kaizen-config.js";

const SIBLING = resolve(process.cwd(), "..", "kaizen-official-plugins");

// Skipped: kaizen-official-plugins still uses the pre-v0.2.0 API (ServiceToken,
// ctx.registerService, manifest `capabilities`). This test re-enables once the
// sibling repo is migrated — tracked in the service-registry-merge spec.
describe.skip("kaizen-official-plugins e2e", () => {
  if (!existsSync(SIBLING)) {
    it.skip("sibling kaizen-official-plugins repo not found — skipping e2e", () => {});
    return;
  }

  let tmpHome: string;
  let originalOverride: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "kaizen-e2e-"));
    originalOverride = process.env.KAIZEN_HOME_OVERRIDE;
    process.env.KAIZEN_HOME_OVERRIDE = tmpHome;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
    else process.env.KAIZEN_HOME_OVERRIDE = originalOverride;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("installs and loads core-events through the virtual module", async () => {
    await addMarketplace(SIBLING, { id: "official", local: true });
    expect(existsSync(marketplaceRepoDir("official"))).toBe(true);

    const cat = await readCatalog("official");
    const coreEvents = cat.entries.find((e) => e.kind === "plugin" && e.name === "core-events");
    expect(coreEvents).toBeDefined();

    const version = coreEvents!.versions[0]!;
    await installPlugin(
      "official",
      "core-events",
      version.version,
      (version as { source: import("../types/plugin.js").PluginSource }).source,
    );
    expect(existsSync(pluginInstallDir("official", "core-events", version.version))).toBe(true);

    const plugin = await loadPluginFromInstallDir("official", "core-events", version.version);
    expect(plugin.name).toBe("core-events");
    expect(plugin.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("installs core-debug harness from the official marketplace", async () => {
    await addMarketplace(SIBLING, { id: "official", local: true });
    const cat = await readCatalog("official");
    const h = cat.entries.find((e) => e.kind === "harness" && e.name === "core-debug");
    expect(h).toBeDefined();
    const v = h!.versions[0]!;
    await installHarness("official", "core-debug", (v as { path: string }).path);
    expect(existsSync(join(harnessInstallDir("official", "core-debug"), "kaizen.json"))).toBe(true);
  });
});
