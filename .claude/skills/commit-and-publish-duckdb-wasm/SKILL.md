---
name: commit-and-publish-duckdb-wasm
description: Use when committing, publishing, or pushing extensions for the duckdb-wasm-trace fork. Use before any git commit, npm publish, or extension push in this repo to avoid committing build artifacts or dirty submodules.
---

# Commit and Publish duckdb-wasm-trace

## Before Every Commit

### 1. Reset patched submodules

The Docker build applies patches to `submodules/duckdb`, `submodules/arrow`, and `submodules/rapidjson` at build time. These patches modify the submodule working trees but must NOT be committed — they are re-applied on every build.

```bash
cd submodules/duckdb && git checkout -- . && git clean -fd && cd ../..
cd submodules/arrow && git checkout -- . && git clean -fd && cd ../..
cd submodules/rapidjson && git checkout -- . && git clean -fd && cd ../..
```

Then verify: `git status -- submodules/` should show only intentionally added submodules (duckdb_lua, lua, duckdb_fts), never modified existing ones.

### 2. Check that upstream package source is untouched

```bash
git diff <upstream-commit> --name-only -- packages/duckdb-wasm/
```

This should show ONLY `packages/duckdb-wasm/package.json`. If anything else appears, you've accidentally modified upstream source — revert it.

### 3. Verify .gitignore covers build artifacts

These must NOT be committed:
- `extension-dist/` — native extension builds
- `build/`, `build-docker/` — WASM build output
- `packages/duckdb-wasm/dist/` — JS bundle output
- `test-rig/node_modules/`, `test-node/node_modules/` — deps
- `test-rig/arrow-bundle.mjs` — generated
- `target/`, `extensions/hash_ext/rust/target/`, `hash_ext_wasm/target/` — Rust

## Publishing to npm

```bash
# 1. Ensure dist/ exists (from a successful build)
ls packages/duckdb-wasm/dist/duckdb-{mvp,eh,coi}.wasm

# 2. Run publish (will prompt for confirmation)
./trace-scripts/publish.sh

# Or dry-run first:
./trace-scripts/publish.sh --dry-run
```

## Pushing Native Extensions to GCS

After building all 4 platforms (`./extensions/hash_ext/build-all.sh`), push to GCS:

```bash
./trace-scripts/push-extensions.sh dev   # dev bucket
./trace-scripts/push-extensions.sh app   # app bucket (production)
```

**When to push where:**
- Always ask the user: "Push extensions to dev, app, or both?"
- **dev** — safe to push anytime after a successful build
- **app** — NEVER push to app unless the user explicitly asks for it
- **both** — run dev first, then app

Buckets:
- `gs://tf-shared-artifacts-hellotrace-dev/duckdb/extensions/`
- `gs://tf-shared-artifacts-hellotrace-app/duckdb/extensions/`

## Never Commit

- Dirty submodules (duckdb, arrow, rapidjson with patch changes)
- `node_modules/` directories
- Build output (`dist/`, `build/`, `extension-dist/`)
- Modified upstream source files