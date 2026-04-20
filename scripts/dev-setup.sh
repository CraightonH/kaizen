#!/usr/bin/env bash
#
# scripts/dev-setup.sh — seed ~/.kaizen/ with the sibling kaizen-official-plugins
# checkout so `kaizen run` works from source without pulling from the network.
#
# Idempotent. Uses only the public `kaizen marketplace` and `kaizen install` commands.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SIBLING="${KAIZEN_PLUGINS_DIR:-$(cd "$REPO_DIR/.." && pwd)/kaizen-official-plugins}"
KAIZEN="${KAIZEN:-bun $REPO_DIR/src/cli.ts}"

if [[ ! -d "$SIBLING" ]]; then
  cat >&2 <<EOF
error: sibling kaizen-official-plugins checkout not found at:
  $SIBLING

Clone it alongside this repo:
  git clone https://github.com/CraightonH/kaizen-official-plugins.git $SIBLING

Or set KAIZEN_PLUGINS_DIR to an existing checkout.
EOF
  exit 1
fi

echo "→ sibling checkout: $SIBLING"

# 1. Add the local marketplace as 'official' (no-op if already added).
if $KAIZEN marketplace list 2>/dev/null | awk '{print $1}' | grep -qx "official"; then
  echo "→ marketplace 'official' already registered"
else
  echo "→ registering marketplace 'official' → $SIBLING"
  $KAIZEN marketplace add "$SIBLING" --id official
fi

# 2. Install the default plugin set + the debug harness.
DEFAULT_PLUGINS=(
  "official/core-events@0.1.0"
  "official/core-lifecycle@0.1.0"
  "official/core-ui-terminal@0.1.0"
  "official/core-cli@0.1.0"
  "official/core-plugin-manager@0.1.0"
  "official/core-executor-debug@0.1.0"
  "official/timestamps@0.1.0"
)
DEFAULT_HARNESS="official/core-debug@1.0.0"

for ref in "${DEFAULT_PLUGINS[@]}" "$DEFAULT_HARNESS"; do
  echo "→ installing $ref"
  $KAIZEN install "$ref" --non-interactive --allow-unscoped
done

echo
echo "✓ dev setup complete"
echo "  Try: $KAIZEN --harness official/core-debug@1.0.0 run 'hello'"
