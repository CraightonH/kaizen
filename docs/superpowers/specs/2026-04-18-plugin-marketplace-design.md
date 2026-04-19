# Design: Plugin Marketplace, Kaizen-Level Config & Install Rework

Date: 2026-04-18
Status: DRAFT
Related:
- `docs/architecture.md` (plugin resolution order, runtime layout)
- `docs/plugin-security.md` (consent + lockfile — unchanged by this spec)
- `docs/superpowers/specs/2026-04-18-unified-plugin-config-design.md` (Spec 2 — consumes `kaizen-config.ts` module introduced here)
- `docs/superpowers/specs/2026-04-18-plugin-scaffolder-standards-design.md` (Spec 3 — depends on this)
- `docs/superpowers/specs/2026-04-18-builtin-plugins-repo-decoupling-design.md` (Spec 4 — depends on this)

---

## Problem Statement

Kaizen currently has no first-class mechanism for discovering, browsing, or sharing
plugins and harnesses. Plugin "discovery" is `npm search kaizen-plugin`. Installation
is split between `kaizen install <name>` and `kaizen plugin install <pkg>` with subtly
different behaviour. There is no portable harness format that can self-bootstrap — a
shared `kaizen.json` only works if the recipient has already installed the right plugins.

This design introduces:

1. **Federated marketplaces** — any git repo containing `.kaizen/marketplace.json` is
   a kaizen marketplace. No central registry required.
2. **Marketplace-scoped plugin refs** — a unified syntax for naming plugins
   (marketplace-qualified or shorthand). Plugins are *always* resolved through a
   marketplace.
3. **Portable harnesses** — a harness file lists plugins by ref. `kaizen --harness
   <url>` bootstraps missing plugins automatically. The file is all you need.
4. **Kaizen-level config** — the existing `~/.kaizen/kaizen.json` layer gains a
   `marketplaces` slice (and more via Spec 2). File I/O is owned by a new shared
   `src/core/kaizen-config.ts` module.
5. **Unified install CLI** — `kaizen install`, `kaizen uninstall`, `kaizen update`,
   `kaizen marketplace *` replace the current fragmented surface.

---

## Design Philosophy

- **Marketplace = discovery, not trust.** Adding a marketplace does not grant any
  special trust to its plugins. Every plugin still goes through per-plugin UAC
  (the security model from `docs/plugin-security.md` is unchanged).
- **File as wire format.** A harness JSON is the portable artifact. Its URL is the
  sharable link. No install step required to try a harness.
- **One install path for everything.** There is no "ephemeral cache" vs "persistent
  install" distinction. Every marketplace lives at `~/.kaizen/marketplaces/<id>/`;
  every plugin's bits live at `~/.kaizen/marketplaces/<id>/plugins/<name>@<ver>/`;
  every installed harness at `~/.kaizen/marketplaces/<id>/harnesses/<name>/`. The
  bootstrap code path for `--harness` is the same `marketplace add` + `install`
  logic users run interactively. If a harness references a new marketplace,
  bootstrap adds it; the user sees it in `kaizen marketplace list` afterward and
  can remove it with `kaizen marketplace remove <id>`.
- **No `node_modules`.** Marketplace-installed plugins are loaded by absolute path
  from `marketplaces/<id>/plugins/<name>@<ver>/`. Node's `node_modules` resolution
  is not used for third-party plugins (builtins stay as workspace imports in the
  kaizen repo itself).
- **Refs are always marketplace-scoped.** `official/timestamps@1.2.3` is
  marketplace-qualified; `timestamps` is shorthand (resolved across added
  marketplaces). No URL, local-path, or bare-npm refs on the user surface — to ship
  a plugin, ship a marketplace (even a one-entry marketplace).
- **Marketplaces are git repos.** `kaizen marketplace add` shallow-clones.
  `kaizen marketplace update` is `git pull`. Local-path marketplaces are symlinked
  to an existing checkout (dev workflow). There is no alternate "HTTP static" or
  "raw catalog file" fetch path.
- **`official` marketplace is pre-seeded at install time.** Kaizen's installer
  configures the `official` marketplace out of the box (analogous to how Claude
  Code ships with its defaults). This spec assumes `official` is present on any
  normally-installed kaizen; kaizen-code never auto-adds it at runtime. Installer
  tooling is out of scope here — it is the installer's job to make the legacy
  `kaizen-plugin-*` shim and the default `official/*` refs resolvable.
