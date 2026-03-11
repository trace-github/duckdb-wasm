# evalexpr_rhai extension — pre-built Rust static library
# The Rust lib is compiled in docker-build.sh before the CMake build runs.
# Two variants: threads (COI) and no-threads (MVP/EH).

set(EVALEXPR_RHAI_SOURCE_DIR "${CMAKE_SOURCE_DIR}/../submodules/evalexpr_rhai")

if(WITH_WASM_THREADS)
  set(EVALEXPR_RHAI_RUST_LIB "/cache/cargo-target-threads/wasm32-unknown-emscripten/release/libduckdb_evalexpr_rhai_rust.a")
else()
  set(EVALEXPR_RHAI_RUST_LIB "/cache/cargo-target-nothreads/wasm32-unknown-emscripten/release/libduckdb_evalexpr_rhai_rust.a")
endif()

add_library(evalexpr_rhai_rust STATIC IMPORTED)
set_property(TARGET evalexpr_rhai_rust PROPERTY IMPORTED_LOCATION ${EVALEXPR_RHAI_RUST_LIB})
target_include_directories(evalexpr_rhai_rust INTERFACE
    ${EVALEXPR_RHAI_SOURCE_DIR}/src/include)
