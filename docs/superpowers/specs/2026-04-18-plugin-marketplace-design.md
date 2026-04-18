# Design: Plugin Marketplace, Kaizen-Level Config & Install Rework

Date: 2026-04-18
Status: APPROVED
Related:
- `docs/architecture.md` (plugin resolution order, runtime layout)
- `docs/plugin-security.md` (consent + lockfile — unchanged by this spec)
- `docs/superpowers/specs/2026-04-18-unified-plugin-config-design.md` (Spec 2 — depends on this)
- `docs/superpowers/specs/2026-04-18-plugin-scaffolder-standards-design.md` (Spec 3 — depends on this)
- `docs/superpowers/specs/2026-04-18-builtin-plugins-repo-decoupling-design.md` (Spec 4 — depends on this)

---

## Problem Statement

Kaizen currently has no first-class mechanism for discovering, browsing, or sharing
plugins and harnesses. Plugin "discovery" is `npm search kaizen-plugin`. Installation is
a split between `kaizen install <name>` and `kaizen plugin install <pkg>` with subtly
different behaviour. There is no portable harness format that can self-bootstrap — a
shared `kaizen.json` only works if the recipient has already installed the right plugins.

This design introduces:

1. **Federated marketplaces** — any git repo or local directory containing
   `.kaizen/marketplace.json` is a kaizen marketplace. No central registry required.
2. **Polymorphic plugin refs** — a unified syntax for naming plugins across all ref
   types (marketplace-qualified, npm, local path, URL).
3. **Portable harnesses** — a harness file lists plugins by ref. `kaizen --harness
   <url>` bootstraps missing plugins automatically. The file is all you need.
4. **Kaizen-level config** — a new `~/.kaizen/kaizen.json` layer for global settings
   (added marketplaces, defaults). Separate from per-project harness config.
5. **Unified install CLI** — `kaizen install`, `kaizen uninstall`, `kaizen update`,
   `kaizen marketplace *` replace the current fragmented surface.

---

## Design Philosophy

- **Marketplace = discovery, not trust.** Adding a marketplace does not grant any
  special trust to its plugins. Every plugin still goes through per-plugin UAC
  (the security model from `docs/plugin-security.md` is unchanged).
- **File as wire format.** A harness JSON is the portable artifact. Its URL is the
  sharable link. No install step required to try a harness.
- **Install vs ephemeral.** Installed plugins persist to `~/.kaizen/node_modules/`.
  Ephemeral (from `--harness <url>`) fetches to `~/.kaizen/cache/` and can be GC'd.
- **Ref syntax is obvious from shape.** `official/timestamps@1.2.3` is marketplace-
  qualified. `./my-plugin` is local. `https://...` is a URL. No explicit scheme
  prefix required for the common cases.
- **Future-proof signing.** The catalog format reserves a `signature` field.
  Publisher signing (trust model C) is deferred — see Future Work.

---

## Scope

### In Scope

- `marketplace.json` schema (the catalog format).
- Kaizen-level config at `~/.kaizen/kaizen.json` (marketplaces array, defaults).
- Plugin ref parser and resolver (all ref shapes → resolved install source).
- `kaizen marketplace add|list|remove|update` commands.
- `kaizen marketplace browse` (stub — lists catalog entries, no interactive TUI).
- Revised `kaizen install <ref>` covering plugin and harness refs.
- New `kaizen uninstall <ref>` and `kaizen update [<ref>]`.
- Bootstrap-on-startup: `kaizen --harness <file|url|ref>` installs missing plugins.
- Harness format extension: plugin entries accept any ref shape.
- Backward compatibility: bare plugin names in existing harnesses treated as npm refs.
- Cache directory (`~/.kaizen/cache/`) for ephemeral fetches.
- Marketplace catalog cache (`~/.kaizen/marketplaces/<id>/marketplace.json`).
- Lazy marketplace repo cloning: only clone full repo for `file`-source plugin installs.

### Out of Scope (deferred)

- Publisher signing / marketplace signature verification (Future Work section).
- `kaizen marketplace browse` interactive TUI — stub only for v1.
- Harness versioning / harness lock files.
- Multi-version plugin side-by-side loading.
- Marketplace publication workflow (`kaizen marketplace publish`).
- Kaizen-level config beyond `marketplaces` and `defaults` (covered by Spec 2).

---

## Artifacts

Four file types are defined or extended by this spec. All are JSON, all are portable
by URL or filesystem path.