- **Harnesses ship via marketplaces, too.** Just like plugins, the way to publish
  a harness for others is to list it as a `harness` entry in a marketplace. Raw
  URLs are not accepted on the user surface. Local file paths remain valid for
  development/CI (analogous to local-path marketplaces).
- **Catalogs index, they don't have to host.** A catalog entry points at source via
  `file` (in-repo), `tarball` (URL), or `npm` (package). The same protocol supports
  monorepo, federated-index, and single-plugin-marketplace patterns.
- **Fail-safe silent updates.** A version bump with byte-equal canonical tier/grant
  hash updates silently. Any change — even a field reorder — re-prompts. Impossible
  to mis-classify a change as safe.
- **Future-proof signing.** The catalog format reserves a `signature` field.
  Publisher signing (trust model C) is deferred — see Future Work.

---

## Scope

### In Scope

- `marketplace.json` schema (the catalog format) with a single `entries[]` list
  tagged by `kind: "plugin" | "harness"`; names unique across all entries.
- Kaizen-level config at `~/.kaizen/kaizen.json` with `marketplaces` array,
  `marketplaceUpdateTTL`, and (for Spec 2) `defaults`. File I/O lives in
  `src/core/kaizen-config.ts` (shared with Spec 2).
- Plugin ref parser (marketplace-qualified and shorthand only) and resolver
  (ref → catalog entry → `PluginSource`).
- Marketplaces as git repos: `kaizen marketplace add <url>` runs
  `git clone --depth=1` into `~/.kaizen/marketplaces/<id>/repo/`. Local paths are
  symlinked (`~/.kaizen/marketplaces/<id>/repo/` → the working checkout).
- `kaizen marketplace add|list|remove|update` commands.
- Background catalog refresh with configurable TTL (default 15 minutes = 900s);
  first command in a session triggers a non-blocking `git fetch/pull` if stale.
- `kaizen marketplace browse` (stub — tabular listing of catalog entries, no TUI).
- Revised `kaizen install <ref>` (catalog lookup, dispatches by entry `kind`).
- New `kaizen uninstall <ref>` and `kaizen update [<ref>]`.
- Canonical tier/grant hash helper (`src/core/plugin-hash.ts`) for silent-update
  eligibility.
- Bootstrap-on-startup: `kaizen --harness <file|ref>` installs missing plugins.
- Harness format extension: plugin entries are marketplace-qualified refs
  (canonical form); shorthand is accepted only at CLI input and canonicalized on
  write.
- Backward compatibility: existing `kaizen-plugin-*` bare-npm refs trigger a
  one-release deprecation shim that resolves them against the `official` marketplace.
- Unified install tree under each marketplace:
  `~/.kaizen/marketplaces/<id>/{repo,plugins/<name>@<ver>,harnesses/<name>}`.
- Plugin loader change: marketplace-installed plugins are imported by absolute
  path (`import(pluginInstallDir(id, name, ver))`). No reliance on
  `~/.kaizen/node_modules/`.
- `--trust-lockfile` and `--non-interactive` flags plumbed through the CLI parser.

### Out of Scope (deferred)

- Publisher signing / marketplace signature verification (Future Work).
- `kaizen marketplace browse` interactive TUI — stub only for v1.
- Harness versioning / harness lock files.
- Multi-version plugin side-by-side loading.
- Marketplace publication workflow (`kaizen marketplace publish`).
- Kaizen-level config beyond `marketplaces` and `marketplaceUpdateTTL` (covered by
  Spec 2).
- Non-git marketplace sources (HTTP static, raw catalog file).
- Install-from-URL / install-from-local-path / install-from-bare-npm as user refs.
- `--harness <url>`: raw URLs are rejected on the user surface. To share a harness,
  publish it as a `harness` entry in a marketplace.
- Installer tooling (pre-seeding the `official` marketplace on a fresh machine) —
  owned by packaging/install docs, not by kaizen-code.
- Batched bootstrap consent UX (per-plugin for v1).
- Local-marketplace hot-reload (symlinking a plugin's source in `repo/` directly
  into its `plugins/<name>@<ver>/` install slot). Copy-on-install for v1.

---

## Artifacts

Five artifact shapes are defined or extended by this spec. All are JSON, all are
portable by URL or filesystem path.

