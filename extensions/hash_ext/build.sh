#!/usr/bin/env bash
# Build hash_ext as a loadable DuckDB extension for the host platform.
# Produces: extension-dist/<version>/<platform>/hash_ext.duckdb_extension.gz
#
# Usage:
#   ./extensions/hash_ext/build.sh            # Build for host platform
#   ./extensions/hash_ext/build.sh --clean     # Clean and rebuild
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DUCKDB_DIR="$PROJECT_ROOT/submodules/duckdb"
RUST_DIR="$SCRIPT_DIR/rust"
BUILD_DIR="$PROJECT_ROOT/build/extension-native"
DIST_DIR="$PROJECT_ROOT/extension-dist"

# Clean if requested
if [[ "${1:-}" == "--clean" ]]; then
    echo "=== Cleaning build artifacts ==="
    rm -rf "$BUILD_DIR"
    rm -rf "$RUST_DIR/target"
    rm -rf "$DIST_DIR"
fi

# ---------------------------------------------------------------------------
# 1. Detect platform
# ---------------------------------------------------------------------------
detect_platform() {
    local os arch
    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="osx" ;;
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *) echo "Unsupported OS: $(uname -s)"; exit 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)  arch="amd64" ;;
        arm64|aarch64) arch="arm64" ;;
        *) echo "Unsupported arch: $(uname -m)"; exit 1 ;;
    esac
    echo "${os}_${arch}"
}

PLATFORM=$(detect_platform)
echo "=== Building hash_ext for platform: $PLATFORM ==="

# ---------------------------------------------------------------------------
# 2. Get DuckDB version from submodule
# ---------------------------------------------------------------------------
DUCKDB_VERSION=$(cd "$DUCKDB_DIR" && git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
echo "=== DuckDB version: $DUCKDB_VERSION ==="

# ---------------------------------------------------------------------------
# 3. Build Rust static library
# ---------------------------------------------------------------------------
echo "=== Building Rust static library ==="
cd "$RUST_DIR"
cargo build --release
RUST_LIB="$RUST_DIR/target/release/libhash_ext.a"
if [[ ! -f "$RUST_LIB" ]]; then
    # Windows produces .lib
    RUST_LIB="$RUST_DIR/target/release/hash_ext.lib"
fi
echo "Rust lib: $RUST_LIB"

# ---------------------------------------------------------------------------
# 4. Build DuckDB with hash_ext extension (loadable only)
# ---------------------------------------------------------------------------
echo "=== Configuring CMake ==="
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

NPROC=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

cmake "$DUCKDB_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_EXTENSIONS_ONLY=1 \
    -DEXTENSION_STATIC_BUILD=0 \
    -DHASH_EXT_RUST_LIB="$RUST_LIB" \
    -DDUCKDB_EXTENSION_CONFIGS="$SCRIPT_DIR/extension_config.cmake" \
    -GNinja 2>/dev/null || \
cmake "$DUCKDB_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_EXTENSIONS_ONLY=1 \
    -DEXTENSION_STATIC_BUILD=0 \
    -DHASH_EXT_RUST_LIB="$RUST_LIB" \
    -DDUCKDB_EXTENSION_CONFIGS="$SCRIPT_DIR/extension_config.cmake"

echo "=== Building extension (using $NPROC cores) ==="
cmake --build . --config Release -j "$NPROC"

# ---------------------------------------------------------------------------
# 5. Find the built extension
# ---------------------------------------------------------------------------
EXT_FILE=$(find "$BUILD_DIR" -name "hash_ext.duckdb_extension" -type f | head -1)
if [[ -z "$EXT_FILE" ]]; then
    echo "ERROR: hash_ext.duckdb_extension not found in build output"
    exit 1
fi
echo "Built extension: $EXT_FILE"

# ---------------------------------------------------------------------------
# 6. Package into serving directory
# ---------------------------------------------------------------------------
DEST_DIR="$DIST_DIR/$DUCKDB_VERSION/$PLATFORM"
mkdir -p "$DEST_DIR"

echo "=== Packaging to $DEST_DIR ==="
gzip -c "$EXT_FILE" > "$DEST_DIR/hash_ext.duckdb_extension.gz"

echo ""
echo "=== Done ==="
echo "Extension:  $DEST_DIR/hash_ext.duckdb_extension.gz"
echo ""
echo "To use with DuckDB CLI or Node Neo:"
echo "  SET allow_unsigned_extensions = true;"
echo "  SET custom_extension_repository = 'http://your-server/extension-dist';"
echo "  INSTALL hash_ext;"
echo "  LOAD hash_ext;"
echo ""
echo "Directory structure:"
find "$DIST_DIR" -type f | sort | sed "s|$PROJECT_ROOT/||"
