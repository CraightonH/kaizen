# Build & Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three GitHub Actions workflows (PR, master, release) and align `scripts/install.sh` with the release asset conventions defined in the spec.

**Architecture:** Workflows gate on a shared path filter so docs-only changes skip CI. PR runs a fast single-target check; master runs the same check plus a five-target matrix compile; `v*` tags trigger a matrix build + `gh release create` with binaries, `SHA256SUMS`, and `install.sh`. The installer learns to verify against the new checksum manifest and uses the new asset naming.

**Tech Stack:** GitHub Actions, Bun (`bun build --compile`), Bash, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-04-20-build-and-release-design.md`

---

## File Structure

- Create: `.github/workflows/ci-pr.yml` — PR checks (typecheck, unit, core, single-target compile).
- Create: `.github/workflows/ci-master.yml` — master integration: PR suite + 5-target matrix compile.
- Create: `.github/workflows/release.yml` — tag-triggered 5-target matrix + GitHub Release.
- Modify: `scripts/install.sh` — update asset naming (`kaizen-<os>-<arch>`), download `SHA256SUMS`, verify checksum before install.
- Create: `tests/install-sh-test.sh` — shell test covering platform detection, asset naming, checksum verification.

Workflows are independent files by concern (PR vs master vs release). The installer change is a localized patch, kept small and testable via the new shell test.

---

## Task 1: PR workflow

**Files:**
- Create: `.github/workflows/ci-pr.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci-pr.yml
# Runs on PRs to master when build-affecting files change. See
# docs/superpowers/specs/2026-04-20-build-and-release-design.md for rationale.
name: ci-pr

on:
  pull_request:
    branches: [master]
    types: [opened, synchronize, reopened]
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

concurrency:
  group: ci-pr-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # NOTE: bun-version is 'latest' during early development. Pin to a
      # specific version once the project stabilizes.
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - run: bun run typecheck

      - run: bun test

      - run: bun run test:core

      - name: Compile (linux-x64)
        run: bun build --compile --target=bun-linux-x64 ./src/cli.ts --outfile kaizen
```

- [ ] **Step 2: Lint the YAML locally**

Run: `bun x --bun actionlint .github/workflows/ci-pr.yml 2>/dev/null || docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest ci-pr.yml || true`

If neither tool is available, skip — a syntax error will surface the first time the workflow runs. Read the file once more and confirm:
- `paths:` list matches the spec verbatim.
- `concurrency.cancel-in-progress` is `true`.
- Every step has either `uses:` or `run:`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci-pr.yml
git commit -m "ci: add PR workflow (typecheck + test + single-target compile)"
```

---

## Task 2: Master workflow

**Files:**
- Create: `.github/workflows/ci-master.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci-master.yml
# Runs on every master push touching build-affecting files. Proves master
# compiles on all five supported targets. No publish.
name: ci-master

on:
  push:
    branches: [master]
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

concurrency:
  group: ci-master-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test
      - run: bun run test:core

  build:
    needs: test
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: darwin
            arch: x64
            runner: macos-13
            target: bun-darwin-x64
            outfile: kaizen-darwin-x64
          - os: darwin
            arch: arm64
            runner: macos-14
            target: bun-darwin-arm64
            outfile: kaizen-darwin-arm64
          - os: linux
            arch: x64
            runner: ubuntu-latest
            target: bun-linux-x64
            outfile: kaizen-linux-x64
          - os: linux
            arch: arm64
            runner: ubuntu-24.04-arm
            target: bun-linux-arm64
            outfile: kaizen-linux-arm64
          - os: windows
            arch: x64
            runner: windows-latest
            target: bun-windows-x64
            outfile: kaizen-windows-x64.exe
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Compile ${{ matrix.target }}
        run: bun build --compile --target=${{ matrix.target }} ./src/cli.ts --outfile ${{ matrix.outfile }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.outfile }}
          path: ${{ matrix.outfile }}
          if-no-files-found: error
```

- [ ] **Step 2: Re-read and verify**

