# Claude Code Guidelines for duckdb-wasm

## Build Instructions

**All builds MUST use the Docker container.** Do NOT build on the host machine directly — the Docker container has the correct versions of emscripten, binaryen, and all other build tools pinned and tested.

### Prerequisites

- Docker Desktop (with at least 16 GiB memory allocated for best performance)

### Build Steps

```shell
git clone https://github.com/trace-github/duckdb-wasm.git
cd duckdb-wasm
git submodule init
git submodule update
./scripts/build-wasm.sh
```

This builds the Docker image (first time only), then builds all three WASM targets (MVP, EH, COI) and the JS/TS package inside the container.

**Do NOT run `make apply_patches`.** The patches in `patches/` are outdated and do not apply cleanly to the current DuckDB submodule (v1.4.4). The build works without them.

### Build Artifacts

- WASM bindings: `packages/duckdb-wasm/src/bindings/duckdb-{mvp,eh,coi}.{wasm,js}`
- JS distribution: `packages/duckdb-wasm/dist/`

### Build Performance

A `duckdb-wasm-cache` Docker volume persists ccache across runs:
- Cold build (first time): ~30-35 min
- Warm build (no source changes): ~1 min
- Incremental build (some changes): ~5-10 min

### Docker Build Details

- **`Dockerfile`** — Debian image with emscripten 4.0.3 (includes binaryen v126), ccache, Node 20
- **`scripts/docker-build.sh`** — Entrypoint script (copied into the image). Uses `build-docker/` as build prefix to avoid CMake cache conflicts with any host builds
- **`scripts/build-wasm.sh`** — Host-side wrapper. Builds the image, creates the cache volume, bind-mounts the repo, runs the build
- The `DUCKDB_WASM_BUILD_PREFIX` env var in `scripts/wasm_build_lib.sh` controls the build output directory (defaults to `${PROJECT_ROOT}/build` for native, set to `/src/build-docker` in Docker)

### Common Pitfalls

- **Do NOT build on the host machine.** Always use `./scripts/build-wasm.sh` or run via Docker.
- **Do NOT run `npm run build` from the repo root.** The root `package.json` maps `build` to `make build_wasm_all`, which triggers a full WASM recompile.
- **Do NOT run `make apply_patches`.** The patches were written for an older DuckDB and fail against v1.4.4. The build succeeds without them.

---

## Agent Instructions

### Submodules

**ABSOLUTE RULE: NEVER modify any file under `submodules/`.** This means do not edit, patch, or overwrite any file whose path starts with `submodules/` — not `submodules/arrow/`, not `submodules/duckdb/`, not any other. This rule has been violated repeatedly and causes real issues: local submodule changes cannot be committed to the parent repo and break `git submodule update` for every developer on every machine.

**Before editing any file, check its path. If it starts with `submodules/`, stop.**

If you have accidentally modified a submodule file, revert it immediately:
```
git -C submodules/<name> checkout -- <file>
```

If a build error appears to originate from submodule code, investigate whether the issue is in our build configuration (cmake flags, link order, missing defines) or in our wrapper code (`lib/src/`, `lib/include/`) before modifying upstream source. If an upstream fix is truly required, put it in `patches/` and apply it in the Docker build script — do not modify the submodule source directly.

**Current submodule versions (as of 2026-04-07):**
- DuckDB: `6ddac802ff` (v1.4.4)
- Arrow: `6a2e19a852` (apache-arrow-17.0.0)
- RapidJSON: `973dc9c06d`

### Patches (OUTDATED - DO NOT APPLY)

The `patches/` directory contains patch files that were written for older DuckDB versions. They **do not apply cleanly** to v1.4.4 and are **not needed** for a successful build.

### Build System

