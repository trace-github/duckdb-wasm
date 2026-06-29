# Extension config for loading hash_ext into the DuckDB build.
# Usage: cmake ... -DDUCKDB_EXTENSION_CONFIGS=".../extension_config.cmake"
duckdb_extension_load(hash_ext
    SOURCE_DIR "${CMAKE_CURRENT_LIST_DIR}"
    DONT_LINK
    EXTENSION_VERSION "${GIT_COMMIT_HASH}"
)