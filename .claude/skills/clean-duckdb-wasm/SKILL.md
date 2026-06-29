---
name: clean-duckdb-wasm
description: Use when cleaning build artifacts, doing a cold/fresh-machine rebuild, resetting submodules before committing, or debugging a "stale build" (e.g. the bundle reports an old duckdb version, or a newly-added extension is missing, after a submodule bump) in duckdb-wasm-trace. Covers clean.sh vs --all, the build-cache staleness trap, the duckdb-coi.pthread.js restore that a clean depends on, and the correct way to reset submodules.
---

# Cleaning duckdb-wasm-trace

## The clean script — always prefer it over manual `rm`

- `./trace-scripts/clean.sh` — removes `build/`, `build-docker/`, `extension-dist/`, generated bindings, `node_modules/`, Rust target dirs, `.tgz`. **Preserves** `dist/`, the Docker image, and the ccache volume. Use for a normal tidy or to bust the duckdb build cache.
- `./trace-scripts/clean.sh --all` — ALSO removes `dist/`, the Docker image, and the ccache volume. Use for a **true cold / fresh-machine rebuild verification**.
- A manual `rm -rf build build-docker` (+ the `src/bindings/duckdb-{eh,coi}.{wasm,js,pthread.js}`) is a valid *faster partial* clean that keeps ccache/node_modules for speed — but it does NOT prove a fresh-machine build. Use `--all` for that.

## Build-cache staleness (the trap)

Rebuilding WITHOUT cleaning reuses the cached duckdb ExternalProject. So after bumping `submodules/duckdb`, a rebuild can silently keep the **old** duckdb.

- **Symptom:** you bumped the submodule but `SELECT version()` still shows the old version, or a newly-added extension isn't present in the bundle.
- **Fix:** run `clean.sh` (removes `build/` + `build-docker/`) before rebuilding after any submodule/version change. When in doubt that a change "took", clean and rebuild.

## A clean DELETES `duckdb-coi.pthread.js` — the build restores it

`clean.sh` removes the generated bindings, including the gitignored `packages/duckdb-wasm/src/bindings/duckdb-coi.pthread.js`. `bundle.mjs` **requires** that file (the Emscripten pthread bootstrap the COI worker reuses), and **Emscripten 4.0.3 does not regenerate it** (it emits no standalone `duckdb_wasm.worker.js`).

- It is restored at build time from the tracked template `lib/duckdb-coi.pthread.template.js` by `scripts/docker-build.sh`. Confirm it fired: the build log shows `Restoring duckdb-coi.pthread.js from template`. This is what makes a clean checkout buildable.
- **Do NOT** "fix" a missing pthread.js by `cp`-ing `duckdb-coi.js` — that yields a runtime `Module is not defined` that breaks the entire COI browser bundle.
- If the template is ever lost, recover the correct bootstrap from the published npm package: read `dist/duckdb-browser-coi.pthread.worker.js.map` and pull `sourcesContent` for `src/bindings/duckdb-coi.pthread.js` (it starts `"use strict";var Module={};…`). It is Emscripten-version- (not duckdb-version-) specific, so regenerate the template only when bumping Emscripten.
- After a clean, `node_modules` are gone: the Docker build reinstalls `test-rig`; `run-tests.sh` installs `test-node`; standalone demos need a `test-node` `npm install` first.

## Resetting submodules (a clean you must do before committing)

The Docker build patches `submodules/{duckdb,arrow,rapidjson}` in place (`make apply_patches`). Reset them before committing.

- `git checkout -- . && git clean -fd` is **NOT enough** — it does not clear **staged** files. `apply_patches` leaves `.rej` files when a hunk is already applied upstream (e.g. arrow/duckdb hunks already present in the new version), and those `.rej` can end up *staged* in the submodule index → they survive checkout+clean (seen in both `submodules/duckdb` and `submodules/arrow`).
- Use, in each submodule: **`git reset --hard HEAD && git clean -fd`**.
- Verify: `git status -- submodules/` shows ONLY an intended gitlink bump (e.g. `M submodules/duckdb` for a version change) and nothing dirty — no `.rej`, no lowercase `m`. Check inside too: `git -C submodules/arrow status --short` should be empty.

## Fresh-machine / "will it build elsewhere?" verification

1. Commit everything needed (so only committed files are present) and reset submodules.
2. `clean.sh --all` (cold: no dist, no Docker image, no ccache, no bindings).
3. Rebuild (`build-wasm.sh`). Confirm the log shows the `duckdb-coi.pthread.js` template restore.
4. **Test for reliance on uncommitted files:** stash a copy of any gitignored file the clean deletes (e.g. `duckdb-coi.pthread.js`). If the build ever needs that *stash*, the test has failed — the build must restore from a *tracked* source instead.
5. Run `run-tests.sh` + the demos; only then publish.

## Never run two Docker builds at once — the 7.7 GB VM OOM-kills the compiler

`build-wasm.sh` (the WASM bundle) and `build-all.sh`'s `linux_amd64` target BOTH run heavy `-j12` C++ compiles inside the **same Docker Desktop Linux VM**, which is typically allocated only ~**7.7 GB** even on a 36 GB host (`docker info --format '{{.MemTotal}}'`). A single `-j12` build of DuckDB's big unity files (e.g. `ub_duckdb_optimizer.cpp`, `ub_duckdb_core_functions_holistic.cpp`) fits in 7.7 GB; **two at once do not** — the kernel OOM-kills the compiler. (`build-all.sh`'s `osx_*` targets compile on the **host** at 36 GB and are never affected.)

- **Run Docker-based builds sequentially**: `build-wasm.sh` to completion, THEN `build-all.sh` (or vice versa). Do NOT background both at once.
- **What concurrency actually breaks** (measured: ran both backgrounded, then each alone):
  - The **WASM build** OOMs — `make[6]: *** [...ub_duckdb_optimizer.cpp.o] Error 255` with **zero** `error:`/stack-dump output above it. It builds fine when run alone. This is the clearest tell you double-booked the VM.
  - **`linux_amd64`** OOMs under contention but **passes when run alone**.
  - `Error 255` (or any `Error N`) with no compiler diagnostic = process killed, not a code bug.
- **`linux_arm64` is intentionally DISABLED in `build-all.sh` (commented out) — don't re-enable it expecting it to work.** It never produced a real arm64 binary in the first place: `build-all.sh` runs that target with the `duckdb-wasm-builder` (`:latest`) image expecting it to be **arm64**, but `build-wasm.sh` builds `:latest` from the main `Dockerfile` as **amd64** (`--platform linux/amd64`, because emsdk has no arm64 binary). So the target ran an emulated amd64 build under QEMU (heavy → the "retryable OOM" the `upgrade-duckdb-wasm` skill records) and, when it succeeded, just re-emitted `linux_amd64`. A genuine arm64 native ext would need a separate Emscripten-free arm64 builder image, which the repo doesn't provide. It's not needed anywhere (the npm WASM package doesn't use native builds; the macOS smoke test uses `osx_arm64`), hence disabled.
- **Before blaming code**, grep the log for `error:`/`Killed`/`Stack dump`/`cannot allocate`; if there's a `Killed`/no diagnostic, it's OOM — rerun one build at a time (don't reduce `-j` or edit scripts). Re-running after an OOM resumes via ccache, so it's fast.

## Related skills

- `upgrade-duckdb-wasm` — bumping to a new upstream release / adding-removing extensions.
- `commit-and-publish-duckdb-wasm` — submodule reset + npm publish + GCS extension push.