### 1. Marketplace Catalog (`.kaizen/marketplace.json`)

Lives at `.kaizen/marketplace.json` within a marketplace repo or directory.

```typescript
interface MarketplaceCatalog {
  /** Catalog schema version. */
  version: "1.0.0";
  /** Human-readable name for the marketplace. */
  name: string;
  /** Short description. */
  description?: string;
  /** Canonical URL — the git remote or HTTPS URL users add via `kaizen marketplace add`. */
  url: string;
  /** Reserved for future publisher signing. */
  signature?: string;
  /** Plugin entries. */
  plugins: MarketplacePluginEntry[];
  /** Harness entries. */
  harnesses: MarketplaceHarnessEntry[];
}

interface MarketplacePluginEntry {
  /** Short name within this marketplace. kebab-case. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Category tags (e.g. "executor", "ui", "tool", "dev"). */
  categories?: string[];
  /** Published versions, newest first. */
  versions: PluginVersionEntry[];
}

interface MarketplaceHarnessEntry {
  /** Short name within this marketplace. */
  name: string;
  description: string;
  categories?: string[];
  versions: HarnessVersionEntry[];
}

interface PluginVersionEntry {
  version: string;             // semver
  source: PluginSource;
  changelog?: string;
  minKaizenVersion?: string;   // semver range
}

interface HarnessVersionEntry {
  version: string;
  /** Path (relative to marketplace root) or URL to the harness JSON file. */
  path: string;
  changelog?: string;
}

type PluginSource =
  | { type: "npm";     name: string;  version: string }
  | { type: "git";     url: string;   ref: string }
  | { type: "tarball"; url: string;   sha256?: string }
  | { type: "file";    path: string };  // relative to marketplace root
```

**`file` source resolution:** relative to the marketplace's root directory. For a
git-backed marketplace this is the repo root (the clone dir). For a local filesystem
marketplace this is the directory passed to `kaizen marketplace add`.

### 2. Plugin Ref Syntax

A plugin ref is a string that identifies a plugin (or harness). The form is inferred
from its shape — no explicit scheme prefix required.

| Form | Example | Resolves via |
|------|---------|-------------|
| Marketplace-qualified | `official/timestamps@1.2.3` | Catalog lookup |
| Marketplace shorthand | `timestamps` or `timestamps@1.2.3` | First matching marketplace (prompt if ambiguous) |
| Local path | `./my-plugin` or `/abs/path` | Filesystem |
| URL | `https://example.com/plugin.tgz` | HTTP fetch |
| npm package (legacy) | `kaizen-plugin-timestamps@1.2.3` | npm resolution |

**Canonical form** (what gets written to harness files and the lockfile):
`<marketplace-id>/<name>@<version>` for marketplace refs. Other forms are stored
verbatim.

**Ambiguity resolution:** if a shorthand name matches entries in multiple added
marketplaces, `kaizen install` prompts the user to pick one. Non-interactive mode
(`--non-interactive`) fails with an error.

### 3. Harness File (extended)

The existing `kaizen.json` harness format is extended: `plugins` entries now accept
any ref shape. Existing bare names continue to work (treated as npm refs).

```json
{
  "marketplaces": [
    { "id": "official", "url": "https://github.com/kaizen-sh/marketplace.git" }
  ],
  "plugins": [
    "official/timestamps@1.2.3",
    "official/godot-tools@2.0.0",
    "./local-dev-plugin",
    "https://example.com/my-plugin.tgz",
    "core-events"
  ],
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  }
}
```

The `marketplaces` section in a harness is **informational + bootstrap-enabling**:
it tells `kaizen --harness <url>` which marketplaces to add (if not already added)
so that marketplace-qualified refs in `plugins` can be resolved. Kaizen adds them
temporarily for the bootstrap run; users must explicitly run `kaizen marketplace add`
to persist them globally.

### 4. Kaizen-Level Config (`~/.kaizen/kaizen.json`)

New global config layer. Already partially exists (created by `kaizen init --global`);
this spec extends its schema.

```typescript
interface KaizenGlobalConfig {
  /** Added marketplaces. */
  marketplaces?: MarketplaceRef[];
  /** Default harness to run when no --harness flag or local .kaizen/kaizen.json. */
  defaultHarness?: string;
  /** Other future global settings. */
  defaults?: Record<string, unknown>;
}

interface MarketplaceRef {
  /** Short identifier used in plugin refs: `<id>/plugin@ver`. */
  id: string;
  /** Git URL or local directory path. */
  url: string;
  /** Timestamp of last successful `kaizen marketplace update`. */
  updatedAt?: string;
}
```

