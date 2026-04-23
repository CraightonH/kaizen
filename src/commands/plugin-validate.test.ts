import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkPackageJson,
  checkManifest,
  checkConfigSchema,
  scanImports,
  checkFilesPresent,
  runPluginValidate,
} from "./plugin-validate.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kaizen-validate-"));
}

function writeJson(dir: string, name: string, data: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(data, null, 2));
}

function writePkg(dir: string, overrides: Record<string, unknown> = {}): void {
  writeJson(dir, "package.json", {
    name: "my-plugin",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./index.ts" },
    keywords: ["kaizen-plugin"],
    ...overrides,
  });
}

function writeValidPlugin(dir: string, overrides: Record<string, unknown> = {}): void {
  const plugin = {
    name: "my-plugin",
    apiVersion: "2.0.0",
    permissions: { tier: "trusted" },
    services: {},
    setup: async () => {},
    ...overrides,
  };
  // Write as a TS file that Bun can import
  const src = `const plugin = ${JSON.stringify({ ...plugin, setup: undefined })};
plugin.setup = async () => {};
export default plugin;
`;
  writeFileSync(join(dir, "index.ts"), src);
}

// ─── checkPackageJson ─────────────────────────────────────────────────────────

describe("checkPackageJson", () => {
  it("passes for a fully valid package.json", async () => {
    const dir = makeTmpDir();
    writePkg(dir);
    const results = await checkPackageJson(dir);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("fails when package.json is missing", async () => {
    const dir = makeTmpDir();
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule === "package.json present" && r.status === "fail")).toBe(true);
  });

  it("fails when name is not kebab-case", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { name: "MyPlugin" });
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule.includes("kebab") && r.status === "fail")).toBe(true);
  });

  it("fails when type is not module", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { type: "commonjs" });
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule === "type: module" && r.status === "fail")).toBe(true);
  });

  it("fails when exports[\".\"] is missing", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { exports: {} });
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule.includes('exports') && r.status === "fail")).toBe(true);
  });

  it("fails when keywords does not include kaizen-plugin", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { keywords: ["some-other-keyword"] });
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule.includes("kaizen-plugin") && r.status === "fail")).toBe(true);
  });

  it("fails when version is missing", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { version: undefined });
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule.includes("version") && r.status === "fail")).toBe(true);
  });

  it("fails when version is not semver", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { version: "v1" });
    const results = await checkPackageJson(dir);
    expect(results.some((r) => r.rule.includes("semver") && r.status === "fail")).toBe(true);
  });
});

// ─── checkManifest ────────────────────────────────────────────────────────────

describe("checkManifest", () => {
  it("fails when plugin.name does not match package.json name", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir, { name: "other-plugin" });
    const results = await checkManifest(dir, pkg);
    expect(results.some((r) => r.rule.includes("plugin.name") && r.status === "fail")).toBe(true);
  });

  it("fails when plugin.apiVersion is missing", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir, { apiVersion: undefined });
    const results = await checkManifest(dir, pkg);
    expect(results.some((r) => r.rule.includes("apiVersion") && r.status === "fail")).toBe(true);
  });

  it("fails when plugin.permissions is missing", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir, { permissions: undefined });
    const results = await checkManifest(dir, pkg);
    expect(results.some((r) => r.rule === "plugin.permissions present" && r.status === "fail")).toBe(true);
  });

  it("fails when scoped tier has no grants", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir, { permissions: { tier: "scoped" } });
    const results = await checkManifest(dir, pkg);
    expect(results.some((r) => r.rule.includes("scoped") && r.status === "fail")).toBe(true);
  });

  it("passes when scoped tier has at least one grant", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir, { permissions: { tier: "scoped", env: ["HOME"] } });
    const results = await checkManifest(dir, pkg);
    expect(results.some((r) => r.rule.includes("scoped") && r.status === "fail")).toBe(false);
  });

  it("fails when plugin.services is missing", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir, { services: undefined });
    const results = await checkManifest(dir, pkg);
    expect(results.some((r) => r.rule.includes("services") && r.status === "fail")).toBe(true);
  });

  it("passes for fully valid plugin", async () => {
    const dir = makeTmpDir();
    const pkg = { name: "my-plugin", exports: { ".": "./index.ts" } };
    writeValidPlugin(dir);
    const results = await checkManifest(dir, pkg);
    const failures = results.filter((r) => r.status === "fail");
    expect(failures).toHaveLength(0);
  });
});

// ─── checkConfigSchema ────────────────────────────────────────────────────────

