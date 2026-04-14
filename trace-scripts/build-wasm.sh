#!/usr/bin/env bash
#
# Build duckdb-wasm using Docker.
#
# Usage:
#   ./build-wasm.sh              # full build
#   ./build-wasm.sh --no-cache   # rebuild Docker image from scratch
#
# Artifacts end up in their normal locations under build/ and packages/.
# A Docker volume is used as a ccache to speed up rebuilds.
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

echo "=== Building Docker image ==="
docker build $DOCKER_BUILD_ARGS -t "$IMAGE_NAME" "$ROOT_DIR"

docker volume create "$CACHE_VOLUME" 2>/dev/null || true

echo "=== Running build ==="
docker run --rm \
    -v "$ROOT_DIR":/src \
    -v "$CACHE_VOLUME":/cache \
    "$IMAGE_NAME"

echo "=== Done ==="