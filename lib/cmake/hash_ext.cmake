# hash_ext Rust WASM static library
# Compiled by docker-build.sh before the CMake build runs.
# Two variants: threads (COI) and no-threads (MVP/EH).

if(WITH_WASM_THREADS)
  set(HASH_EXT_RUST_LIB "/cache/cargo-target-hash-threads/wasm32-unknown-emscripten/release/libhash_ext_wasm.a")
else()
  set(HASH_EXT_RUST_LIB "/cache/cargo-target-hash-nothreads/wasm32-unknown-emscripten/release/libhash_ext_wasm.a")
endif()

add_library(hash_ext_rust STATIC IMPORTED)
set_property(TARGET hash_ext_rust PROPERTY IMPORTED_LOCATION ${HASH_EXT_RUST_LIB})
