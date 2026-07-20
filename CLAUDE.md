# duckdb-wasm-trace

Fork of [duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) with statically linked extensions.

## What this repo does

Builds `@run-trace/duckdb-wasm` — the upstream duckdb-wasm package with bundled extensions so they don't need runtime installation.

## Bundled extensions

json, parquet, icu, tpcds, tpch, fts, hash_ext (custom Rust), lua, quack (client-server protocol; client-only on wasm)

## Build variants

- **COI** (browser) — pthreads + WasmFS for native OPFS. Uses Emscripten 4.0.3.
- **EH** (node) — wasm exceptions, no threads. Uses Emscripten 4.0.3.
- MVP was removed — all modern browsers support COI.

## Key rules

- **Never commit, push, publish, or create branches unless the user explicitly asks** — make changes in the working tree only. Do not run `git commit`, `git push`, `git branch`/`git checkout -b`, `npm publish`, `trace-scripts/publish.sh`, or `trace-scripts/push-extensions.sh` on your own initiative. Each requires an explicit request for that specific action.
  - A **conditional** pre-authorization ("publish if the tests pass") is NOT a green light to publish autonomously. `npm publish` and GCS pushes are irreversible/outward — report the result and get a fresh, explicit "publish now" immediately before doing it. Never treat an earlier "if it works" as a standing approval.
  - "Tests pass" only counts as a **complete** `run-tests.sh` run with prerequisites built (native extension via `build-all.sh` — see Testing) on the relevant machine. A single local green run is not a robust pass; surface caveats (machine-dependent timeouts, prerequisites) rather than concluding "everything works."
- **Release order: test → publish to npm → push extensions → clean → commit** (each step still needs its own explicit go-ahead per the rule above). Publish and extension-push must come **before** clean because they need built assets we don't commit (`dist/`, `extension-dist/`, the `src/bindings/` Emscripten artifacts) and `clean.sh` deletes them; clean (including submodule resets) must come **before** commit so no build artifacts or dirty submodules land in git. See `.claude/skills/commit-and-publish-duckdb-wasm/` for the per-step details.
- **Minimal upstream source changes** — `packages/duckdb-wasm/src/` changes are limited to removing MVP support (`platform.ts`, blocking targets, node base bindings), the HTTP-options feature (see below), and the shared-memory heap-growth guard (see below). `wasm_build_lib.sh` and `arrow.cmake` are untouched.
- **Heap-growth guard (`viewHeapU8`) — TS source fix** — in the COI build any pthread can grow the shared wasm memory; the main worker's `mod.HEAPU8` then still views the old, shorter SharedArrayBuffer (Emscripten refreshes views only lazily via its glue-internal `GROWABLE_HEAP_*` accessors), so constructing a `Uint8Array` view past its end threw `RangeError: Invalid typed array length: <n>` intermittently (user-visible in `registerFileBuffer`; also the old `--hash-ext` `copyBuffer` flake). `viewHeapU8(mod, begin, length)` in `src/bindings/runtime.ts` detects a too-short view, forces a glue refresh via the exported `mod.stringToUTF8('', 0, 0)` (a no-op write that runs the `GROWABLE_HEAP_U8` staleness check *before* its zero-write guard — verified against the Emscripten 4.0.3 glue), and throws a descriptive error if the span genuinely exceeds memory. All direct heap accesses in `bindings_base.ts`, `runtime.ts`, `runtime_browser.ts`, and `udf_runtime.ts` route through it (or `viewHeapF64` for the packed f64 response blocks — whose raw indexed form both silently dropped out-of-bounds writes on a stale view AND broke for >2GB pointers via the signed `>> 3`). `runtime_node.ts` is intentionally untouched: the EH/node build is single-threaded, so its views can never be stale. Unit spec: `test/heap_growth.test.ts` (runs in the jasmine node/browser suites). After an Emscripten bump, re-verify the `stringToUTF8`/`GROWABLE_HEAP_U8` glue contract (see the upgrade skill).
- **HTTP options (cookies + custom headers) — TS source feature** — `await db.open({ http: { withCredentials: ['<url-pattern>'], headers: { '<url-pattern>': {...} } } })` makes engine HTTP requests (quack `/quack` calls, `read_parquet('https://...')` reads) send cookies and/or extra headers. Patterns are prefixes or globs (see below). Implemented in fork TS source (not a dist patch):
  - `src/bindings/http_options.ts` — config store (`globalThis.__DUCKDB_HTTP__`, read lazily per request; a blob-importScripts bootstrap may set it directly) + `installHTTPOptionsHooks()` (hooks `XMLHttpRequest.prototype` — covers both the EM_ASM XHRs from `lib/src/http_wasm.cc` and `runtime_browser.ts` — and wraps `Worker` to inject config into later-spawned pthreads). URL matching (both `withCredentials` entries and `headers` keys): a pattern with no `*` is a literal **prefix** (`startsWith`); a pattern with `*` is a **glob** (`*` = any chars except `/`, `**` = across `/`, start-anchored) — e.g. `https://*.trace.dev:8080`. `*` is slash-bounded so path/query content can't satisfy a host pattern.
  - `src/bindings/config.ts` — `DuckDBHTTPConfig` type + `DuckDBConfig.http` field.
  - `src/parallel/worker_dispatcher.ts` — lifts `http` off the OPEN config (C++ ignores the extra key).
  - `src/targets/duckdb-browser-coi.worker.ts` / `duckdb-browser-coi.pthread.worker.ts` — install hooks; pthread target additionally consumes the `cmd:"__duckdb_http__"` re-broadcast for pthreads spawned before `open()` (the `-sPTHREAD_POOL_SIZE=4` pool workers, which pre-spawn at instantiate with no config to bootstrap). The pthread target must recapture `self.onmessage` right after calling `DuckDB(m)`: the Emscripten 4.x glue bundles the pthread bootstrap into the main module and synchronously installs its own `handleMessage`, which would otherwise swallow every custom command (`registerFileHandle` & co included) with a `worker: received unknown command <cmd>` console error. Guarded by the E2E's "no unknown-command worker errors" assertion.
  - Cross-origin cookies additionally require the server to echo the exact `Origin` (not `*`) and send `Access-Control-Allow-Credentials: true`; custom headers must be allowed in the OPTIONS preflight. E2E: `node test-node/xhr-http-options-test.mjs`.
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

