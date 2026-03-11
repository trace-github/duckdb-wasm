#include "duckdb/web/extensions/evalexpr_rhai_extension.h"

#include "evalexpr_rhai_extension.hpp"
#include "query_farm_telemetry.hpp"

// Stub out telemetry for WASM — no httpfs, no network access from extension init
namespace duckdb {
void QueryFarmSendTelemetry(ExtensionLoader &loader, const string &extension_name, const string &extension_version) {
    // no-op in WASM builds
}
}

extern "C" void duckdb_web_evalexpr_rhai_init(duckdb::DuckDB* db) {
    db->LoadStaticExtension<duckdb::EvalexprRhaiExtension>();
}
