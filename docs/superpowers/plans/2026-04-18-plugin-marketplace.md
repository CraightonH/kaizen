# Plugin Marketplace, Kaizen-Level Config & Install Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement federated marketplaces, polymorphic plugin refs, portable
harness bootstrap, and a unified install CLI. After this plan, `kaizen marketplace
add <url>` adds a catalog, `kaizen install official/timestamps@1.0.0` installs from
it, and `kaizen --harness <url>` bootstraps missing plugins automatically.

**Spec:** `docs/superpowers/specs/2026-04-18-plugin-marketplace-design.md`

**Tech Stack:** TypeScript, Bun, existing `src/core/` infrastructure,
`src/commands/` pattern.

**Prerequisites:** None (this is the first-domino spec).

---

## File Structure

**New files:**
- `src/core/marketplace.ts` — kaizen-level config I/O + catalog fetch/cache
- `src/core/marketplace.test.ts`
- `src/core/ref-resolver.ts` — plugin ref parser + resolver
- `src/core/ref-resolver.test.ts`
- `src/commands/marketplace.ts` — add/list/remove/update/browse subcommands
- `src/commands/uninstall.ts` — unified uninstall
- `src/commands/update.ts` — unified update

**Modified files:**
- `src/types/plugin.ts` — add `MarketplaceRef`, `MarketplaceCatalog`, `PluginSource` types; extend harness `KaizenConfig` with `marketplaces` field
- `src/commands/install.ts` — rework to use ref resolver; deprecate old path
- `src/commands/manage.ts` — deprecation notices on `cmdPluginInstall`/`cmdPluginRemove`
- `src/cli.ts` — wire new subcommands; extend `--harness` bootstrap

---

## Phase 1 — Types & Catalog Schema

### Task 1: Define marketplace types

**Files:** `src/types/plugin.ts`

- [ ] **Step 1: Add `PluginSource` union type**

```typescript
export type PluginSource =
  | { type: "npm";     name: string;  version: string }
  | { type: "git";     url: string;   ref: string }
  | { type: "tarball"; url: string;   sha256?: string }
  | { type: "file";    path: string };
```

- [ ] **Step 2: Add `MarketplacePluginEntry`, `MarketplaceHarnessEntry`, `MarketplaceCatalog`**

```typescript
export interface PluginVersionEntry {
  version: string;
  source: PluginSource;
  changelog?: string;
  minKaizenVersion?: string;
}

export interface HarnessVersionEntry {
  version: string;
  path: string;
  changelog?: string;
}

export interface MarketplacePluginEntry {
  name: string;
  description: string;
  categories?: string[];
  versions: PluginVersionEntry[];
}

export interface MarketplaceHarnessEntry {
  name: string;
  description: string;
  categories?: string[];
  versions: HarnessVersionEntry[];
}

export interface MarketplaceCatalog {
  version: "1.0.0";
  name: string;
  description?: string;
  url: string;
  signature?: string;
  plugins: MarketplacePluginEntry[];
  harnesses: MarketplaceHarnessEntry[];
}
```

- [ ] **Step 3: Add `MarketplaceRef` and extend global config**

```typescript
export interface MarketplaceRef {
  id: string;
  url: string;
  updatedAt?: string;
}

export interface KaizenGlobalConfig {
  marketplaces?: MarketplaceRef[];
  defaultHarness?: string;
  defaults?: Record<string, unknown>;
}
```

- [ ] **Step 4: Extend the harness config type to allow `marketplaces` field**

In `src/core/config.ts`, extend the harness config shape to allow an optional
`marketplaces: MarketplaceRef[]` field.

---

## Phase 2 — Ref Parser

### Task 2: Implement `src/core/ref-resolver.ts`

- [ ] **Step 1: Define `ParsedRef` discriminated union**

```typescript
export type ParsedRef =
  | { kind: "marketplace"; id: string;  name: string; version?: string }
  | { kind: "shorthand";               name: string; version?: string }
  | { kind: "local";       path: string }
  | { kind: "url";         url: string }
  | { kind: "npm";         name: string; version?: string };
```

- [ ] **Step 2: Implement `parseRef(ref: string): ParsedRef`**

Detection rules (in order):
1. Starts with `./` or `/` → `local`
2. Starts with `https://` or `http://` → `url`
3. Contains `/` and does not look like a scoped npm package (`@scope/name`) →
   split on first `/`, left is `id`, right is `name@version` → `marketplace`
4. No `/` → check for `@version` suffix → `shorthand` (may be npm name without `/`)

- [ ] **Step 3: Implement `resolveRef(parsed, marketplaces, catalogs): ResolvedSource`**