### Local JS-only rebuild (no Docker)

TS-source changes (e.g. `http_options.ts`) don't need the Docker wasm build: `cd packages/duckdb-wasm && npm run build:release`, then re-apply the post-build patches (`node trace-scripts/patch-node-bundle.mjs && node trace-scripts/patch-browser-workers.mjs` — `bundle.mjs` wipes `dist/`). Prerequisites:

- `src/bindings/` must contain the Emscripten artifacts: `duckdb-{coi,eh}.wasm` (copy back from `dist/`) and `duckdb-coi.js` / `duckdb-eh.js` / `duckdb-coi.pthread.js` (if cleaned, recover from the dist sourcemaps' `sourcesContent` — `duckdb-browser-coi.worker.js.map`, `duckdb-node-eh.worker.cjs.map`, `duckdb-browser-coi.pthread.worker.js.map`).
- `node_modules` must match `yarn.lock`. There is NO package-lock, so ANY `npm install` (including `npm version`) re-resolves the tree to latest-satisfying and silently drifts `typescript`, `@types/emscripten`, `web-worker`, `wasm-feature-detect` — which breaks `tsc --emitDeclarationOnly` (TS ≥5.7 SharedArrayBuffer typing) or changes bundle output (`web-worker` drift breaks `patch-node-bundle.mjs` anchors). Fix by pinning all of them together in one command with versions from `yarn.lock`: `npm install --no-save --no-package-lock typescript@5.3.3 @types/emscripten@1.39.10 web-worker@1.2.0 wasm-feature-detect@1.6.1`.
- On macOS the Docker-installed esbuild binary is linux-x64; add `@esbuild/darwin-arm64@<esbuild version>` the same way.

## Testing

- Browser: Puppeteer test rig (`test-rig/`)
- Node WASM main thread: `test-node/wasm-smoke-test.mjs`
- Node WASM worker thread: `test-node/wasm-worker-test.mjs`
- Node native extension: `test-node/smoke-test.mjs`

**Prerequisite — `run-tests.sh` does NOT build the native extension.** The "Node.js hash_ext native smoke test" (`test-node/smoke-test.mjs`) requires `extension-dist/` to already exist; if it's absent the suite fails with "extension-dist/ not found", and `run-tests.sh` neither builds it nor skips it. So a full pass requires `./extensions/hash_ext/build-all.sh` (4-platform Rust cross-compile) to have run first. `build-wasm.sh` + `run-tests.sh` alone will always fail that suite. (This is a native-artifact prerequisite only — it does not affect the published WASM package, which doesn't use the native builds.)

**Timeout caveat.** The browser "Rust hash extension" suite (`--hash-ext`) runs 10M-row perf steps under a hardcoded `--timeout 120000`. On slower hardware it can exceed 120s and report a FAIL even though every assertion passes — check the suite log for a timeout vs. an actual assertion failure before treating it as broken. The same suite used to intermittently FAIL with `RangeError: Invalid typed array length: <n>` (an upstream shared-memory growth race — pthread grows wasm memory, main worker's `mod.HEAPU8.buffer` goes stale). Fixed 2026-07-16 by the `viewHeapU8` heap-growth guard (see Key rules); if this RangeError ever reappears, it is a real regression, not a known flake.

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
