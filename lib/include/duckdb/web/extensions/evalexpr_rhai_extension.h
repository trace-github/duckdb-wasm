#ifndef INCLUDE_DUCKDB_WEB_EXTENSIONS_EVALEXPR_RHAI_EXTENSION_H_
#define INCLUDE_DUCKDB_WEB_EXTENSIONS_EVALEXPR_RHAI_EXTENSION_H_

#include "duckdb/main/database.hpp"

extern "C" void duckdb_web_evalexpr_rhai_init(duckdb::DuckDB* db);

#endif
