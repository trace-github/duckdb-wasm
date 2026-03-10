# Claude Code Guidelines for duckdb-wasm

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

**Do NOT run `make apply_patches`.** The patches in `patches/` are outdated and do not apply cleanly to the current DuckDB submodule (v1.3.0). The build works without them. See "Patches" section below for details.

### Build Artifacts

- WASM bindings: `packages/duckdb-wasm/src/bindings/duckdb-{mvp,eh,coi}.{wasm,js}`
- JS distribution: `packages/duckdb-wasm/dist/`

### Build Performance

A `duckdb-wasm-cache` Docker volume persists ccache across runs:
- Cold build (first time): ~30-35 min
- Warm build (no source changes): ~1 min
- Incremental build (some changes): ~5-10 min

### Docker Build Details

- **`Dockerfile`** — Debian image with emscripten 3.1.57, binaryen v126, ccache, Node 20
- **`docker-build.sh`** — Entrypoint script. Uses `build-docker/` as build prefix to avoid CMake cache conflicts with any host builds
- **`build-wasm.sh`** — Host-side wrapper. Builds the image, creates the cache volume, bind-mounts the repo, runs the build
- The `DUCKDB_WASM_BUILD_PREFIX` env var in `scripts/wasm_build_lib.sh` controls the build output directory (defaults to `${PROJECT_ROOT}/build` for native, set to `/src/build-docker` in Docker)

### Common Pitfalls

- **Do NOT build on the host machine.** Always use `./build-wasm.sh` or run via Docker.
- **Do NOT run `npm run build` from the repo root.** The root `package.json` maps `build` to `make build_wasm_all`, which triggers a full WASM recompile.
- **Do NOT run `make apply_patches`.** The patches were written for an older DuckDB and fail against v1.3.0. The build succeeds without them.

---

## Agent Instructions

### Submodules

DO NOT modify files in `submodules/` (duckdb, arrow, rapidjson) unless explicitly asked. The WASM build compiles against unmodified upstream sources.

If a build error appears to originate from submodule code, investigate whether the issue is in our build configuration (cmake flags, link order, missing defines) or in our wrapper code (`lib/src/`, `lib/include/`) before modifying upstream source.

**Current submodule versions (as of 2026-03-06):**
- DuckDB: `71c5c07cdd` (v1.3.0)
- Arrow: `apache-arrow-17.0.0`
- RapidJSON: `973dc9c06d`

### Patches (OUTDATED - DO NOT APPLY)

The `patches/` directory contains patch files that were written for an older DuckDB version. They **do not apply cleanly** to v1.3.0 and are **not needed** for a successful build. Specifically:

| Patch | Status | Why it's unnecessary |
|-------|--------|---------------------|
| `revert_arrow_decimal_types.patch` | BROKEN | DuckDB v1.3.0 has `ArrowFormatVersion` — using `V1_0` achieves the same result (128-bit decimals) without patching |
| `binary_executor.patch` | BROKEN | Line numbers shifted; `SMALLER_BINARY=1` cmake flag handles binary size reduction |
| `extension_install_rework.patch` | BROKEN | Extension loading API refactored in v1.3.0; `DISABLE_EXTENSION_LOAD=TRUE` cmake flag suffices |
| `fix_load_database.patch` | BROKEN | `ExtensionIsLoaded` moved to extension_manager in v1.3.0 |
| `duckdb_smaller_binary_no_select.patch` | BROKEN | Same line-shift issues as binary_executor |
| `smaller_casts.patch` | Applied OK | But not required for build success |
| `fix_config_size_t.patch` | Already applied upstream | No-op |
| Arrow/RapidJSON patches | Already applied or unnecessary | |

### Build System

- DuckDB is built as a CMake ExternalProject in `lib/cmake/duckdb.cmake`
- Three WASM targets: MVP, EH (exception handling), COI (cross-origin isolation with threads)
- Extensions (json, parquet, icu, tpcds, tpch) are statically linked, not dynamically loaded
- Use `LoadStaticExtension<T>()` (not deprecated `LoadExtension<T>()`) to properly register extensions
- `DISABLE_EXTENSION_LOAD=TRUE` is passed as a CMake variable to DuckDB's ExternalProject to prevent dynamic extension loading
- Autoloading is disabled at runtime in `webdb.cc` via `db_config.options.autoload_known_extensions = false`
- Emscripten 3.1.57 is pinned in the Dockerfile. Do not change the version.
- Binaryen v126 is installed in the Dockerfile to replace the emsdk-bundled v117 (which doesn't support `--enable-bulk-memory-opt`)

### DuckDB v1.3.0 API Notes

The current DuckDB submodule (v1.3.0) uses:
- `time_t` for `FileSystem::GetLastModifiedTime` (not `timestamp_t`)
- 6-arg `ClientProperties` constructor (no `ArrowFormatVersion` parameter)
- `db_config.options.allow_unsigned_extensions`, `db_config.options.duckdb_api`, etc. as direct struct fields (not `SetOptionByName`)
- `LogicalTypeId::USER` (not `VARIANT`)
- `LogicalTypeId::VARINT` exists

Do NOT change these to newer API patterns unless the DuckDB submodule is actually upgraded.

### JS Build

To rebuild only the JS/TS layer (without recompiling WASM):
```
cd packages/duckdb-wasm
npx vite build && node bin/bundle.mjs release && npx tsc
```

Do NOT run `npm run build` from the repo root — it triggers `make build_wasm_all`.

### Type Declarations

The `.d.ts` path in `bin/bundle.mjs` must match the actual tsc output structure. TypeScript outputs to `dist/types/` with the `src/` prefix stripped (e.g., `dist/types/targets/duckdb.d.ts`, not `dist/types/src/targets/duckdb.d.ts`).

### Debugging Build Failures

1. **`wasm-opt` unknown option errors** — Binaryen version mismatch. The Dockerfile installs binaryen v126 to fix this.
2. **Submodule compile errors (arrow types, decimal, extension loading)** — Do NOT apply patches. Build without them. If errors persist, they are likely in our wrapper code in `lib/`.
3. **`ClientProperties` constructor mismatch** — Check arg count against the installed DuckDB headers in the build dir.
4. **`DBConfigOptions` missing member** — Check whether the field exists as a direct struct member in the submodule's `config.hpp`. Do NOT assume it moved to `SetOptionByName` without verifying.
5. **CMake cache conflicts** — The Docker build uses `build-docker/` via `DUCKDB_WASM_BUILD_PREFIX` to avoid conflicts with host build caches.