### 1. Marketplace Catalog (`.kaizen/marketplace.json`)

Lives at `.kaizen/marketplace.json` within a marketplace git repo.

```typescript
interface MarketplaceCatalog {
  /** Catalog schema version. */
  version: "1.0.0";
  /** Human-readable name for the marketplace. */
  name: string;
  /** Short description. */
  description?: string;
  /** Canonical git URL — the remote users add via `kaizen marketplace add`. */
  url: string;
  /** Reserved for future publisher signing. */
  signature?: string;
  /** Flat list of entries; names unique across all entries. */
  entries: MarketplaceEntry[];
}

type MarketplaceEntry = MarketplacePluginEntry | MarketplaceHarnessEntry;

interface MarketplacePluginEntry {
  kind: "plugin";
  /** kebab-case; unique across all entries in this catalog. */
  name: string;
  description: string;
  categories?: string[];
  versions: PluginVersionEntry[];
}

interface MarketplaceHarnessEntry {
  kind: "harness";
  /** Unique across all entries in this catalog. */
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
  /** Path to the harness JSON file, relative to marketplace root. */
  path: string;
  changelog?: string;
}

type PluginSource =
  | { type: "npm";     name: string;  version: string }
  | { type: "tarball"; url: string;   sha256?: string }
  | { type: "file";    path: string };  // relative to marketplace root
```

**Name uniqueness.** `name` must be unique across all entries — a plugin and a
harness cannot share a name within a single catalog. Validated at `kaizen marketplace
add` time (and on every `update`); collision is a fatal error.

**`file` source resolution.** Relative to the marketplace's **repo root** — on
disk that is `~/.kaizen/marketplaces/<id>/repo/` (either the shallow clone or a
symlink into a working checkout for local-dev marketplaces).

### 2. Marketplace Patterns

The catalog is an index; plugin source can live inside or outside the marketplace
repo. Three patterns emerge from the same protocol:

| Pattern | Sources used | Fits |
|---------|--------------|------|
| Monorepo marketplace | `file` | 5–15 tightly coupled plugins (e.g. `kaizen-sh/kaizen-plugins`) |
| Federated catalog | `tarball` / `npm` | Curated list; plugins live in author repos |
| Single-plugin marketplace | `file` or `tarball` | Plugin author's own repo with a 1-entry catalog |

A catalog may mix source types freely. Pattern choice is a marketplace author
concern — it does not affect users or the wire protocol.

### 3. Plugin Ref Syntax

A plugin ref is a string that identifies a plugin or harness. Only two shapes are
accepted.

| Form | Example | Resolves via |
|------|---------|--------------|
| Marketplace-qualified | `official/timestamps@1.2.3` | Catalog lookup in `official` |
| Shorthand             | `timestamps` or `timestamps@1.2.3` | First matching catalog (prompt if ambiguous) |

**Canonical form** (what gets written to harness files and the lockfile):
`<marketplace-id>/<name>@<version>`.

**Ambiguity resolution.** If a shorthand name matches entries in multiple added
marketplaces, `kaizen install` prompts the user to pick one. Non-interactive mode
(`--non-interactive`) fails with a `RefConflictError`.

**Dispatch by kind.** `kaizen install <ref>` looks the ref up in the catalog and
dispatches based on the matching entry's `kind` — plugin or harness. No scheme
prefix anywhere.

**Legacy shim.** Bare-npm refs matching `kaizen-plugin-*` are auto-resolved against
the `official` marketplace with a deprecation notice. The shim ships for one
release, then becomes a hard error.

**Rejected shapes.** URL (`https://...`, `http://...`, `file://...`), local paths
(`./foo`, `/abs/path`), scoped npm (`@scope/pkg`) are all rejected at parse time
with a message pointing at `kaizen marketplace create` for the intended workflow.

### 4. Harness File (extended)

The existing `kaizen.json` harness format is extended: `plugins` entries **must be
marketplace-qualified refs** in canonical `<marketplace-id>/<name>@<version>` form.
Shorthand (`timestamps`, `timestamps@1.2.3`) is accepted only at CLI input (e.g.
`kaizen install timestamps`); it is expanded to canonical form before being written
to any harness file. This keeps shipped harnesses deterministic: the same
`kaizen.json` bootstraps identically on any machine, regardless of which other
marketplaces the recipient has added.

