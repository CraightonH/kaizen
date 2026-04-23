import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kaizen-init-"));
});

afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

async function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    env: { ...process.env, KAIZEN_HOME_OVERRIDE: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

test("kaizen init without --global errors and exits 2", async () => {
  const { code, stderr } = await run(["init"]);
  expect(code).toBe(2);
  expect(stderr).toMatch(/requires --global/);
  expect(existsSync(join(home, "kaizen.json"))).toBe(false);
});

test("kaizen init --global writes {} when no --harness", async () => {
  const { code } = await run(["init", "--global"]);
  expect(code).toBe(0);
  const file = join(home, "kaizen.json");
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
});

test("kaizen init --global --harness X writes {defaults: {harness: X}}", async () => {
  const { code, stdout } = await run(["init", "--global", "--harness", "example/foo@1.0.0"]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/defaults\.harness=example\/foo@1\.0\.0/);
  const body = JSON.parse(readFileSync(join(home, "kaizen.json"), "utf8"));
  expect(body).toEqual({ defaults: { harness: "example/foo@1.0.0" } });
});

test("kaizen init --global is no-clobber when file exists", async () => {
  writeFileSync(join(home, "kaizen.json"), '{"marketplaces":[]}\n', "utf8");
  const { code, stdout } = await run(["init", "--global"]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/already exists/);
  const body = JSON.parse(readFileSync(join(home, "kaizen.json"), "utf8"));
  expect(body).toEqual({ marketplaces: [] });
});
