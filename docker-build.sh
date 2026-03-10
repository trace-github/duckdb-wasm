#!/usr/bin/env bash
#
# Build script that runs inside the Docker container.
# Uses build-docker/ to avoid conflicts with host CMake caches in build/.
#
set -euo pipefail

cd /src

git config --global --add safe.directory /src

# Use a docker-specific build prefix so CMake caches don't conflict with host builds.
export DUCKDB_WASM_BUILD_PREFIX=/src/build-docker

echo "=== Building WASM targets ==="
make build_wasm_all

echo "=== Building JS/TS package ==="
cd packages/duckdb-wasm
npm install
npx vite build && node bin/bundle.mjs release && npx tsc

echo "=== Build complete ==="