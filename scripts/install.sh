#!/usr/bin/env bash
# kaizen installer
# Usage: curl -fsSL https://your-host/install.sh | bash
# Or:    bash scripts/install.sh  (local dev install)

set -euo pipefail

KAIZEN_HOME="${KAIZEN_HOME:-$HOME/.kaizen}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
KAIZEN_REPO="${KAIZEN_REPO:-CraightonH/kaizen}"
BINARY="kaizen"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

die() { red "error: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 -O "$dest" "$url"
  else
    die "neither curl nor wget found"
  fi
}

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

# Ensure bun is available so plugin runtime deps can be resolved at install
# time. Idempotent and best-effort: a failure here warns and continues, never
# aborts the kaizen installer.
#
# Opt out by setting KAIZEN_NO_BUN=1.
ensure_bun() {
  if [ "${KAIZEN_NO_BUN:-0}" = "1" ]; then
    info "Skipping bun install (KAIZEN_NO_BUN=1)."
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    info "bun already installed: $(command -v bun)"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bun" ]; then
    info "bun found at ~/.bun/bin/bun"
    return 0
  fi

  info "Installing bun (required for plugin dependency resolution)..."
  if curl -fsSL https://bun.sh/install | bash; then
    green "  ✓ bun installed"
  else
    red "  ! bun install failed; install manually: curl -fsSL https://bun.sh/install | bash"
    return 0
  fi
}

# Register the official marketplace and install the default harness. Plugin
# resolution is deferred to the binary — kaizen auto-installs a harness's
# plugins on first run via src/core/bootstrap.ts. Each step is best-effort:
# failures warn and continue, never abort the installer.
#
# Opt out by setting KAIZEN_NO_BOOTSTRAP=1 or passing --no-bootstrap.
bootstrap() {
  if [ "${KAIZEN_NO_BOOTSTRAP:-0}" = "1" ]; then
    info "Skipping bootstrap (KAIZEN_NO_BOOTSTRAP=1)."
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    red "  ! git not found on PATH; skipping marketplace bootstrap."
    info "    Install git and run: kaizen marketplace add https://github.com/CraightonH/kaizen-official-plugins.git --id official"
    return 0
  fi

  local market_url="https://github.com/CraightonH/kaizen-official-plugins.git"
  info "Registering marketplace 'official'..."
  if kaizen marketplace add "$market_url" --id official; then
    green "  ✓ marketplace 'official' registered"
  else
    red "  ! marketplace add failed; run manually: kaizen marketplace add $market_url --id official"
    return 0
  fi

  local default_harness="official/claude-wrapper"
  info "Installing default harness ${default_harness}..."
  if kaizen install "$default_harness"; then
    green "  ✓ ${default_harness} installed"
  else
    red "  ! harness install failed; run manually: kaizen install $default_harness"
    return 0
  fi
}

latest_release_tag() {
  local api_url="https://api.github.com/repos/${KAIZEN_REPO}/releases/latest"
  local tag
  if command -v curl >/dev/null 2>&1; then
    tag="$(curl -fsSL "$api_url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  else
    tag="$(wget -qO- "$api_url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  fi
  [ -n "$tag" ] || die "could not determine latest release (check your connection or set VERSION env var)"
  echo "$tag"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  # Parse --no-bootstrap flag; everything else is ignored.
  for arg in "$@"; do
    case "$arg" in
      --no-bootstrap) KAIZEN_NO_BOOTSTRAP=1 ;;
    esac
  done

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

  local base_url="https://github.com/${KAIZEN_REPO}/releases/download/${version}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "${tmpdir:-}"' EXIT

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

  case ":$PATH:" in
    *":${INSTALL_DIR}:"*) ;;
    *) red "  ! ${INSTALL_DIR} is not on PATH — add it to your shell profile so 'kaizen' resolves." ;;
  esac

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
  ensure_bun

  echo ""
  bootstrap

  echo ""
  bold "Done!"
  echo ""
  info "Quick start:"
  info "  kaizen --harness official/core-shell@1.0.0   # default shell harness (installed)"
  info "  kaizen marketplace list                      # see registered marketplaces"
  info "  kaizen install <ref>                         # install another plugin or harness"
  echo ""
  info "On first --harness run, kaizen prompts for consent on each plugin."
}

# Only run main if the script is executed directly, not sourced. Lets tests
# source the file to unit-test individual helpers.
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  main "$@"
fi