---

## CLI Surface

### `kaizen marketplace` subcommands

```
kaizen marketplace add <url> [--id <id>]
```
- `<url>`: git URL or local path. HTTPS GitHub URLs auto-detected.
- `--id <id>`: override the marketplace identifier (default: derived from URL basename).
- Fetches `.kaizen/marketplace.json` from the source (single-file fetch for git,
  direct read for local). Validates schema. Writes to `~/.kaizen/marketplaces/<id>/`.
- Updates `~/.kaizen/kaizen.json` `marketplaces` array.

```
kaizen marketplace list
```
Shows all added marketplaces: id, URL, plugin count, harness count, last updated.

```
kaizen marketplace remove <id>
```
Removes from global config and deletes cached catalog. Does not uninstall plugins.

```
kaizen marketplace update [<id>]
```
Re-fetches `.kaizen/marketplace.json` for one or all marketplaces.

```
kaizen marketplace browse [<id>]
```
Lists catalog entries. v1: tabular output to stdout. No interactive TUI.

### `kaizen install <ref>`

Unified install command. Accepts any ref shape. Replaces the split between
`kaizen install <plugin>` (security flow) and `kaizen plugin install <pkg>` (npm-only).

Flow:
1. Parse ref → determine type.
2. Resolve to a `PluginSource` (catalog lookup, or direct for path/URL/npm refs).
3. Fetch manifest (read `KaizenPlugin` default export).
4. Run consent flow (existing UAC — unchanged from `docs/plugin-security.md`).
5. Install to `~/.kaizen/node_modules/` (npm) or appropriate location.
6. Write lockfile entry.
7. Add plugin name to `.kaizen/kaizen.json` `plugins` array (if project config exists).

**Harness install:** `kaizen install harness:<ref>` fetches a harness JSON and writes
it to `~/.kaizen/harnesses/<name>/kaizen.json`. The harness's plugins are NOT
auto-installed — user runs `kaizen apply` separately, or uses `--harness` to bootstrap.

### `kaizen uninstall <name>`

Removes a plugin:
1. Remove from `.kaizen/kaizen.json` `plugins` array.
2. If `--purge`: npm uninstall from `~/.kaizen/node_modules/`, remove lockfile entry.
3. Without `--purge`: removes from config only (plugin stays installed, lockfile entry
   stays). Safe default — the plugin may be referenced by other harnesses.

### `kaizen update [<ref>]`

Updates one plugin (or all if no ref given):
1. Resolve latest version from marketplace catalog (or npm dist-tag for npm refs).
2. If version changed: re-run consent flow (grant changes require explicit re-consent;
   same tier + same grants → silent update with new lockfile hash).
3. Install new version.

### `kaizen --harness <arg>` bootstrap

`--harness` now accepts: file path, marketplace ref (`official/harness-name@ver`), or
URL.

Bootstrap flow for a harness with missing plugins:
1. Fetch/read the harness JSON.
2. If harness has a `marketplaces` section, register those marketplaces for this
   session (without persisting to global config).
3. For each plugin ref in `plugins`: check if installed. If not:
   a. Resolve via ref resolver.
   b. Fetch manifest.
   c. Run consent flow (UAC per plugin). `--non-interactive --trust-lockfile` skips
      UAC if a committed `kaizen.permissions.lock` covers the plugin.
   d. Install (to `~/.kaizen/node_modules/` if interactive, to `~/.kaizen/cache/` if
      ephemeral — see Ephemeral Cache).
4. Run kaizen with the resolved plugin stack.

**CI flow:**
```bash
kaizen --harness ./kaizen.json --trust-lockfile --non-interactive
```
Requires a committed `kaizen.permissions.lock` that covers all plugins. Fails fast
if any plugin is missing from the lockfile.

### Ephemeral Cache

`~/.kaizen/cache/` holds fetched assets for `--harness <url>` runs that have not been
explicitly installed. Subdirs by content hash. GC policy: entries older than 30 days
with no recent access are candidates for removal. `kaizen cache clean [--all]` manual
GC (future command, not part of this spec).

---

## Component Architecture

### New modules

**`src/core/marketplace.ts`**
- `loadMarketplaceConfig(): KaizenGlobalConfig` — reads `~/.kaizen/kaizen.json`.
- `saveMarketplaceConfig(cfg)` — writes global config.
- `fetchCatalog(url): MarketplaceCatalog` — single-file fetch for git URLs (GitHub
  raw API, or `git archive`); direct read for local paths. Validates against schema.