Confirm:
- Matrix has all 5 entries with the exact runner/target/outfile from the spec's build-matrix table.
- `fail-fast: false` (visibility over speed on master).
- `needs: test` — build runs only if test passed.
- Windows outfile has `.exe` suffix.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci-master.yml
git commit -m "ci: add master workflow (test + 5-target matrix compile)"
```

---

## Task 3: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/release.yml
# Tag-triggered release. Compiles all 5 targets, generates SHA256SUMS, and
# publishes a GitHub Release with binaries + install.sh.
name: release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  validate-tag:
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - name: Validate tag format
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          if ! echo "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+.*$'; then
            echo "Tag '$tag' does not match v<major>.<minor>.<patch>[-suffix]" >&2
            exit 1
          fi
          echo "tag=$tag" >> "$GITHUB_OUTPUT"
        id: validate

  build:
    needs: validate-tag
    if: startsWith(github.ref, 'refs/tags/v')
    strategy:
      fail-fast: true
      matrix:
        include:
          - os: darwin
            arch: x64
            runner: macos-13
            target: bun-darwin-x64
            outfile: kaizen-darwin-x64
          - os: darwin
            arch: arm64
            runner: macos-14
            target: bun-darwin-arm64
            outfile: kaizen-darwin-arm64
          - os: linux
            arch: x64
            runner: ubuntu-latest
            target: bun-linux-x64
            outfile: kaizen-linux-x64
          - os: linux
            arch: arm64
            runner: ubuntu-24.04-arm
            target: bun-linux-arm64
            outfile: kaizen-linux-arm64
          - os: windows
            arch: x64
            runner: windows-latest
            target: bun-windows-x64
            outfile: kaizen-windows-x64.exe
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Compile ${{ matrix.target }}
        run: bun build --compile --target=${{ matrix.target }} ./src/cli.ts --outfile ${{ matrix.outfile }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.outfile }}
          path: ${{ matrix.outfile }}
          if-no-files-found: error

  release:
    needs: build
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: actions/checkout@v4

      - name: Download all binaries
        uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Generate SHA256SUMS
        working-directory: dist
        run: sha256sum kaizen-* > SHA256SUMS

      - name: Stage install.sh
        run: cp scripts/install.sh dist/install.sh

      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          gh release create "$tag" \
            --generate-notes \
            dist/kaizen-* \
            dist/SHA256SUMS \
            dist/install.sh
```

- [ ] **Step 2: Re-read and verify**

Confirm:
- `fail-fast: true` on release build (atomicity).
- Tag format regex accepts `v0.1.0`, `v1.2.3-rc.1`, rejects `v1`, `1.0.0`.
- `permissions: contents: write` scoped to the workflow.
- `sha256sum` globs `kaizen-*` (not the whole dir — skips SHA256SUMS itself).
- `gh release create` uses `$tag` from `GITHUB_REF`, not a hardcoded value.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow (tag-triggered, 5-target, SHA256SUMS)"
```

---

## Task 4: Shell test for installer

**Files:**
- Create: `tests/install-sh-test.sh`

This test exercises the installer's platform detection, asset naming, and
checksum verification against a local fake "release" directory. No network.

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bash
# tests/install-sh-test.sh
# Exercises scripts/install.sh platform detection, asset naming, and
# checksum verification against a local fake release directory.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# --- Test 1: platform detection produces kaizen-<os>-<arch> ------------------
got="$(bash -c '
  set -euo pipefail
  # shellcheck source=/dev/null
  source "$1"; detect_platform
' _ "$INSTALLER" <<<"")" || fail "detect_platform errored"

case "$got" in
  kaizen-linux-x64|kaizen-linux-arm64|kaizen-darwin-x64|kaizen-darwin-arm64)
    pass "detect_platform returned '$got'"
    ;;
  *)
    fail "detect_platform returned unexpected value '$got'"
    ;;
esac

# --- Test 2: checksum verification passes on matching hash -------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "hello" > "$tmp/kaizen-linux-x64"
(cd "$tmp" && sha256sum kaizen-linux-x64 > SHA256SUMS)

bash -c '
  set -euo pipefail
  # shellcheck source=/dev/null
  source "$1"
  verify_checksum "$2/kaizen-linux-x64" "$2/SHA256SUMS" "kaizen-linux-x64"
' _ "$INSTALLER" "$tmp" || fail "verify_checksum rejected matching hash"
pass "verify_checksum accepts matching hash"

# --- Test 3: checksum verification rejects mismatched hash -------------------
echo "tampered" > "$tmp/kaizen-linux-x64"
if bash -c '
  set -euo pipefail
  # shellcheck source=/dev/null
  source "$1"
  verify_checksum "$2/kaizen-linux-x64" "$2/SHA256SUMS" "kaizen-linux-x64"
' _ "$INSTALLER" "$tmp" 2>/dev/null; then
  fail "verify_checksum accepted mismatched hash"
fi
pass "verify_checksum rejects mismatched hash"

echo "OK"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/install-sh-test.sh`

