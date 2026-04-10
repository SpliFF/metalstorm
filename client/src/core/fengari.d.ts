/**
 * Ambient declarations for fengari-web (pre-built browser bundle of
 * fengari). The package ships no types; we declare the narrow surface
 * area we actually use. Everything is typed as `any` rather than
 * `unknown` to avoid wrapping every call in a cast — the C-style API
 * doesn't lend itself to strict typing.
 *
 * We import from 'fengari-web' rather than 'fengari' so Vite picks up
 * the webpack bundle that has Node-specific code (process.env, os) baked
 * out, rather than trying to resolve those at browser runtime.
 */
declare module 'fengari-web' {
    export const lua: {
        LUA_OK: number;
        LUA_MULTRET: number;
        LUA_TNIL: number;
        LUA_TBOOLEAN: number;
        LUA_TLIGHTUSERDATA: number;
        LUA_TNUMBER: number;
        LUA_TSTRING: number;
        LUA_TTABLE: number;
        LUA_TFUNCTION: number;
        LUA_TUSERDATA: number;
        LUA_TTHREAD: number;
        LUA_REGISTRYINDEX: number;

        lua_close(L: any): void;
        lua_pushvalue(L: any, idx: number): void;
        lua_rawgeti(L: any, idx: number, n: number): number;
        lua_rawlen(L: any, idx: number): number;
        lua_gettop(L: any): number;
        lua_settop(L: any, idx: number): void;
        lua_pop(L: any, n: number): void;
        lua_type(L: any, idx: number): number;
        lua_isfunction(L: any, idx: number): boolean;
        lua_iscfunction(L: any, idx: number): boolean;
        lua_istable(L: any, idx: number): boolean;
        lua_isnil(L: any, idx: number): boolean;
        lua_toboolean(L: any, idx: number): boolean;
        lua_tonumber(L: any, idx: number): number;
        lua_tostring(L: any, idx: number): Uint8Array | null;
        lua_pushnil(L: any): void;
        lua_pushboolean(L: any, b: number): void;
        lua_pushnumber(L: any, n: number): void;
        lua_pushinteger(L: any, n: number): void;
        lua_pushstring(L: any, s: Uint8Array | null): Uint8Array | null;
        lua_pushlightuserdata(L: any, p: any): void;
        lua_touserdata(L: any, idx: number): any;
        lua_islightuserdata(L: any, idx: number): boolean;
        lua_pushjsfunction(L: any, fn: (L: any) => number): void;
        lua_createtable(L: any, narr: number, nrec: number): void;
        lua_rawseti(L: any, idx: number, n: number): void;
        lua_setfield(L: any, idx: number, k: Uint8Array): void;
        lua_getfield(L: any, idx: number, k: Uint8Array): number;
        lua_getglobal(L: any, name: Uint8Array): number;
        lua_setglobal(L: any, name: Uint8Array): void;
        lua_pcall(L: any, nargs: number, nresults: number, errfunc: number): number;
        lua_remove(L: any, idx: number): void;
        lua_insert(L: any, idx: number): void;
        lua_next(L: any, idx: number): number;
    };

    export const lauxlib: {
        luaL_newstate(): any;
        luaL_loadbuffer(L: any, buf: Uint8Array, size: number, name: Uint8Array): number;
        luaL_loadstring(L: any, s: Uint8Array): number;
        luaL_dostring(L: any, s: Uint8Array): number;
        luaL_error(L: any, msg: Uint8Array): number;
        luaL_ref(L: any, t: number): number;
        luaL_unref(L: any, t: number, ref: number): void;
    };

    export const lualib: {
        luaL_openlibs(L: any): void;
    };

    export function to_luastring(s: string): Uint8Array;
    export function to_jsstring(s: Uint8Array): string;
}
