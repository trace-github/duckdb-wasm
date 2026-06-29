#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="duckdb-wasm-builder"
CACHE_VOLUME="duckdb-wasm-cache"

remove_all=false
if [[ "${1:-}" == "--all" ]]; then
    remove_all=true
fi

echo "=== Cleaning build artifacts ==="

rm -rf "$ROOT_DIR/build"
rm -rf "$ROOT_DIR/build-docker"
rm -rf "$ROOT_DIR/extension-dist"
echo "  removed build/, build-docker/, extension-dist/"

rm -f "$ROOT_DIR"/packages/duckdb-wasm/src/bindings/duckdb-eh.{wasm,js,pthread.js}
rm -f "$ROOT_DIR"/packages/duckdb-wasm/src/bindings/duckdb-coi.{wasm,js,pthread.js}
echo "  removed generated bindings"

# dist/ preserved by default — WASM builds are slow. Use --all to remove.
echo "  skipped packages/duckdb-wasm/dist/ (use --all to remove)"

rm -rf "$ROOT_DIR/packages/duckdb-wasm/node_modules"
rm -rf "$ROOT_DIR/test-rig/node_modules"
rm -rf "$ROOT_DIR/test-node/node_modules"
echo "  removed node_modules"

rm -f "$ROOT_DIR/test-rig/arrow-bundle.mjs"
echo "  removed test build artifacts"

rm -rf "$ROOT_DIR/target"
rm -rf "$ROOT_DIR/hash_ext_wasm/target"
echo "  removed Rust target dirs"

rm -f "$ROOT_DIR"/packages/duckdb-wasm/*.tgz
rm -f "$ROOT_DIR"/*.tgz
echo "  removed .tgz packs"

if $remove_all; then
    echo ""
    echo "=== Cleaning Docker image, cache, and dist ==="

    rm -rf "$ROOT_DIR/packages/duckdb-wasm/dist"
    echo "  removed packages/duckdb-wasm/dist/"

    if docker volume inspect "$CACHE_VOLUME" &>/dev/null; then
        docker volume rm "$CACHE_VOLUME"
        echo "  removed Docker volume $CACHE_VOLUME"
    else
        echo "  Docker volume $CACHE_VOLUME not found, skipping"
    fi

    if docker image inspect "$IMAGE_NAME" &>/dev/null; then
        docker rmi "$IMAGE_NAME"
        echo "  removed Docker image $IMAGE_NAME"
    else
        echo "  Docker image $IMAGE_NAME not found, skipping"
    fi
fi

echo ""
echo "=== Clean complete ==="
