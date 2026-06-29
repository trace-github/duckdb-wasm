#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/duckdb-wasm"

NPM_ARGS=("--access" "public")
dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
    dry_run=true
    NPM_ARGS+=("--dry-run")
fi

if [ ! -d "$PKG_DIR/dist" ]; then
    echo "ERROR: dist/ not found. Run ./build-wasm.sh first." >&2
    exit 1
fi

for variant in eh coi; do
    if [ ! -f "$PKG_DIR/dist/duckdb-${variant}.wasm" ]; then
        echo "ERROR: dist/duckdb-${variant}.wasm not found. Run ./build-wasm.sh first." >&2
        exit 1
    fi
done

if [ ! -f "$PKG_DIR/dist/duckdb-browser.mjs" ]; then
    echo "ERROR: dist/duckdb-browser.mjs not found. Run ./build-wasm.sh first." >&2
    exit 1
fi

pkg_name=$(node -p "require('$PKG_DIR/package.json').name")
pkg_version=$(node -p "require('$PKG_DIR/package.json').version")

echo "=== Publishing $pkg_name@$pkg_version ==="
if $dry_run; then echo "(dry run)"; fi

cd "$PKG_DIR"
npm pack --dry-run 2>&1

if ! $dry_run; then
    read -r -p "Publish $pkg_name@$pkg_version? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then echo "Aborted."; exit 0; fi
fi

npm publish "${NPM_ARGS[@]}"

if $dry_run; then echo "=== Dry run complete ==="; else echo "=== Published $pkg_name@$pkg_version ==="; fi
