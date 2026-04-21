import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { addMarketplace } from "../core/marketplace.js";
import { pluginInstallDir } from "../core/kaizen-config.js";
import { writeLockfile, upsertPluginEntry, readLockfile, LOCKFILE_SCHEMA_VERSION } from "../core/lockfile.js";
import { canonicalTierGrantHash } from "../core/plugin-hash.js";
import { runUpdate } from "./update.js";

let home: string;
let upstream: string;

function makePlugin(dir: string, name: string, version: string, permissions = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"),
    JSON.stringify({ name, version, main: "index.mjs", type: "module" }));
  writeFileSync(join(dir, "index.mjs"),
    `export default { name: "${name}", apiVersion: "2", permissions: ${JSON.stringify(permissions)}, async setup() {} };`);
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(upstream, ".kaizen"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

async function makeUpstreamWithVersions(perms1: object, perms2: object): Promise<void> {
  makePlugin(join(upstream, "plugins", "demo-v1"), "demo", "1.0.0", perms1);
  makePlugin(join(upstream, "plugins", "demo-v2"), "demo", "1.0.1", perms2);

  writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify({
    version: "1.0.0", name: "M", url: upstream,
    entries: [{ kind: "plugin", name: "demo", description: "",
      versions: [
        { version: "1.0.0", source: { type: "file", path: "plugins/demo-v1" } },
        { version: "1.0.1", source: { type: "file", path: "plugins/demo-v2" } },
      ] }],
  }));
  await $`git init -q`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(upstream);
  await addMarketplace(upstream, { id: "m", local: true });
}

describe("runUpdate", () => {
  it("silently updates when hash unchanged", async () => {
    const samePerms = { tier: "trusted" };
    await makeUpstreamWithVersions(samePerms, samePerms);

    const lockfilePath = join(home, "permissions.lock");
    const hash = canonicalTierGrantHash({ tier: "trusted" });
    const lf = {
      schemaVersion: LOCKFILE_SCHEMA_VERSION,
      plugins: {
        demo: {
          version: "1.0.0",
          hash,
          tier: "trusted" as const,
          consentedAt: new Date().toISOString(),
          consentedBy: "test",
        },
      },
    };
    writeLockfile(lockfilePath, lf);

    // Also install v1.0.0 so it's "installed"
    const v1dir = pluginInstallDir("m", "demo", "1.0.0");
    makePlugin(v1dir, "demo", "1.0.0", samePerms);

    const code = await runUpdate({ ref: "m/demo", lockfilePath, allowUnscoped: false, nonInteractive: true });
    expect(code).toBe(0);
    expect(existsSync(pluginInstallDir("m", "demo", "1.0.1"))).toBe(true);
    // lockfile bumped
    const updated = readLockfile(lockfilePath);
    expect(updated.plugins["demo"]?.version).toBe("1.0.1");
  });
});
