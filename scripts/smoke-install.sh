#!/usr/bin/env bash
#
# scripts/smoke-install.sh — compile the binary, run it against a fresh
# KAIZEN_HOME, add the official marketplace by its git URL, install a
# plugin, and assert no errors.
#
# Catches divergence between `bun src/cli.ts` and the compiled binary.
# Run manually: bash scripts/smoke-install.sh
# Skip via:      SKIP_SMOKE=1 bash scripts/smoke-install.sh   (exits 0)
#
set -euo pipefail

if [[ "${SKIP_SMOKE:-}" == "1" ]]; then
  echo "smoke: SKIP_SMOKE=1 — skipping"
  exit 0
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$(mktemp -d)/kaizen"
HOME_DIR="$(mktemp -d)"
MARKETPLACE_URL="${KAIZEN_OFFICIAL_URL:-https://github.com/CraightonH/kaizen-official-plugins.git}"
PLUGIN_REF="${KAIZEN_SMOKE_PLUGIN:-official/core-events@0.1.0}"

cleanup() {
  rm -rf "$(dirname "$BIN")" "$HOME_DIR"
}
trap cleanup EXIT

echo "smoke: building binary → $BIN"
( cd "$REPO_DIR" && bun build --compile ./src/cli.ts --outfile "$BIN" >/dev/null )

echo "smoke: fresh KAIZEN_HOME → $HOME_DIR"
export KAIZEN_HOME_OVERRIDE="$HOME_DIR"

echo "smoke: marketplace add $MARKETPLACE_URL"
"$BIN" marketplace add "$MARKETPLACE_URL" --id official

echo "smoke: install $PLUGIN_REF"
"$BIN" install "$PLUGIN_REF" --non-interactive --allow-unscoped

# Install dir must exist.
VERSION="${PLUGIN_REF##*@}"
NAME_WITH_MP="${PLUGIN_REF%@*}"
NAME="${NAME_WITH_MP##*/}"
INSTALL_DIR="$HOME_DIR/marketplaces/official/plugins/${NAME}@${VERSION}"
if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "smoke: FAIL — install dir missing: $INSTALL_DIR" >&2
  exit 1
fi

echo "smoke: PASS"