```json
{
  "marketplaces": [
    { "id": "official", "url": "https://github.com/kaizen-sh/kaizen-plugins.git" }
  ],
  "plugins": [
    "official/timestamps@1.2.3",
    "official/godot-tools@2.0.0",
    "official/core-events@1.0.0"
  ],
  "core-executor-anthropic": {
    "model": "claude-opus-4-6",
    "api_key_env": "ANTHROPIC_API_KEY"
  }
}
```

The `marketplaces` section in a harness is **informational + bootstrap-enabling**:
it tells `kaizen --harness <file|ref>` which marketplaces the harness expects. For
any listed entry not already in `~/.kaizen/kaizen.json`, bootstrap runs the
**same code path as `kaizen marketplace add`** — shallow-clone into
`~/.kaizen/marketplaces/<id>/repo/` and append the entry to the global config.
There is no separate "ephemeral" or "session-scoped" marketplace state. The user
sees an explicit log line (`Adding marketplace <id> from <url>`) and can later
remove with `kaizen marketplace remove <id>`. This keeps the mental model
singular: every marketplace that resolves a ref is an installed, listed
marketplace.

### 5. Kaizen-Level Config (`~/.kaizen/kaizen.json`)

Existing global config layer (already present; `kaizen init --global` creates it).
This spec introduces the `marketplaces` and `marketplaceUpdateTTL` fields. Spec 2
extends the same file further with `defaults` and per-plugin config slices.

File **and directory** I/O is owned by a new shared module
**`src/core/kaizen-config.ts`** — this spec's marketplace module and Spec 2's
config module both consume it. The module owns the whole `~/.kaizen/` tree: it
exposes path helpers (`kaizenHome()`, `marketplacesDir()`, `marketplaceDir(id)`,
`marketplaceRepoDir(id)`, `pluginInstallDir(id, name, version)`,
`harnessInstallDir(id, name)`), an `ensureKaizenHome()` bootstrap that creates
`~/.kaizen/` and `~/.kaizen/marketplaces/` on first use, and the `load/save` pair
for `~/.kaizen/kaizen.json` with atomic writes. No other module reads or writes
`~/.kaizen/` directly.

```typescript
interface KaizenGlobalConfig {
  /** Added marketplaces (this spec). */
  marketplaces?: MarketplaceRef[];
  /** Default harness to run when no --harness flag or local .kaizen/kaizen.json. */
  defaultHarness?: string;
  /** Per-plugin default overrides (Spec 2). */
  defaults?: Record<string, unknown>;
  /** Seconds between background marketplace refreshes; 0 disables. Default 900. */
  marketplaceUpdateTTL?: number;
}

interface MarketplaceRef {
  /** Short identifier used in plugin refs: `<id>/plugin@ver`. */
  id: string;
  /** Git URL or local directory path. */
  url: string;
  /** ISO-8601 timestamp of last successful pull (manual or background). */
  updatedAt?: string;
}
```

---

## CLI Surface

### `kaizen marketplace` subcommands

```
kaizen marketplace add <url> [--id <id>]
```
- `<url>`: git URL, or local directory path for dev marketplaces.
- `--id <id>`: override the marketplace identifier (default: derived from URL basename).
- Git URL: creates `~/.kaizen/marketplaces/<id>/` and runs
  `git clone --depth=1 <url> ~/.kaizen/marketplaces/<id>/repo`.
- Local path: creates `~/.kaizen/marketplaces/<id>/` and a symlink
  `~/.kaizen/marketplaces/<id>/repo` → `<url>` so edits to the working checkout
  appear immediately.
- Reads `<id>/repo/.kaizen/marketplace.json`; validates schema and name uniqueness.
- Updates `~/.kaizen/kaizen.json` `marketplaces` array via `kaizen-config.ts`.

```
kaizen marketplace list
```
Shows all added marketplaces: id, URL, plugin count, harness count, last updated.

```
kaizen marketplace remove <id>
```
Removes the entry from global config and deletes the entire
`~/.kaizen/marketplaces/<id>/` tree — repo, installed plugins, and installed
harnesses from that marketplace all go. Lockfile entries for those plugins are
left in place (in case another marketplace exposes the same plugin and the user
re-installs later); `--purge-lockfile` removes them too.

