#!/bin/sh
# Build a release archive: sprawler + the Rust-built analyzer plugins, for one target.
#
#   scripts/package.sh                          # the host target
#   scripts/package.sh x86_64-unknown-linux-gnu # a specific target (its toolchain must be installed)
#
# Writes dist/sprawler-<version>-<target>.tar.gz containing bin/ (sprawler) and plugins/ (analyzers).
set -eu
cd "$(dirname "$0")/.."
target="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)"
plugins="rust roc typescript python go"
exe=""; case "$target" in *windows*) exe=".exe" ;; esac

cargo build --release --locked --target "$target" -p sprawler $(for p in $plugins; do printf -- '-p sprawler-analyzer-%s ' "$p"; done)

name="sprawler-$version-$target"
stage="dist/$name"
rm -rf "$stage" && mkdir -p "$stage/bin" "$stage/plugins"
cp "target/$target/release/sprawler$exe" "$stage/bin/"
for p in $plugins; do cp "target/$target/release/sprawler-analyzer-$p$exe" "$stage/plugins/"; done
cp LICENSE README.md "$stage/"
tar -czf "dist/$name.tar.gz" -C dist "$name"
echo "dist/$name.tar.gz"
