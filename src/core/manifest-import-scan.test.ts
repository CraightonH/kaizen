import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanPluginEntryImports } from "./manifest-import-scan.js";

function writeTmp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kaizen-scan-"));
  const file = join(dir, "index.ts");
  writeFileSync(file, contents);
  return file;
}

describe("scanPluginEntryImports", () => {
  test("empty file has no imports", () => {
    const f = writeTmp("export const x = 1;");
    expect(scanPluginEntryImports(f)).toEqual([]);
  });

  test("detects ESM import specifiers", () => {
    const f = writeTmp(`
      import fs from "node:fs";
      import { join } from "path";
      import * as os from "os";
      export const x = fs;
    `);
    const imports = scanPluginEntryImports(f);
    expect(imports).toContain("node:fs");
    expect(imports).toContain("path");
    expect(imports).toContain("os");
  });

  test("detects require() calls", () => {
    const f = writeTmp(`
      const fs = require("node:fs");
      const cp = require("child_process");
    `);
    const imports = scanPluginEntryImports(f);
    expect(imports).toContain("node:fs");
    expect(imports).toContain("child_process");
  });

  test("ignores dynamic imports with computed strings", () => {
    const f = writeTmp(`
      const mod = "fs";
      const fs = require(mod);  // we can't resolve this statically
    `);
    expect(() => scanPluginEntryImports(f)).not.toThrow();
  });

  test("returns deduped list", () => {
    const f = writeTmp(`
      import fs from "node:fs";
      import { x } from "node:fs";
    `);
    const imports = scanPluginEntryImports(f);
    expect(imports.filter((m) => m === "node:fs").length).toBe(1);
  });
});
