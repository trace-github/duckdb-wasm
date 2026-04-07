# FTS (Full Text Search) extension — compiled from source.
# Sources: duckdb-fts community extension + Snowball stemmer bundled in the DuckDB submodule.

set(SNOWBALL_DIR "${CMAKE_SOURCE_DIR}/../submodules/duckdb/third_party/snowball")
set(DUCKDB_FTS_DIR "${CMAKE_SOURCE_DIR}/../submodules/duckdb_fts/extension/fts")

# Snowball stemmer library — identical source list to DuckDB's own CMakeLists.txt
# but using the .cpp extensions used in the DuckDB submodule.
add_library(snowball_stemmer STATIC
    ${SNOWBALL_DIR}/libstemmer/libstemmer.cpp
    ${SNOWBALL_DIR}/runtime/api.cpp
    ${SNOWBALL_DIR}/runtime/utilities.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_arabic.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_basque.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_catalan.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_danish.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_dutch.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_english.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_finnish.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_french.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_german.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_german2.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_greek.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_hindi.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_hungarian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_indonesian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_irish.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_italian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_kraaij_pohlmann.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_lithuanian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_lovins.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_nepali.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_norwegian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_porter.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_portuguese.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_romanian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_russian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_serbian.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_spanish.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_swedish.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_tamil.cpp
    ${SNOWBALL_DIR}/src_c/stem_UTF_8_turkish.cpp)

target_include_directories(snowball_stemmer PUBLIC
    ${SNOWBALL_DIR}/libstemmer
    ${SNOWBALL_DIR}/runtime
    ${SNOWBALL_DIR}/src_c)

if(EMSCRIPTEN AND WITH_WASM_THREADS)
    target_compile_options(snowball_stemmer PRIVATE -matomics -mbulk-memory -sUSE_PTHREADS=1)
endif()
