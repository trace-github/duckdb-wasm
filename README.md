# @run-trace/duckdb-wasm

A custom build of [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm), forked from [ridge-ai/duckdb-wasm](https://github.com/ridge-ai/duckdb-wasm), with modifications for multi-threaded browser use.

**What's different from the standard DuckDB-WASM package:**

- **WasmFS** — supports multiple threads reading files concurrently. Due to base package design around connections, we are still limited to one query at a time. I only see 20-30% improvement on large queries from parquet.
- **Statically linked extensions** — JSON, parquet, and other extensions are linked directly into the WASM binary, fixing load failures when running with multiple threads
- **Custom Rust extension** — a hashing extension for JSON values (example of how to write one).
- **No apache-arrow dependency** — raw IPC buffers (`Uint8Array`) are returned as query results; bring your own Arrow library (e.g. [flechette](https://github.com/uwdata/flechette))
- **Dockerfile to support building**

Published as [`@run-trace/duckdb-wasm`](https://www.npmjs.com/package/@run-trace/duckdb-wasm).

## Build From Source

```shell
git clone https://github.com/trace-github/duckdb-wasm.git
cd duckdb-wasm
git submodule init
git submodule update
./build-wasm.sh
```

Requires Docker Desktop (16 GiB memory recommended). See [CLAUDE.md](CLAUDE.md) for full build details.

## Repository Structure

| Subproject | Description | Language |
| --- | :--- | :--- |
| [duckdb_wasm](/lib) | Wasm Library | C++ |
| [@run-trace/duckdb-wasm](/packages/duckdb-wasm) | TypeScript API | TypeScript |
