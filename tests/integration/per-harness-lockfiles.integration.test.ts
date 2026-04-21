import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { deriveLockfilePath } from "../../src/core/lockfile-path.js";
import { resolveHarness } from "../../src/core/config.js";

describe("per-harness lockfile isolation", () => {
  test("two harnesses in one repo get independent lockfile paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "kz-two-"));
    const cwdOrig = process.cwd();
    process.chdir(repo);
    try {
      const a = join(repo, ".kaizen", "harnesses", "a");
      const b = join(repo, ".kaizen", "harnesses", "b");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, "kaizen.json"), JSON.stringify({ plugins: ["p1"] }));
      writeFileSync(join(b, "kaizen.json"), JSON.stringify({ plugins: ["p2"] }));

      const lockA = deriveLockfilePath(resolveHarness("a").kaizenJsonPath);
      const lockB = deriveLockfilePath(resolveHarness("b").kaizenJsonPath);

      expect(lockA).not.toBe(lockB);
      expect(lockA.includes(".kaizen/harnesses/a/permissions.lock")).toBe(true);
      expect(lockB.includes(".kaizen/harnesses/b/permissions.lock")).toBe(true);

      writeFileSync(lockA, "A");
      writeFileSync(lockB, "B");
      expect(readFileSync(lockA, "utf8")).toBe("A");
      expect(readFileSync(lockB, "utf8")).toBe("B");
      expect(existsSync(join(repo, "kaizen.permissions.lock"))).toBe(false);
    } finally {
      process.chdir(cwdOrig);
    }
  });
});
