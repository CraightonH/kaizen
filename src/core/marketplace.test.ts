import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import {
  addMarketplace, pullMarketplace, readCatalog, validateCatalog,
  shouldRefresh, MarketplaceCatalogInvalidError,
} from "./marketplace.js";
import { loadKaizenGlobalConfig, marketplaceRepoDir } from "./kaizen-config.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

let home: string;
let upstream: string;

async function makeUpstream(catalog: MarketplaceCatalog): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(dir, ".kaizen"), { recursive: true });
  writeFileSync(join(dir, ".kaizen", "marketplace.json"), JSON.stringify(catalog, null, 2));
  await $`git init -q`.cwd(dir);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(dir);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(dir);
  return dir;
}

const sampleCatalog: MarketplaceCatalog = {
  version: "1.0.0", name: "Official", url: "local://upstream",
  entries: [{
    kind: "plugin", name: "timestamps", description: "ts",
    versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/timestamps" } }],
  }],
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = await makeUpstream(sampleCatalog);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("validateCatalog", () => {
  it("passes a valid catalog", () => {
    expect(() => validateCatalog(sampleCatalog)).not.toThrow();
  });
  it("rejects unknown kind", () => {
    const bad = { ...sampleCatalog, entries: [{ ...sampleCatalog.entries[0], kind: "bogus" }] } as unknown;
    expect(() => validateCatalog(bad as MarketplaceCatalog)).toThrow(MarketplaceCatalogInvalidError);
  });
  it("rejects duplicate names across kinds", () => {
    const dup: MarketplaceCatalog = {
      ...sampleCatalog,
      entries: [
        sampleCatalog.entries[0]!,
        { kind: "harness", name: "timestamps", description: "clash",
          versions: [{ version: "1.0.0", path: "h.json" }] },
      ],
    };
    expect(() => validateCatalog(dup)).toThrow(MarketplaceCatalogInvalidError);
  });
});

describe("addMarketplace — git clone", () => {
  it("clones upstream into <home>/marketplaces/<id>/repo, writes global config", async () => {
    await addMarketplace(upstream, { id: "official" });
    expect(existsSync(marketplaceRepoDir("official"))).toBe(true);
    const cat = await readCatalog("official");
    expect(cat.name).toBe("Official");
    const g = await loadKaizenGlobalConfig();
    expect(g.marketplaces?.[0]?.id).toBe("official");
    expect(g.marketplaces?.[0]?.url).toBe(upstream);
  });

  it("is idempotent — re-adding same id is a no-op", async () => {
    await addMarketplace(upstream, { id: "official" });
    await addMarketplace(upstream, { id: "official" });
    const g = await loadKaizenGlobalConfig();
    expect(g.marketplaces?.length).toBe(1);
  });

  it("derives id from URL basename when not supplied", async () => {
    await addMarketplace(upstream);
    const g = await loadKaizenGlobalConfig();
    expect(g.marketplaces?.[0]?.id).toBeDefined();
  });
});

describe("addMarketplace — local path (symlinked)", () => {
  it("symlinks repo dir when url is an absolute local path", async () => {
    await addMarketplace(upstream, { id: "local-dev", local: true });
    const repoPath = marketplaceRepoDir("local-dev");
    expect(existsSync(repoPath)).toBe(true);
    // Confirm it's a symlink by checking that editing upstream shows up.
    writeFileSync(join(upstream, "NEW"), "x");
    expect(existsSync(join(repoPath, "NEW"))).toBe(true);
  });
});

describe("pullMarketplace", () => {
  it("pulls a cloned marketplace (ff-only)", async () => {
    await addMarketplace(upstream, { id: "official" });
    writeFileSync(join(upstream, "README.md"), "hi");
    await $`git -c user.email=t@t -c user.name=t add README.md`.cwd(upstream);
    await $`git -c user.email=t@t -c user.name=t commit -qm r`.cwd(upstream);
    await pullMarketplace("official");
    expect(existsSync(join(marketplaceRepoDir("official"), "README.md"))).toBe(true);
  });
  it("is a no-op on symlinked marketplaces", async () => {
    await addMarketplace(upstream, { id: "local-dev", local: true });
    await pullMarketplace("local-dev"); // must not throw
  });
});

describe("shouldRefresh", () => {
  it("refreshes when no updatedAt", () => {
    expect(shouldRefresh({ id: "x", url: "" }, 900)).toBe(true);
  });
  it("does not refresh when within TTL", () => {
    expect(shouldRefresh({ id: "x", url: "", updatedAt: new Date().toISOString() }, 900)).toBe(false);
  });
  it("refreshes when older than TTL", () => {
    const old = new Date(Date.now() - 1000 * 60 * 60).toISOString();
    expect(shouldRefresh({ id: "x", url: "", updatedAt: old }, 900)).toBe(true);
  });
  it("ttl=0 disables refresh", () => {
    expect(shouldRefresh({ id: "x", url: "" }, 0)).toBe(false);
  });
});
