#!/usr/bin/env bash
# Run all test rig suites sequentially. Exit code 0 = all passed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="node $SCRIPT_DIR/test-rig/puppeteer-run.mjs"

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
run "COI + threading"        "--coi"
run "WasmFS OPFS"            "--wasmfs"
run "OPFS persistence"       "--opfs-persist"
run "DB stress"              "--db-stress"
run "File I/O stress"        "--file-stress"
run "Rust hash extension"    "--hash-ext"
run "Evalexpr (Rhai)"        "--evalexpr"
run "Lua extension"          "--lua"
run "Buffer registration"    "--buffer-reg"
run "Metric table"           "--metric-table"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  RESULTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for t in "${PASS[@]}"; do echo "  PASS  $t"; done
for t in "${FAIL[@]}"; do echo "  FAIL  $t"; done
echo ""

if [ ${#FAIL[@]} -gt 0 ]; then
    echo "${#FAIL[@]} suite(s) failed."
    exit 1
else
    echo "All ${#PASS[@]} suites passed."
    exit 0
fi