```
kaizen marketplace update [<id>]
```
- Cloned marketplace: runs `git pull --depth=1 --ff-only` for one or all.
- Symlinked (local) marketplace: no-op (the working checkout is authoritative).
- Re-validates each catalog.
- Also triggered in the background when `now - updatedAt > marketplaceUpdateTTL`.

```
kaizen marketplace browse [<id>]
```
Lists catalog entries. v1: tabular output to stdout. No interactive TUI.

### `kaizen install <ref>`

Unified install command. Accepts marketplace-qualified or shorthand refs. Replaces
the split between `kaizen install <plugin>` (security flow) and `kaizen plugin
install <pkg>` (npm-only).

Flow:
1. Parse ref → `marketplace` or `shorthand`.
2. Resolve against added marketplaces + cached catalogs → matching `MarketplaceEntry`.
3. Dispatch by entry `kind`:
   - **plugin**: fetch from `source` into
     `~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/`:
     - `npm` source → `npm pack` + extract into the install dir (no global
       `node_modules` involvement).
     - `tarball` source → download + verify optional SHA-256 + extract.
     - `file` source → copy from `<id>/repo/<path>` into the install dir. Always
       a copy; symlink-based hot-reload is Future Work.
     Then run consent flow (UAC — unchanged from `plugin-security.md`) and write
     the lockfile entry (including canonical tier/grant hash).
   - **harness**: read the harness file from `<id>/repo/<path>` and write it to
     `~/.kaizen/marketplaces/<id>/harnesses/<name>/kaizen.json`. Harness plugins
     are NOT auto-installed; user runs `kaizen apply` separately or uses
     `--harness` to bootstrap.
4. If a project harness exists and this is a plugin install: add canonical ref to
   its `plugins` array.

### `kaizen uninstall <name>`

Removes a plugin:
1. Remove from project harness `plugins` array (if present).
2. If `--purge`: `rm -rf ~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/`
   and remove the lockfile entry.
3. Without `--purge`: removes from config only (installed bits and lockfile entry
   stay). Safe default — the plugin may be referenced by other harnesses.

### `kaizen update [<ref>]`

Updates one plugin (or all if no ref given):
1. Resolve latest version from marketplace catalog.
2. Compute `canonicalTierGrantHash(manifest)` for the new version (helper in
   `src/core/plugin-hash.ts`: sorted keys + sorted arrays + SHA-256 of
   `{ tier, permissions }`).
3. If hash matches stored lockfile hash → silent update (new source bits; bump
   version; keep hash).
4. If hash differs → full consent flow (UAC). Any diff in `tier` or `permissions`
   — even a field reorder — re-prompts. Fail-safe bias.

### `kaizen --harness <arg>` bootstrap

`--harness` accepts: local file path, or marketplace ref
(`official/harness-name@ver`). Raw URLs are **rejected** with the same guidance
as plugin refs — to ship a harness, publish it in a marketplace.

Bootstrap flow for a harness with missing plugins:
1. Fetch/read the harness JSON.
2. For each entry in the harness's `marketplaces` section not already in
   `~/.kaizen/kaizen.json`: run the same flow as `kaizen marketplace add`
   (clone into `~/.kaizen/marketplaces/<id>/repo/`, append config entry, log
   `Adding marketplace <id> from <url>`). Failure to clone is fatal if any plugin
   ref depends on that marketplace; otherwise a warning.
3. For each plugin ref in `plugins`: check `isInstalled(marketplaceId, name, version)`
   (from `src/core/plugin-manager.ts`). If not:
   a. Resolve via ref resolver.
   b. Run consent flow (UAC per plugin). `--non-interactive --trust-lockfile` skips
      UAC if a committed `kaizen.permissions.lock` covers the plugin.
   c. Install into `~/.kaizen/marketplaces/<id>/plugins/<name>@<version>/` (the
      same install path as interactive `kaizen install`).
4. Run kaizen with the resolved plugin stack.

Consent prompts are per-plugin for v1 (one prompt per missing plugin). Batched
summary UX is noted as Future Work.

**CI flow:**

```bash
kaizen --harness ./kaizen.json --trust-lockfile --non-interactive
```

Requires a committed `kaizen.permissions.lock` that covers all plugins. Fails fast
if any plugin is missing from the lockfile.

### Install Layout (reference)

All marketplace state, installed plugins, and installed harnesses live under a
single tree:

```
~/.kaizen/
  kaizen.json                                              # global config
  marketplaces/
    <id>/
      repo/                                                # shallow git clone or symlink
        .kaizen/marketplace.json                           # catalog
        …                                                  # marketplace repo contents
      plugins/
        <name>@<version>/                                  # installed plugin bits
      harnesses/
        <name>/
          kaizen.json                                      # installed harness
```

There is no `~/.kaizen/cache/` and no `~/.kaizen/node_modules/`. Bootstrap-added
marketplaces are indistinguishable on disk from manually-added ones and appear in
`kaizen marketplace list`. `kaizen marketplace remove <id>` is the single cleanup
verb for everything under `<id>/`.

---

## Component Architecture

### New modules

**`src/core/kaizen-config.ts`** (shared with Spec 2) — owns the entire `~/.kaizen/` tree
- `loadKaizenGlobalConfig(opts?): Promise<KaizenGlobalConfig>` — reads
  `~/.kaizen/kaizen.json`. Returns `{}` if absent.
- `saveKaizenGlobalConfig(cfg, opts?): Promise<void>` — atomic write via
  `write-to-tmp + rename`.
- `ensureKaizenHome(): Promise<void>` — creates `~/.kaizen/` and
  `~/.kaizen/marketplaces/` on first use (idempotent). Per-marketplace subdirs
  (`repo/`, `plugins/`, `harnesses/`) are created on demand by the marketplace /
  install modules.
- Path helpers (all return absolute paths; all hardcoded `~/.kaizen/` usage in
  the codebase goes through these):
  - `kaizenHome()`
  - `marketplacesDir()`
  - `marketplaceDir(id)`               → `<home>/marketplaces/<id>`
  - `marketplaceRepoDir(id)`           → `<home>/marketplaces/<id>/repo`
  - `pluginInstallDir(id, name, ver)`  → `<home>/marketplaces/<id>/plugins/<name>@<ver>`
  - `harnessInstallDir(id, name)`      → `<home>/marketplaces/<id>/harnesses/<name>`
- Owned by Spec 1; consumed by Spec 2 for its config slice and by this spec's
  marketplace + install modules for on-disk paths. No other module touches
  `~/.kaizen/` directly.

**`src/core/marketplace.ts`**
- `addMarketplace(url, id, opts?): Promise<void>` — the single entry point used
  by both `kaizen marketplace add` and `--harness` bootstrap. Creates
  `marketplaceDir(id)`, clones into `marketplaceRepoDir(id)` (or symlinks for
  local paths), validates the catalog, appends to `kaizen.json` `marketplaces[]`.
  Idempotent if the id is already added (no-op + optional `pullMarketplace`).
- `pullMarketplace(id, opts?): Promise<void>` — `git pull --depth=1 --ff-only`
  inside `marketplaceRepoDir(id)`; no-op on symlinks.
- `readCatalog(id, opts?): Promise<MarketplaceCatalog>` — reads
  `marketplaceRepoDir(id)/.kaizen/marketplace.json`. Validates.
- `validateCatalog(catalog): void` — schema check + name-uniqueness.
- `shouldRefresh(ref, ttlSeconds): boolean` — timestamp arithmetic.
- `refreshInBackground(id, opts?): void` — fire-and-forget `pullMarketplace` +
  `updatedAt` write.
- (On-disk paths are resolved via `kaizen-config.ts` path helpers; this module
  never hardcodes `~/.kaizen/` paths.)
- **Concurrency:** concurrent refreshes across multiple kaizen processes are safe.
  `git pull --ff-only` is idempotent and git's index lock serializes writes;
  callers treat git as the arbiter and do not take an additional lock.

**`src/core/ref-resolver.ts`**
- `parseRef(ref): ParsedRef` — determines `marketplace` vs `shorthand` from shape
  (presence of `/`). Rejects URL / local / scoped-npm.
- `resolveRef(parsed, catalogs): ResolvedEntry` — catalog lookup; throws
  `RefConflictError` on ambiguous shorthand, `MarketplaceNotFoundError` /
  `PluginNotFoundError` on misses.
- `ResolvedEntry = { marketplaceId; entry; version; source? }` — `source` populated
  for plugin entries.

**`src/core/plugin-hash.ts`** (extend if present, else new)
- `canonicalTierGrantHash(manifest): string` — SHA-256 of canonical serialization
  of `{ tier, permissions }` (sorted keys + sorted arrays).

