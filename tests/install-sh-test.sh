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

# --- Test 4: bootstrap invokes expected kaizen commands ----------------------
btmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "$btmp"' EXIT

# Fake kaizen: records each invocation's argv to a log file, always exits 0.
mkdir -p "$btmp/bin"
cat > "$btmp/bin/kaizen" <<'FAKE'
#!/usr/bin/env bash
echo "kaizen $*" >> "$KAIZEN_FAKE_LOG"
FAKE
chmod +x "$btmp/bin/kaizen"

KAIZEN_FAKE_LOG="$btmp/log" PATH="$btmp/bin:$PATH" bash -c '
  set -euo pipefail
  # shellcheck source=/dev/null
  source "$1"
  bootstrap
' _ "$INSTALLER" || fail "bootstrap errored"

expected_market="kaizen marketplace add https://github.com/CraightonH/kaizen-official-plugins.git --id official"
expected_install="kaizen install official/claude-wrapper"

grep -Fxq "$expected_market" "$btmp/log" || fail "bootstrap did not run: $expected_market"
grep -Fxq "$expected_install" "$btmp/log" || fail "bootstrap did not run: $expected_install"
pass "bootstrap invokes marketplace add + harness install"

# --- Test 5: KAIZEN_NO_BOOTSTRAP=1 skips bootstrap ---------------------------
: > "$btmp/log"
KAIZEN_NO_BOOTSTRAP=1 KAIZEN_FAKE_LOG="$btmp/log" PATH="$btmp/bin:$PATH" bash -c '
  set -euo pipefail
  # shellcheck source=/dev/null
  source "$1"
  bootstrap
' _ "$INSTALLER" || fail "bootstrap with KAIZEN_NO_BOOTSTRAP errored"
[ ! -s "$btmp/log" ] || fail "bootstrap ran commands when KAIZEN_NO_BOOTSTRAP=1"
pass "KAIZEN_NO_BOOTSTRAP=1 skips bootstrap"

# --- Test: ensure_bun no-ops when bun on PATH ---------------------------------
out="$(bash -c '
  set -euo pipefail
  # Stub PATH with a fake bun.
  tmp="$(mktemp -d)"
  cat > "$tmp/bun" <<EOF
#!/bin/sh
exit 0
EOF
  chmod +x "$tmp/bun"
  PATH="$tmp:$PATH" HOME="$tmp" KAIZEN_NO_BUN=0
  export PATH HOME KAIZEN_NO_BUN
  # shellcheck source=/dev/null
  source "$1"
  ensure_bun
  rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (PATH hit) errored: $out"

echo "$out" | grep -q "bun already installed" || fail "ensure_bun (PATH hit) did not detect bun on PATH: $out"
pass "ensure_bun no-ops when bun on PATH"

# --- Test: ensure_bun no-ops when ~/.bun/bin/bun exists -----------------------
out="$(bash -c '
  set -euo pipefail
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/.bun/bin"
  cat > "$tmp/.bun/bin/bun" <<EOF
#!/bin/sh
exit 0
EOF
  chmod +x "$tmp/.bun/bin/bun"
  # Empty PATH so command -v bun fails.
  PATH="/nonexistent-empty-path" HOME="$tmp"
  export PATH HOME
  # shellcheck source=/dev/null
  source "$1"
  ensure_bun
  /bin/rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (~/.bun fallback) errored: $out"

echo "$out" | grep -q "bun found at ~/.bun/bin/bun" || fail "ensure_bun did not detect ~/.bun/bin/bun: $out"
pass "ensure_bun no-ops when ~/.bun/bin/bun exists"

# --- Test: KAIZEN_NO_BUN=1 skips ensure_bun ----------------------------------
out="$(bash -c '
  set -euo pipefail
  tmp="$(mktemp -d)"
  PATH="/nonexistent-empty-path" HOME="$tmp" KAIZEN_NO_BUN=1
  export PATH HOME KAIZEN_NO_BUN
  # shellcheck source=/dev/null
  source "$1"
  ensure_bun
  /bin/rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (NO_BUN) errored: $out"

echo "$out" | grep -q "Skipping bun install (KAIZEN_NO_BUN=1)" || fail "KAIZEN_NO_BUN=1 was not respected: $out"
pass "ensure_bun skipped via KAIZEN_NO_BUN=1"

# --- Test: ensure_bun installer failure does not abort -----------------------
out="$(bash -c '
  set -euo pipefail
  tmp="$(mktemp -d)"
  # Stub: an empty PATH dir + a failing curl shadow.
  stub="$tmp/stub"
  mkdir -p "$stub"
  cat > "$stub/curl" <<EOF
#!/bin/sh
exit 1
EOF
  chmod +x "$stub/curl"
  PATH="$stub" HOME="$tmp"
  export PATH HOME
  # shellcheck source=/dev/null
  source "$1"
  # Should not abort despite curl failing.
  ensure_bun
  echo "AFTER_ENSURE_BUN"
  /bin/rm -rf "$tmp"
' _ "$INSTALLER" 2>&1)" || fail "ensure_bun (failure path) aborted the script: $out"

echo "$out" | grep -q "AFTER_ENSURE_BUN" || fail "ensure_bun failure aborted execution: $out"
echo "$out" | grep -q "bun install failed" || fail "ensure_bun did not warn on failure: $out"
pass "ensure_bun installer failure does not abort"

echo "OK"