```typescript
export interface ResolvedSource {
  source: PluginSource;
  marketplaceId?: string;
  pluginName: string;
  version: string;
}
```

Resolution logic:
- `marketplace`: look up `id` in `catalogs`, find entry by `name`, resolve version
  (latest if not specified, exact if specified). Throw `MarketplaceNotFoundError` or
  `PluginNotFoundError` as appropriate.
- `shorthand`: search all catalogs. If zero matches: try as npm package. If one match:
  return it. If multiple matches: throw `RefConflictError` listing the marketplaces.
- `local`: return `{ type: "file", path: ... }`.
- `url`: return `{ type: "tarball", url: ... }`.
- `npm`: return `{ type: "npm", name, version: version ?? "latest" }`.

- [ ] **Step 4: Write `src/core/ref-resolver.test.ts`**

Tests:
- `parseRef` for each form including edge cases (`@scope/pkg`, `market/name@1.0`,
  bare name, `./path`, absolute path, HTTPS URL).
- `resolveRef` marketplace found, not found, ambiguous shorthand, local, URL, npm.

---

## Phase 3 — Marketplace Config & Catalog I/O

### Task 3: Implement `src/core/marketplace.ts`

- [ ] **Step 1: `loadGlobalConfig()` and `saveGlobalConfig()`**

Read/write `~/.kaizen/kaizen.json`. Handle file-not-found (return empty config).

- [ ] **Step 2: `fetchCatalog(url: string): Promise<MarketplaceCatalog>`**

Detection:
- Local path (starts with `./`, `/`, or `file://`): read `.kaizen/marketplace.json`
  from the directory.
- Git URL (ends in `.git` or matches GitHub URL pattern): use GitHub raw content API
  (`https://raw.githubusercontent.com/<user>/<repo>/HEAD/.kaizen/marketplace.json`)
  for HTTPS GitHub URLs. For other git URLs, fall back to `git archive` subprocess
  call: `git archive --remote=<url> HEAD .kaizen/marketplace.json`.
- Validate result against `MarketplaceCatalog` schema (Zod or manual).
- Throw descriptive errors for network failures, missing file, schema errors.

- [ ] **Step 3: `getCachedCatalog(id)` and `writeCachedCatalog(id, catalog)`**

Cache path: `~/.kaizen/marketplaces/<id>/marketplace.json`. Create dirs as needed.

- [ ] **Step 4: Write `src/core/marketplace.test.ts`**

Mock filesystem + HTTP. Test: fetch from local path, fetch from GitHub URL, cache
read/write, invalid schema, file not found.

---

## Phase 4 — `kaizen marketplace` Commands

### Task 4: Implement `src/commands/marketplace.ts`

- [ ] **Step 1: `cmdMarketplaceAdd(url, idOverride?)`**

1. Derive `id` from URL basename if no override.
2. Check `id` not already in global config (warn if updating).
3. Call `fetchCatalog(url)`.
4. Call `writeCachedCatalog(id, catalog)`.
5. Update `loadGlobalConfig()`, push `{ id, url, updatedAt }`, `saveGlobalConfig()`.
6. Print: `Added marketplace 'official' (42 plugins, 3 harnesses).`

- [ ] **Step 2: `cmdMarketplaceList()`**

Load global config, read each cached catalog, print table:
```
  ID        PLUGINS  HARNESSES  UPDATED
  official       42          3  2026-04-18
  my-internal    12          1  2026-04-17
```

- [ ] **Step 3: `cmdMarketplaceRemove(id)`**

Remove from global config, delete `~/.kaizen/marketplaces/<id>/`. Confirm if
`--force` not set.

- [ ] **Step 4: `cmdMarketplaceUpdate(id?)`**

Re-fetch for one or all marketplaces. Print diff of plugin/harness count.

- [ ] **Step 5: `cmdMarketplaceBrowse(id?)`**

Print all plugin entries (from cached catalog) in a table. Filter by `id` if given.
v1: stdout only.

---

## Phase 5 — Unified Install

### Task 5: Rework `src/commands/install.ts`

- [ ] **Step 1: Replace `runInstall` with `runUnifiedInstall(ref, opts)`**

```typescript
interface InstallOpts {
  lockfilePath: string;
  allowUnscoped: boolean;
  nonInteractive: boolean;
  ephemeral?: boolean;   // install to cache instead of node_modules
}
```

Flow:
1. Load global config + all cached catalogs.
2. `parseRef(ref)` → `resolveRef(parsed, marketplaces, catalogs)` → `ResolvedSource`.
3. Fetch plugin source to a temp dir (npm install, git clone, HTTP fetch, or local
   path as-is).