**`src/core/plugin-installer.ts`** (new)
- `installPlugin(id, name, version, source, opts?): Promise<void>` — materializes
  plugin bits at `pluginInstallDir(id, name, version)`. Handles npm-pack-extract,
  tarball-download-extract, and file-copy variants. Does not touch consent or the
  lockfile — callers do that.
- `installHarness(id, name, version, pathInRepo, opts?): Promise<void>` — copies
  the harness JSON into `harnessInstallDir(id, name)/kaizen.json`.

**`src/core/plugin-loader.ts`** (new or extend the existing plugin loader)
- `loadPluginFromInstallDir(id, name, version): Promise<KaizenPlugin>` —
  resolves the absolute path via `pluginInstallDir(...)`, `import()`s it, and
  returns the plugin default export. Marketplace-installed plugins are NOT
  resolved through node `require`/`node_modules` lookup; only builtins (compiled
  into the kaizen binary / workspace) are.

**`src/core/bootstrap.ts`**
- `bootstrapMissingPlugins(harnessConfig, opts): Promise<BootstrapReport>` —
  adds any missing marketplaces (via `addMarketplace`), resolves + installs
  missing plugins, returns summary.

**`src/commands/marketplace.ts`** — `add`, `list`, `remove`, `update`, `browse`.

**`src/commands/install.ts`** (reworked) — unified install using the ref resolver.

**`src/commands/uninstall.ts`** (new).
**`src/commands/update.ts`** (new).

### Modified modules

**`src/cli.ts`**
- Wire `marketplace` subcommand (inserted before any catch-all default branch).
- Wire `install` / `uninstall` / `update` top-level commands.
- Extend `--harness` arg parsing to handle file-path and marketplace-ref shapes
  (raw URLs rejected at parse time).
- Add `--trust-lockfile` and `--non-interactive` boolean flags.
- First-invocation logic: for each added marketplace, `shouldRefresh() →
  refreshInBackground()`.

**`src/core/plugin-manager.ts`**
- Export `isInstalled(marketplaceId: string, name: string, version: string): Promise<boolean>`
  — checks `pluginInstallDir(...)` for a valid plugin. Replaces any prior
  node_modules-presence check.

**`src/commands/manage.ts`**
- `cmdPluginInstall` / `cmdPluginRemove` deprecated in favour of new commands.
  Kept but print deprecation notice; `kaizen-plugin-*` bare-npm input auto-resolves
  against `official`.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Marketplace clone fails (network / auth error) | Error with URL + git exit; exit 1 |
| Local marketplace path does not exist | Fatal: "Path <p> not found"; exit 1 |
| Catalog schema invalid | Error listing validation failures; exit 1 |
| Catalog entry name collision (plugin + harness share name) | Fatal at `marketplace add` / `update`; exit 1 |
| Shorthand ref is ambiguous | Prompt to pick marketplace (interactive) or `RefConflictError` (non-interactive) |
| Plugin not found in any marketplace | `PluginNotFoundError`: "not found in any added marketplace. Run `kaizen marketplace list`." |
| Ref is URL / local path / scoped-npm | Fatal at parse: "refs must be marketplace-qualified or shorthand; see `kaizen marketplace create`." |
| `--harness <url>` (raw URL) | Fatal at parse: "raw URL harnesses are not supported; publish the harness in a marketplace and use `--harness <id>/<name>@<ver>`." |
| Harness plugin entry is shorthand (not canonical) | Fatal: "harness plugin refs must be canonical `<marketplace>/<name>@<version>`. Run `kaizen install <name>` to canonicalize." |
| Legacy `kaizen-plugin-*` bare-npm ref | Deprecation warning; auto-resolve against `official`. Hard error in v-next. |
| Consent denied | Exit 1, no install |
| `--trust-lockfile` with missing lockfile entry | Fatal: "Plugin <name> not in lockfile. Run `kaizen install <ref>` first." |
| Harness `marketplaces` entry clone fails during bootstrap, and a plugin ref needs it | Fatal: "cannot add marketplace <id> from <url>: <git error>"; bootstrap aborts |
| Harness `marketplaces` entry clone fails, no plugin ref depends on it | Warning; bootstrap continues |
| `pullMarketplace` on symlinked marketplace | No-op (by design) |
| Background refresh failure | Logged, non-fatal; next foreground command retries |

