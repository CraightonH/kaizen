import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
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

    it("defaults do not produce a driver manifest", async () => {
      await runPluginCreate(targetPath, { defaults: true });
      const src = readFileSync(join(targetPath, "index.ts"), "utf8");
      expect(src).not.toContain("driver: true");
      expect(src).not.toContain("async start(ctx)");
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

describe("driver generator", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
    targetPath = join(tmpBase, "my-driver");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("emits driver: true and start(ctx) in index.ts when driver flag is set", async () => {
    const { generateIndexTs } = await import("./plugin-create.js");
    const src = generateIndexTs({
      name: "my-driver",
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: true,
    });
    expect(src).toContain("driver: true,");
    expect(src).toContain("async start(ctx)");
    expect(src).toContain(`ctx.log("driver started")`);
  });

  it("generated test asserts driver: true when driver flag is set", async () => {
    const { generateIndexTestTs } = await import("./plugin-create.js");
    const src = generateIndexTestTs({
      name: "my-driver",
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: true,
    });
    expect(src).toContain(`expect(plugin.driver).toBe(true)`);
  });

  it("non-driver generation is unchanged", async () => {
    const { generateIndexTs, generateIndexTestTs } = await import("./plugin-create.js");
    const cfg = {
      name: "p",
      description: "",
      tier: "trusted" as const,
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: false,
    };
    expect(generateIndexTs(cfg)).not.toContain("driver:");
    expect(generateIndexTs(cfg)).not.toContain("async start(ctx)");
    expect(generateIndexTestTs(cfg)).not.toContain("plugin.driver");
  });
});

describe("buildConfigFromFlags", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("fills defaults for unset flags", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const cfg = buildConfigFromFlags("/tmp/some-path/my-plug", {});
    expect(cfg).toEqual({
      name: "my-plug",
      description: "",
      tier: "trusted",
      grants: [],
      provides: [],
      consumes: [],
      hasConfig: false,
      configKeys: [],
      driver: false,
    });
  });

  it("applies all flags", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const cfg = buildConfigFromFlags("/tmp/x/plug", {
      name: "custom-name",
      description: "desc",
      tier: "scoped",
      grants: ["fs", "net"],
      provides: ["svc:a"],
      consumes: ["svc:b"],
      driver: true,
    });
    expect(cfg.name).toBe("custom-name");
    expect(cfg.description).toBe("desc");
    expect(cfg.tier).toBe("scoped");
    expect(cfg.grants).toEqual(["fs", "net"]);
    expect(cfg.provides).toEqual(["svc:a"]);
    expect(cfg.consumes).toEqual(["svc:b"]);
    expect(cfg.driver).toBe(true);
  });

  it("rejects invalid tier", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", { tier: "god-mode" as never }))
      .toThrow(/tier/);
  });

  it("rejects invalid grant", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", { grants: ["bogus" as never] }))
      .toThrow(/grant/);
  });

  it("parses --config-keys-json inline", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const json = JSON.stringify([
      { name: "api_key", type: "string", required: true, secret: true },
    ]);
    const cfg = buildConfigFromFlags("/tmp/p", { configKeysJson: json });
    expect(cfg.hasConfig).toBe(true);
    expect(cfg.configKeys).toEqual([
      { name: "api_key", type: "string", required: true, secret: true },
    ]);
  });

  it("parses --config-keys-file", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const file = join(tmpBase, "keys.json");
    writeFileSync(file, JSON.stringify([
      { name: "port", type: "number", required: false, secret: false },
    ]));
    const cfg = buildConfigFromFlags("/tmp/p", { configKeysFile: file });
    expect(cfg.hasConfig).toBe(true);
    expect(cfg.configKeys[0]?.name).toBe("port");
  });

  it("rejects both --config-keys-json and --config-keys-file", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", {
      configKeysJson: "[]",
      configKeysFile: "/tmp/x.json",
    })).toThrow(/mutually exclusive/);
  });

  it("rejects malformed config-keys JSON (not array)", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    expect(() => buildConfigFromFlags("/tmp/p", { configKeysJson: "{}" }))
      .toThrow(/array/);
  });

  it("rejects malformed config-keys entry (missing name)", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const json = JSON.stringify([{ type: "string", required: false, secret: false }]);
    expect(() => buildConfigFromFlags("/tmp/p", { configKeysJson: json }))
      .toThrow(/name/);
  });

  it("rejects malformed config-keys entry (bad type)", async () => {
    const { buildConfigFromFlags } = await import("./plugin-create.js");
    const json = JSON.stringify([{ name: "x", type: "enum", required: false, secret: false }]);
    expect(() => buildConfigFromFlags("/tmp/p", { configKeysJson: json }))
      .toThrow(/type/);
  });
});

describe("non-interactive mode", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
    targetPath = join(tmpBase, "np");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("runs non-interactively when flags are passed", async () => {
    const code = await runPluginCreate(targetPath, {
      flags: { name: "np", tier: "scoped", grants: ["fs"], driver: true },
    });
    expect(code).toBe(0);
    const src = readFileSync(join(targetPath, "index.ts"), "utf8");
    expect(src).toContain(`name: "np"`);
    expect(src).toContain(`tier: "scoped"`);
    expect(src).toContain(`fs:`);
    expect(src).toContain("driver: true,");
    expect(src).toContain("async start(ctx)");
  });

  it("non-interactive with no flags produces defaults-equivalent output", async () => {
    const code = await runPluginCreate(targetPath, { flags: {} });
    expect(code).toBe(0);
    const src = readFileSync(join(targetPath, "index.ts"), "utf8");
    expect(src).toContain(`name: "np"`);
    expect(src).toContain(`tier: "trusted"`);
    expect(src).not.toContain("driver:");
  });

  it("returns 1 on invalid tier", async () => {
    const code = await runPluginCreate(targetPath, {
      flags: { tier: "god-mode" as never },
    });
    expect(code).toBe(1);
    expect(existsSync(targetPath)).toBe(false);
  });

  it("returns 1 on invalid config-keys JSON", async () => {
    const code = await runPluginCreate(targetPath, {
      flags: { configKeysJson: "not json" },
    });
    expect(code).toBe(1);
    expect(existsSync(targetPath)).toBe(false);
  });
});

describe("cli flag shapes", () => {
  let tmpBase: string;
  let targetPath: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "kaizen-create-"));
    targetPath = join(tmpBase, "svc");
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("accepts repeated + comma-separated grants merged", async () => {
    // Simulating what cli.ts will produce after normalizing
    // parseArgs output ("--grant fs,net --grant env" becomes ["fs","net","env"])
    const code = await runPluginCreate(targetPath, {
      flags: { grants: ["fs", "net", "env"] },
    });
    expect(code).toBe(0);
    const src = readFileSync(join(targetPath, "index.ts"), "utf8");
    expect(src).toContain("fs:");
    expect(src).toContain("net:");
    expect(src).toContain("env:");
  });
});
