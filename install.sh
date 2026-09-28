#!/bin/sh
# Install Sprawler: the core binary, plus analyzer plugins.
#
# From a clone (builds from source; needs Rust):
#   ./install.sh                 # core + the plugins your toolchains support
#   ./install.sh roc rust        # core + exactly these plugins
#
# Without a clone (downloads the prebuilt release for this machine):
#   curl -fsSL https://raw.githubusercontent.com/clankernative/sprawler/main/install.sh | sh
#
# From source the core goes to ~/.cargo/bin; prebuilt it goes to ~/.local/bin (SPRAWLER_BIN_DIR).
# Plugins go to ~/.local/share/sprawler/plugins (SPRAWLER_PLUGIN_HOME), where `sprawler` finds them.
# SPRAWLER_VERSION picks a release (default: latest); SPRAWLER_RELEASE_URL overrides the archive URL.
# SPRAWLER_INSTALL=prebuilt downloads even when run from a clone (the GitHub Action does this).
set -eu
here="$(cd "$(dirname "$0")" 2>/dev/null && pwd || pwd)"

if [ "${SPRAWLER_INSTALL:-}" != "prebuilt" ] && [ -d "$here/crates/sprawler" ] && [ -d "$here/plugins" ]; then
  # ── from source ──
  cd "$here"
  command -v cargo >/dev/null 2>&1 || { echo "Building Sprawler needs Rust: https://rustup.rs" >&2; exit 2; }
  echo "… installing sprawler"
  cargo install --quiet --force --path crates/sprawler
  if [ "$#" -gt 0 ]; then
    plugins="$*"
  else
    plugins="rust roc typescript python go"
    if command -v dotnet >/dev/null 2>&1; then plugins="$plugins csharp"; else echo "  (skipping csharp: no .NET SDK)"; fi
  fi
  SPRAWLER_SOURCE="$PWD" sprawler plugin add $plugins
  sprawler_bin=sprawler
else
  # ── prebuilt ──
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu ;;
    Darwin-x86_64) target=x86_64-apple-darwin ;;
    Darwin-arm64) target=aarch64-apple-darwin ;;
    *) echo "No prebuilt Sprawler for $(uname -s) $(uname -m); build from a clone: https://github.com/clankernative/sprawler" >&2; exit 2 ;;
  esac
  repo=https://github.com/clankernative/sprawler
  if [ -n "${SPRAWLER_RELEASE_URL:-}" ]; then
    url="$SPRAWLER_RELEASE_URL"
  else
    version="${SPRAWLER_VERSION:-}"
    if [ -z "$version" ]; then
      # the latest release's tag, from the redirect of /releases/latest
      version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/releases/latest" | sed 's|.*/tag/v||')"
    fi
    version="${version#v}"
    url="$repo/releases/download/v$version/sprawler-$version-$target.tar.gz"
  fi
  bindir="${SPRAWLER_BIN_DIR:-$HOME/.local/bin}"
  plugdir="${SPRAWLER_PLUGIN_HOME:-$HOME/.local/share/sprawler/plugins}/bin"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "… downloading $url"
  if [ -f "$url" ]; then cp "$url" "$tmp/release.tar.gz"; else curl -fsSL -o "$tmp/release.tar.gz" "$url"; fi
  tar -xzf "$tmp/release.tar.gz" -C "$tmp"
  dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  mkdir -p "$bindir" "$plugdir"
  cp "$dir/bin/sprawler" "$bindir/"
  if [ "$#" -gt 0 ]; then
    for p in "$@"; do
      if [ -f "$dir/plugins/sprawler-analyzer-$p" ]; then cp "$dir/plugins/sprawler-analyzer-$p" "$plugdir/"
      else echo "  (skipping $p: not in the prebuilt release; build it from a clone)"; fi
    done
  else
    cp "$dir"/plugins/sprawler-analyzer-* "$plugdir/"
  fi
  chmod +x "$bindir/sprawler" "$plugdir"/sprawler-analyzer-*
  echo "  ✓ sprawler → $bindir/sprawler"
  case ":$PATH:" in *":$bindir:"*) ;; *) echo "  note: add $bindir to your PATH" ;; esac
  sprawler_bin="$bindir/sprawler"
fi

if ! command -v graphify >/dev/null 2>&1; then
  echo "  note: the rust plugin resolves modules itself; for symbol counts also run: uv tool install graphifyy"
fi
echo
"$sprawler_bin" doctor || true
