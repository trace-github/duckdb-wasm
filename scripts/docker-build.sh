#!/usr/bin/env bash
#
# Build script that runs inside the Docker container.
# Uses build-docker/ to avoid conflicts with host CMake caches.
#
set -euo pipefail

cd /src

git config --global --add safe.directory /src
git config --global --add safe.directory /src/submodules/duckdb

export DUCKDB_WASM_BUILD_PREFIX=/src/build-docker

echo "=== Applying patches ==="
make apply_patches || true

echo "=== Building hash_ext Rust library for WASM (no-threads) ==="
cd /src/hash_ext_wasm
CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER="emcc" \
CC_wasm32_unknown_emscripten="emcc" \
CXX_wasm32_unknown_emscripten="em++" \
AR_wasm32_unknown_emscripten="emar" \
CARGO_TARGET_DIR=/cache/cargo-target-hash-nothreads \
cargo +nightly build \
    --target wasm32-unknown-emscripten \
    --release \
    -Z build-std=core

echo "=== Building hash_ext Rust library for WASM (threads/COI) ==="
CARGO_TARGET_WASM32_UNKNOWN_EMSCRIPTEN_LINKER="emcc" \
CC_wasm32_unknown_emscripten="emcc" \
CXX_wasm32_unknown_emscripten="em++" \
AR_wasm32_unknown_emscripten="emar" \
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory" \
CARGO_TARGET_DIR=/cache/cargo-target-hash-threads \
cargo +nightly build \
    --target wasm32-unknown-emscripten \
    --release \
    -Z build-std=core
echo "=== Rust libraries built ==="
cd /src

echo "=== Building WASM targets (MVP + EH with emsdk 3.1.71) ==="
/src/scripts/wasm_build_lib.sh relperf mvp
/src/scripts/wasm_build_lib.sh relperf eh

echo "=== Switching to emsdk 3.1.57 for COI ==="
/opt/emsdk/emsdk activate 3.1.57 2>/dev/null
source /opt/emsdk/emsdk_env.sh 2>/dev/null

echo "=== Building WASM target (COI with emsdk 3.1.57) ==="
/src/scripts/wasm_build_lib.sh relperf coi

echo "=== Building JS/TS package ==="
# Use yarn to respect the lockfile (pins @types/emscripten to 1.39.10)
cd /src
npm install --global yarn
yarn install
cd packages/duckdb-wasm
node bundle.mjs release && npx tsc --emitDeclarationOnly

echo "=== Building test-rig Arrow bundle ==="
cd /src/test-rig
npm install
npm run build

echo "=== Build complete ==="
