#include "duckdb/web/extensions/lua_extension.h"

#include "lua_extension.hpp"

extern "C" void duckdb_web_lua_init(duckdb::DuckDB* db) {
    db->LoadStaticExtension<duckdb::LuaExtension>();
}
