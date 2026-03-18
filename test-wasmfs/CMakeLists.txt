cmake_minimum_required(VERSION 3.13)
project(wasmfs_test C)

set(CMAKE_C_STANDARD 11)

add_executable(wasmfs_test wasmfs_test.c)

# WasmFS with OPFS backend
target_link_options(wasmfs_test PRIVATE
    -sWASMFS
    -lopfs.js
    -sALLOW_MEMORY_GROWTH=1
    -sMODULARIZE=1
    -sEXPORT_NAME=WasmFSTest
    -sEXPORTED_RUNTIME_METHODS=callMain
    -sINVOKE_RUN=0
    -sEXIT_RUNTIME=0
    -O2
)

# pthreads support (COI-only)
option(WITH_THREADS "Build with pthread support" ON)
if(WITH_THREADS)
    target_compile_options(wasmfs_test PRIVATE -pthread)
    target_link_options(wasmfs_test PRIVATE
        -pthread
        -sPTHREAD_POOL_SIZE=8
    )
endif()
