#include "duckdb/web/extensions/tpcds_extension.h"

#include "tpcds_extension.hpp"

extern "C" void duckdb_web_tpcds_init(duckdb::DuckDB* db) { db->LoadStaticExtension<duckdb::TpcdsExtension>(); }
