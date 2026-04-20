import { describe, it, expect } from "bun:test";
import { parseRef, resolveRef, RefConflictError,
         MarketplaceNotFoundError, PluginNotFoundError, RefParseError } from "./ref-resolver.js";
import type { MarketplaceCatalog } from "../types/plugin.js";

describe("parseRef", () => {
  it("parses marketplace-qualified with version", () => {
    expect(parseRef("official/timestamps@1.2.3"))
      .toEqual({ kind: "marketplace", marketplaceId: "official", name: "timestamps", version: "1.2.3" });
  });
  it("parses marketplace-qualified without version", () => {
    expect(parseRef("official/timestamps"))
      .toEqual({ kind: "marketplace", marketplaceId: "official", name: "timestamps" });
  });
  it("parses shorthand with version", () => {
    expect(parseRef("timestamps@1.2.3"))
      .toEqual({ kind: "shorthand", name: "timestamps", version: "1.2.3" });
  });
  it("parses shorthand bare", () => {
    expect(parseRef("timestamps"))
      .toEqual({ kind: "shorthand", name: "timestamps" });
  });
  it("parses legacy kaizen-plugin-* shim", () => {
    expect(parseRef("kaizen-plugin-timestamps"))
      .toEqual({ kind: "legacy-npm", name: "kaizen-plugin-timestamps" });
  });

  it.each([
    ["https://x/y.git"],
    ["http://x/y"],
    ["file:///x"],
    ["./local"],
    ["/abs/path"],
    ["../up"],
    ["@scope/pkg"],
    [""],
  ])("rejects %s", (r) => {
    expect(() => parseRef(r)).toThrow(RefParseError);
  });
});

describe("resolveRef", () => {
  const catTs: MarketplaceCatalog = {
    version: "1.0.0", name: "Official", url: "https://x.git",
    entries: [{
      kind: "plugin", name: "timestamps", description: "",
      versions: [
        { version: "1.0.0", source: { type: "file", path: "a" } },
        { version: "1.2.3", source: { type: "file", path: "a" } },
      ],
    }],
  };
  const catOther: MarketplaceCatalog = {
    version: "1.0.0", name: "Other", url: "https://o.git",
    entries: [{
      kind: "plugin", name: "timestamps", description: "",
      versions: [{ version: "1.0.0", source: { type: "file", path: "a" } }],
    }],
  };

  it("resolves marketplace-qualified to exact version", () => {
    const r = resolveRef(parseRef("official/timestamps@1.2.3"), { official: catTs });
    expect(r.marketplaceId).toBe("official");
    expect(r.version).toBe("1.2.3");
  });
  it("resolves marketplace-qualified to latest when no version", () => {
    const r = resolveRef(parseRef("official/timestamps"), { official: catTs });
    expect(r.version).toBe("1.2.3");
  });
  it("throws MarketplaceNotFoundError for unknown marketplace", () => {
    expect(() => resolveRef(parseRef("nope/x"), { official: catTs }))
      .toThrow(MarketplaceNotFoundError);
  });
  it("throws PluginNotFoundError for unknown name in marketplace", () => {
    expect(() => resolveRef(parseRef("official/missing"), { official: catTs }))
      .toThrow(PluginNotFoundError);
  });
  it("shorthand with single match auto-resolves", () => {
    const r = resolveRef(parseRef("timestamps@1.2.3"), { official: catTs });
    expect(r.marketplaceId).toBe("official");
  });
  it("shorthand ambiguous throws RefConflictError listing candidates", () => {
    expect(() => resolveRef(parseRef("timestamps"), { official: catTs, other: catOther }))
      .toThrow(RefConflictError);
  });
  it("legacy-npm resolves against 'official'", () => {
    const cat: MarketplaceCatalog = {
      version: "1.0.0", name: "Official", url: "https://x.git",
      entries: [{
        kind: "plugin", name: "timestamps", description: "",
        versions: [{ version: "1.0.0", source: { type: "npm", name: "kaizen-plugin-timestamps", version: "1.0.0" } }],
      }],
    };
    const r = resolveRef(parseRef("kaizen-plugin-timestamps"), { official: cat });
    expect(r.marketplaceId).toBe("official");
    expect(r.entry.name).toBe("timestamps");
  });
});
