/*
 * Custom Lua library initializer for WASM builds with FILESYSTEM=0 (MVP/EH).
 * Excludes io, os, and package libs which require filesystem syscalls that
 * are not available when Emscripten is built without filesystem support.
 *
 * Adapted from Lua 5.4 linit.c (MIT License).
 */
#define LUA_LIB
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

static const luaL_Reg loadedlibs[] = {
    {LUA_GNAME,       luaopen_base},
    {LUA_COLIBNAME,   luaopen_coroutine},
    {LUA_TABLIBNAME,  luaopen_table},
    {LUA_STRLIBNAME,  luaopen_string},
    {LUA_MATHLIBNAME, luaopen_math},
    {LUA_UTF8LIBNAME, luaopen_utf8},
    {LUA_DBLIBNAME,   luaopen_debug},
    {NULL, NULL}
};

LUALIB_API void luaL_openlibs(lua_State *L) {
    const luaL_Reg *lib;
    for (lib = loadedlibs; lib->func; lib++) {
        luaL_requiref(L, lib->name, lib->func, 1);
        lua_pop(L, 1);
    }
}
