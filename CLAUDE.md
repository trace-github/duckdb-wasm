# duckdb-wasm-trace

Fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) with statically linked extensions.

## What this repo does

Builds `@run-trace/duckdb-wasm` — the upstream duckdb-wasm package with bundled extensions so they don't need runtime installation.

## Bundled extensions

json, parquet, icu, tpcds, tpch, fts, hash_ext (custom Rust), lua

## Build variants

- **COI** (browser) — pthreads + WasmFS for native OPFS. Uses Emscripten 4.0.3.
- **EH** (node) — wasm exceptions, no threads. Uses Emscripten 4.0.3.
- MVP was removed — all modern browsers support COI.

## Key rules

- **Never commit, push, publish, or create branches unless the user explicitly asks** — make changes in the working tree only. Do not run `git commit`, `git push`, `git branch`/`git checkout -b`, `npm publish`, `trace-scripts/publish.sh`, or `trace-scripts/push-extensions.sh` on your own initiative. Each requires an explicit request for that specific action.
  - A **conditional** pre-authorization ("publish if the tests pass") is NOT a green light to publish autonomously. `npm publish` and GCS pushes are irreversible/outward — report the result and get a fresh, explicit "publish now" immediately before doing it. Never treat an earlier "if it works" as a standing approval.
  - "Tests pass" only counts as a **complete** `run-tests.sh` run with prerequisites built (native extension via `build-all.sh` — see Testing) on the relevant machine. A single local green run is not a robust pass; surface caveats (machine-dependent timeouts, prerequisites) rather than concluding "everything works."
- **Minimal upstream source changes** — `packages/duckdb-wasm/src/` changes are limited to removing MVP support (`platform.ts`, blocking targets, node base bindings). `wasm_build_lib.sh` and `arrow.cmake` are untouched.
- **Post-build bundle patches** — `dist/` files are patched after every WASM build (called automatically by `build-wasm.sh`). These are NOT source modifications — `dist/` is not tracked in git.
  - `trace-scripts/patch-node-bundle.mjs` — patches `dist/duckdb-node.cjs` to export `NodeWorker` and guard the worker bootstrap so DuckDB works in Node.js worker threads. Uses regex patterns (not minified variable names) for robustness.
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

**Prerequisite — `run-tests.sh` does NOT build the native extension.** The "Node.js hash_ext native smoke test" (`test-node/smoke-test.mjs`) requires `extension-dist/` to already exist; if it's absent the suite fails with "extension-dist/ not found", and `run-tests.sh` neither builds it nor skips it. So a full pass requires `./extensions/hash_ext/build-all.sh` (4-platform Rust cross-compile) to have run first. `build-wasm.sh` + `run-tests.sh` alone will always fail that suite. (This is a native-artifact prerequisite only — it does not affect the published WASM package, which doesn't use the native builds.)

**Timeout caveat.** The browser "Rust hash extension" suite (`--hash-ext`) runs 10M-row perf steps under a hardcoded `--timeout 120000`. On slower hardware it can exceed 120s and report a FAIL even though every assertion passes — check the suite log for a timeout vs. an actual assertion failure before treating it as broken.

**Don't trust the `Status: PASS` / suite summary alone — scan the FULL page output for errors.** A suite can report PASS while a real page/worker error is logged. In particular an async error in the COI pthread worker (e.g. `Uncaught ReferenceError: Module is not defined` at `dist/duckdb-browser-coi.pthread.worker.js`) can fire *after* the page already sent its PASS report, so the FAIL report is swallowed (`_reported` is already true) and the rig still prints PASS. Before declaring any run clean, grep the captured output for: `[BROWSER:PAGEERROR]`, `[BROWSER:ERROR]`, `Global error:`, `Module is not defined`, `ReferenceError`, `worker sent an error`. Capture the whole run (not just `tail`) — reading only the summary will miss these. Note many suites use `maximumThreads: 1` and never spawn the pthread worker, so they pass even if it's broken; verify the COI pthread worker with a genuinely multi-threaded suite (`--db-stress`, `--file-stress`, `--thread-file-stress`, `--wasmfs`).

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