- DuckDB is built as a CMake ExternalProject in `lib/cmake/duckdb.cmake`
- Three WASM targets: MVP, EH (exception handling), COI (cross-origin isolation with threads)
- Extensions (json, parquet, icu, tpcds, tpch) are statically linked via `extension_config_wasm.cmake` and `LoadStaticExtension<T>()` calls
- Extension init calls are in `lib/src/webdb.cc` (see `duckdb_web_*_init` functions)
- Emscripten 4.0.3 is pinned in the Dockerfile. Do not change the version.
- Binaryen v126 is bundled with emscripten 4.0.3 (supports `--enable-bulk-memory-opt`)
- Arrow COI build: `-msimd128` is stripped from Arrow's compile flags in `lib/cmake/arrow.cmake`. This is required because Arrow 17.0.0's vendored xxhash conditionally includes `arm_neon.h` when `__wasm_simd128__` is defined but does so inside an `extern "C"` block, breaking Emscripten's `em_asm.h` C++ templates. Arrow's SIMD is disabled (`ARROW_SIMD_LEVEL=NONE`) so this flag is safe to strip.
- Emscripten 4.x no longer generates a separate `duckdb_wasm.worker.js` pthread file. `scripts/wasm_build_lib.sh` generates a `duckdb-coi.pthread.js` stub that works with Emscripten 4.x's new protocol (the COI JS itself handles pthread init when loaded with `{ name: "em-pthread" }`).
- The `packages/duckdb-wasm/src/targets/duckdb-browser-coi.pthread.worker.ts` worker uses Emscripten 4.x's `handleMessage`/`startWorker` protocol: forwards `load` to Emscripten's handler, overrides `startWorker` to capture the module instance, then re-registers DuckDB-specific handlers.

### DuckDB v1.4.4 API Notes

The current DuckDB submodule (v1.4.4) uses:
- `timestamp_t` for `FileSystem::GetLastModifiedTime` (not `time_t`)
- 7-arg `ClientProperties` constructor — we use `ArrowFormatVersion::V1_5` (enables Decimal32/64 for narrow decimals; note: BLOB/BIT columns will use BinaryView format which requires a flechette-compatible Arrow parser)
- `db_config.SetOption("arrow_lossless_conversion", ...)` (not direct struct member access)
- `db_config.options.allow_unsigned_extensions`, `db_config.options.duckdb_api`, etc. remain as direct struct fields
- `autoload_known_extensions` and `autoinstall_known_extensions` options have been removed
- Built-in HTTP support via `HTTPWasmUtil` (registered in `webdb.cc`)
- Encryption support via mbedtls (`AESStateMBEDTLSFactory`)

Do NOT change these to different API patterns unless the DuckDB submodule is actually upgraded.

### JS Build

To rebuild only the JS/TS layer (without recompiling WASM):
```
cd packages/duckdb-wasm
npx vite build && node bin/bundle.mjs release && npx tsc
```

Do NOT run `npm run build` from the repo root — it triggers `make build_wasm_all`.

### Type Declarations

The `.d.ts` path in `bin/bundle.mjs` must match the actual tsc output structure. TypeScript outputs to `dist/types/` with the `src/` prefix stripped (e.g., `dist/types/targets/duckdb.d.ts`, not `dist/types/src/targets/duckdb.d.ts`).

### Browser Test Rig

A browser test rig is available at `test-rig/` for verifying the built JS/WASM package end-to-end in a real browser with Cross-Origin Isolation.

### Critical Rules

- **NEVER kill Chrome or any user application.** Do not use `pkill`, `kill`, or similar commands on Chrome, browsers, or any application the user may have open. This destroys the user's open tabs and work. If stale browser tabs cause issues (e.g., OPFS lock contention), use workarounds like unique file names per run. Only kill processes that were explicitly started by the current script/session.

**Run the full test suite:**
```
./scripts/run-tests.sh
```

This runs all browser test suites sequentially. Exit code 0 = all passed.

