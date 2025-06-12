################################################################################
# DuckDB-Wasm extension base config
################################################################################

duckdb_extension_load(json)
duckdb_extension_load(parquet)
duckdb_extension_load(icu)

#duckdb_extension_load(autocomplete DONT_LINK)
#duckdb_extension_load(tpcds DONT_LINK)
#duckdb_extension_load(tpch DONT_LINK)

#duckdb_extension_load(httpfs DONT_LINK)
