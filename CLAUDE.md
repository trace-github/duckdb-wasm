# duckdb-wasm-trace

Fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) with statically linked extensions.

## What this repo does

Builds `@run-trace/duckdb-wasm` — the upstream duckdb-wasm package with bundled extensions so they don't need runtime installation. Zero changes to upstream TypeScript/JavaScript source.

## Bundled extensions

json, parquet, icu, tpcds, tpch, fts, hash_ext (custom Rust), lua

## Key rules

- **Never modify upstream source** — `packages/duckdb-wasm/src/`, `bundle.mjs`, `wasm_build_lib.sh`, `arrow.cmake` are untouched
- **Only `package.json`** changes in the upstream package (name, version)
- **Post-build bundle patches** — `dist/` files are patched after every WASM build (called automatically by `build-wasm.sh`). These are NOT source modifications — `dist/` is not tracked in git.
  - `trace-scripts/patch-node-bundle.mjs` — patches `dist/duckdb-node.cjs` to export `NodeWorker` and guard `He()` so DuckDB works in Node.js worker threads.
  - `trace-scripts/patch-browser-workers.mjs` — patches `dist/duckdb-browser-*.worker.js` to fix a DuckDB v1.5.2 OPFS path normalization regression (see "OPFS browser worker patch" section below).
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

## OPFS browser worker patch

`trace-scripts/patch-browser-workers.mjs` fixes a DuckDB v1.5.2 regression that breaks OPFS database storage in browsers.

**The bug:** DuckDB's C++ internally opens the database file a second time using a normalized path (`opfs:/file.db` with a single slash) instead of the original `opfs://file.db` (double slash). The JS runtime's `inferDataProtocol("opfs:/...")` doesn't recognize the single-slash form and defaults to `BROWSER_FILEREADER` (read-only). The C++ `Write()` then throws "HTML FileReaders do not support writing".

**What the patch does:**
- Registers OPFS files with the C++ filesystem under both `opfs://` and `opfs:/` path forms, so the second internal open finds the file with the correct `BROWSER_FSACCESS` protocol
- Stores OPFS handles in JS maps under both key forms for the same reason
- Removes a `getSize()` check that skipped registration for new (empty) database files
- Guards the COI worker's `postMessage` of OPFS handles to pthreads — `FileSystemSyncAccessHandle` cannot be structured-cloned, so the upstream code throws `DataCloneError` on the COI bundle without this guard. File I/O still works because it's proxied through the main worker thread.

**When to revert:** This patch can be removed when upstream duckdb-wasm fixes the path normalization. Track: https://github.com/duckdb/duckdb-wasm/issues — look for issues related to OPFS path handling or `inferDataProtocol`. The fix would be either (a) upstream stops normalizing `opfs://` to `opfs:/` internally, or (b) upstream's `inferDataProtocol` recognizes both `opfs://` and `opfs:/` prefixes. To test if the patch is still needed: remove the `patch-browser-workers.mjs` call from `build-wasm.sh`, rebuild, and run `node test-rig/puppeteer-run.mjs --opfs-open`.

## Skills

- **Upgrading DuckDB version**: `.claude/skills/upgrade-duckdb-wasm/`
- **Committing and publishing**: `.claude/skills/commit-and-publish-duckdb-wasm/`
