#!/usr/bin/env bash
# Build hash_ext as a loadable DuckDB extension for the host platform.
# Produces: extension-dist/<version>/<platform>/hash_ext.duckdb_extension.gz
#
# Usage:
#   ./extensions/hash_ext/build.sh                       # Build for host platform
#   ./extensions/hash_ext/build.sh --clean               # Clean and rebuild
#   ./extensions/hash_ext/build.sh --platform osx_arm64  # Cross-compile for a specific platform
#
# Supported --platform values: osx_arm64, osx_amd64 (cross-compiled on macOS)
# Linux builds: run this script without --platform inside a Docker container (see build-all.sh)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DUCKDB_DIR="$PROJECT_ROOT/submodules/duckdb"
RUST_DIR="$SCRIPT_DIR/rust"
BUILD_DIR="$PROJECT_ROOT/build/extension-native"
DIST_DIR="$PROJECT_ROOT/extension-dist"

# ---------------------------------------------------------------------------
# 0. Parse arguments
# ---------------------------------------------------------------------------
CROSS_PLATFORM=""
CLEAN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --clean)
            CLEAN=1
            shift
            ;;
        --platform)
            CROSS_PLATFORM="${2:-}"
            if [[ -z "$CROSS_PLATFORM" ]]; then
                echo "ERROR: --platform requires an argument"
                exit 1
            fi
            shift 2
            ;;
        *)
            echo "Unknown argument: $1"
            exit 1
            ;;
    esac
done

# Clean if requested
if [[ "$CLEAN" == "1" ]]; then
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

RUST_TARGET=""
CMAKE_EXTRA_FLAGS=""

if [[ -n "$CROSS_PLATFORM" ]]; then
    PLATFORM="$CROSS_PLATFORM"
    case "$CROSS_PLATFORM" in
        osx_arm64)
            RUST_TARGET="aarch64-apple-darwin"
            CMAKE_EXTRA_FLAGS=""
            ;;
        osx_amd64)
            RUST_TARGET="x86_64-apple-darwin"
            CMAKE_EXTRA_FLAGS="-DCMAKE_OSX_ARCHITECTURES=x86_64"
            ;;
        linux_amd64|linux_arm64)
            # Linux targets are built natively inside Docker via build-all.sh.
            # If running directly on Linux, no cross-compilation flags needed.
            ;;
        *)
            echo "ERROR: Unknown platform '$CROSS_PLATFORM'. Supported: osx_arm64, osx_amd64, linux_amd64, linux_arm64"
            exit 1
            ;;
    esac
    # Use a platform-specific build directory to avoid conflicts
    BUILD_DIR="$PROJECT_ROOT/build/extension-native-$PLATFORM"
else
    PLATFORM=$(detect_platform)
fi

echo "=== Building hash_ext for platform: $PLATFORM ==="

# ---------------------------------------------------------------------------
# 2. Get DuckDB version from submodule
# ---------------------------------------------------------------------------
DUCKDB_VERSION=$(cd "$DUCKDB_DIR" && git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
DUCKDB_HASH=$(cd "$DUCKDB_DIR" && git log -1 --format=%h 2>/dev/null || echo "0000000000")
echo "=== DuckDB version: $DUCKDB_VERSION (${DUCKDB_HASH}) ==="

# ---------------------------------------------------------------------------
# 3. Build Rust static library
# ---------------------------------------------------------------------------
echo "=== Building Rust static library ==="
# Run cargo from workspace root; use build-dir-specific output to avoid
# arch conflicts when the same repo is bind-mounted into Docker containers.
cd "$PROJECT_ROOT"
CARGO_OUT="$BUILD_DIR/cargo-target"
if [[ -n "$RUST_TARGET" ]]; then
    CARGO_TARGET_DIR="$CARGO_OUT" cargo build --target "$RUST_TARGET" --release -p hash_ext
    RUST_LIB="$CARGO_OUT/$RUST_TARGET/release/libhash_ext.a"
else
    CARGO_TARGET_DIR="$CARGO_OUT" cargo build --release -p hash_ext
    RUST_LIB="$CARGO_OUT/release/libhash_ext.a"
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
    -DGIT_COMMIT_HASH="$DUCKDB_HASH" \
    -DOVERRIDE_GIT_DESCRIBE="$DUCKDB_VERSION-0-g$DUCKDB_HASH" \
    ${CMAKE_EXTRA_FLAGS:+$CMAKE_EXTRA_FLAGS}

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
cp "$EXT_FILE" "$DEST_DIR/hash_ext.duckdb_extension"
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
