/**
 * Asserts that a plugin located in a temp dir (with no ancestor
 * node_modules/kaizen/) can `import "kaizen/types"` and load cleanly after
 * `registerHostApi()` runs. This is the regression test for the gap the
 * original e2e test missed.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerHostApi } from "../core/host-api-register.js";

describe("host-api virtual module — plugin load from foreign dir", () => {
  let tmpRoot: string;
  let pluginDir: string;

  beforeAll(() => {
    registerHostApi();
    // Use tmpdir to ensure no ancestor node_modules/kaizen on the walk.
    tmpRoot = mkdtempSync(join(tmpdir(), "kaizen-host-api-"));
    pluginDir = join(tmpRoot, "plugin@0.0.1");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "probe-plugin", version: "0.0.1", type: "module", exports: { ".": "./index.ts" } }),
    );
    writeFileSync(
      join(pluginDir, "index.ts"),
      `import { ServiceToken, PLUGIN_API_VERSION } from "kaizen/types";
       import type { KaizenPlugin } from "kaizen/types";
       const token = new ServiceToken<{ hi(): string }>("probe-svc");
       const plugin: KaizenPlugin = {
         name: "probe-plugin",
         apiVersion: PLUGIN_API_VERSION + ".0.0",
         permissions: { tier: "trusted" },
         capabilities: {},
         async setup(ctx) { ctx.registerService(token, { hi: () => "hi" }); },
       };
       export default plugin;
       export { token };`,
    );
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves kaizen/types when loading a plugin from an isolated tmp dir", async () => {
    const mod = (await import(join(pluginDir, "index.ts"))) as {
      default: { name: string; apiVersion: string };
      token: unknown;
    };
    expect(mod.default.name).toBe("probe-plugin");
    expect(mod.default.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mod.token).toBeDefined();
  });
});
