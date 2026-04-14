#!/usr/bin/env bash
#
# Remove all build artifacts so the next build starts from scratch.
#
# Usage:
#   ./clean.sh              # remove build artifacts (keeps Docker image + ccache volume)
#   ./clean.sh --all        # also remove Docker image and ccache volume
#
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

# WASM build outputs (host and Docker)
rm -rf "$ROOT_DIR/build"
rm -rf "$ROOT_DIR/build-docker"
echo "  removed build/ and build-docker/"

# Generated WASM bindings (copied from build into src/bindings/)
rm -f "$ROOT_DIR"/packages/duckdb-wasm/src/bindings/duckdb-mvp.{wasm,js,pthread.js}
rm -f "$ROOT_DIR"/packages/duckdb-wasm/src/bindings/duckdb-eh.{wasm,js,pthread.js}
rm -f "$ROOT_DIR"/packages/duckdb-wasm/src/bindings/duckdb-coi.{wasm,js,pthread.js}
echo "  removed generated bindings"

# JS/TS distribution
rm -rf "$ROOT_DIR/packages/duckdb-wasm/dist"
echo "  removed packages/duckdb-wasm/dist/"

# Node modules
rm -rf "$ROOT_DIR/packages/duckdb-wasm/node_modules"
rm -rf "$ROOT_DIR/test-rig/node_modules"
echo "  removed node_modules"

# Test artifacts
rm -rf "$ROOT_DIR/test-wasmfs/build"
rm -f "$ROOT_DIR/test-rig/wasmfs_test.js"
rm -f "$ROOT_DIR/test-rig/wasmfs_test.wasm"
rm -f "$ROOT_DIR/test-rig/wasmfs_test.worker.js"
rm -f "$ROOT_DIR/test-rig/arrow-bundle.mjs"
echo "  removed test build artifacts"

# Rust target directories (local, not the Docker cache volume)
rm -rf "$ROOT_DIR/target"
rm -rf "$ROOT_DIR/evalexpr_rhai_wasm/target"
rm -rf "$ROOT_DIR/hash_ext_wasm/target"
echo "  removed Rust target dirs"

# Misc
rm -f "$ROOT_DIR"/packages/duckdb-wasm/*.tgz
rm -f "$ROOT_DIR"/*.tgz
echo "  removed .tgz packs"

if $remove_all; then
    echo ""
    echo "=== Cleaning Docker image and cache ==="

    if docker volume inspect "$CACHE_VOLUME" &>/dev/null; then
        docker volume rm "$CACHE_VOLUME"
        echo "  removed Docker volume $CACHE_VOLUME (ccache + Rust cargo cache)"
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
