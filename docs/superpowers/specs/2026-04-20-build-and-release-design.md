# Build & Release Pipeline

**Status:** Draft
**Date:** 2026-04-20

## Goal

Establish an early-stage GitHub Actions pipeline for kaizen that:

1. Runs a fast test suite on every PR, but only when the change could affect
   the build artifact.
2. Runs the same suite + a full cross-platform compile on every master commit
   (same path filter) — master is always proven to build on all supported
   targets.
3. Cuts a GitHub Release on each `v*` tag, attaching compiled binaries for
   four Unix targets, an `install.sh`, and a `SHA256SUMS` manifest.

**Scope note:** Windows is not a supported target at this time. Unix-only
(macOS + Linux, both x64 and arm64). Windows support is a future effort.

The pipeline must not fire on doc-only or spec-only changes.

## Non-goals

- Windows support (no `bun-windows-*` target, no `.exe` asset). Deferred.
- Homebrew tap, npm shim, Linux packages (.deb/.rpm).
- Code signing (macOS notarization, Windows Authenticode) or supply-chain
  attestation (`gh attestation`). Revisit once the project has users.
- Auto-publishing every master commit as a prerelease. Tags gate releases.
- Branch protection / required status checks. Decoupled from CI design; can be
  enabled later.

## Workflows

Three workflows, all under `.github/workflows/`.

### `ci-pr.yml` — PR checks

**Trigger:** `pull_request` (`opened`, `synchronize`, `reopened`) targeting
`master`, gated by the shared path filter (see below).

**Concurrency:** `ci-pr-${{ github.ref }}`, `cancel-in-progress: true`.

**Job:** single `ubuntu-latest` runner:

1. `actions/checkout@v4`
2. `oven-sh/setup-bun@v2` with `bun-version: latest`
3. `bun install --frozen-lockfile`
4. `bun run typecheck`
5. `bun test`
6. `bun run test:core`
7. `bun build --compile --target=bun-linux-x64 ./src/cli.ts --outfile kaizen`
   (proves the binary still compiles; artifact discarded)

### `ci-master.yml` — master integration

**Trigger:** `push` to `master`, gated by the shared path filter.

**Concurrency:** `ci-master-${{ github.ref }}`, `cancel-in-progress: true`.

**Jobs:**

- **test** — identical to the `ci-pr.yml` job steps 1–6 (typecheck + unit +
  core).
- **build** — matrix across all four supported targets (see Build Matrix).
  `fail-fast: false` so every target's result is visible. Each compiled binary
  is uploaded as a workflow artifact for manual verification; they are not
  published anywhere.
- **build** depends on **test** passing.

### `release.yml` — tag-triggered release

**Trigger:** `push` of tags matching `v*` (e.g. `v0.1.0`, `v1.2.3-rc.1`).

**Concurrency:** not applied — tag pushes are idempotent and should never be
cancelled.

**Guard:** every job includes `if: startsWith(github.ref, 'refs/tags/v')`.
Workflow also validates the tag matches `v[0-9]+\.[0-9]+\.[0-9]+.*` and exits
with an error if not.

**Jobs:**

- **build** — same four-target matrix as `ci-master.yml`, but `fail-fast: true`.
  A broken target must abort the release; partial releases are not acceptable.
  Each job uploads its binary as a workflow artifact.
- **release** — depends on **build**. Steps:
  1. Download all binary artifacts to a single directory.
  2. Generate `SHA256SUMS` over the binaries (`sha256sum kaizen-* > SHA256SUMS`).
  3. `gh release create "$TAG" --generate-notes kaizen-* SHA256SUMS scripts/install.sh`.

## Build matrix

Used by `ci-master.yml` and `release.yml`:

| os      | arch  | runner              | bun target          | output filename           |
|---------|-------|---------------------|---------------------|---------------------------|
| darwin  | x64   | `macos-13`          | `bun-darwin-x64`    | `kaizen-darwin-x64`       |
| darwin  | arm64 | `macos-14`          | `bun-darwin-arm64`  | `kaizen-darwin-arm64`     |
| linux   | x64   | `ubuntu-latest`     | `bun-linux-x64`     | `kaizen-linux-x64`        |
| linux   | arm64 | `ubuntu-24.04-arm`  | `bun-linux-arm64`   | `kaizen-linux-arm64`      |

Each matrix job runs: checkout → setup-bun → `bun install --frozen-lockfile`
→ `bun build --compile --target=<target> ./src/cli.ts --outfile <filename>`
→ upload artifact.

## Path filter

Applied to `ci-pr.yml` and `ci-master.yml` via top-level `paths:`. Workflows
only run when a change touches any of:

