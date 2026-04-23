import { test, expect, afterEach, beforeEach } from "bun:test";
import { warnStaleProjectConfig } from "./deprecation-warn.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let cwdBackup: string;
let dir: string;

beforeEach(() => {
  cwdBackup = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "kaizen-stalecfg-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwdBackup);
  rmSync(dir, { recursive: true, force: true });
});

test("warnStaleProjectConfig: warns when .kaizen/kaizen.json exists", () => {
  mkdirSync(".kaizen");
  writeFileSync(".kaizen/kaizen.json", "{}", "utf8");
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toMatch(/\.kaizen\/kaizen\.json/);
  expect(warnings[0]).toMatch(/no longer supported/);
});

test("warnStaleProjectConfig: warns when root kaizen.json exists", () => {
  writeFileSync("kaizen.json", "{}", "utf8");
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings.length).toBe(1);
  // Sanity: the message mentions root kaizen.json, not just .kaizen/kaizen.json.
  expect(warnings[0]).not.toMatch(/^Found '\.kaizen\//);
  expect(warnings[0]).toMatch(/(^|[^.])kaizen\.json/);
});

test("warnStaleProjectConfig: silent when neither file exists", () => {
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

test("warnStaleProjectConfig: warns for both when both exist", () => {
  mkdirSync(".kaizen");
  writeFileSync(".kaizen/kaizen.json", "{}", "utf8");
  writeFileSync("kaizen.json", "{}", "utf8");
  const warnings: string[] = [];
  warnStaleProjectConfig({ warn: (m) => warnings.push(m) });
  expect(warnings.length).toBe(2);
});
