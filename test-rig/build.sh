#!/usr/bin/env bash
# Build the Apache Arrow browser bundle required by the test rig.
# Run this after `npm install` if arrow-bundle.mjs is missing.
# The Docker build (./trace-scripts/build-wasm.sh) runs this automatically.
set -euo pipefail

cd "$(dirname "$0")"
npm install
node_modules/.bin/esbuild node_modules/apache-arrow/Arrow.dom.mjs \
    --bundle --format=esm --outfile=arrow-bundle.mjs --platform=browser
