#!/usr/bin/env bash
# Test rig runner: starts server, opens browser, waits for report
# Usage: ./test-rig/run.sh [--keep-alive] [--no-open] [--port PORT] [--timeout MS]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${TEST_RIG_PORT:-9876}"
TIMEOUT="${TEST_RIG_TIMEOUT:-60000}"
KEEP_ALIVE=""
OPEN_BROWSER=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-alive) KEEP_ALIVE=1; shift;;
    --no-open) OPEN_BROWSER=0; shift;;
    --port) PORT="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

export TEST_RIG_PORT="$PORT"
export TEST_RIG_TIMEOUT="$TIMEOUT"
[[ -n "$KEEP_ALIVE" ]] && export TEST_RIG_KEEP_ALIVE=1

echo "Starting test rig on port $PORT..."

# Start server
node "$SCRIPT_DIR/server.mjs" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if [[ "$OPEN_BROWSER" == "1" ]]; then
  echo "Opening browser at http://localhost:$PORT/"
  if command -v open &>/dev/null; then
    open "http://localhost:$PORT/"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "http://localhost:$PORT/"
  else
    echo "Please open http://localhost:$PORT/ in your browser"
  fi
fi

# Wait for server to exit (it exits after receiving the report)
wait "$SERVER_PID"
EXIT_CODE=$?
trap - EXIT
exit $EXIT_CODE
