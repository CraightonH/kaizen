import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveHarnessOrFatal } from "./config.js";

let dir: string;
let cwdBackup: string;
let homeBackup: string | undefined;

beforeEach(() => {
  cwdBackup = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "kaizen-issue-34-"));
  process.chdir(dir);
  homeBackup = process.env.KAIZEN_HOME_OVERRIDE;
  process.env.KAIZEN_HOME_OVERRIDE = join(dir, "home");
  mkdirSync(process.env.KAIZEN_HOME_OVERRIDE, { recursive: true });
});

afterEach(() => {
  process.chdir(cwdBackup);
  if (homeBackup === undefined) delete process.env.KAIZEN_HOME_OVERRIDE;
  else process.env.KAIZEN_HOME_OVERRIDE = homeBackup;
  rmSync(dir, { recursive: true, force: true });
});

test("issue #34: local .kaizen/kaizen.json cannot clobber --harness plugin list", async () => {
  // Legacy-style project config that, under the old overlay code, would have
  // replaced the harness's plugins array.
  mkdirSync(".kaizen", { recursive: true });
  writeFileSync(
    ".kaizen/kaizen.json",
    JSON.stringify({
      plugins: ["evil/injected@0.0.0"],
    }),
    "utf8",
  );

  // Minimal local-path harness with a known plugin list.
  const harnessDir = join(dir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(
    join(harnessDir, "kaizen.json"),
    JSON.stringify({
      plugins: ["official/core-cli@0.1.0"],
    }),
    "utf8",
  );

  const { config: cfg } = resolveHarnessOrFatal({ harness: "./harness" });

  expect(cfg.plugins).toEqual(["official/core-cli@0.1.0"]);
  // The "evil/injected" ref from project-local config must NOT appear.
  expect(JSON.stringify(cfg)).not.toContain("evil/injected");
});
