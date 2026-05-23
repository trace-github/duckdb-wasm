// hash_ext — native loadable extension entry point
#include "hash_ext_functions.h"

extern "C" {
DUCKDB_CPP_EXTENSION_ENTRY(hash_ext, loader) {
    duckdb::RegisterHashExtFunctions(loader);
}
}