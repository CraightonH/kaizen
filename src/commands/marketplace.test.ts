import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import {
  cmdMarketplaceAdd, cmdMarketplaceList, cmdMarketplaceBrowse, cmdMarketplaceRemove,
} from "./marketplace.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

let home: string;
let upstream: string;

const catalog: MarketplaceCatalog = {
  version: "1.0.0", name: "Test", url: "local://test",
  entries: [{
    kind: "plugin", name: "demo", description: "a demo",
    versions: [{ version: "1.0.0", source: { type: "file", path: "plugins/demo" } }],
  }],
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kz-home-"));
  process.env.KAIZEN_HOME_OVERRIDE = home;
  upstream = mkdtempSync(join(tmpdir(), "kz-up-"));
  mkdirSync(join(upstream, ".kaizen"), { recursive: true });
  writeFileSync(join(upstream, ".kaizen", "marketplace.json"), JSON.stringify(catalog));
  await $`git init -q`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t add .`.cwd(upstream);
  await $`git -c user.email=t@t -c user.name=t commit -qm init`.cwd(upstream);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(upstream, { recursive: true, force: true });
  delete process.env.KAIZEN_HOME_OVERRIDE;
});

describe("marketplace CLI commands", () => {
  it("add → list → browse → remove (happy path)", async () => {
    expect(await cmdMarketplaceAdd({ url: upstream, id: "test" })).toBe(0);
    expect(await cmdMarketplaceList()).toBe(0);
    expect(await cmdMarketplaceBrowse({ id: "test" })).toBe(0);
    expect(await cmdMarketplaceRemove({ id: "test" })).toBe(0);
    // After remove, list shows empty
    expect(await cmdMarketplaceList()).toBe(0);
  });

  it("add returns 1 on bad url", async () => {
    const code = await cmdMarketplaceAdd({ url: "/nonexistent/path", id: "bad" });
    expect(code).toBe(1);
  });
});
