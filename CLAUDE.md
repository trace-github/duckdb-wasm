# duckdb-wasm-trace

Fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) with statically linked extensions.

## What this repo does

Builds `@run-trace/duckdb-wasm` — the upstream duckdb-wasm package with bundled extensions so they don't need runtime installation. Zero changes to upstream TypeScript/JavaScript source.

## Bundled extensions

json, parquet, icu, tpcds, tpch, fts, hash_ext (custom Rust), lua

## Key rules

- **Never modify upstream source** — `packages/duckdb-wasm/src/`, `bundle.mjs`, `wasm_build_lib.sh`, `arrow.cmake` are untouched
- **Only `package.json`** changes in the upstream package (name, version)
- **Post-build bundle patch** — `dist/duckdb-node.cjs` is patched by `trace-scripts/patch-node-bundle.mjs` after every WASM build (called automatically by `build-wasm.sh`). This is NOT a source modification — `dist/` is not tracked in git. The patch exports `NodeWorker` and guards `He()` so DuckDB works in Node.js worker threads.
- **Use `yarn install` inside the Docker build** (not npm) — upstream's `yarn.lock` pins compatible dep versions. This only applies to the WASM build container, not to client projects consuming the published package.
- **If tests fail, the build is wrong** — never change tests to fix builds
- **Reset submodules before committing** — Docker builds patch duckdb/arrow/rapidjson in-place; reset with `git checkout -- . && git clean -fd` in each submodule

## Building

```bash
./trace-scripts/build-wasm.sh          # WASM (Docker)
./extensions/hash_ext/build-all.sh     # Native extensions (4 platforms)
./trace-scripts/run-tests.sh           # All tests
./trace-scripts/clean.sh --all         # Full clean
```

## Testing

- Browser: Puppeteer test rig (`test-rig/`)
- Node WASM main thread: `test-node/wasm-smoke-test.mjs`
- Node WASM worker thread: `test-node/wasm-worker-test.mjs`
- Node native extension: `test-node/smoke-test.mjs`

## Skills

- **Upgrading DuckDB version**: `.claude/skills/upgrade-duckdb-wasm/`
- **Committing and publishing**: `.claude/skills/commit-and-publish-duckdb-wasm/`
