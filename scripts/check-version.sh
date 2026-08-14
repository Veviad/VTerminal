#!/usr/bin/env bash
#
# Verify the version strings agree — and, given a tag, that they agree with it.
#
# VTerminal has no single source of truth for its version: package.json,
# src-tauri/Cargo.toml and src-tauri/tauri.conf.json each carry their own copy,
# and tauri.conf.json only inherits from Cargo.toml when the key is absent
# (ours is not). Nothing but this script notices when they drift.
#
# This is deliberately a CHECK and never a patch. Rewriting a version during a
# release would publish a DMG whose embedded version disagrees with the commit
# it claims to be built from — the artifact would be unreproducible from source.
#
#   ./scripts/check-version.sh            # the three manifests must agree
#   ./scripts/check-version.sh v0.2.5     # ...and must match the tag
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

pkg=$(node -p "require('./package.json').version")
conf=$(node -p "require('./src-tauri/tauri.conf.json').version")

# Only the [package] table. A bare `grep '^version'` would also match every
# dependency further down the file and silently pick the wrong one.
cargo=$(awk '
  /^\[/ { in_pkg = ($0 == "[package]") }
  in_pkg && /^version[[:space:]]*=/ {
    sub(/^version[[:space:]]*=[[:space:]]*"/, "")
    sub(/".*$/, "")
    print
    exit
  }
' src-tauri/Cargo.toml)

printf '  %-28s %s\n' 'package.json' "$pkg"
printf '  %-28s %s\n' 'src-tauri/Cargo.toml' "$cargo"
printf '  %-28s %s\n' 'src-tauri/tauri.conf.json' "$conf"

fail=0

if [ -z "$pkg" ] || [ -z "$cargo" ] || [ -z "$conf" ]; then
  echo "error: could not read one of the version strings" >&2
  fail=1
elif [ "$pkg" != "$conf" ] || [ "$pkg" != "$cargo" ]; then
  echo "error: the three manifests disagree" >&2
  fail=1
fi

if [ $# -ge 1 ]; then
  tag=${1#v}
  printf '  %-28s %s\n' 'git tag' "$1"
  if [ "$tag" != "$pkg" ]; then
    echo "error: tag '$1' does not match the manifest version '$pkg'" >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "Bump all three so they agree, then re-tag if a tag was already pushed." >&2
  exit 1
fi

echo "version $pkg is consistent"