Expected: FAIL — sourcing `install.sh` currently re-runs `main "$@"` at the
bottom (it tries to reach the network and invoke sudo), `detect_platform`
returns `bun-linux-x64` style, and `verify_checksum` does not exist yet.
Task 5 adds a sourcing guard and fixes the other two issues.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/install-sh-test.sh
chmod +x tests/install-sh-test.sh
git add tests/install-sh-test.sh
git commit -m "test: add installer shell test (failing)"
```

---

## Task 5: Patch installer to match release naming

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Update platform detection to emit `kaizen-<os>-<arch>`**

Replace the body of `detect_platform` in `scripts/install.sh` with:

```bash
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      case "$arch" in
        x86_64)  echo "kaizen-linux-x64" ;;
        aarch64) echo "kaizen-linux-arm64" ;;
        *) die "unsupported Linux architecture: $arch" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64)  echo "kaizen-darwin-x64" ;;
        arm64)   echo "kaizen-darwin-arm64" ;;
        *) die "unsupported macOS architecture: $arch" ;;
      esac
      ;;
    *) die "unsupported OS: $os" ;;
  esac
}
```

- [ ] **Step 2: Add checksum verification helper**

Add this function in `scripts/install.sh`, placed immediately below the
existing `download()` helper:

```bash
verify_checksum() {
  local file="$1" sums="$2" name="$3"
  local expected actual
  expected="$(grep " ${name}$" "$sums" | awk '{print $1}')"
  [ -n "$expected" ] || die "no checksum for ${name} in SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    die "neither sha256sum nor shasum found"
  fi
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${name} (expected ${expected}, got ${actual})"
}
```

- [ ] **Step 3: Rewrite `main` to use new naming and verify checksum**

Replace the `main()` function in `scripts/install.sh` with:

```bash
main() {
  bold "kaizen installer"
  echo ""

  local version="${VERSION:-}"
  if [ -z "$version" ]; then
    info "Fetching latest release..."
    version="$(latest_release_tag)"
  fi
  info "Version: $version"

  local asset_name
  asset_name="$(detect_platform)"
  info "Asset:   $asset_name"

  local base_url="https://github.com/${REPO}/releases/download/${version}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  info "Downloading ${asset_name}..."
  download "${base_url}/${asset_name}" "${tmpdir}/${asset_name}"

  info "Downloading SHA256SUMS..."
  download "${base_url}/SHA256SUMS" "${tmpdir}/SHA256SUMS"

  info "Verifying checksum..."
  verify_checksum "${tmpdir}/${asset_name}" "${tmpdir}/SHA256SUMS" "${asset_name}"
  green "  ✓ Checksum OK"

  chmod +x "${tmpdir}/${asset_name}"

  if [ -w "$INSTALL_DIR" ]; then
    mv "${tmpdir}/${asset_name}" "${INSTALL_DIR}/${BINARY}"
  else
    info "Requesting sudo to install to ${INSTALL_DIR}..."
    sudo mv "${tmpdir}/${asset_name}" "${INSTALL_DIR}/${BINARY}"
  fi

  green "  ✓ Installed ${BINARY} → ${INSTALL_DIR}/${BINARY}"

  local global_config="${KAIZEN_HOME}/kaizen.json"
  if [ ! -f "$global_config" ]; then
    info "Setting up ~/.kaizen/..."
    mkdir -p "$KAIZEN_HOME"
    "${INSTALL_DIR}/${BINARY}" init --global
    green "  ✓ Created ${global_config}"
  else
    info "~/.kaizen/kaizen.json already exists, skipping init."
  fi

  echo ""
  bold "Done!"
  echo ""
  info "Quick start:"
  info "  kaizen --harness core-anthropic          # use built-in Anthropic harness"
  info "  kaizen init                              # create .kaizen/kaizen.json in current project"
  info "  kaizen install <harness-url-or-name>     # extend a harness"
  info "  kaizen plugin install <npm-package>      # add a plugin"
  echo ""
  info "ANTHROPIC_API_KEY must be set for core-anthropic harness."
}
```

- [ ] **Step 4: Guard `main` so sourcing doesn't execute the installer**

Replace the final line of `scripts/install.sh` (currently `main "$@"`) with:

```bash
# Only run main if the script is executed directly, not sourced. Lets tests
# source the file to unit-test individual helpers.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bash tests/install-sh-test.sh`

