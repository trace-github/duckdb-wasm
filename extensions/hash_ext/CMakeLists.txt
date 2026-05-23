cmake_minimum_required(VERSION 3.12)
project(HashExtExtension)

include_directories(src/include)

# Import the pre-built Rust static library.
# HASH_EXT_RUST_LIB can be overridden (e.g. for cross-compilation).
if(NOT HASH_EXT_RUST_LIB)
    set(HASH_EXT_RUST_LIB "${CMAKE_CURRENT_SOURCE_DIR}/rust/target/release/libhash_ext.a")
endif()

if(NOT EXISTS "${HASH_EXT_RUST_LIB}")
    message(FATAL_ERROR
        "Rust static library not found at ${HASH_EXT_RUST_LIB}\n"
        "Build it first: cd extensions/hash_ext/rust && cargo build --release")
endif()

add_library(hash_ext_rust STATIC IMPORTED)
set_property(TARGET hash_ext_rust PROPERTY IMPORTED_LOCATION "${HASH_EXT_RUST_LIB}")

set(EXTENSION_SOURCES
    src/hash_ext_functions.cpp
    src/hash_ext_loadable.cpp)

build_static_extension(hash_ext ${EXTENSION_SOURCES})
build_loadable_extension(hash_ext "" ${EXTENSION_SOURCES})

target_link_libraries(hash_ext_extension hash_ext_rust)
target_link_libraries(hash_ext_loadable_extension hash_ext_rust)
