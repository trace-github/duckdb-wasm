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

echo "=== Switching to emsdk 4.0.3 for COI ==="
/opt/emsdk/emsdk activate 4.0.3 2>/dev/null
source /opt/emsdk/emsdk_env.sh 2>/dev/null

echo "=== Building WASM target (COI with emsdk 4.0.3) ==="
/src/scripts/wasm_build_lib.sh relperf coi

echo "=== Building JS/TS package ==="
# Use yarn to respect the lockfile (pins @types/emscripten to 1.39.10)
cd /src
npm install --global yarn
yarn install
cd packages/duckdb-wasm

# Patch Emscripten-generated JS: esbuild browser bundles can't resolve Node
# built-in "crypto". Same trick bundle.mjs uses for "child_process".
for f in src/bindings/duckdb-mvp.js src/bindings/duckdb-eh.js src/bindings/duckdb-coi.js; do
  if grep -q 'require("crypto")' "$f" 2>/dev/null; then
    sed -i 's/require("crypto")/["crypto"].map(require).pop()/g' "$f"
    echo "  Patched crypto require in $f"
  fi
done

# Patch COI glue: in pthread context, Emscripten 4.0.3 doesn't initialize the
# local wasmMemory variable from Module["wasmMemory"]. This breaks bundled
# pthread workers that set Module["wasmMemory"] before calling the module factory.
node -e '
const fs = require("fs");
const f = "src/bindings/duckdb-coi.js";
let src = fs.readFileSync(f, "utf8");
const anchor = "updateMemoryViews()\n            }";
const replacement = "updateMemoryViews()\n            } else if (Module[\"wasmMemory\"]) {\n                wasmMemory = Module[\"wasmMemory\"];\n                updateMemoryViews()\n            }";
if (src.includes(anchor) && !src.includes("else if (Module[\"wasmMemory\"])")) {
  // Find the specific instance after !ENVIRONMENT_IS_PTHREAD
  const idx = src.indexOf("if (!ENVIRONMENT_IS_PTHREAD)");
  const anchorIdx = src.indexOf(anchor, idx);
  if (anchorIdx > idx) {
    src = src.slice(0, anchorIdx) + replacement + src.slice(anchorIdx + anchor.length);
    fs.writeFileSync(f, src);
    console.log("  Patched COI pthread wasmMemory initialization");
  } else {
    console.log("  WARNING: COI pthread wasmMemory anchor not found after ENVIRONMENT_IS_PTHREAD");
  }
} else if (src.includes("else if (Module[\"wasmMemory\"])")) {
  console.log("  COI pthread wasmMemory patch already applied");
} else {
  console.log("  WARNING: COI pthread wasmMemory patch anchor not found");
}
'

node bundle.mjs release && npx tsc --emitDeclarationOnly

echo "=== Building test-rig Arrow bundle ==="
cd /src/test-rig
npm install
npm run build

echo "=== Build complete ==="
