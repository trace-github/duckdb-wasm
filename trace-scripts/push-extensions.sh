#!/usr/bin/env bash
#
# Assemble every extension bundled in the duckdb-wasm package and push them to
# a GCS bucket, so DuckDB Neo (@duckdb/node-api) can use them offline.
#
# For the current DuckDB version (from submodules/duckdb), for each target
# platform, this:
#   1. Downloads the hosted extensions (json, parquet, icu, tpcds, tpch, fts,
#      quack, lua) from the DuckDB core/community repos into extension-dist/.
#   2. Includes the custom hash_ext from its local build (extension-dist/).
#   3. Pushes extension-dist/ to gs://.../duckdb/extensions/ via gsutil rsync.
#
# Build hash_ext first so it's included:  ./extensions/hash_ext/build-all.sh
#
# Usage:
#   ./push-extensions.sh dev    # push to tf-shared-artifacts-hellotrace-dev
#   ./push-extensions.sh app    # push to tf-shared-artifacts-hellotrace-app
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension-dist"

# Target platforms (matches extensions/hash_ext/build-all.sh).
PLATFORMS=(osx_arm64 osx_amd64 linux_amd64)

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]] || [[ "$1" != "dev" && "$1" != "app" ]]; then
    echo "Usage: $0 <dev|app>"
    echo ""
    echo "  dev  → gs://tf-shared-artifacts-hellotrace-dev/duckdb/extensions/"
    echo "  app  → gs://tf-shared-artifacts-hellotrace-app/duckdb/extensions/"
    exit 1
fi

ENV="$1"
BUCKET="gs://tf-shared-artifacts-hellotrace-${ENV}/duckdb/extensions"
VERSION="$(cd "$ROOT_DIR/submodules/duckdb" && git describe --tags --abbrev=0)"

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
for cmd in gsutil curl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: '$cmd' not found."
        [[ "$cmd" == "gsutil" ]] && echo "  Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
        exit 1
    fi
done

# Check GCS access (bucket root — the extensions/ path may not exist yet)
BUCKET_ROOT="gs://tf-shared-artifacts-hellotrace-${ENV}"
if ! gsutil ls "$BUCKET_ROOT" &>/dev/null; then
    echo "ERROR: Cannot access $BUCKET_ROOT"
    echo ""
    echo "Check that:"
    echo "  1. You are authenticated:         gcloud auth login"
    echo "  2. You have access to the bucket: gsutil ls $BUCKET_ROOT"
    exit 1
fi

# ---------------------------------------------------------------------------
# Assemble extensions into extension-dist/ (hosted downloads + hash_ext build).
# fetch-extensions.sh is STRICT: it errors if any extension (including
# hash_ext) can't be captured, and set -e aborts here before anything is
# pushed to GCS.
# ---------------------------------------------------------------------------
echo "=== Assembling extensions for $VERSION into extension-dist/ ==="
for platform in "${PLATFORMS[@]}"; do
    echo ""
    echo "--- $platform ---"
    DEST_ROOT="$EXT_DIR" "$SCRIPT_DIR/fetch-extensions.sh" "$VERSION" "$platform"
done

# Drop stray macOS metadata so it doesn't get pushed
find "$EXT_DIR" -name '.DS_Store' -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------
echo ""
echo "=== Pushing extensions to $BUCKET ==="
echo ""
echo "Local:"
find "$EXT_DIR" -type f | sort | sed "s|$ROOT_DIR/||"
echo ""

gsutil -m rsync -r -x '.*\.DS_Store$' "$EXT_DIR" "$BUCKET"

echo ""
echo "=== Done ==="
echo "Remote: $BUCKET"
gsutil ls "$BUCKET/**" 2>/dev/null || true
