import type {
  MarketplaceCatalog, MarketplaceEntry, MarketplacePluginEntry,
  PluginVersionEntry,
} from "../types/plugin.js";

export type ParsedRef =
  | { kind: "marketplace"; marketplaceId: string; name: string; version?: string }
  | { kind: "shorthand";   name: string;          version?: string }
  | { kind: "legacy-npm";  name: string };           // kaizen-plugin-*

export interface ResolvedEntry {
  marketplaceId: string;
  entry: MarketplaceEntry;
  version: string;
  /** Present when entry.kind === "plugin". */
  pluginVersion?: PluginVersionEntry;
}

export class RefParseError extends Error { constructor(msg: string) { super(msg); this.name = "RefParseError"; } }
export class RefConflictError extends Error {
  constructor(public name: string, public candidates: string[]) {
    super(`ref '${name}' is ambiguous across marketplaces: ${candidates.join(", ")}. ` +
          `Use the marketplace-qualified form, e.g. ${candidates[0]}/${name}.`);
    this.name = "RefConflictError";
  }
}
export class MarketplaceNotFoundError extends Error {
  constructor(public marketplaceId: string) {
    super(`marketplace '${marketplaceId}' is not added. Run \`kaizen marketplace list\`.`);
    this.name = "MarketplaceNotFoundError";
  }
}
export class PluginNotFoundError extends Error {
  constructor(public name: string, marketplaceId?: string) {
    super(marketplaceId
      ? `plugin '${name}' not found in marketplace '${marketplaceId}'.`
      : `plugin '${name}' not found in any added marketplace.`);
    this.name = "PluginNotFoundError";
  }
}

const LEGACY_PREFIX = "kaizen-plugin-";

export function parseRef(ref: string): ParsedRef {
  if (!ref) throw new RefParseError("empty ref");

  // Rejections first — URL / local / scoped-npm.
  if (/^https?:\/\//i.test(ref) || ref.startsWith("file://")) {
    throw new RefParseError(rejectMsg(ref, "raw URL"));
  }
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/")) {
    throw new RefParseError(rejectMsg(ref, "local path"));
  }
  if (ref.startsWith("@")) {
    throw new RefParseError(rejectMsg(ref, "scoped npm package"));
  }

  // Legacy kaizen-plugin-* shim — no '/' or '@' allowed except the name itself.
  if (ref.startsWith(LEGACY_PREFIX) && !ref.includes("/")) {
    return { kind: "legacy-npm", name: splitAt(ref).name };
  }

  const slash = ref.indexOf("/");
  if (slash >= 0) {
    const id = ref.slice(0, slash);
    const tail = ref.slice(slash + 1);
    if (!id || !tail) throw new RefParseError(`invalid ref '${ref}'`);
    const { name, version } = splitAt(tail);
    return { kind: "marketplace", marketplaceId: id, name, ...(version !== undefined ? { version } : {}) };
  }

  const { name, version } = splitAt(ref);
  return { kind: "shorthand", name, ...(version !== undefined ? { version } : {}) };
}

function splitAt(s: string): { name: string; version?: string } {
  const at = s.indexOf("@");
  if (at < 0) return { name: s };
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

function rejectMsg(ref: string, what: string): string {
  return `ref '${ref}' rejected: ${what} is not a supported ref form. ` +
         `Refs must be marketplace-qualified (<id>/<name>[@<version>]) or shorthand (<name>[@<version>]). ` +
         `To ship a plugin, publish it in a marketplace (\`kaizen marketplace add <url>\`).`;
}

export function resolveRef(
  parsed: ParsedRef,
  catalogs: Record<string, MarketplaceCatalog>,
): ResolvedEntry {
  if (parsed.kind === "marketplace") {
    const cat = catalogs[parsed.marketplaceId];
    if (!cat) throw new MarketplaceNotFoundError(parsed.marketplaceId);
    return pickEntry(parsed.marketplaceId, cat, parsed.name, parsed.version);
  }

  if (parsed.kind === "legacy-npm") {
    const cat = catalogs["official"];
    if (!cat) throw new MarketplaceNotFoundError("official");
    // Strip the `kaizen-plugin-` prefix; match against the catalog name.
    const short = parsed.name.slice(LEGACY_PREFIX.length);
    return pickEntry("official", cat, short, undefined);
  }

  // shorthand — search every catalog.
  const hits: Array<{ id: string; resolved: ResolvedEntry }> = [];
  for (const [id, cat] of Object.entries(catalogs)) {
    try {
      hits.push({ id, resolved: pickEntry(id, cat, parsed.name, parsed.version) });
    } catch (e) {
      if (e instanceof PluginNotFoundError) continue;
      throw e;
    }
  }
  if (hits.length === 0) throw new PluginNotFoundError(parsed.name);
  if (hits.length > 1) throw new RefConflictError(parsed.name, hits.map((h) => h.id));
  return hits[0]!.resolved;
}

function pickEntry(
  id: string, cat: MarketplaceCatalog, name: string, version: string | undefined,
): ResolvedEntry {
  const entry = cat.entries.find((e) => e.name === name);
  if (!entry) throw new PluginNotFoundError(name, id);

  const versions = entry.kind === "plugin"
    ? (entry as MarketplacePluginEntry).versions.map((v) => v.version)
    : entry.versions.map((v) => v.version);

  const chosen = version ?? pickLatestSemver(versions);
  if (!versions.includes(chosen)) {
    throw new PluginNotFoundError(`${name}@${chosen}`, id);
  }

  const result: ResolvedEntry = { marketplaceId: id, entry, version: chosen };
  if (entry.kind === "plugin") {
    result.pluginVersion = entry.versions.find((v) => v.version === chosen)!;
  }
  return result;
}

/** Naive semver: split by '.', numeric compare. Good enough for v1. */
function pickLatestSemver(versions: string[]): string {
  return [...versions].sort((a, b) => cmpSemver(b, a))[0]!;
}
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
