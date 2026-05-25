#!/usr/bin/env bash
# Run all test rig suites sequentially. Exit code 0 = all passed.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="node $ROOT_DIR/test-rig/puppeteer-run.mjs"

PASS=()
FAIL=()

run() {
    local name="$1"
    local flag="$2"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if $RUNNER $flag; then
        PASS+=("$name")
    else
        FAIL+=("$name")
    fi
}

run "Smoke tests (default)"  ""
run "OPFS open + COPY"       "--opfs-open"
run "OPFS persistence"       "--opfs-persist --timeout 120000"
run "DB stress"              "--db-stress"
run "File I/O stress"        "--file-stress"
run "Rust hash extension"    "--hash-ext --timeout 120000"
run "Lua extension"          "--lua"
run "Buffer registration"    "--buffer-reg"
run "Metric table"           "--metric-table"

# Node.js smoke tests
(cd "$ROOT_DIR/test-node" && npm install --silent)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Node.js WASM smoke test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if node "$ROOT_DIR/test-node/wasm-smoke-test.mjs"; then
    PASS+=("Node.js WASM smoke test")
else
    FAIL+=("Node.js WASM smoke test")
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Node.js WASM in application worker thread"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if node "$ROOT_DIR/test-node/wasm-worker-test.mjs"; then
    PASS+=("Node.js WASM in application worker thread")
else
    FAIL+=("Node.js WASM in application worker thread")
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Node.js hash_ext native smoke test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if node "$ROOT_DIR/test-node/smoke-test.mjs"; then
    PASS+=("Node.js hash_ext native smoke test")
else
    FAIL+=("Node.js hash_ext native smoke test")
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RESULTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[ ${#PASS[@]} -gt 0 ] && for t in "${PASS[@]}"; do echo "  PASS  $t"; done
[ ${#FAIL[@]} -gt 0 ] && for t in "${FAIL[@]}"; do echo "  FAIL  $t"; done
echo ""

NFAIL=${#FAIL[@]}
if [ "$NFAIL" -gt 0 ]; then
    echo "$NFAIL suite(s) failed."
    exit 1
else
    echo "All ${#PASS[@]} suite(s) passed."
    exit 0
fi
