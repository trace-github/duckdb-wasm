# Lua 5.4.8 C library + duckdb-lua extension — compiled from source.
# Lua is pure C and compiles directly with emcc — no pre-build step needed.

set(LUA_C_SOURCE_DIR "${CMAKE_SOURCE_DIR}/../submodules/lua")
set(DUCKDB_LUA_SOURCE_DIR "${CMAKE_SOURCE_DIR}/../submodules/duckdb_lua")

# Lua core C library (excludes lua.c/luac.c/onelua.c interpreter entry points
# and ltests.c which is internal test code).
#
# liolib.c, loslib.c, loadlib.c, and linit.c are handled specially below:
# the MVP/EH targets use FILESYSTEM=0 so those files are excluded and replaced
# with a custom linit that only registers filesystem-free libs.
set(LUA_C_SOURCES
    ${LUA_C_SOURCE_DIR}/lapi.c
    ${LUA_C_SOURCE_DIR}/lauxlib.c
    ${LUA_C_SOURCE_DIR}/lbaselib.c
    ${LUA_C_SOURCE_DIR}/lcode.c
    ${LUA_C_SOURCE_DIR}/lcorolib.c
    ${LUA_C_SOURCE_DIR}/lctype.c
    ${LUA_C_SOURCE_DIR}/ldblib.c
    ${LUA_C_SOURCE_DIR}/ldebug.c
    ${LUA_C_SOURCE_DIR}/ldo.c
    ${LUA_C_SOURCE_DIR}/ldump.c
    ${LUA_C_SOURCE_DIR}/lfunc.c
    ${LUA_C_SOURCE_DIR}/lgc.c
    ${LUA_C_SOURCE_DIR}/llex.c
    ${LUA_C_SOURCE_DIR}/lmathlib.c
    ${LUA_C_SOURCE_DIR}/lmem.c
    ${LUA_C_SOURCE_DIR}/lobject.c
    ${LUA_C_SOURCE_DIR}/lopcodes.c
    ${LUA_C_SOURCE_DIR}/lparser.c
    ${LUA_C_SOURCE_DIR}/lstate.c
    ${LUA_C_SOURCE_DIR}/lstring.c
    ${LUA_C_SOURCE_DIR}/lstrlib.c
    ${LUA_C_SOURCE_DIR}/ltable.c
    ${LUA_C_SOURCE_DIR}/ltablib.c
    ${LUA_C_SOURCE_DIR}/ltm.c
    ${LUA_C_SOURCE_DIR}/lundump.c
    ${LUA_C_SOURCE_DIR}/lutf8lib.c
    ${LUA_C_SOURCE_DIR}/lvm.c
    ${LUA_C_SOURCE_DIR}/lzio.c)

if(EMSCRIPTEN AND NOT WITH_WASM_THREADS)
  # MVP and EH builds use -s FILESYSTEM=0. Lua's io, os, and package libs
  # require filesystem syscalls that aren't available. Exclude those C files
  # and use a custom linit.c that only opens the filesystem-free libs.
  list(APPEND LUA_C_SOURCES
      ${CMAKE_SOURCE_DIR}/src/extensions/lua_wasm_linit.c)
else()
  # COI (threads) build: WasmFS provides a filesystem, include all libs.
  list(APPEND LUA_C_SOURCES
      ${LUA_C_SOURCE_DIR}/linit.c
      ${LUA_C_SOURCE_DIR}/liolib.c
      ${LUA_C_SOURCE_DIR}/loslib.c
      ${LUA_C_SOURCE_DIR}/loadlib.c)
endif()

add_library(lua_c_lib STATIC ${LUA_C_SOURCES})
target_include_directories(lua_c_lib PUBLIC ${LUA_C_SOURCE_DIR})

if(EMSCRIPTEN)
  if(WITH_WASM_EXCEPTIONS)
    # EH and COI targets use native Wasm exceptions (-fwasm-exceptions).
    # Lua's C error handling uses setjmp/longjmp; compile with the same flag
    # so longjmp uses the native Wasm mechanism instead of invoke_ wrappers.
    target_compile_options(lua_c_lib PRIVATE -fwasm-exceptions)
  endif()
  if(WITH_WASM_THREADS)
    # COI target: all object files must be compiled with atomics+bulk-memory
    # for shared memory (pthreads). Emscripten adds these to C++ via
    # -sUSE_PTHREADS=1 in CMAKE_CXX_FLAGS, but Lua is a C library so we
    # must add them explicitly.
    target_compile_options(lua_c_lib PRIVATE -matomics -mbulk-memory -sUSE_PTHREADS=1)
  endif()
endif()
