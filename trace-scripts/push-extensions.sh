#!/usr/bin/env bash
#
# Push native extension builds to a GCS bucket.
#
# Usage:
#   ./push-extensions.sh dev    # push to tf-shared-artifacts-dev
#   ./push-extensions.sh app    # push to tf-shared-artifacts-app
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension-dist"

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

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if [[ ! -d "$EXT_DIR" ]]; then
    echo "ERROR: $EXT_DIR not found. Build extensions first:"
    echo "  ./extensions/hash_ext/build-all.sh"
    exit 1
fi

EXT_COUNT=$(find "$EXT_DIR" -name "*.duckdb_extension" -not -name "*.gz" | wc -l | tr -d ' ')
if [[ "$EXT_COUNT" -eq 0 ]]; then
    echo "ERROR: No .duckdb_extension files found in $EXT_DIR"
    exit 1
fi

if ! command -v gcloud &>/dev/null; then
    echo "ERROR: gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check GCS access (check bucket root, not full path — path may not exist yet)
BUCKET_ROOT="gs://tf-shared-artifacts-hellotrace-${ENV}"
if ! gcloud storage ls "$BUCKET_ROOT" &>/dev/null 2>&1; then
    echo "ERROR: Cannot access $BUCKET"
    echo ""
    echo "Check that:"
    echo "  1. You are authenticated: gcloud auth login"
    echo "  2. You have access to the bucket: gcloud storage ls $BUCKET/"
    exit 1
fi

# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------
echo "=== Pushing extensions to $BUCKET ==="
echo ""
echo "Local:"
find "$EXT_DIR" -type f | sort | sed "s|$ROOT_DIR/||"
echo ""

gcloud storage rsync "$EXT_DIR" "$BUCKET" --recursive

echo ""
echo "=== Done ==="
echo "Remote: $BUCKET"
gcloud storage ls "$BUCKET/**" 2>/dev/null || true