---

## Testing

| Area | Approach |
|------|----------|
| Ref parser | Unit tests: marketplace-qualified, shorthand with/without version, legacy `kaizen-plugin-*`, ambiguous shorthand. Rejection cases: URL, local path, scoped-npm. |
| Catalog schema | Valid / invalid JSON, missing required fields, unknown `kind`, name collision across kinds. |
| `addMarketplace` / `pullMarketplace` | Use temp-dir git-repo fixtures (real git subprocess); test clone into `<id>/repo/`, pull, symlink-case no-op, idempotent re-add, failure. |
| Install layout | Each source type (`npm`, `tarball`, `file`) lands plugin bits at `marketplaces/<id>/plugins/<name>@<version>/`; harness install lands at `marketplaces/<id>/harnesses/<name>/kaizen.json`. |
| `marketplace remove` | Deletes the entire `<id>/` subtree; installed plugins and harnesses from that marketplace vanish; lockfile entries preserved (unless `--purge-lockfile`). |
| Absolute-path plugin loader | `loadPluginFromInstallDir` imports by absolute path; no `node_modules` fallback. |
| Install pipeline | Integration test with a fixture local git marketplace covering all three source types (`file`, `tarball`, `npm`). |
| Harness bootstrap | Harness with missing plugins triggers consent + install; `--trust-lockfile --non-interactive` skips UAC when lockfile covers; fails fast when it doesn't. |
| Canonical tier/grant hash | Reordered keys / reordered arrays → same hash. Any value change → different hash. Tier change → different hash. |
| Silent vs prompting update | Hash equal → no prompt, version bump only. Hash diff → consent flow fires. |
| Backward compat | Existing harness with bare `kaizen-plugin-*` names loads with deprecation warning and resolves. |
| CLI commands | `marketplace add/list/remove/update/browse` — functional tests with temp dirs. |
| Background refresh | Expired TTL → async pull fires; unexpired → no-op. Failed pull is non-fatal. |

---

## Migration

Kaizen has no external adopters yet, so there is **no on-disk migration**. Users
who have run pre-release versions can `rm -rf ~/.kaizen` and re-install cleanly
against the new layout. No migrator tooling is shipped.

CLI-surface compat:

- `kaizen install <plugin>` (current security-consent flow) is replaced by the
  new unified `kaizen install`. Bare `kaizen-plugin-*` names continue to work for
  one release with a deprecation warning, auto-resolved against `official`.
- `kaizen install https://...`, `kaizen install ./path`, and scoped-npm refs now
  error at parse time with guidance pointing at `kaizen marketplace create`.
- `kaizen plugin install <pkg>` emits a deprecation notice and delegates to
  `kaizen install`.
- `kaizen plugin remove <name>` delegates to `kaizen uninstall`.
- `kaizen.permissions.lock` schema gains the canonical tier/grant hash for new
  entries; no rewrite of pre-existing files needed (kaizen is pre-adoption).

---

## Future Work

- **Publisher signing (Trust Model C).** The `signature` field in
  `marketplace.json` is reserved. Implementation: marketplace authors sign the
  catalog with a key; `kaizen marketplace add --trust-key <key>` imports a public
  key; plugins from signed marketplaces install without UAC for TRUSTED tier.
  Deferred — public marketplaces require per-plugin UAC regardless of signing.
- **Batched bootstrap consent.** `--harness` with many missing plugins currently
  prompts per plugin. A batched "12 plugins to add: 3 TRUSTED / 7 SCOPED / 2
  UNSCOPED — approve all TRUSTED? [y/N]" UX is a post-v1 refactor.
- **`kaizen marketplace browse` TUI.** Interactive fuzzy-search browse + install in
  the terminal. Deferred post-v1.
- **Marketplace publishing workflow.** `kaizen marketplace publish` (or a separate
  CI action) validates a marketplace repo, generates the catalog, and opens a PR.
- **Multi-version side-by-side.** Currently the install model assumes one version
  per plugin name. Future: version-namespaced installs for testing.
- **Local-marketplace hot-reload.** `file`-source installs from a symlinked
  marketplace could symlink `<id>/plugins/<name>@<ver>/` directly to the source
  in `<id>/repo/<path>/` instead of copying, so edits to plugin source reflect
  without reinstall.
