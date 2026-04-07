#!/usr/bin/env bash
#
# Run the DuckDB-WASM thread benchmark in a browser via Puppeteer.
#
# Usage:
#   ./test-rig/run-bench.sh [options]
#
# Options:
#   --keep-alive      Keep server and browser open after results are reported
#   --no-open         (passed through; no-op — Puppeteer always opens a tab)
#   --port PORT       Server port (default 9876)
#   --timeout MS      Timeout in milliseconds (default 300000 = 5 minutes)
#   --debug-port PORT Chrome remote debugging port (default 9222)
#
# The benchmark tests DuckDB-WASM COI build (pthread) with 1, 2, 4, 8 threads.
# Results are printed to stdout as they arrive; exit code 0 = PASS, 1 = FAIL.
#
# Requires:
#   - node (v18+)
#   - puppeteer-core (already in test-rig/node_modules)
#   - Google Chrome (or set CHROME_PATH)
#   - Built dist/ files (packages/duckdb-wasm/dist/)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Default options
PORT=9876
TIMEOUT=300000   # 5 minutes — benchmarks are slow
KEEP_ALIVE=""
DEBUG_PORT=9222

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-alive)   KEEP_ALIVE="--keep-alive"; shift ;;
    --no-open)      shift ;;   # no-op for compatibility with run.sh callers
    --port)         PORT="$2"; shift 2 ;;
    --timeout)      TIMEOUT="$2"; shift 2 ;;
    --debug-port)   DEBUG_PORT="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--keep-alive] [--port PORT] [--timeout MS] [--debug-port PORT]" >&2
      exit 1
      ;;
  esac
done

echo "=== DuckDB-WASM Thread Benchmark ==="
echo "Port:        $PORT"
echo "Timeout:     ${TIMEOUT}ms"
echo "Debug port:  $DEBUG_PORT"
echo ""

exec node "${SCRIPT_DIR}/puppeteer-run.mjs" \
  --bench-threads \
  --port "$PORT" \
  --timeout "$TIMEOUT" \
  --debug-port "$DEBUG_PORT" \
  $KEEP_ALIVE
