import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMarketplaceCreate } from "./marketplace-create.js";
import { runMarketplaceValidate } from "./marketplace-validate.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kaizen-market-create-"));
}

describe("runMarketplaceCreate", () => {
  // ─── Test 1: Non-interactive (defaults) mode ────────────────────────────────

  it("generates marketplace scaffold in defaults mode with all files and dirs", async () => {
    const tmpRoot = makeTmpDir();
    const targetPath = join(tmpRoot, "my-market");

    const code = await runMarketplaceCreate(targetPath, { defaults: true });
    expect(code).toBe(0);

    // Check directories exist
    expect(existsSync(join(targetPath, ".kaizen"))).toBe(true);
    expect(existsSync(join(targetPath, "plugins"))).toBe(true);
    expect(existsSync(join(targetPath, "harnesses"))).toBe(true);

    // Check files exist
    expect(existsSync(join(targetPath, ".kaizen", "marketplace.json"))).toBe(true);
    expect(existsSync(join(targetPath, "plugins", ".gitkeep"))).toBe(true);
    expect(existsSync(join(targetPath, "harnesses", ".gitkeep"))).toBe(true);
    expect(existsSync(join(targetPath, "README.md"))).toBe(true);

    // Validate the generated marketplace with runMarketplaceValidate
    const validateCode = await runMarketplaceValidate(targetPath);
    expect(validateCode).toBe(0);
  });

  // ─── Test 2: Generated marketplace.json has correct shape ────────────────────

  it("generates marketplace.json with correct v1.0.0 shape and entries array", async () => {
    const tmpRoot = makeTmpDir();
    const targetPath = join(tmpRoot, "my-market");

    const code = await runMarketplaceCreate(targetPath, { defaults: true });
    expect(code).toBe(0);

    const marketplaceContent = readFileSync(join(targetPath, ".kaizen", "marketplace.json"), "utf8");
    const marketplace = JSON.parse(marketplaceContent) as Record<string, unknown>;

    // Check shape
    expect(marketplace.version).toBe("1.0.0");
    expect(typeof marketplace.name).toBe("string");
    expect(marketplace.name).toBe("my-market");
    expect(typeof marketplace.description).toBe("string");
    expect(typeof marketplace.url).toBe("string");
    expect(Array.isArray(marketplace.entries)).toBe(true);
    expect(marketplace.entries).toEqual([]);

    // Ensure no legacy shape
    expect(marketplace.plugins).toBeUndefined();
    expect(marketplace.harnesses).toBeUndefined();
  });

  // ─── Test 3: Target path already exists → return 1 ─────────────────────────

  it("returns 1 when target path already exists", async () => {
    const tmpRoot = makeTmpDir();
    const targetPath = join(tmpRoot, "existing-market");

    // Create the target first
    await runMarketplaceCreate(targetPath, { defaults: true });

    // Try to create again at the same path
    const code = await runMarketplaceCreate(targetPath, { defaults: true });
    expect(code).toBe(1);
  });

  // ─── Test 4: Default name and description in defaults mode ──────────────────

  it("uses basename as name and generates description in defaults mode", async () => {
    const tmpRoot = makeTmpDir();
    const targetPath = join(tmpRoot, "my-custom-market");

    const code = await runMarketplaceCreate(targetPath, { defaults: true });
    expect(code).toBe(0);

    const marketplaceContent = readFileSync(join(targetPath, ".kaizen", "marketplace.json"), "utf8");
    const marketplace = JSON.parse(marketplaceContent) as Record<string, unknown>;

    expect(marketplace.name).toBe("my-custom-market");
    expect(marketplace.description).toBe("Kaizen plugins for my-custom-market.");
  });

  // ─── Test 5: Default url in defaults mode ────────────────────────────────────

  it("generates a non-empty placeholder URL in defaults mode", async () => {
    const tmpRoot = makeTmpDir();
    const targetPath = join(tmpRoot, "my-market");

    const code = await runMarketplaceCreate(targetPath, { defaults: true });
    expect(code).toBe(0);

    const marketplaceContent = readFileSync(join(targetPath, ".kaizen", "marketplace.json"), "utf8");
    const marketplace = JSON.parse(marketplaceContent) as Record<string, unknown>;

    expect(typeof marketplace.url).toBe("string");
    expect(marketplace.url).toBeTruthy(); // non-empty string
    expect((marketplace.url as string).length).toBeGreaterThan(0);
  });

  // ─── Test 6: README.md is generated ──────────────────────────────────────────

  it("generates a helpful README.md", async () => {
    const tmpRoot = makeTmpDir();
    const targetPath = join(tmpRoot, "my-market");

    const code = await runMarketplaceCreate(targetPath, { defaults: true });
    expect(code).toBe(0);

    const readmeContent = readFileSync(join(targetPath, "README.md"), "utf8");

    // Check for key content
    expect(readmeContent).toContain("marketplace");
    expect(readmeContent).toContain("plugin");
    expect(readmeContent).toContain("harness");
    expect(readmeContent).toContain("kind");
    expect(readmeContent).toContain("source");
    expect(readmeContent.toLowerCase()).toContain("validate");
  });
});
