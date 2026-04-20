/**
 * Integration tests: full scaffold → validate workflows.
 *
 * Plugin validate: checkManifest will fail because the scaffolded index.ts
 * imports "kaizen/types", which is not resolvable in a bare temp dir.
 * That's expected — the manifest check requires `kaizen` to be installed.
 * The structural checks (package.json, README, test file) should still pass.
 *
 * Marketplace validate: no dynamic imports, so full workflow passes cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runPluginCreate } from "./plugin-create.js";
import { runMarketplaceCreate } from "./marketplace-create.js";
import { runMarketplaceValidate } from "./marketplace-validate.js";
import {
  checkPackageJson,
  checkFilesPresent,
  type ValidationResult,
} from "./plugin-validate.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kaizen-integration-"));
}

// ─── Test 1: Full plugin scaffold workflow ────────────────────────────────────

describe("integration: plugin scaffold", () => {
  let tmpBase: string;
  let pluginDir: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    pluginDir = join(tmpBase, "my-integration-plugin");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("runPluginCreate returns 0 and all 6 files exist", async () => {
    const code = await runPluginCreate(pluginDir, { defaults: true });
    expect(code).toBe(0);

    expect(existsSync(join(pluginDir, "package.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "index.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "index.test.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "README.md"))).toBe(true);
    expect(existsSync(join(pluginDir, ".kaizen", ".gitkeep"))).toBe(true);
  });

  it("scaffolded package.json passes checkPackageJson", async () => {
    await runPluginCreate(pluginDir, { defaults: true });

    const results = await checkPackageJson(pluginDir);
    const failures = results.filter((r: ValidationResult) => r.status === "fail");
    expect(failures).toHaveLength(0);
  });

  it("scaffolded plugin dir passes checkFilesPresent", async () => {
    await runPluginCreate(pluginDir, { defaults: true });

    const results = await checkFilesPresent(pluginDir);
    const failures = results.filter((r: ValidationResult) => r.status === "fail");
    expect(failures).toHaveLength(0);
  });

  it("scaffolded package.json has correct content (type:module, keywords, exports)", async () => {
    await runPluginCreate(pluginDir, { defaults: true });

    const pkg = JSON.parse(
      readFileSync(join(pluginDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(pkg.type).toBe("module");
    expect(pkg.keywords).toContain("kaizen-plugin");
    expect((pkg.exports as Record<string, unknown>)["."]).toBe("./index.ts");
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("checkManifest fail is isolated to manifest-loadable rule (kaizen/types not installed)", async () => {
    // The scaffolded index.ts imports "kaizen/types" which won't resolve in a
    // bare temp dir. We confirm the failure message references the import
    // rather than a structural problem (missing exports, wrong shape, etc.).
    await runPluginCreate(pluginDir, { defaults: true });

    const pkg = JSON.parse(
      readFileSync(join(pluginDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;

    const { checkManifest } = await import("./plugin-validate.js");
    const results = await checkManifest(pluginDir, pkg);
    const failures = results.filter((r: ValidationResult) => r.status === "fail");

    // There should be exactly one failure, and it must be the loadable rule.
    // (If kaizen/types somehow resolved, this plugin would load cleanly — that's fine too.)
    if (failures.length > 0) {
      expect(failures).toHaveLength(1);
      const f = failures[0] as ValidationResult;
      expect(f.rule).toBe("plugin manifest loadable");
      expect(f.message).toMatch(/kaizen\/types|Cannot find|ERR_MODULE_NOT_FOUND/i);
    }
    // If failures.length === 0 then the package resolved (e.g. in CI with kaizen installed) — pass.
  });
});

// ─── Test 2: Full marketplace scaffold → validate workflow ────────────────────

describe("integration: marketplace scaffold → validate", () => {
  let tmpBase: string;
  let marketDir: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    marketDir = join(tmpBase, "my-integration-market");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("runMarketplaceCreate → runMarketplaceValidate exits 0", async () => {
    const createCode = await runMarketplaceCreate(marketDir, { defaults: true });
    expect(createCode).toBe(0);

    const validateCode = await runMarketplaceValidate(marketDir);
    expect(validateCode).toBe(0);
  });

  it("scaffolded marketplace has all required files and dirs", async () => {
    const code = await runMarketplaceCreate(marketDir, { defaults: true });
    expect(code).toBe(0);

    expect(existsSync(join(marketDir, ".kaizen", "marketplace.json"))).toBe(true);
    expect(existsSync(join(marketDir, "plugins", ".gitkeep"))).toBe(true);
    expect(existsSync(join(marketDir, "harnesses", ".gitkeep"))).toBe(true);
    expect(existsSync(join(marketDir, "README.md"))).toBe(true);
  });

  it("scaffolded marketplace.json has correct v1.0.0 shape", async () => {
    await runMarketplaceCreate(marketDir, { defaults: true });

    const marketplace = JSON.parse(
      readFileSync(join(marketDir, ".kaizen", "marketplace.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(marketplace.version).toBe("1.0.0");
    expect(marketplace.name).toBe("my-integration-market");
    expect(Array.isArray(marketplace.entries)).toBe(true);
    expect(marketplace.entries).toHaveLength(0);
  });

  it("runMarketplaceValidate returns 1 for empty dir (missing marketplace.json)", async () => {
    // marketDir doesn't exist yet — validate should fail gracefully
    const code = await runMarketplaceValidate(marketDir);
    expect(code).toBe(1);
  });
});
