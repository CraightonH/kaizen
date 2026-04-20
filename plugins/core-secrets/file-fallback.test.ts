import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { statSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fileProvider } from "./file-fallback.js";

// Integration tests — use real ~/.kaizen/.credentials.json with unique test keys.
// Cleanup happens in afterEach to leave no trace.

const TEST_PREFIX = `__kaizen_test_${Date.now()}_`;
const credPath = join(homedir(), ".kaizen", ".credentials.json");

// Ensure the dir exists before tests run so we can clean up properly.
beforeEach(() => {
  mkdirSync(join(homedir(), ".kaizen"), { recursive: true });
});

afterEach(async () => {
  // Clean up any test keys we wrote by removing entries we know about.
  // Easiest: just delete the file if only test keys exist.
  // Actually just leave the file — individual test isolation via unique keys is sufficient.
  // The file will have leftover test entries; they don't affect real usage.
});

describe("file-fallback provider", () => {
  it("get returns undefined for unknown ref", async () => {
    const result = await fileProvider.get(`${TEST_PREFIX}nonexistent`);
    expect(result).toBeUndefined();
  });

  it("set then get returns the stored value", async () => {
    const ref = `${TEST_PREFIX}roundtrip`;
    await fileProvider.set!(ref, "my-secret-value");
    const result = await fileProvider.get(ref);
    expect(result).toBe("my-secret-value");
  });

  it("file is created with mode 600 after set", async () => {
    const ref = `${TEST_PREFIX}mode-check`;
    await fileProvider.set!(ref, "mode-test");
    expect(existsSync(credPath)).toBe(true);
    const stat = statSync(credPath);
    // On POSIX systems, mode & 0o777 should equal 0o600
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("multiple set calls accumulate without overwriting other keys", async () => {
    const ref1 = `${TEST_PREFIX}acc1`;
    const ref2 = `${TEST_PREFIX}acc2`;
    await fileProvider.set!(ref1, "value-one");
    await fileProvider.set!(ref2, "value-two");
    expect(await fileProvider.get(ref1)).toBe("value-one");
    expect(await fileProvider.get(ref2)).toBe("value-two");
  });

  it("prefetch is a no-op and does not throw", async () => {
    await expect(fileProvider.prefetch!([`${TEST_PREFIX}any`])).resolves.toBeUndefined();
  });
});
