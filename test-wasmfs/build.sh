#!/usr/bin/env bash
#
# Build the WasmFS + OPFS test program using the project's Docker container.
#
# Usage:
#   ./test-wasmfs/build.sh              # build with threads (default)
#   ./test-wasmfs/build.sh --no-threads # build without threads
#
# Outputs: test-rig/wasmfs_test.{js,wasm,worker.js}
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="duckdb-wasm-builder"
WITH_THREADS="ON"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-threads) WITH_THREADS="OFF"; shift;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

echo "=== Building Docker image (if needed) ==="
docker build -t "$IMAGE_NAME" "$PROJECT_ROOT"

echo "=== Building WasmFS test (threads=$WITH_THREADS) ==="
docker run --rm \
    --entrypoint bash \
    -v "$PROJECT_ROOT":/src \
    -w /src/test-wasmfs \
    "$IMAGE_NAME" \
    -c "
        set -euo pipefail
        mkdir -p build && cd build
        emcmake cmake .. -DWITH_THREADS=$WITH_THREADS -DCMAKE_BUILD_TYPE=Release
        emmake make -j\$(nproc) VERBOSE=1
        echo '=== Build complete ==='
        ls -la wasmfs_test.*
    "

echo "=== Copying artifacts to test-rig/ ==="
BUILD_DIR="$SCRIPT_DIR/build"
RIG_DIR="$PROJECT_ROOT/test-rig"

cp "$BUILD_DIR/wasmfs_test.js" "$RIG_DIR/"
cp "$BUILD_DIR/wasmfs_test.wasm" "$RIG_DIR/"

# Worker file is only generated with pthreads
if [[ -f "$BUILD_DIR/wasmfs_test.worker.js" ]]; then
    cp "$BUILD_DIR/wasmfs_test.worker.js" "$RIG_DIR/"
    echo "Copied: wasmfs_test.js, wasmfs_test.wasm, wasmfs_test.worker.js"
else
    echo "Copied: wasmfs_test.js, wasmfs_test.wasm (no worker — threads disabled)"
fi

echo "=== Done. Run with: ./test-rig/run.sh --wasmfs ==="
