import { describe, it, expect } from "bun:test";
import type {
  PluginSource, MarketplaceEntry, MarketplaceCatalog,
  MarketplaceRef, KaizenGlobalConfig, KaizenConfig,
} from "./plugin.js";

describe("marketplace types", () => {
  it("accepts a catalog with plugin + harness entries", () => {
    const cat: MarketplaceCatalog = {
      version: "1.0.0",
      name: "Official",
      url: "https://github.com/kaizen-sh/kaizen-plugins.git",
      entries: [
        {
          kind: "plugin",
          name: "timestamps",
          description: "time tools",
          versions: [{ version: "1.2.3", source: { type: "file", path: "plugins/timestamps" } }],
        },
        {
          kind: "harness",
          name: "anthropic-default",
          description: "default harness",
          versions: [{ version: "1.0.0", path: "harnesses/anthropic.json" }],
        },
      ],
    };
    expect(cat.entries.length).toBe(2);
  });

  it("accepts a global config with marketplaces", () => {
    const g: KaizenGlobalConfig = {
      marketplaces: [{ id: "official", url: "https://…", updatedAt: "2026-04-18T00:00:00Z" }],
      marketplaceUpdateTTL: 900,
    };
    expect(g.marketplaces?.[0]?.id).toBe("official");
  });

  it("accepts a harness config with marketplaces slice", () => {
    const h: KaizenConfig = {
      plugins: ["official/timestamps@1.2.3"],
      marketplaces: [{ id: "official", url: "https://…" }],
    };
    expect(h.plugins.length).toBe(1);
  });
});
