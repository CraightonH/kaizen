/**
 * End-to-end: materialize a marketplace harness ref (ci/ci-default@1.0.0),
 * derive the per-harness lockfile path, run bootstrap, and assert
 *   (a) the lockfile was written under the marketplace-harness path
 *       (~/.kaizen/marketplaces/<id>/harnesses/<name>/permissions.lock),
 *   (b) a session round-trip completed through the fixture plugins.
 *
 * This mirrors what `kaizen --harness ci/ci-default@1.0.0` does in src/cli.ts,
 * but stays in-process so we can assert on the resulting lockfile location.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { addMarketplace } from "./marketplace.js";
import { materializeHarnessRef } from "./kaizen-config.js";
import { resolveHarness } from "./config.js";
import { deriveLockfilePath } from "./lockfile-path.js";
import { bootstrap } from "./index.js";
import { bootstrapMissingPlugins } from "./bootstrap.js";

const FIXTURE_MARKETPLACE = resolve(process.cwd(), "tests", "fixtures", "ci-marketplace");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kz-harness-mp-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("marketplace harness ref → load flow (--harness ci/ci-default@1.0.0)", () => {
  it("materializes the harness, derives a per-harness lockfile, and boots", async () => {
    // 1. Register the local fixture marketplace under id "ci".
    await addMarketplace(FIXTURE_MARKETPLACE, { id: "ci", local: true });

    // 2. Materialize the harness ref — this is what cli.ts does before resolveConfig.
    const harnessJsonPath = await materializeHarnessRef("ci/ci-default@1.0.0");

    // The materialized path must live under ~/.kaizen/marketplaces/ci/harnesses/ci-default/
    expect(harnessJsonPath).toBe(
      join(home, "marketplaces", "ci", "harnesses", "ci-default", "kaizen.json"),
    );
    expect(existsSync(harnessJsonPath)).toBe(true);

    // 3. Derive the per-harness lockfile path — same rule cli.ts uses.
    const lockfilePath = deriveLockfilePath(harnessJsonPath);
    expect(lockfilePath).toBe(
      join(home, "marketplaces", "ci", "harnesses", "ci-default", "permissions.lock"),
    );
    expect(existsSync(lockfilePath)).toBe(false); // not created yet

    // 4. Load the materialized harness config.
    const resolved = resolveHarness(harnessJsonPath);
    const kaizenConfig = {
      ...resolved.config,
      marketplaces: [{ id: "ci", url: FIXTURE_MARKETPLACE }],
    };

    // 5. Bootstrap missing plugins (installs fixtures, writes consent to the per-harness lockfile).
    await bootstrapMissingPlugins(kaizenConfig, {
      lockfilePath,
      trustLockfile: false,
      nonInteractive: true,
      allowUnscoped: true,
    });

    // Lockfile now exists at the marketplace-harness path.
    expect(existsSync(lockfilePath)).toBe(true);

    // Nothing at a repo-root-style legacy path.
    expect(existsSync(join(home, "kaizen.permissions.lock"))).toBe(false);

    // 6. Run the full bootstrap — the session should complete through the fixture plugins.
    await bootstrap(kaizenConfig, lockfilePath);

    // Lockfile still present after bootstrap.
    expect(existsSync(lockfilePath)).toBe(true);

    // Contains entries for at least the fixture plugins we just consented to.
    const lockRaw = readFileSync(lockfilePath, "utf8");
    expect(lockRaw).toContain("fixture-events");
    expect(lockRaw).toContain("fixture-lifecycle");
  });

  it("preserves permissions.lock across re-materialization of the harness", async () => {
    // Covers the Task 6 contract via the real --harness entry point.
    await addMarketplace(FIXTURE_MARKETPLACE, { id: "ci", local: true });
    const harnessJsonPath = await materializeHarnessRef("ci/ci-default@1.0.0");
    const lockfilePath = deriveLockfilePath(harnessJsonPath);

    // Seed a lockfile with bogus but syntactically valid content.
    writeFileSync(lockfilePath, "schemaVersion: 1\nplugins: {}\n");
    const before = readFileSync(lockfilePath);

    // Re-materialize — should not clobber the lockfile.
    await materializeHarnessRef("ci/ci-default@1.0.0");

    expect(existsSync(lockfilePath)).toBe(true);
    expect(readFileSync(lockfilePath).equals(before)).toBe(true);
  });
});