Expected output:
```
PASS: detect_platform returned 'kaizen-linux-x64'  (or darwin/arm64 variant)
PASS: verify_checksum accepts matching hash
PASS: verify_checksum rejects mismatched hash
OK
```

- [ ] **Step 6: Commit**

```bash
git add scripts/install.sh
git commit -m "feat(installer): match release asset naming, verify SHA256SUMS"
```

---

## Task 6: End-to-end validation

This task is manual — CI workflows can only be fully verified against GitHub.
Do not push until all previous tasks have been committed and the PR workflow
lints cleanly.

- [ ] **Step 1: Push a branch and open a docs-only PR**

Create a throwaway branch with only a `docs/` or `README.md` edit. Push, open
PR against master.

Expected: no workflow runs trigger. The PR has zero checks.

Close the PR without merging. Delete the branch.

- [ ] **Step 2: Push a branch and open a src-touching PR**

Create a throwaway branch with a trivial `src/` edit (e.g. add a comment).
Push, open PR.

Expected: `ci-pr` runs, all steps pass, single linux-x64 compile succeeds.

Close the PR without merging. Delete the branch.

- [ ] **Step 3: Merge this plan's implementation PR to master**

Once the real PR (workflows + installer) lands on master, verify:
- `ci-master` triggers automatically.
- All 5 matrix jobs complete successfully.
- Artifacts are present in the workflow run.

If any target fails, debug before attempting a tag.

- [ ] **Step 4: Cut a test release**

Push a `v0.0.0-pipeline-test` tag:

```bash
git tag v0.0.0-pipeline-test
git push origin v0.0.0-pipeline-test
```

Expected:
- `release.yml` runs.
- All 5 binaries compile.
- GitHub Release is created at `v0.0.0-pipeline-test` containing 5 binaries,
  `SHA256SUMS`, and `install.sh`.

- [ ] **Step 5: Verify installer end-to-end**

On a fresh linux or darwin machine (or Docker container):

```bash
curl -fsSL https://github.com/CraightonH/kaizen/releases/download/v0.0.0-pipeline-test/install.sh | VERSION=v0.0.0-pipeline-test bash
kaizen --version
```

Expected: downloads, verifies checksum, installs to `/usr/local/bin/kaizen`,
and prints version output.

- [ ] **Step 6: Clean up the test release**

```bash
gh release delete v0.0.0-pipeline-test --yes --cleanup-tag
```

- [ ] **Step 7: Mark the build-and-release rollout complete**

No additional commits. The presence of working workflows on master + a clean
test release is the done signal.
