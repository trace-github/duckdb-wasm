#include "duckdb/web/extensions/hash_ext_extension.h"
#include "hash_ext_functions.h"

namespace duckdb {
class HashExtExtension : public Extension {
public:
    void Load(ExtensionLoader &loader) override {
        RegisterHashExtFunctions(loader);
    }
    std::string Name() override { return "hash_ext"; }
};
} // namespace duckdb

extern "C" void duckdb_web_hash_ext_init(duckdb::DuckDB *db) {
    db->LoadStaticExtension<duckdb::HashExtExtension>();
}
