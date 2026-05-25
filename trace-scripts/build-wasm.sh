#!/usr/bin/env bash
#
# Build duckdb-wasm using Docker.
#
# Uses --platform linux/amd64 because Emscripten 3.1.57 only ships
# x86_64 Linux binaries. On Apple Silicon this uses QEMU emulation.
#
# Usage:
#   ./build-wasm.sh              # full build
#   ./build-wasm.sh --no-cache   # rebuild Docker image from scratch
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="duckdb-wasm-builder"
CACHE_VOLUME="duckdb-wasm-cache"

DOCKER_BUILD_ARGS=""
if [[ "${1:-}" == "--no-cache" ]]; then
    DOCKER_BUILD_ARGS="--no-cache"
    shift
fi

echo "=== Building Docker image (linux/amd64) ==="
docker buildx build --platform linux/amd64 $DOCKER_BUILD_ARGS -t "$IMAGE_NAME" --load "$ROOT_DIR"

docker volume create "$CACHE_VOLUME" 2>/dev/null || true

echo "=== Running build ==="
docker run --rm \
    --platform linux/amd64 \
    -v "$ROOT_DIR":/src \
    -v "$CACHE_VOLUME":/cache \
    "$IMAGE_NAME"

echo "=== Patching Node bundle ==="
node "$SCRIPT_DIR/patch-node-bundle.mjs"

echo "=== Patching browser workers (OPFS fix) ==="
node "$SCRIPT_DIR/patch-browser-workers.mjs"

echo "=== Done ==="