```yaml
paths:
  - 'src/**'
  - 'tests/**'
  - 'scripts/build-*.sh'
  - 'scripts/build-*.ts'
  - 'scripts/install.sh'
  - 'scripts/smoke-install.sh'
  - 'package.json'
  - 'bun.lock'
  - 'tsconfig*.json'
  - '.github/workflows/ci-pr.yml'
  - '.github/workflows/ci-master.yml'
  - '.github/workflows/release.yml'
```

Deliberately excluded: `docs/**`, `**/*.md`, `plugins/**`, and every other
path not listed above.

`release.yml` does not use a path filter — tag pushes must always run.

### Interaction with branch protection

If `ci-pr` is later marked a required status check, PRs that touch only
excluded paths will have the check stay in "pending" state and be unmergeable.
The decision is deferred: branch protection stays off for now. When turned on,
either (a) remove the path filter and add a short-circuiting guard job, or
(b) use a combination of `paths-ignore` with a gate job that always reports
success.

## Installer alignment

`scripts/install.sh` must match the release asset naming and GitHub Release
layout:

- Asset filenames exactly match the **output filename** column of the build
  matrix.
- Installer URL pattern: `https://github.com/CraightonH/kaizen/releases/latest/download/kaizen-<os>-<arch>`.
- Installer downloads and verifies against `SHA256SUMS` published in the same
  release.

Implementation task must audit and patch `scripts/install.sh` to confirm these
conventions hold.

## Installer first-run bootstrap

After the binary is installed and `kaizen init --global` has run, the
installer registers the official marketplace and installs a default harness.
Plugin resolution is intentionally deferred to the binary itself — `kaizen`
auto-installs any missing plugins a harness references on first run via
`src/core/bootstrap.ts`. The installer does not pre-install plugins.

### Steps

1. Verify `git` is present on `PATH`. If missing, print a warning and skip
   the remainder of bootstrap (do not fail — binary installation has already
   succeeded, and the user can run bootstrap manually later).
2. `kaizen marketplace add https://github.com/CraightonH/kaizen-official-plugins.git --id official`
   — idempotent in the binary (early-returns if the marketplace ID already
   exists).
3. `kaizen install official/core-shell@1.0.0` — installs the harness
   artifact only; its four referenced plugins (`core-events`,
   `core-executor-shell`, `core-ui-terminal`, `core-lifecycle`) install lazily
   on first `kaizen --harness` run.

### Opt-out

- `--no-bootstrap` flag on the installer, or
- `KAIZEN_NO_BOOTSTRAP=1` environment variable.

Either skips steps 1–3. Used for CI, air-gapped environments, and testing the
installer itself.

### Failure handling

Each bootstrap step runs under a guard: a failure prints a warning naming
the command that failed plus a recovery hint ("run `kaizen marketplace add
...` manually"), then continues. Bootstrap failures never cause the
installer to exit non-zero — the binary is installed and usable.

### First-run UX

When a user first invokes `kaizen --harness official/core-shell@1.0.0`, the
binary's bootstrap code walks the harness's four plugins, prompts for
consent per plugin, and records each in the lockfile. This is by design:
the permission consent prompts are the security model. The installer must
not silence them by passing `--allow-unscoped --non-interactive`.

This is documented in the README quickstart.

## CI hygiene

- **Bun version:** `oven-sh/setup-bun@v2` with `bun-version: latest` during
  early development. A comment in each workflow notes this should be pinned to
  a specific version once the project stabilizes.
- **Install cache:** provided by `setup-bun` — no additional cache action.
- **Matrix failure semantics:** `ci-master` uses `fail-fast: false` (visibility
  over speed); `release` uses `fail-fast: true` (atomicity over visibility).
- **Secrets:** `release.yml` uses the default `GITHUB_TOKEN` with
  `permissions: { contents: write }` — no additional secrets required.

## Testing the pipeline

Validation before declaring the pipeline done:

1. Open a docs-only PR; confirm no workflows run.
2. Open a `src/**` PR; confirm `ci-pr` runs and passes.
3. Merge to master; confirm `ci-master` runs all four matrix jobs.
4. Push a `v0.0.1-test` tag to a throwaway branch; confirm `release.yml`
   produces a draft release with all four binaries, `SHA256SUMS`, and
   `install.sh`. Delete the test release and tag afterwards.
5. On a clean machine, run `curl -fsSL .../releases/latest/download/install.sh | bash`
   and confirm it downloads, verifies, and installs the binary.

## Open questions

None at spec time. Future design work (out of scope here): Homebrew tap, npm
shim, code signing, attestation, Linux package formats.
