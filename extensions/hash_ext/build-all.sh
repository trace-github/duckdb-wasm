#!/usr/bin/env bash
# Build hash_ext native extension for all supported platforms.
#
# macOS targets: built natively on the host (cross-arch via clang)
# Linux targets: built inside Docker containers with native toolchains
#
# Prerequisites:
#   - Docker Desktop with the duckdb-wasm-builder image built for arm64
#   - For linux_amd64: duckdb-wasm-builder:amd64 image (see Dockerfile.amd64)
#   - Rust with x86_64-apple-darwin target (rustup target add x86_64-apple-darwin)
#   - CMake and Xcode Command Line Tools
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CACHE_VOLUME="duckdb-wasm-cache"

BUILT=()
FAILED=()

build_native() {
    local platform="$1"
    echo ""
    echo "=============================="
    echo "  Building for $platform (native)"
    echo "=============================="
    if "$SCRIPT_DIR/build.sh" --platform "$platform"; then
        BUILT+=("$platform")
    else
        echo "  FAILED: $platform"
        FAILED+=("$platform")
    fi
}

build_in_docker() {
    local platform="$1"
    local image="$2"
    echo ""
    echo "=============================="
    echo "  Building for $platform (Docker: $image)"
    echo "=============================="

    if ! docker image inspect "$image" &>/dev/null; then
        echo "  ERROR: Docker image '$image' not found."
        echo "  Build it first — see Dockerfile / Dockerfile.amd64"
        FAILED+=("$platform")
        return
    fi

    docker volume create "$CACHE_VOLUME" 2>/dev/null || true
    if docker run --rm \
        -v "$ROOT_DIR":/src \
        -v "$CACHE_VOLUME":/cache \
        --entrypoint bash \
        "$image" \
        -c "cd /src && git config --global --add safe.directory /src && git config --global --add safe.directory /src/submodules/duckdb && ./extensions/hash_ext/build.sh"; then
        BUILT+=("$platform")
    else
        echo "  FAILED: $platform"
        FAILED+=("$platform")
    fi
}

# macOS targets — native cross-compilation
build_native osx_arm64
build_native osx_amd64

# Linux targets — Docker with native toolchains
build_in_docker linux_amd64 duckdb-wasm-builder:amd64

# excluding linux_arm64. requires heavily emulated system to build, often OOMs, and we dont use it anywhere
#build_in_docker linux_arm64 duckdb-wasm-builder

echo ""
echo "=============================="
echo "  Results"
echo "=============================="
find "$ROOT_DIR/extension-dist" -type f -name "*.duckdb_extension*" 2>/dev/null | sort | sed "s|$ROOT_DIR/||"

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "BUILT:  ${BUILT[*]:-none}"
    echo "FAILED: ${FAILED[*]}"
    exit 1
else
    echo ""
    echo "All ${#BUILT[@]} platforms built successfully."
fi
