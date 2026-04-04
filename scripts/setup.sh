#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# kaizen dev environment setup
# Safe to run multiple times — each step is idempotent.
# Run as your normal user: ./scripts/setup.sh
# Do NOT run as root/sudo — sudo is used internally only where required.
# ---------------------------------------------------------------------------

if [[ "${EUID}" -eq 0 ]]; then
  echo "Do not run this script as root." >&2
  echo "Run it as your normal user: ./scripts/setup.sh" >&2
  echo "It will prompt for sudo only where needed (apt-get)." >&2
  exit 1
fi

BUN_MIN_VERSION="1.1.0"

log()  { echo "[setup] $*"; }
ok()   { echo "[setup] ✓ $*"; }
fail() { echo "[setup] ✗ $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. System prerequisites (unzip required by Bun installer)
# ---------------------------------------------------------------------------
if ! command -v unzip &>/dev/null; then
  log "unzip not found — installing via apt (requires sudo)..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y unzip
  elif command -v brew &>/dev/null; then
    brew install unzip
  else
    fail "Cannot install unzip — install it manually and re-run setup."
  fi
  ok "unzip installed"
else
  ok "unzip"
fi

# ---------------------------------------------------------------------------
# 1. Bun
# ---------------------------------------------------------------------------
install_bun() {
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # The installer appends to ~/.bashrc / ~/.zshrc but won't affect the
  # current shell — source the env file directly so bun is usable immediately.
  BUN_ENV="${HOME}/.bun/env"
  if [[ -f "$BUN_ENV" ]]; then
    # shellcheck source=/dev/null
    source "$BUN_ENV"
  else
    export PATH="${HOME}/.bun/bin:${PATH}"
  fi
}

version_gte() {
  # Returns 0 if $1 >= $2 (semver, major.minor.patch only)
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

# Ensure ~/.bun/bin and ~/.local/bin are on PATH before checking
export PATH="${HOME}/.local/bin:${HOME}/.bun/bin:${PATH}"

if command -v bun &>/dev/null; then
  BUN_VERSION=$(bun --version)
  if version_gte "$BUN_VERSION" "$BUN_MIN_VERSION"; then
    ok "Bun $BUN_VERSION"
  else
    log "Bun $BUN_VERSION found but < $BUN_MIN_VERSION — upgrading..."
    install_bun
    ok "Bun $(bun --version)"
  fi
else
  install_bun
  ok "Bun $(bun --version)"
fi

# ---------------------------------------------------------------------------
# 1b. Symlink bun as node if node is not installed
#     tsc and other npm-published binaries use #!/usr/bin/env node
# ---------------------------------------------------------------------------
if ! command -v node &>/dev/null; then
  log "node not found — symlinking bun as node in ~/.local/bin..."
  mkdir -p "${HOME}/.local/bin"
  ln -sf "${HOME}/.bun/bin/bun" "${HOME}/.local/bin/node"
  ok "node → bun symlink created"
else
  ok "node $(node --version)"
fi

# ---------------------------------------------------------------------------
# 2. Dependencies
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# If node_modules exists but is owned by root (from a prior `sudo` run),
# fix ownership before installing — bun install will fail otherwise.
if [[ -d "node_modules" ]]; then
  NM_OWNER=$(stat -c '%U' node_modules)
  CURRENT_USER=$(id -un)
  if [[ "$NM_OWNER" != "$CURRENT_USER" ]]; then
    log "node_modules owned by '$NM_OWNER' but running as '$CURRENT_USER' — fixing ownership (requires sudo)..."
    sudo chown -R "${CURRENT_USER}:${CURRENT_USER}" node_modules
    ok "node_modules ownership fixed"
  fi
fi

log "Installing dependencies..."
bun install
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# 3. Typecheck
# ---------------------------------------------------------------------------
log "Running typecheck..."
bun run typecheck
ok "Typecheck passed"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Dev environment ready."
echo "  bun run build      — compile to ./kaizen binary"
echo "  bun test           — run tests"
echo "  bun run spike      — run the Day 1 loader probe"
