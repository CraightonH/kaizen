# Marketplace Authoring Guide

*Read when: you want to publish a marketplace so others can install your plugins.*

For the design rationale behind the marketplace format and resolution rules,
see
[`superpowers/specs/2026-04-18-plugin-marketplace-design.md`](../superpowers/specs/2026-04-18-plugin-marketplace-design.md).
For the exact type definitions, see
[`reference/plugin-api.md`](../reference/plugin-api.md#marketplace-types) or
[`src/types/plugin.ts`](../../src/types/plugin.ts).

## What is a marketplace

A marketplace is a directory — local or backed by a git URL — that kaizen
resolves plugin and harness references against. It contains a
`.kaizen/marketplace.json` catalog, optional in-tree `plugins/` and
`harnesses/` directories, and whatever else you want to ship alongside.

When a user runs `kaizen install <marketplace-id>/<plugin>[@<version>]`, kaizen
reads the marketplace catalog, resolves the version entry, and fetches the
plugin source from the declared `source` (npm, tarball, or in-repo file).

The catalog follows the `MarketplaceCatalog` type:

```ts
interface MarketplaceCatalog {
  version: "1.0.0";
  name: string;
  description?: string;
  url: string;
  signature?: string;     // reserved; unused in v1
  entries: MarketplaceEntry[];
}
```

Each `MarketplaceEntry` is either a `MarketplacePluginEntry`
(`kind: "plugin"`) or a `MarketplaceHarnessEntry` (`kind: "harness"`). Both
carry `name`, `description`, optional `categories`, and a `versions[]` array.

## Scaffold

```sh
kaizen marketplace create <target-dir>
```

Interactive prompts: marketplace name, description, URL (where the
marketplace is served from — used for discovery, not resolution). Add
`--defaults` for a non-interactive scaffold.

The generator writes:

```
<target-dir>/
  .kaizen/marketplace.json   # empty catalog (entries: [])
  plugins/.gitkeep           # for in-repo plugin sources
  harnesses/.gitkeep         # for in-repo harness files
  README.md
```

## Catalog format

A minimal catalog with one plugin entry and one harness entry:

```json
{
  "version": "1.0.0",
  "name": "acme",
  "description": "Acme Corp plugins for kaizen.",
  "url": "https://github.com/acme/kaizen-marketplace",
  "entries": [
    {
      "kind": "plugin",
      "name": "echo",
      "description": "Echoes text back.",
      "categories": ["util"],
      "versions": [
        {
          "version": "0.1.0",
          "source": { "type": "file", "path": "plugins/echo" },
          "minKaizenVersion": "1.4.0"
        }
      ]
    },
    {
      "kind": "harness",
      "name": "debug",
      "description": "Minimal debug harness.",
      "versions": [
        { "version": "0.1.0", "path": "harnesses/debug/kaizen.json" }
      ]
    }
  ]
}
```

Plugin `source` can take three forms:

```ts
type PluginSource =
  | { type: "npm";     name: string; version: string }
  | { type: "tarball"; url: string;  sha256?: string }
  | { type: "file";    path: string };   // relative to marketplace repo root
```

`minKaizenVersion` must be a bare semver (e.g. `"1.4.0"`), not a range. If the
user's kaizen is older, `kaizen install` refuses the install with a clear
message.

Harness entries reference an in-tree `kaizen.json` via `path` (relative to the
marketplace root). Every plugin ref inside a harness must be the canonical
`<marketplace>/<name>[@<version>]` form — bare names are rejected.

## Validate

```sh
kaizen marketplace validate <marketplace-dir>
```

Checks the catalog parses as `MarketplaceCatalog`, entries have valid
`kind` / `name` / `versions`, source types are recognized, referenced in-tree
paths exist, and `minKaizenVersion` is a bare semver. Exit `0` on pass, non-zero
on failure. Run it before every release.

## Publishing and sharing

Consumers add your marketplace with:

```sh
kaizen marketplace add <url> [--id <id>]
```

`<url>` can be:

- A **git URL** (`https://…/marketplace.git` or `git@…`). kaizen clones it
  under `~/.kaizen/marketplaces/<id>/` and refreshes periodically.
- An **absolute local directory** — useful for developing a marketplace
  against a local kaizen checkout.

If `--id` is omitted, kaizen derives one from the URL. The id is what
consumers type in plugin refs: `my-marketplace/my-plugin@1.0.0`.

Harnesses reference the marketplace the same way. A `kaizen.json`:

```json
{
  "plugins": [
    "acme/echo@0.1.0"
  ]
}
```

Or users can install a published harness directly:

```sh
kaizen install acme/debug@0.1.0
```

## Versioning

Every version in `versions[]` is a bare semver string. Follow standard semver:

- **Patch** (`0.1.0` → `0.1.1`): bug fixes, no behavior change.
- **Minor** (`0.1.0` → `0.2.0`): new features, backwards-compatible.
- **Major** (`0.1.0` → `1.0.0`): breaking changes to tool signatures, config
  schema, required capabilities, or permission tier.

To release a new version: add a new entry to the plugin's `versions[]` array
(don't rewrite old ones — users may still be pinned), run
`kaizen marketplace validate`, and publish. Optionally fill in `changelog` on
the version entry.

Bump `minKaizenVersion` when you start using newer host-API surface; users on
older kaizen will see a blocking error at install time rather than a confusing
runtime failure.