**Run a single test:**
```
node test-rig/puppeteer-run.mjs [--coi | --opfs-persist | --db-stress | --file-stress | --hash-ext | --evalexpr | --lua | --buffer-reg | --metric-table | --wasmfs]
```

Options: `--keep-alive` (keep server/browser open), `--port PORT`, `--timeout MS`.

**Smoke test** (`./scripts/run-tests.sh` with no flag) tests EH/COI/MVP bundle selection, DuckDB version, queries, extensions, and decimal parsing via Apache Arrow IPC.

**WasmFS OPFS test** uses a C program compiled by the Docker build. The `wasmfs_test.js`/`.wasm` files are produced by `./scripts/build-wasm.sh` and copied into `test-rig/` automatically.

**Arrow bundle** (`test-rig/arrow-bundle.mjs`) is a bundled version of `apache-arrow` for browser use. It is gitignored (not committed) and is built by `./scripts/build-wasm.sh` as part of the normal Docker build. To rebuild it manually: `cd test-rig && npm run build`.

**Use this after JS/TS changes** to verify the built package works in a browser. The server prints all logs, errors, and query results to the terminal so you can act on failures without needing to open browser DevTools.

### Rust Extensions for WASM

**IMPORTANT:** Rust extensions in this repo target `wasm32-unknown-emscripten` and run **in the browser via DuckDB WASM**. They are NOT loadable `.duckdb_extension` files for native DuckDB. The real WASM target requires a completely different approach from native DuckDB extensions.

#### Correct architecture (follow `evalexpr_rhai_wasm/` as the reference)

1. **Rust crate** — `crate-type = ["staticlib"]`, no `duckdb` crate dependency. Exposes raw `extern "C"` functions that operate on **batches** (pointers + lengths), not individual rows. Compiled to `wasm32-unknown-emscripten`.

2. **C++ glue** (`lib/src/extensions/`) — A DuckDB extension (`.cc`) that registers scalar/table functions with DuckDB's C++ API. The registered functions call the Rust batch functions once per vector (~2048 rows). Zero per-row FFI overhead.

3. **CMake** (`lib/cmake/`) — Imports the pre-built Rust `.a` staticlib as `IMPORTED STATIC`. Two variants: `cargo-target-nothreads` (MVP/EH) and `cargo-target-threads` (COI). See `lib/cmake/evalexpr_rhai.cmake`.

4. **Init** (`lib/src/webdb.cc`) — Calls `duckdb_web_<ext>_init(db.get())` to register the extension.

5. **Docker build** (`scripts/docker-build.sh`) — Compiles the Rust staticlib twice (no-threads and threads) before the CMake step, using emscripten as the linker. See the `evalexpr_rhai_wasm` block in `scripts/docker-build.sh` for the exact cargo invocation with RUSTFLAGS for both variants.

6. **Test rig** — Browser-based, like `test-rig/`. NOT a native DuckDB CLI test.

#### Why not the scripting/rhai approach

The `evalexpr_rhai_wasm` extension was observed to be too slow for production use — the scripting engine overhead dominates. Direct compiled Rust (as in `hash_ext_wasm/`) is the right approach. The FFI boundary is cheap when called once per batch, not once per row.

### Debugging Build Failures

1. **`wasm-opt` unknown option errors** — Binaryen version mismatch. The Dockerfile installs binaryen v126 to fix this.
2. **Submodule compile errors (arrow types, decimal, extension loading)** — Do NOT apply patches. Build without them. If errors persist, they are likely in our wrapper code in `lib/`.
3. **`ClientProperties` constructor mismatch** — Must be 7 args including `ArrowFormatVersion::V1_0`.
4. **`DBConfigOptions` missing member** — Some options moved to `SetOption()` in v1.4.x (e.g., `arrow_lossless_conversion`). Check against the submodule's `config.hpp`.
5. **CMake cache conflicts** — The Docker build uses `build-docker/` via `DUCKDB_WASM_BUILD_PREFIX` to avoid conflicts with host build caches.
