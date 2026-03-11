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

echo "=== Building evalexpr_rhai Rust library for WASM (no-threads) ==="
cd /src/evalexpr_rhai_wasm
CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER="emcc" \
CC_wasm32_unknown_emscripten="emcc" \
CXX_wasm32_unknown_emscripten="em++" \
AR_wasm32_unknown_emscripten="emar" \
EMCC_CFLAGS="-sDISABLE_EXCEPTION_CATCHING=0" \
RUSTFLAGS="-C panic=abort -C link-arg=-sDISABLE_EXCEPTION_CATCHING=0" \
CARGO_TARGET_DIR=/cache/cargo-target-nothreads \
cargo +nightly build \
    --target wasm32-unknown-emscripten \
    --release \
    -Z build-std=std,panic_abort

echo "=== Building evalexpr_rhai Rust library for WASM (threads/COI) ==="
CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER="emcc" \
CC_wasm32_unknown_emscripten="emcc" \
CXX_wasm32_unknown_emscripten="em++" \
AR_wasm32_unknown_emscripten="emar" \
EMCC_CFLAGS="-sDISABLE_EXCEPTION_CATCHING=0 -sUSE_PTHREADS=1 -pthread" \
RUSTFLAGS="-C panic=abort -C link-arg=-sDISABLE_EXCEPTION_CATCHING=0 -C target-feature=+atomics,+bulk-memory" \
CARGO_TARGET_DIR=/cache/cargo-target-threads \
cargo +nightly build \
    --target wasm32-unknown-emscripten \
    --release \
    -Z build-std=std,panic_abort
echo "=== Rust libraries built ==="
cd /src

echo "=== Building WASM targets ==="
make build_wasm_all

echo "=== Building JS/TS package ==="
cd packages/duckdb-wasm
npm install
npx vite build && node bin/bundle.mjs release && npx tsc

echo "=== Build complete ==="