describe("checkConfigSchema", () => {
  it("returns empty when no config declared", async () => {
    const plugin = { name: "my-plugin", apiVersion: "2.0.0" };
    const results = await checkConfigSchema(plugin);
    expect(results).toHaveLength(0);
  });

  it("fails when config.secrets key not in schema.properties", async () => {
    const plugin = {
      name: "my-plugin",
      apiVersion: "2.0.0",
      config: {
        schema: { type: "object", properties: { other_key: { type: "string" } } },
        secrets: ["api_key"],
      },
    };
    const results = await checkConfigSchema(plugin);
    expect(results.some((r) => r.rule.includes("api_key") && r.status === "fail")).toBe(true);
  });

  it("passes when config.secrets keys are all in schema.properties", async () => {
    const plugin = {
      name: "my-plugin",
      apiVersion: "2.0.0",
      config: {
        schema: { type: "object", properties: { api_key: { type: "string" } } },
        secrets: ["api_key"],
      },
    };
    const results = await checkConfigSchema(plugin);
    expect(results.some((r) => r.status === "fail")).toBe(false);
  });

  it("warns when secrets non-empty and core-secrets:provider not in consumes", async () => {
    const plugin = {
      name: "my-plugin",
      apiVersion: "2.0.0",
      services: { consumes: [] },
      config: {
        schema: { type: "object", properties: { api_key: { type: "string" } } },
        secrets: ["api_key"],
      },
    };
    const results = await checkConfigSchema(plugin);
    expect(results.some((r) => r.status === "warn" && r.message?.includes("core-secrets:provider"))).toBe(true);
  });

  it("does not warn when core-secrets:provider is in consumes", async () => {
    const plugin = {
      name: "my-plugin",
      apiVersion: "2.0.0",
      services: { consumes: ["core-secrets:provider"] },
      config: {
        schema: { type: "object", properties: { api_key: { type: "string" } } },
        secrets: ["api_key"],
      },
    };
    const results = await checkConfigSchema(plugin);
    expect(results.some((r) => r.status === "warn" && r.message?.includes("core-secrets:provider"))).toBe(false);
  });

  it("passes secrets check regardless of env grant (secrets/env decoupling)", async () => {
    // Secrets don't require env grants — they go through secrets context
    const plugin = {
      name: "my-plugin",
      apiVersion: "2.0.0",
      permissions: { tier: "scoped", fs: { read: ["./data"] } },
      services: { consumes: ["core-secrets:provider"] },
      config: {
        schema: { type: "object", properties: { api_key: { type: "string" } } },
        secrets: ["api_key"],
      },
    };
    const results = await checkConfigSchema(plugin);
    expect(results.some((r) => r.status === "fail")).toBe(false);
  });
});

// ─── scanImports ──────────────────────────────────────────────────────────────

describe("scanImports", () => {
  it("warns when trusted plugin imports node:fs", async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "index.ts");
    writeFileSync(filePath, `import fs from "node:fs";\nexport default {};\n`);
    const results = await scanImports(filePath);
    expect(results.some((r) => r.status === "warn" && r.message?.includes("node:fs"))).toBe(true);
    expect(results.some((r) => r.message?.includes("runtime enforcer"))).toBe(true);
  });

  it("warns when plugin imports child_process", async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "index.ts");
    writeFileSync(filePath, `import { exec } from "child_process";\nexport default {};\n`);
    const results = await scanImports(filePath);
    expect(results.some((r) => r.status === "warn" && r.message?.includes("child_process"))).toBe(true);
  });

  it("returns no warnings for clean plugin", async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "index.ts");
    writeFileSync(filePath, `import { join } from "path";\nexport default {};\n`);
    const results = await scanImports(filePath);
    expect(results.filter((r) => r.status === "warn")).toHaveLength(0);
  });

  it("warns when file cannot be read", async () => {
    const results = await scanImports("/nonexistent/path/index.ts");
    expect(results.some((r) => r.status === "warn" && r.message?.includes("Could not parse"))).toBe(true);
  });

  it("does not flag imports for unscoped tier", async () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "index.ts");
    writeFileSync(filePath, `import fs from "node:fs";\nimport { spawn } from "node:child_process";\nexport default {};\n`);
    const results = await scanImports(filePath, "unscoped");
    expect(results.filter((r) => r.status === "warn")).toHaveLength(0);
  });
});

// ─── checkFilesPresent ────────────────────────────────────────────────────────

describe("checkFilesPresent", () => {
  it("fails when no test file present", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "README.md"), "# My Plugin");
    const results = await checkFilesPresent(dir);
    expect(results.some((r) => r.rule.includes("test") && r.status === "fail")).toBe(true);
  });

  it("fails when README.md is missing", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "index.test.ts"), "// tests");
    const results = await checkFilesPresent(dir);
    expect(results.some((r) => r.rule.includes("README") && r.status === "fail")).toBe(true);
  });

  it("passes when both test file and README are present", async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "index.test.ts"), "// tests");
    writeFileSync(join(dir, "README.md"), "# My Plugin");
    const results = await checkFilesPresent(dir);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
});

// ─── runPluginValidate (integration) ──────────────────────────────────────────

describe("runPluginValidate", () => {
  it("returns 1 when package.json is missing", async () => {
    const dir = makeTmpDir();
    const code = await runPluginValidate(dir);
    expect(code).toBe(1);
  });

  it("returns 1 when multiple failures exist", async () => {
    const dir = makeTmpDir();
    writePkg(dir, { name: "BadName", type: "commonjs" });
    const code = await runPluginValidate(dir);
    expect(code).toBe(1);
  });

  it("returns 0 for a fully valid plugin directory", async () => {
    const dir = makeTmpDir();
    writePkg(dir);
    writeValidPlugin(dir);
    writeFileSync(join(dir, "index.test.ts"), "// tests");
    writeFileSync(join(dir, "README.md"), "# My Plugin");
    const code = await runPluginValidate(dir);
    expect(code).toBe(0);
  });
});
