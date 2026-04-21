# Contributing to kaizen

*Read when: you want to contribute to kaizen core (this repo, not plugins).*

For contributing **plugins or harnesses**, see
[`guides/plugin-authoring.md`](./plugin-authoring.md) and
[`guides/marketplace-authoring.md`](./marketplace-authoring.md) — plugins live
in a separate repo
([`kaizen-official-plugins`](https://github.com/CraightonH/kaizen-official-plugins)).
This guide is for changes to **kaizen itself** (the loader, event bus, host API,
resolver, CLI).

## Setup

The kaizen binary ships with zero plugins. To run it meaningfully from source
you need a sibling checkout of the official plugins repo.

```sh
# 1. Clone both repos side by side
git clone https://github.com/CraightonH/kaizen.git
git clone https://github.com/CraightonH/kaizen-official-plugins.git

# 2. Install deps
cd kaizen && bun install
cd ../kaizen-official-plugins && bun install

# 3. Seed the dev marketplace and install the default plugin set
cd ../kaizen
./scripts/dev-setup.sh
```

`scripts/dev-setup.sh` is idempotent. It registers the sibling checkout as a
local marketplace named `official` and installs the default plugin set plus
the debug harness. Override the sibling location with
`KAIZEN_PLUGINS_DIR=/path/to/checkout`.

Sanity check:

```sh
bun src/cli.ts --harness official/core-debug@1.0.0 run "hello"
```

## Running tests

kaizen uses `bun:test`.

```sh
bun test                                   # full suite
bun test src/core/plugin-loader.test.ts    # single file
bun test --watch                           # watch mode
```

Integration tests live under `tests/integration/`. The install-script smoke
test (`tests/install-sh-test.sh`) runs separately.

## Project structure

```
src/
  cli.ts              # entry point; dispatches subcommands
  host-api.ts         # authoritative plugin API surface (types + runtime values)
  core/               # loader, event bus, registry, resolver, secrets, etc.
  commands/           # one file per CLI subcommand (install, plugin-*, marketplace-*)
  types/plugin.ts     # KaizenPlugin, ToolDefinition, MarketplaceCatalog, …
  integration/        # in-repo integration helpers
  spike/              # throwaway prototypes

tests/
  fixtures/           # plugin/harness fixtures used across tests
  integration/        # integration tests (marketplace, install, etc.)

scripts/
  dev-setup.sh        # seeds ~/.kaizen for a local checkout
  install.sh          # end-user install script
  build-types-package.ts   # builds the kaizen/types virtual package

docs/                 # this tree (concepts / guides / reference / superpowers)
```

`src/host-api.ts` carries a load-bearing comment: *"Adding to the plugin API =
editing this file. This file is the authoritative, reviewable contract between
kaizen and all plugins."* Any change to what plugins can import needs to flow
through there.

## Submitting a PR

- **Branch naming:** short, kebab-case, prefixed by change type —
  `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `refactor/<topic>`, etc.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/).
  Allowed types: `feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `docs`,
  `style`, `perf`, `test`. Scope where useful:
  `feat(core): resolve session driver via lifecycle flag`.
- **Tests:** add or update tests for any behavior change. Bugs get a
  regression test.
- **Docs:** if you change behavior or the plugin/host API, update the relevant
  page under `docs/concepts/`, `docs/guides/`, or `docs/reference/` in the
  same PR.
- **PR checklist:**
  - [ ] `bun test` green
  - [ ] Docs updated (or explicitly N/A)
  - [ ] New behavior has a test; bug fix has a regression test
  - [ ] Conventional Commit subject
  - [ ] No unrelated changes

## Coding standards

- **TypeScript strict.** No `any` in new code without a comment explaining
  why. Type-only imports use `import type`.
- **File size.** Keep files around 500 LOC or less. Split when a file grows
  past that — co-locate helpers, don't create a grab-bag `utils.ts`.
- **Imports.** Inside kaizen core, import from relative paths. Plugins
  (including anything under `tests/fixtures`) must import from
  `"kaizen/types"`, never via a relative path into `src/`.
- **Registration timing.** `registerService`, `registerTool`,
  `registerExecutor`, `registerUi`, and `defineCapability` are only valid
  during `INITIALIZING` (i.e. inside a plugin's `setup()`). Anything that
  relaxes this needs design review.
- **Tests over asserts.** Fail loud in tests, not in library code. Core
  helpers should throw typed, named errors — see existing `NamedError`
  usages.

For plugin-specific rules enforced by `kaizen plugin validate`, see
[`reference/plugin-standards.md`](../reference/plugin-standards.md).
