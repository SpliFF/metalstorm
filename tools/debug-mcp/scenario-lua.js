/**
 * Bare-Lua evaluation for scenario files — the offline twin of
 * `ScenarioDiscovery::LoadOne` (rts/Server/ScenarioDiscovery.cpp:292-330).
 *
 * The lobby discovers scenarios by loading each `scenarios/*.lua` into a bare
 * `lua_State` with `luaL_openlibs` and nothing else: no `VFS`, no `Spring.*`,
 * no `GG`. A file that touches those at file scope does not error anywhere a
 * human will see — it is simply *absent* from the Create Game picker. That
 * silent-vanish is the failure mode `validate_scenario` exists to catch, so
 * this module reproduces the same load, in-process, with fengari.
 *
 * fengari is Lua 5.3 and the engine bundles a 5.1-lineage Lua. For the pure
 * table literals the bare parser requires, the dialects are identical; the
 * divergence risk is bounded by the regression sweep over every shipped
 * scenario (scenario-validate.test.js).
 */
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

// Bounds for the Lua->JS reader. A scenario file is authored content, but the
// MCP must not hang or blow the heap on a pathological one (a self-referential
// table, or a generated file with a runaway loop).
const MAX_DEPTH = 16;
const MAX_ENTRIES = 50000;

/**
 * Convert the Lua value at `idx` to plain JS.
 *
 * Arrays and hashes are both read as objects with numeric-or-string keys,
 * except that a table whose keys are exactly 1..n comes back as a JS array —
 * the schema's `units[]`/`objectives[]`/... are sequences everywhere, and the
 * rule checks read them with `.length`/index, exactly as the Lua `ipairs`
 * loops they mirror do.
 *
 * Values Lua allows but the schema never uses (functions, userdata) are
 * recorded as `{ __luatype: 'function' }` rather than dropped: a rule that
 * says "must be a string" should report what was actually there.
 */
function readValue(L, idx, depth, budget) {
    const t = lua.lua_type(L, idx);
    switch (t) {
        case lua.LUA_TNIL: return null;
        case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, idx);
        case lua.LUA_TNUMBER: return lua.lua_tonumber(L, idx);
        case lua.LUA_TSTRING: return to_jsstring(lua.lua_tostring(L, idx));
        case lua.LUA_TTABLE: return readTable(L, idx, depth, budget);
        default: return { __luatype: to_jsstring(lua.lua_typename(L, t)) };
    }
}

function readTable(L, idx, depth, budget) {
    if (depth >= MAX_DEPTH) return { __truncated: 'depth' };
    // Each level of descent holds a key and a value on the Lua stack for the
    // whole of its lua_next loop, and the default stack is LUA_MINSTACK (20)
    // slots. Without this a table nested ~10 deep — or a self-referential one —
    // raises a Lua "stack overflow" from inside the reader, which surfaced as a
    // whole-file `bare-parse` error for a file the lobby loads perfectly well.
    if (!lua.lua_checkstack(L, 4)) return { __truncated: 'stack' };
    const abs = lua.lua_absindex(L, idx);
    const out = {};
    let maxIntKey = 0;
    let intKeys = 0;
    let otherKeys = 0;

    lua.lua_pushnil(L);
    while (lua.lua_next(L, abs) !== 0) {
        if (++budget.n > MAX_ENTRIES) {
            lua.lua_pop(L, 2);          // value + key
            out.__truncated = 'entries';
            break;
        }
        // -2 = key, -1 = value. Read the key WITHOUT lua_tostring on a number:
        // that would coerce the key in place and break lua_next's iteration.
        const kt = lua.lua_type(L, -2);
        let key = null;
        if (kt === lua.LUA_TNUMBER) {
            const n = lua.lua_tonumber(L, -2);
            key = String(n);
            if (Number.isInteger(n) && n >= 1) { intKeys++; if (n > maxIntKey) maxIntKey = n; }
            else otherKeys++;
        } else if (kt === lua.LUA_TSTRING) {
            key = to_jsstring(lua.lua_tostring(L, -2));
            otherKeys++;
        } else {
            otherKeys++;                 // boolean/table keys: legal Lua, not schema
            lua.lua_pop(L, 1);
            continue;
        }
        out[key] = readValue(L, -1, depth + 1, budget);
        lua.lua_pop(L, 1);
    }

    // A pure sequence (keys exactly 1..n) becomes a JS array.
    if (otherKeys === 0 && intKeys > 0 && maxIntKey === intKeys && !out.__truncated) {
        const arr = new Array(intKeys);
        for (let i = 1; i <= intKeys; i++) arr[i - 1] = out[String(i)];
        return arr;
    }
    return out;
}

/**
 * Load + run `source` in a fresh bare state and return its single return value
 * as JS. Mirrors LoadOne: openlibs only (so `require` exists in both VMs and
 * fails the same way on path resolution), pcall, must return a table.
 *
 * @returns {{ok: true, table: object}|{ok: false, error: string}}
 */
export function evalBareLua(source, chunkname = 'scenario') {
    const L = lauxlib.luaL_newstate();
    if (!L) return { ok: false, error: 'could not create a Lua state' };
    try {
        lualib.luaL_openlibs(L);
        const buf = to_luastring(source);
        if (lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@' + chunkname)) !== lua.LUA_OK)
            return { ok: false, error: to_jsstring(lua.lua_tostring(L, -1)) };
        if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK)
            return { ok: false, error: to_jsstring(lua.lua_tostring(L, -1)) };
        if (!lua.lua_istable(L, -1))
            return { ok: false, error: 'did not return a table' };
        return { ok: true, table: readValue(L, -1, 0, { n: 0 }) };
    } catch (e) {
        // fengari throws on some malformed input rather than returning an
        // error code; a thrown parse failure is still a parse failure.
        return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
        lua.lua_close(L);
    }
}