4. Read `KaizenPlugin` default export from the fetched source.
5. Run existing consent flow (`runInstall` internals — reuse or inline).
6. Install: if `ephemeral`, copy to `~/.kaizen/cache/<hash>/`; else npm install to
   `~/.kaizen/node_modules/`.
7. Write lockfile entry.
8. If project config exists and not ephemeral: add canonical ref to `plugins` array
   in `.kaizen/kaizen.json`.

- [ ] **Step 2: Deprecation shims in `src/commands/manage.ts`**

`cmdPluginInstall` prints:
```
Note: 'kaizen plugin install' is deprecated. Use 'kaizen install <ref>' instead.
```
Then delegates to `runUnifiedInstall`.

---

## Phase 6 — Uninstall & Update

### Task 6: `src/commands/uninstall.ts`

- [ ] **Step 1: `runUninstall(name, opts: { purge: boolean })`**

1. Remove from `.kaizen/kaizen.json` plugins array (if present).
2. If `--purge`: npm uninstall from `~/.kaizen/node_modules/`; delete lockfile entry.
3. Print result.

### Task 7: `src/commands/update.ts`

- [ ] **Step 1: `runUpdate(ref?, opts)`**

1. If no ref: update all plugins in `.kaizen/kaizen.json`.
2. Resolve current version from lockfile.
3. Resolve latest available from catalog or npm.
4. If version changed: re-run consent flow, install, update lockfile.
5. If tier/grants unchanged and only version changed: silent update.

---

## Phase 7 — Harness Bootstrap

### Task 8: Bootstrap-on-startup in `src/cli.ts`

- [ ] **Step 1: Extend `--harness` arg to accept marketplace ref and URL**

Current: only file path. New: detect form, fetch if URL/marketplace ref.

- [ ] **Step 2: Implement `bootstrapMissingPlugins(harnessConfig, opts)`**

```
For each plugin ref in harnessConfig.plugins:
  1. Check if already installed (existing isInstalled() check).
  2. If not installed:
     a. Resolve ref.
     b. Run consent flow (skip if --trust-lockfile covers it).
     c. Install (to node_modules if interactive, cache if ephemeral URL harness).
  3. Continue to next plugin.
```

If any consent is denied: fatal with a summary of what was denied.
If `--non-interactive --trust-lockfile`: fail fast if any plugin missing from lockfile.

- [ ] **Step 3: Temporary marketplace registration from harness `marketplaces` section**

If harness has a `marketplaces` array, register each entry temporarily (in-memory)
for this run. Do not write to `~/.kaizen/kaizen.json`.

---

## Phase 8 — Wire CLI

### Task 9: Update `src/cli.ts`

- [ ] **Step 1: Add `kaizen marketplace` subcommand routing**

```typescript
if (subcommand === "marketplace") {
  const sub = rawArgs[1];
  // route to cmdMarketplaceAdd / List / Remove / Update / Browse
}
```

- [ ] **Step 2: Add `kaizen uninstall <ref>` routing**

- [ ] **Step 3: Add `kaizen update [<ref>]` routing**

- [ ] **Step 4: Update `kaizen install` routing** to use `runUnifiedInstall`.

- [ ] **Step 5: Update `kaizen --harness` path** to call `bootstrapMissingPlugins`
before `bootstrap(kaizenConfig, builtins)`.

---

## Phase 9 — Tests & Integration

### Task 10: Integration tests

- [ ] **Step 1: End-to-end: local marketplace**

Create a temp local marketplace dir with a `file`-source plugin. Run:
1. `kaizen marketplace add <dir>` — catalog loaded.
2. `kaizen install local-market/test-plugin` — plugin installed, lockfile written.
3. `kaizen marketplace list` — shows the marketplace.
4. `kaizen uninstall test-plugin --purge` — plugin removed.

- [ ] **Step 2: Backward compatibility**

Existing harness file with `"plugins": ["core-events", "core-executor-anthropic"]`
(bare npm names) loads without modification. Verify no errors or deprecation noise.

- [ ] **Step 3: Bootstrap test**

Write a harness JSON referencing a local marketplace plugin. Run `kaizen --harness
<file>` with missing plugin — bootstrap triggers consent + install, then kaizen starts.

---

## Phase 10 — Docs

### Task 11: Documentation updates

- [ ] Update `docs/architecture.md` — kaizen-level config, marketplace resolution in
  plugin resolution order.
- [ ] Update `README.md` — add `kaizen marketplace` to commands reference.
- [ ] Add marketplace section to `docs/plugin-api.md` — "Installing from a marketplace".