- `getCachedCatalog(id): MarketplaceCatalog | null` — reads from
  `~/.kaizen/marketplaces/<id>/marketplace.json`.
- `writeCachedCatalog(id, catalog)` — persists fetched catalog.

**`src/core/ref-resolver.ts`**
- `parseRef(ref: string): ParsedRef` — determines ref type from shape.
- `resolveRef(parsed: ParsedRef, marketplaces: MarketplaceRef[]): ResolvedSource` —
  catalog lookup, npm resolution, or direct source.
- `RefConflictError` — thrown when a shorthand ref matches multiple marketplaces.

**`src/commands/marketplace.ts`**
- Implements `add`, `list`, `remove`, `update`, `browse` subcommands.

**`src/commands/install.ts`** (reworked)
- Unified install using ref resolver. Replaces current `runInstall`.

**`src/commands/uninstall.ts`** (new)
**`src/commands/update.ts`** (new)

### Modified modules

**`src/cli.ts`**
- Wire new `marketplace` subcommand.
- Wire new `install` / `uninstall` / `update` top-level commands.
- Extend `--harness` arg parsing to handle all ref shapes.
- Bootstrap-on-startup logic.

**`src/commands/manage.ts`**
- `cmdPluginInstall` / `cmdPluginRemove` deprecated in favour of new commands.
  Kept but print deprecation notice.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Marketplace fetch fails (network error) | Error with URL + status; exit 1 |
| Catalog schema invalid | Error listing validation failures; exit 1 |
| Shorthand ref is ambiguous | Prompt to pick marketplace (interactive) or error (non-interactive) |
| Plugin not found in any marketplace | Error "not found in any added marketplace. Run `kaizen marketplace list`." |
| Consent denied | Exit 1, no install |
| `--trust-lockfile` with missing lockfile entry | Fatal: "Plugin <name> not in lockfile. Run `kaizen install <ref>` first." |
| Harness `marketplaces` ref fetch fails during bootstrap | Warning; bootstrap continues using already-added marketplaces |

---

## Testing

| Area | Approach |
|------|----------|
| Ref parser | Unit tests for all forms: marketplace-qualified, shorthand, local, URL, npm, ambiguous |
| Catalog schema | Valid / invalid JSON, missing required fields, unknown entry types |
| `fetchCatalog` | Mock git raw API, local FS, network error |
| Install pipeline | Integration test with a mock marketplace and all source types |
| Harness bootstrap | Harness with missing plugins triggers consent + install; `--trust-lockfile` skips UAC |
| Backward compat | Existing harness with bare npm names loads without modification |
| CLI commands | `marketplace add/list/remove/update/browse` — functional tests with temp dirs |

---

## Migration

- `kaizen install <plugin>` (current security-consent flow) is replaced by the new
  unified `kaizen install`. Existing invocations continue to work; the ref `<plugin>`
  is treated as an npm ref.
- `kaizen plugin install <pkg>` emits a deprecation notice and delegates to `kaizen
  install`.
- `kaizen plugin remove <name>` delegates to `kaizen uninstall`.
- Existing `kaizen.permissions.lock` files are unchanged.
- Existing `~/.kaizen/kaizen.json` (if present) gains the `marketplaces` and
  `defaults` fields lazily on next write. Old format is valid (fields are optional).

---

## Future Work

- **Publisher signing (Trust Model C).** The `signature` field in `marketplace.json`
  is reserved. Implementation: marketplace authors sign the catalog with a key;
  `kaizen marketplace add --trust-key <key>` imports a public key; plugins from
  signed marketplaces install without UAC for TRUSTED tier. Deferred — public
  marketplaces require per-plugin UAC regardless of signing.
- **`kaizen marketplace browse` TUI.** Interactive fuzzy-search browse + install in
  the terminal. Deferred post-v1.
- **Marketplace publishing workflow.** `kaizen marketplace publish` (or a separate CI
  action) validates a marketplace repo, generates the catalog, and opens a PR.
- **HTTP-hosted static marketplaces.** Support `https://host/` as a marketplace ref
  (fetches `/.kaizen/marketplace.json`). Currently out of scope to avoid breaking
  the "points at a directory, not a file" contract.
- **Multi-version side-by-side.** Currently the install model assumes one version per
  plugin name. Future: version-namespaced installs for testing.
