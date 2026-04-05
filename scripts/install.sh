#!/usr/bin/env bash
# kaizen installer
# Usage: curl -fsSL https://your-host/install.sh | bash
# Or:    bash scripts/install.sh  (local dev install)

set -euo pipefail

KAIZEN_HOME="${KAIZEN_HOME:-$HOME/.kaizen}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
REPO="${REPO:-CraightonH/kaizen}"
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
        x86_64)  echo "bun-linux-x64" ;;
        aarch64) echo "bun-linux-arm64" ;;
        *) die "unsupported Linux architecture: $arch" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64)  echo "bun-darwin-x64" ;;
        arm64)   echo "bun-darwin-arm64" ;;
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

latest_release_tag() {
  local api_url="https://api.github.com/repos/${REPO}/releases/latest"
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
  bold "kaizen installer"
  echo ""

  # Allow pinning a version via env
  local version="${VERSION:-}"
  if [ -z "$version" ]; then
    info "Fetching latest release..."
    version="$(latest_release_tag)"
  fi
  info "Version: $version"

  local platform
  platform="$(detect_platform)"
  info "Platform: $platform"

  # Build download URL (adjust to your release asset naming convention)
  local asset_name="${BINARY}-${version}-${platform}"
  local download_url="https://github.com/${REPO}/releases/download/${version}/${asset_name}"

  # Temp dir
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  info "Downloading ${asset_name}..."
  download "$download_url" "${tmpdir}/${BINARY}"
  chmod +x "${tmpdir}/${BINARY}"

  # Install binary
  if [ -w "$INSTALL_DIR" ]; then
    mv "${tmpdir}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  else
    info "Requesting sudo to install to ${INSTALL_DIR}..."
    sudo mv "${tmpdir}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  fi

  green "  ✓ Installed ${BINARY} → ${INSTALL_DIR}/${BINARY}"

  # Initialize global kaizen home if missing
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

main "$@"
