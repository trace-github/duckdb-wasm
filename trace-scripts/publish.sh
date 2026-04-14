#!/usr/bin/env bash
#
# Publish @run-trace/duckdb-wasm to npm.
#
# Usage:
#   ./publish.sh              # publish current version
#   ./publish.sh --dry-run    # show what would be published without actually publishing
#
# Prerequisites:
#   - Run ./build-wasm.sh first (dist/ must exist with WASM + JS bundles)
#   - Be logged in to npm: npm login
#
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

# --- Preflight checks ---

if [ ! -d "$PKG_DIR/dist" ]; then
    echo "ERROR: dist/ not found. Run ./build-wasm.sh first." >&2
    exit 1
fi

# Check that the three WASM binaries exist
for variant in mvp eh coi; do
    if [ ! -f "$PKG_DIR/dist/duckdb-${variant}.wasm" ]; then
        echo "ERROR: dist/duckdb-${variant}.wasm not found. Run ./build-wasm.sh first." >&2
        exit 1
    fi
done

# Check that the main JS bundle exists
if [ ! -f "$PKG_DIR/dist/duckdb-wasm.mjs" ]; then
    echo "ERROR: dist/duckdb-wasm.mjs not found. Run ./build-wasm.sh first." >&2
    exit 1
fi

# Read package info
pkg_name=$(node -p "require('$PKG_DIR/package.json').name")
pkg_version=$(node -p "require('$PKG_DIR/package.json').version")

echo "=== Publishing $pkg_name@$pkg_version ==="

if $dry_run; then
    echo "(dry run -- nothing will actually be published)"
fi

echo ""
echo "Package contents:"
cd "$PKG_DIR"
npm pack --dry-run 2>&1
echo ""

if ! $dry_run; then
    read -r -p "Publish $pkg_name@$pkg_version? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

npm publish "${NPM_ARGS[@]}"

if $dry_run; then
    echo ""
    echo "=== Dry run complete ==="
else
    echo ""
    echo "=== Published $pkg_name@$pkg_version ==="
fi
