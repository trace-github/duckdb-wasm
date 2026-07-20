---
name: upgrade-duckdb-wasm
description: Use when upgrading the duckdb-wasm-trace fork to a new upstream duckdb-wasm release, or when adding/removing bundled extensions. Applies when the user says "upgrade to 1.x.x", "update duckdb", "add extension X", or similar.
---

# Upgrade duckdb-wasm-trace Fork

Upgrade the fork to a new upstream duckdb-wasm release while preserving our bundled extensions.

## Core Principle

We only add extensions and apply one post-build patch to the Node.js bundle. The duckdb-wasm package TypeScript/JavaScript source must be identical to upstream — only `package.json` (name/version) and the built `dist/duckdb-node.cjs` (patched post-build) differ. If you're changing upstream TS/JS source files, you're doing it wrong.

## Investigation discipline (learned the hard way)

Don't conclude "impossible / unsupported / can't reach that version" without verifying against fresh data and a real build:

- **`git fetch upstream` BEFORE checking upstream state.** `git log upstream/main` / `git show upstream/...` without fetching is stale — it has led to wrong "the fork can't reach duckdb vX" conclusions when upstream was already there.
- **Read the actual source (`.cpp`/`.hpp`), not just `CMakeLists.txt`/CI**, before declaring a feature unsupported. An extension's wasm support can live in an `#ifdef __EMSCRIPTEN__` in its `.cpp` while its CMake/CI show nothing (this is exactly how `quack`'s wasm-client support is gated).
- **Verify by building, not by inference** — and note a stale build cache reports the OLD duckdb version after a submodule bump (see the `clean-duckdb-wasm` skill).
- **Prebuilt artifacts are ground truth:** `curl -sI http://extensions.duckdb.org/v<VER>/wasm_eh/<EXT>.duckdb_extension.wasm` returning 200 proves an extension already builds for wasm.

## Red Flags — STOP and Rethink

- Modifying `packages/duckdb-wasm/src/` files (bindings, runtime, workers)
- Modifying `packages/duckdb-wasm/bundle.mjs`
- Patching Emscripten output (sed/awk on generated JS) — the `patch-node-bundle.mjs` script is the ONE exception, and it's explicit
- Changing tests to make the build pass
- Using a different Emscripten version than upstream without understanding why
- Installing packages on the user's machine without asking

**If tests fail, the build is broken — not the tests. Never change tests to fix the build.**

## What We Change vs Upstream

### Files we ADD (new):
- `Dockerfile` + `Dockerfile.amd64` — Docker build environment
- `scripts/docker-build.sh` — in-container build script
- `trace-scripts/` — build-wasm.sh, patch-node-bundle.mjs, run-tests.sh, clean.sh, publish.sh
- `extension_config_wasm.cmake` — which extensions to load
- `extensions/hash_ext/` — custom Rust extension (source + native build)
- `hash_ext_wasm/Cargo.toml` — WASM build wrapper for hash_ext
- `lib/src/extensions/*.cc` — extension glue (one per extension)
- `lib/include/duckdb/web/extensions/*.h` — extension headers
- `lib/cmake/hash_ext.cmake`, `lua.cmake`, `fts.cmake` — extension cmake
- `test-rig/` — Puppeteer browser tests
- `test-node/` — Node.js smoke tests (WASM + native extension + worker thread)
- `Cargo.toml` — workspace config
- Submodules: `duckdb_lua`, `lua`, `duckdb_fts`

### Files we MODIFY (minimal changes):
- `lib/cmake/duckdb.cmake` — add extensions to DUCKDB_EXTENSIONS list + imported targets
- `lib/CMakeLists.txt` — add extension library targets + link them
- `lib/src/webdb.cc` — add extension init calls
- `packages/duckdb-wasm/package.json` — name, version, description, repo URL
- `.gitmodules` — add lua/fts submodules

### The post-build bundle patch:
- `dist/duckdb-node.cjs` is patched by `trace-scripts/patch-node-bundle.mjs` after every WASM build
- The patch is NOT a source modification — it's applied to the build output, which is not tracked in git
- The patch script is called automatically by `trace-scripts/build-wasm.sh`
- See the patch script for details on what it changes

