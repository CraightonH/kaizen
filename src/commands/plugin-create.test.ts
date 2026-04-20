import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runPluginCreate } from "./plugin-create.js";

// Note: Full runPluginValidate integration test (checking the generated index.ts loads cleanly)
// requires "kaizen/types" to be resolvable as a package. That integration test will run after
// Task 7 wires the CLI and the package is published. For now we verify file structure only.

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kaizen-create-"));
}

describe("runPluginCreate", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
    targetPath = join(tmpBase, "my-plugin");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  describe("defaults mode", () => {
    it("creates all required files", async () => {
      const code = await runPluginCreate(targetPath, { defaults: true });
      expect(code).toBe(0);

      expect(existsSync(join(targetPath, "package.json"))).toBe(true);
      expect(existsSync(join(targetPath, "tsconfig.json"))).toBe(true);
      expect(existsSync(join(targetPath, "index.ts"))).toBe(true);
      expect(existsSync(join(targetPath, "index.test.ts"))).toBe(true);
      expect(existsSync(join(targetPath, "README.md"))).toBe(true);
      expect(existsSync(join(targetPath, ".kaizen", ".gitkeep"))).toBe(true);
    });

    it("generates valid package.json", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const pkg = JSON.parse(readFileSync(join(targetPath, "package.json"), "utf8")) as Record<string, unknown>;
      expect(pkg.name).toBe("my-plugin");
      expect(pkg.version).toBe("0.1.0");
      expect(pkg.type).toBe("module");
      expect(pkg.keywords).toContain("kaizen-plugin");
      expect((pkg.exports as Record<string, unknown>)["."]).toBe("./index.ts");
    });

    it("generates valid tsconfig.json", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const tsconfig = JSON.parse(readFileSync(join(targetPath, "tsconfig.json"), "utf8")) as Record<string, unknown>;
      const opts = tsconfig.compilerOptions as Record<string, unknown>;
      expect(opts.target).toBe("ESNext");
      expect(opts.strict).toBe(true);
    });

    it("generates index.ts with correct plugin shape", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const src = readFileSync(join(targetPath, "index.ts"), "utf8");
      expect(src).toContain(`name: "my-plugin"`);
      expect(src).toContain(`apiVersion: "2.0.0"`);
      expect(src).toContain(`tier: "trusted"`);
      expect(src).toContain(`export default plugin`);
    });

    it("generates index.test.ts with bun:test imports", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const src = readFileSync(join(targetPath, "index.test.ts"), "utf8");
      expect(src).toContain(`from "bun:test"`);
      expect(src).toContain(`has correct metadata`);
      expect(src).toContain(`setup runs without error`);
    });

    it("generates README.md with plugin name", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const readme = readFileSync(join(targetPath, "README.md"), "utf8");
      expect(readme).toContain("# my-plugin");
      expect(readme).toContain("Installation");
    });

    it("uses basename of targetPath as name", async () => {
      const nestedTarget = join(tmpBase, "nested", "my-nested-plugin");
      const code = await runPluginCreate(nestedTarget, { defaults: true });
      expect(code).toBe(0);
      const pkg = JSON.parse(readFileSync(join(nestedTarget, "package.json"), "utf8")) as Record<string, unknown>;
      expect(pkg.name).toBe("my-nested-plugin");
    });
  });

  describe("target exists error", () => {
    it("returns 1 if target path already exists", async () => {
      // Create the dir first
      await runPluginCreate(targetPath, { defaults: true });

      // Try again — should fail
      const code = await runPluginCreate(targetPath, { defaults: true });
      expect(code).toBe(1);
    });
  });
});
