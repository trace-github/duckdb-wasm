# Claude Code Guidelines for duckdb-wasm

## Critical Rules

- **NEVER kill Chrome or any user application.** Do not use `pkill`, `kill`, or similar commands on Chrome, browsers, or any application the user may have open. This destroys the user's open tabs and work. If stale browser tabs cause issues (e.g., OPFS lock contention), use workarounds like unique file names per run. Only kill processes that were explicitly started by the current script/session.

## Build Instructions

**All builds MUST use the Docker container.** Do NOT build on the host machine directly — the Docker container has the correct versions of emscripten, binaryen, and all other build tools pinned and tested.

### Prerequisites

- Docker Desktop (with at least 16 GiB memory allocated for best performance)

### Build Steps

```shell
git clone https://github.com/ridge-ai/duckdb-wasm.git
cd duckdb-wasm
git submodule init
git submodule update
./build-wasm.sh
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
- **`docker-build.sh`** — Entrypoint script. Uses `build-docker/` as build prefix to avoid CMake cache conflicts with any host builds
- **`build-wasm.sh`** — Host-side wrapper. Builds the image, creates the cache volume, bind-mounts the repo, runs the build
- The `DUCKDB_WASM_BUILD_PREFIX` env var in `scripts/wasm_build_lib.sh` controls the build output directory (defaults to `${PROJECT_ROOT}/build` for native, set to `/src/build-docker` in Docker)

### Common Pitfalls

- **Do NOT build on the host machine.** Always use `./build-wasm.sh` or run via Docker.
- **Do NOT run `npm run build` from the repo root.** The root `package.json` maps `build` to `make build_wasm_all`, which triggers a full WASM recompile.
- **Do NOT run `make apply_patches`.** The patches were written for an older DuckDB and fail against v1.4.4. The build succeeds without them.

---

## Agent Instructions

### Submodules

DO NOT modify files in `submodules/` (duckdb, arrow, rapidjson) unless explicitly asked. The WASM build compiles against unmodified upstream sources.

If a build error appears to originate from submodule code, investigate whether the issue is in our build configuration (cmake flags, link order, missing defines) or in our wrapper code (`lib/src/`, `lib/include/`) before modifying upstream source.

**Current submodule versions (as of 2026-03-10):**
- DuckDB: `6ddac802ff` (v1.4.4)
- Arrow: `apache-arrow-17.0.0`
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

### DuckDB v1.4.4 API Notes

The current DuckDB submodule (v1.4.4) uses:
- `timestamp_t` for `FileSystem::GetLastModifiedTime` (not `time_t`)
- 7-arg `ClientProperties` constructor (includes `ArrowFormatVersion::V1_0` parameter)
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

**Run it:**
```
./test-rig/run.sh
```

This starts a local server (port 9876) with COOP/COEP headers, opens a browser, loads the built `dist/` package, runs diagnostic queries, and reports results back to stdout. Exit code 0 = PASS, 1 = FAIL, 2 = timeout.

**Options:**
- `--keep-alive` — Keep server running after report (for iterating in the browser)
- `--no-open` — Don't auto-open browser
- `--port PORT` — Custom port (default 9876)
- `--timeout MS` — Custom timeout (default 60s)

**What it tests:** Module loading, bundle selection (tries EH → COI → MVP), database open/connect, version query, computation, generate_series, table CRUD, and extension availability (json, parquet).

**Use this after JS/TS changes** to verify the built package works in a browser. The server prints all logs, errors, and query results to the terminal so you can act on failures without needing to open browser DevTools.

### Debugging Build Failures

1. **`wasm-opt` unknown option errors** — Binaryen version mismatch. The Dockerfile installs binaryen v126 to fix this.
2. **Submodule compile errors (arrow types, decimal, extension loading)** — Do NOT apply patches. Build without them. If errors persist, they are likely in our wrapper code in `lib/`.
3. **`ClientProperties` constructor mismatch** — Must be 7 args including `ArrowFormatVersion::V1_0`.
4. **`DBConfigOptions` missing member** — Some options moved to `SetOption()` in v1.4.x (e.g., `arrow_lossless_conversion`). Check against the submodule's `config.hpp`.
5. **CMake cache conflicts** — The Docker build uses `build-docker/` via `DUCKDB_WASM_BUILD_PREFIX` to avoid conflicts with host build caches.
