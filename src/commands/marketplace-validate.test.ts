import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMarketplaceValidate } from "./marketplace-validate.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kaizen-market-validate-"));
}

function writeMarketplace(dir: string, catalog: unknown): void {
  const kaizenDir = join(dir, ".kaizen");
  mkdirSync(kaizenDir, { recursive: true });
  writeFileSync(join(kaizenDir, "marketplace.json"), JSON.stringify(catalog, null, 2));
}

function makeValidCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    name: "my-org-plugins",
    description: "Test catalog",
    url: "https://example.com/marketplace",
    entries: [],
    ...overrides,
  };
}

// ─── Test 1: Valid entries[] catalog (mixed plugin + harness) ─────────────────

describe("runMarketplaceValidate", () => {
  it("passes a valid catalog with mixed plugin and harness entries", async () => {
    const dir = makeTmpDir();
    // Create referenced harness path
    const harnessDir = join(dir, "harnesses", "my-harness");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, "kaizen.json"), "{}");

    writeMarketplace(dir, {
      version: "1.0.0",
      name: "my-org-plugins",
      description: "Test catalog",
      url: "https://example.com/marketplace",
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "A test plugin",
          versions: [
            {
              version: "0.1.0",
              source: { type: "npm", name: "my-plugin", version: "0.1.0" },
            },
          ],
        },
        {
          kind: "harness",
          name: "my-harness",
          description: "A test harness",
          versions: [
            {
              version: "0.1.0",
              path: "harnesses/my-harness/kaizen.json",
            },
          ],
        },
      ],
    });

    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(0);
  });

  // ─── Test 2: Legacy {plugins, harnesses} shape ──────────────────────────────

  it("fails with migration error for legacy {plugins, harnesses} shape", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, {
      version: "1.0.0",
      name: "my-org-plugins",
      url: "https://example.com",
      plugins: [{ name: "my-plugin" }],
      harnesses: [],
    });

    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 3: Cross-kind name collision ──────────────────────────────────────

  it("fails when a plugin and harness share the same name", async () => {
    const dir = makeTmpDir();
    // Create the harness path so it doesn't fail on that
    const harnessDir = join(dir, "harnesses", "foo");
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(join(harnessDir, "kaizen.json"), "{}");

    writeMarketplace(dir, {
      version: "1.0.0",
      name: "my-org-plugins",
      url: "https://example.com",
      entries: [
        {
          kind: "plugin",
          name: "foo",
          description: "Plugin foo",
          versions: [{ version: "1.0.0", source: { type: "npm", name: "foo", version: "1.0.0" } }],
        },
        {
          kind: "harness",
          name: "foo",
          description: "Harness foo",
          versions: [{ version: "1.0.0", path: "harnesses/foo/kaizen.json" }],
        },
      ],
    });

    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 4a: npm valid ──────────────────────────────────────────────────────

  it("passes for valid npm source", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [{ version: "1.0.0", source: { type: "npm", name: "my-plugin", version: "1.0.0" } }],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(0);
  });

  // ─── Test 4b: npm missing version ───────────────────────────────────────────

  it("fails for npm source missing version", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [{ version: "1.0.0", source: { type: "npm", name: "my-plugin" } }],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 4c: tarball valid ──────────────────────────────────────────────────

  it("passes for valid tarball source", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: { type: "tarball", url: "https://example.com/my-plugin-1.0.0.tgz" },
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(0);
  });

  // ─── Test 4d: tarball bad sha256 ────────────────────────────────────────────

  it("fails for tarball source with wrong-length sha256", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: {
                type: "tarball",
                url: "https://example.com/my-plugin-1.0.0.tgz",
                sha256: "tooshort",
              },
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 4e: file with valid path ──────────────────────────────────────────

  it("passes for file source with existing path", async () => {
    const dir = makeTmpDir();
    const pluginsDir = join(dir, "plugins", "my-plugin");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "index.ts"), "export default {};");

    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: { type: "file", path: "plugins/my-plugin/index.ts" },
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(0);
  });

  // ─── Test 4f: file with missing path ────────────────────────────────────────

  it("fails for file source with missing path", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: { type: "file", path: "plugins/my-plugin/index.ts" },
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 5: Missing harness path ───────────────────────────────────────────

  it("fails when harness path does not exist", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "harness",
          name: "my-harness",
          description: "Harness",
          versions: [{ version: "1.0.0", path: "harnesses/my-harness/kaizen.json" }],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 6: Bad semver in version ──────────────────────────────────────────

  it("fails when entry version is not valid semver", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [{ version: "v1", source: { type: "npm", name: "my-plugin", version: "1.0.0" } }],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 7: minKaizenVersion with range ────────────────────────────────────

  it("fails when minKaizenVersion is a semver range like ^1.0.0", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: { type: "npm", name: "my-plugin", version: "1.0.0" },
              minKaizenVersion: "^1.0.0",
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 8: minKaizenVersion bare semver ───────────────────────────────────

  it("passes when minKaizenVersion is a bare semver", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: { type: "npm", name: "my-plugin", version: "1.0.0" },
              minKaizenVersion: "1.0.0",
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(0);
  });

  // ─── Test 9: Missing description ────────────────────────────────────────────

  it("fails when entry description is missing", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          versions: [{ version: "1.0.0", source: { type: "npm", name: "my-plugin", version: "1.0.0" } }],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Test 10: Empty versions array ──────────────────────────────────────────

  it("fails when entry versions array is empty", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  // ─── Additional edge cases ───────────────────────────────────────────────────

  it("fails when .kaizen/marketplace.json is missing", async () => {
    const dir = makeTmpDir();
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  it("fails when marketplace.json is invalid JSON", async () => {
    const dir = makeTmpDir();
    const kaizenDir = join(dir, ".kaizen");
    mkdirSync(kaizenDir, { recursive: true });
    writeFileSync(join(kaizenDir, "marketplace.json"), "{ invalid json }");
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  it("fails when version is not 1.0.0", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({ version: "2.0.0" }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });

  it("fails minKaizenVersion range with >= prefix", async () => {
    const dir = makeTmpDir();
    writeMarketplace(dir, makeValidCatalog({
      entries: [
        {
          kind: "plugin",
          name: "my-plugin",
          description: "Plugin",
          versions: [
            {
              version: "1.0.0",
              source: { type: "npm", name: "my-plugin", version: "1.0.0" },
              minKaizenVersion: ">=1.0.0",
            },
          ],
        },
      ],
    }));
    const code = await runMarketplaceValidate(dir);
    expect(code).toBe(1);
  });
});
