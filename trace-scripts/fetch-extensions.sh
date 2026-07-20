#!/usr/bin/env bash
#
# Assemble all duckdb-wasm bundled extensions as native loadable files for one
# platform, so DuckDB Neo (@duckdb/node-api) can use them offline (or so they
# can be pushed to GCS — see push-extensions.sh).
#
# Layout produced (per extension, both forms):
#   <dest>/v<duckdb_version>/<platform>/<name>.duckdb_extension       (uncompressed — for extension_directory + LOAD)
#   <dest>/v<duckdb_version>/<platform>/<name>.duckdb_extension.gz    (gzipped — DuckDB repository format / INSTALL)
#
# Hosted extensions are downloaded from the DuckDB core/community repos.
# hash_ext is custom (not hosted) — copied from extension-dist/ (must be built).
#
# STRICT: errors (non-zero exit) if any hosted extension fails to download, if
# hash_ext is not built, or if the assembled set is incomplete. The full set
# must be captured or the script fails.
#
# Usage:
#   ./trace-scripts/fetch-extensions.sh                       # host platform, version from submodule, dest = temp/
#   ./trace-scripts/fetch-extensions.sh v1.5.4 linux_amd64    # explicit version + platform
#   DEST_ROOT=extension-dist ./trace-scripts/fetch-extensions.sh v1.5.4 osx_arm64   # write into a different root
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Resolve version + platform + destination
# ---------------------------------------------------------------------------
VERSION="${1:-$(cd "$ROOT_DIR/submodules/duckdb" && git describe --tags --abbrev=0)}"

PLATFORM="${2:-}"
if [[ -z "$PLATFORM" ]]; then
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64)   PLATFORM=osx_arm64 ;;
        Darwin-x86_64)  PLATFORM=osx_amd64 ;;
        Linux-x86_64)   PLATFORM=linux_amd64 ;;
        Linux-aarch64)  PLATFORM=linux_arm64 ;;
        *) echo "ERROR: can't detect platform; pass it as arg 2 (e.g. linux_amd64)"; exit 1 ;;
    esac
fi

# Destination root (override with DEST_ROOT). Default: <repo>/temp.
# Relative values are resolved against the repo root.
DEST_ROOT="${DEST_ROOT:-temp}"
case "$DEST_ROOT" in
    /*) : ;;                          # absolute — leave as-is
    *)  DEST_ROOT="$ROOT_DIR/$DEST_ROOT" ;;
esac

DEST="$DEST_ROOT/$VERSION/$PLATFORM"
CORE="https://extensions.duckdb.org/$VERSION/$PLATFORM"
COMMUNITY="https://community-extensions.duckdb.org/$VERSION/$PLATFORM"

# The complete set bundled in the duckdb-wasm package (see lib/src/webdb.cc).
CORE_EXTS=(json parquet icu tpcds tpch fts quack)   # from extensions.duckdb.org
COMMUNITY_EXTS=(lua)                                 # from community-extensions.duckdb.org
CUSTOM_EXTS=(hash_ext)                               # built locally (extension-dist/)
EXPECTED=("${CORE_EXTS[@]}" "${COMMUNITY_EXTS[@]}" "${CUSTOM_EXTS[@]}")

mkdir -p "$DEST"
echo "Version:  $VERSION"
echo "Platform: $PLATFORM"
echo "Target:   $DEST"
echo ""

# ---------------------------------------------------------------------------
# Download each hosted extension; keep .gz and also write uncompressed.
# Returns non-zero on failure so the caller can record it.
# ---------------------------------------------------------------------------
FAILED=()
fetch() {
    local name="$1" base="$2"
    local url="$base/$name.duckdb_extension.gz"
    local gz="$DEST/$name.duckdb_extension.gz"
    local raw="$DEST/$name.duckdb_extension"
    if curl -sfL "$url" -o "$gz" && gzip -dc "$gz" > "$raw"; then
        echo "  downloaded  $name"
    else
        rm -f "$gz" "$raw"
        echo "  FAILED      $name  ($url)"
        return 1
    fi
}

for name in "${CORE_EXTS[@]}";      do fetch "$name" "$CORE"      || FAILED+=("$name"); done
for name in "${COMMUNITY_EXTS[@]}"; do fetch "$name" "$COMMUNITY" || FAILED+=("$name"); done

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "ERROR: failed to download hosted extensions: ${FAILED[*]}"
    echo "       (check network / that $VERSION/$PLATFORM exists in the DuckDB repos)"
    exit 1
fi

# ---------------------------------------------------------------------------
# hash_ext: custom, not hosted — copy from local build (both forms).
# When DEST already IS extension-dist, the file is already in place (skip copy).
# STRICT: missing build is a hard error.
# ---------------------------------------------------------------------------
HASH_SRC="$ROOT_DIR/extension-dist/$VERSION/$PLATFORM/hash_ext.duckdb_extension"
HASH_DEST="$DEST/hash_ext.duckdb_extension"
if [[ -f "$HASH_SRC" ]]; then
    if [[ "$HASH_SRC" != "$HASH_DEST" ]]; then
        cp "$HASH_SRC" "$HASH_DEST"
        [[ -f "$HASH_SRC.gz" ]] && cp "$HASH_SRC.gz" "$HASH_DEST.gz"
    fi
    echo "  present     hash_ext"
else
    echo ""
    echo "ERROR: hash_ext is not built for $VERSION/$PLATFORM."
    echo "       Build it first:  ./extensions/hash_ext/build.sh --platform $PLATFORM"
    echo "       (or all platforms: ./extensions/hash_ext/build-all.sh)"
    exit 1
fi

# ---------------------------------------------------------------------------
# Completeness check — every expected extension must be present, or fail.
# ---------------------------------------------------------------------------
MISSING=()
for name in "${EXPECTED[@]}"; do
    [[ -f "$DEST/$name.duckdb_extension" ]] || MISSING+=("$name")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo ""
    echo "ERROR: assembled set is incomplete — missing: ${MISSING[*]}"
    exit 1
fi

echo ""
echo "Done. Captured all ${#EXPECTED[@]} extensions in $DEST:"
ls -1 "$DEST"
