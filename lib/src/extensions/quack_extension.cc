#include "duckdb/web/extensions/quack_extension.h"

#include "duckdb/main/extension.hpp"

// quack is an out-of-tree extension built by the duckdb ExternalProject into
// libquack_extension.a (see lib/cmake/duckdb.cmake). Rather than wire the
// generated clone's include path, we mirror the class declaration from
// duckdb-quack @ 40de7badae4193c29d9c0834473fb76acc6c51e6
// (src/include/quack_extension.hpp). The method bodies live in the linked
// static library. Keep this in sync with the GIT_TAG pinned in duckdb.cmake.
namespace duckdb {
class QuackExtension : public Extension {
   public:
    void Load(ExtensionLoader& db) override;
    std::string Name() override;
    std::string Version() const override;
};
}  // namespace duckdb

extern "C" void duckdb_web_quack_init(duckdb::DuckDB* db) {
    db->LoadStaticExtension<duckdb::QuackExtension>();
}