### Files we NEVER change:
- `packages/duckdb-wasm/src/` — all TypeScript/JavaScript source
- `packages/duckdb-wasm/bundle.mjs` — esbuild bundler
- `scripts/wasm_build_lib.sh` — upstream WASM build script
- `lib/cmake/arrow.cmake` — Arrow build config
- `yarn.lock` — dependency pinning (use upstream's)

## Upgrade Process

### Step 1: Find the upstream commit

```bash
git fetch upstream
git log upstream/main --oneline | grep -i "bump.*v1.X.X"
# Note the commit hash
```

### Step 2: Create a new branch from that commit

```bash
git checkout -b upgrade/v1.X.X <upstream-commit-hash>
git submodule init && git submodule update
```

Verify: `git -C submodules/duckdb describe --tags` should show the target version.

### Step 3: Check what Emscripten version upstream uses

```bash
git show <upstream-commit>:actions/image/Dockerfile | grep EMSDK_VERSION
```

Use the same version if it has arm64 Linux binaries. If not, use the nearest version that does. Check arm64 support:

```bash
# Inside a test container:
./emsdk install <version>  # Will fail if no arm64 binary
```

If emsdk bundles a binaryen version that doesn't support flags its LLVM passes (e.g., `--enable-bulk-memory-opt`), upgrade binaryen in the Dockerfile.

### Step 4: Check upstream's Rust version and yarn.lock

```bash
git show <upstream-commit>:actions/image/Dockerfile | grep RUST_VERSION
```

Use upstream's `yarn.lock` as-is — it pins TypeScript, @types/emscripten, and other deps to compatible versions. Run `yarn install` (not `npm install`) in docker-build.sh.

### Step 5: Copy our extension files from the previous version

```bash
# From the previous working branch (e.g., fresh-fork):
git checkout fresh-fork -- \
  Dockerfile Dockerfile.amd64 \
  scripts/docker-build.sh \
  trace-scripts/ \
  extension_config_wasm.cmake \
  extensions/hash_ext/ \
  hash_ext_wasm/ \
  lib/src/extensions/ \
  lib/include/duckdb/web/extensions/ \
  lib/cmake/hash_ext.cmake lib/cmake/lua.cmake lib/cmake/fts.cmake \
  test-rig/ test-node/ \
  Cargo.toml .gitignore
```

### Step 6: Apply changes to upstream files

Read each file before modifying. Compare with the previous version to understand what changed upstream.

**`lib/cmake/duckdb.cmake`:**
- Find the `DUCKDB_EXTENSIONS` variable, add: `parquet;icu;tpcds;tpch`
- Add BUILD_BYPRODUCTS for new extension .a files
- Add imported library targets (duckdb_icu, duckdb_tpcds, duckdb_tpch)

**`lib/CMakeLists.txt`:**
- Add `include(cmake/hash_ext.cmake)`, `include(cmake/lua.cmake)`, `include(cmake/fts.cmake)`
- Add library targets for each extension wrapper
- Add to `target_link_libraries(duckdb_web ...)`
- Always link JSON (remove upstream's conditional cache check)

**`lib/src/webdb.cc`:**
- Add `#include` for each extension header
- Add init calls in the `#ifndef WASM_LOADABLE_EXTENSIONS` block

**`packages/duckdb-wasm/package.json`:**
- Change name to `@run-trace/duckdb-wasm`
- Bump version
- Update description and repository URL

**`.gitmodules`:**
- Add duckdb_lua, lua, duckdb_fts submodules

**Adding an out-of-tree extension (how `quack` was added):**
- Add its name to `DUCKDB_EXTENSIONS` in `lib/cmake/duckdb.cmake`. If duckdb ships `.github/config/extensions/<name>.cmake`, duckdb's `extension/extension_build_tools.cmake` auto-includes it (clones the pinned `GIT_URL`/`GIT_TAG`) — no custom config file needed. Note `extension_config_wasm.cmake` is effectively **vestigial** for the lib build (the duckdb ExternalProject builds from `DUCKDB_EXTENSIONS`, not that file).
- Add `<INSTALL_DIR>/lib/lib<name>_extension.a` to `BUILD_BYPRODUCTS` + an imported target (`duckdb_<name>`) + `add_dependencies(duckdb_<name> duckdb_ep)`.
- Glue `lib/src/extensions/<name>_extension.cc`: `db->LoadStaticExtension<duckdb::<Name>Extension>()` + header + a `duckdb_web_<name>` lib linked into `duckdb_web` + an init call in `webdb.cc`. **The generated loader only registers `core_functions`** — `ExtensionHelper::LoadExtension(db, "name")` by name silently no-ops, so the explicit `LoadStaticExtension<Class>` glue is mandatory (same pattern as the others).
- If the extension's header only exists in a build-time clone, mirror its class declaration inline in the glue (pinned to the `GIT_TAG`) instead of wiring the clone's include path.
- An extension may be client-only on wasm (e.g. `quack`: `quack_serve` is `#ifdef __EMSCRIPTEN__`-disabled). duckdb-wasm HTTP uses synchronous XHR — it works in the browser; **Node has no HTTP** (`runtime_node.ts` → "Unsupported data protocol") and needs a sync-XHR shim (see `test-node/sync-xhr-node.cjs`).

### Step 7: Add submodules

```bash
git submodule add https://github.com/isaacbrodsky/duckdb-lua.git submodules/duckdb_lua
git submodule add https://github.com/lua/lua.git submodules/lua
git submodule add https://github.com/duckdb/duckdb-fts.git submodules/duckdb_fts
```

### Step 8: Update extension_config.cmake for hash_ext

The `extensions/hash_ext/extension_config.cmake` must pass `EXTENSION_VERSION` to match DuckDB's git hash, otherwise users get metadata mismatch errors:

```cmake
duckdb_extension_load(hash_ext
    SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}"
    DONT_LINK
    EXTENSION_VERSION "${GIT_COMMIT_HASH}"
)
```

### Step 9: Build, patch, test, and build all native extension architectures

```bash
# Clean
./trace-scripts/clean.sh --all

# Build WASM (inside Docker) — automatically runs patch-node-bundle.mjs at the end
./trace-scripts/build-wasm.sh

# Verify patch was applied
node -e "const d = require('./packages/duckdb-wasm/dist/duckdb-node.cjs'); console.log('NodeWorker:', typeof d.NodeWorker)"
# Expected: NodeWorker: function

# Build native extensions for ALL platforms (osx_arm64, osx_amd64, linux_arm64, linux_amd64)
./extensions/hash_ext/build-all.sh

# Run ALL tests (browser smoke, hash-ext, lua, Node WASM, Node worker, Node native)
./trace-scripts/run-tests.sh
```

You MUST build all 4 native extension platforms before the upgrade is complete. Do not just build osx_arm64 — run `build-all.sh`, not `build.sh --platform osx_arm64`.

### Step 10: Verify patch anchors still match after upgrade

If `patch-node-bundle.mjs` exits with an error like "anchor not found", the bundle structure changed upstream. Read the new `duckdb-node.cjs` and update the anchor strings in the patch script. The patch applies 4 string replacements — check each one.

## Debugging Build Failures

### Approach

1. Read the actual error message — not just "build failed"
2. Check if upstream has the same issue at that commit
3. Check if our previous version had the same file/config
4. Diff our changed files against upstream to find the deviation
5. Fix the build, NOT the tests

### Common Issues

**`wasm-opt: Unknown option '--enable-bulk-memory-opt'`**
Binaryen version mismatch. The LLVM in emsdk produces wasm with features that the bundled binaryen doesn't support. Fix: upgrade binaryen in the Dockerfile.

**`Emscripten.WebAssemblyExports not found` (tsc error)**
Using `npm install` instead of `yarn install`. The `yarn.lock` pins `@types/emscripten` to a compatible version. Fix: use `yarn install` in docker-build.sh.

**`TypeError: b.randomFillSync is not a function` (Node.js)**
Patched `require("crypto")` in the Emscripten glue. Fix: don't patch upstream files.

**Extension metadata mismatch when loading**
The extension's git hash doesn't match DuckDB's. Fix: pass `EXTENSION_VERSION "${GIT_COMMIT_HASH}"` in extension_config.cmake.

**`unique_ptr` conversion errors (GCC in Docker)**
DuckDB uses a custom 3-parameter `unique_ptr`, not `std::unique_ptr`. GCC requires explicit `std::move()` for derived→base conversions. This is correct — not a pessimizing move.

**`getTempRet0 is not defined` (browser)**
The wasm_build_lib.sh post-processing (sed/awk on js-beautify output) didn't match the generated code patterns. Usually caused by using a different binaryen version than upstream expects.

**`patch-node-bundle.mjs: ERROR: Patch N anchor not found`**
The bundle structure changed in this upstream version. Open `packages/duckdb-wasm/dist/duckdb-node.cjs` and search for the new location of the anchor. Update the patch script anchor strings.

**Bundle reports the OLD duckdb version, or a newly-added extension is missing**
Stale build cache — the duckdb ExternalProject wasn't rebuilt after the submodule bump. Run `clean.sh` (removes `build/`) and rebuild. See `clean-duckdb-wasm`.

**`bundle.mjs` can't read `duckdb-coi.pthread.js`, or COI bundle throws "Module is not defined"**
Emscripten 4.0.3 emits no standalone pthread worker, so the file is restored from the tracked template `lib/duckdb-coi.pthread.template.js` by `docker-build.sh`. If you bump the Emscripten version, regenerate that template (extract `sourcesContent` for `duckdb-coi.pthread.js` from a published `*.pthread.worker.js.map`). Never `cp duckdb-coi.js`. See `clean-duckdb-wasm`.

**After ANY Emscripten version bump: re-verify the heap-growth guard's glue contract**
`viewHeapU8`/`viewHeapF64` in `src/bindings/runtime.ts` refresh stale heap views (COI pthread memory growth) by calling `mod.stringToUTF8('', 0, 0)` — this relies on the glue (a) exporting `stringToUTF8` on Module and (b) implementing it as `stringToUTF8Array(str, GROWABLE_HEAP_U8(), ...)` so the staleness check runs before the zero-write guard. Verified for Emscripten 4.0.3. After a bump, grep the new `duckdb-coi.js` glue for `var stringToUTF8 =` and confirm it still evaluates `GROWABLE_HEAP_U8()` (or equivalent view-refresh accessor). If the shape changed, the guard fails loudly (`heap view ending at N exceeds wasm memory size`) rather than corrupting — but it must be re-wired to whatever refresh path the new glue exposes.

**Native extension fails to load after a duckdb bump** ("built for version X, can only load with that version")
The native `hash_ext` is version-locked to duckdb. Rebuild with `./extensions/hash_ext/build-all.sh` — it builds `osx_arm64`, `osx_amd64`, `linux_amd64`. The npm wasm package doesn't use native builds; the macOS native smoke test uses the `osx_arm64` artifact.

> **`linux_arm64` is intentionally disabled in `build-all.sh` (commented out) — don't re-enable it expecting a real arm64 binary.** Its old "may OOM under Docker (`cc1plus` killed) — retryable" reputation was a symptom of an image-tag conflict, not a flaky compile: `build-all.sh` ran that target with the `duckdb-wasm-builder` (`:latest`) image expecting **arm64**, but `build-wasm.sh` builds `:latest` as **amd64** (`--platform linux/amd64`, emsdk has no arm64 binary). So it actually ran an emulated amd64 build under QEMU (heavy → the OOM) and at best re-emitted `linux_amd64` — a genuine arm64 ext was never produced. A real one would need a separate Emscripten-free arm64 builder image the repo doesn't provide; we don't ship the native ext to ARM64 Linux, so it's disabled. Full root cause in `clean-duckdb-wasm`.

## Bundled Extensions Reference

| Extension | Type | Source | CMake Target |
|-----------|------|--------|-------------|
| json | DuckDB built-in | submodules/duckdb | duckdb_web_json |
| parquet | DuckDB built-in | submodules/duckdb | duckdb_web_parquet |
| icu | DuckDB built-in | submodules/duckdb | duckdb_web_icu |
| tpcds | DuckDB built-in | submodules/duckdb | duckdb_web_tpcds |
| tpch | DuckDB built-in | submodules/duckdb | duckdb_web_tpch |
| fts | External submodule | submodules/duckdb_fts | duckdb_web_fts |
| lua | External submodule | submodules/duckdb_lua + submodules/lua | duckdb_web_lua |
| hash_ext | Custom (Rust+C++) | extensions/hash_ext/ | duckdb_web_hash_ext |

## Test Expectations

All of these must pass before the upgrade is complete:

- **Browser smoke** — DuckDB loads, version matches, JSON/Parquet extensions work
- **Browser hash-ext** — All hash function tests pass
- **Browser lua** — All lua tests pass
- **Node.js WASM smoke** — DuckDB loads in Node via NodeWorker, queries work, extensions respond
- **Node.js WASM worker thread** — DuckDB works when imported from an application worker thread; global not mutated; NodeWorker exported
- **Node.js native extension** — hash_ext loads via `@duckdb/node-api`, known hash values match

## Related skills

- `clean-duckdb-wasm` — clean.sh vs --all, the build-cache staleness trap, submodule reset (`reset --hard`, not just checkout+clean), and the `duckdb-coi.pthread.js` restore a clean depends on.
- `commit-and-publish-duckdb-wasm` — reset submodules before committing, npm publish, GCS native-extension push.