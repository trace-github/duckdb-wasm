# DuckDB-WASM, Customized

[DuckDB](https://duckdb.org) is an in-process SQL OLAP Database Management System.
DuckDB-WASM brings DuckDB to every browser thanks to WebAssembly.

This project is a fork of the official DuckDB-WASM repository, with some modifications:

- *WASM build*: Core extensions (`parquet`, `json`) are pre-bundled for faster loading. Additional runtime extensions are not supported. The resulting WASM bundles are about 2/3 the size of the official version. Multi-threaded execution is supported when `crossOriginIsolation` is enabled.
- *JS client*: The browser client has no `apache-arrow` JS lib dependency. Instead raw IPC buffers (`Uint8Array`) are returned as query results. This reduces the bundle size by ~10x and allows clients to "bring their own" Arrow library (such as [flechette](https://github.com/uwdata/flechette)). In addition, UDFs are not (currently) supported.

## Build From Source

```shell
git clone https://github.com/ridge-ai/duckdb-wasm.git
cd duckdb-wasm
git submodule init
git submodule update
make apply_patches
make build_wasm_all
cd packages/duckdb-wasm
npm run build
```

After building, use `npm run dev` in `packages/duckdb-wasm` to run basic dev tests (see browser console).

## Repository Structure

| Subproject                                               | Description    | Language   |
| -------------------------------------------------------- | :------------- | :--------- |
| [duckdb_wasm](/lib)                                      | Wasm Library   | C++        |
| [@duckdb/duckdb-wasm](/packages/duckdb-wasm)             | Typescript API | Typescript |
