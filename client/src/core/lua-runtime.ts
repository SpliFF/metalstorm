/**
 * LuaRuntime — thin wrapper around fengari (Lua 5.3 in JS).
 *
 * This is our bootstrap runtime for client-side widgets. PLAN-scripting.md
 * specifies a forked wasmoon Lua 5.1 for production, but fengari is a
 * drop-in Lua VM that runs today without a custom WASM build. Performance
 * is lower (pure JS interpreter, no shared memory command buffer), but it
 * unblocks the API design and lets us load real Spring widgets while we
 * decide whether the perf cost justifies the WASM port.
 *
 * We import from `fengari-web` (not `fengari` directly) because it ships
 * a pre-built webpack bundle with the browser branch of luaconf.js baked
 * in. Importing from the raw `fengari` package tries to dereference
 * `process.env` / `require('os').platform()` at module load, which Vite
 * cannot resolve in the browser.
 *
 * The runtime is per-widget: each widget gets its own lua_State so they
 * cannot interfere with each other. Globals set into one state are
 * invisible to others. Shared APIs (Spring, gl, Game, VFS, GL) are
 * re-registered into every new state by the caller.
 */
import {
    lua,
    lauxlib,
    lualib,
    to_luastring,
    to_jsstring,
} from 'fengari-web';

/**
 * Callable wrapper returned by readValueFrom when the Lua value is a
 * function. Invoking it re-enters the Lua VM via a registry ref. We
 * expose `release()` so callers can drop the ref once the JS side is
 * done with it (e.g. after running a one-shot callback). Callers who
 * don't call release() leak the ref until the runtime is disposed —
 * acceptable for short-lived widget callbacks.
 */
export interface LuaFnRef {
    (...args: LuaValue[]): LuaValue | undefined;
    __luaFnRef: number;
    release(): void;
}

/** Opaque handle to a fengari lua_State. */
export type LuaState = unknown;

/**
 * Marker brand used to mark JS objects that should be passed to Lua as
 * light userdata (opaque pointers) instead of being walked into Lua
 * tables. gl.* handles (shaders, textures, FBOs, VAOs) use this so they
 * round-trip through Lua without having their internal WebGL references
 * stripped by the table walker.
 *
 * We use a runtime sentinel — any object whose `__lua_opaque` field is
 * `true` is passed via lightuserdata.
 */
export const LUA_OPAQUE = Symbol('lua_opaque');
export function markOpaque<T extends object>(obj: T): T {
    (obj as { [LUA_OPAQUE]?: true })[LUA_OPAQUE] = true;
    return obj;
}
export function isOpaque(v: unknown): boolean {
    return typeof v === 'object' && v !== null && (v as { [LUA_OPAQUE]?: true })[LUA_OPAQUE] === true;
}

/**
 * Wrapper that forces an array to be marshalled as a Lua table (1-indexed
 * sequence) rather than as multiple return values. Use this when a Spring API
 * function returns a Lua table — e.g. GetPlayerList returns {[1]=0, [2]=1},
 * not two separate values 0 and 1.
 */
const LUA_TABLE = Symbol('lua_table');
export class LuaTable {
    [LUA_TABLE] = true as const;
    items: LuaValue[];
    constructor(items: LuaValue[]) {
        this.items = items;
    }
}
export function luaTable(...items: LuaValue[]): LuaTable {
    return new LuaTable(items);
}
export function isLuaTable(v: unknown): v is LuaTable {
    return typeof v === 'object' && v !== null && (v as { [LUA_TABLE]?: true })[LUA_TABLE] === true;
}

/** Argument types we marshal between JS and Lua. */
export type LuaValue =
    | null
    | undefined
    | boolean
    | number
    | string
    | LuaValue[]
    | { [key: string]: LuaValue }
    | object  // opaque handle (marked via markOpaque)
    | ((...args: LuaValue[]) => LuaValue | LuaValue[] | void);

/**
 * Detect whether a Lua table at the given stack index is a pure sequence
 * (keys 1..N with no holes and no non-integer keys). We use this in
 * readValueFrom so that Lua arrays round-trip to JS arrays instead of
 * objects with string keys — otherwise `fogcolor[1]` on a rehydrated
 * table would break because JS object keys become "1", "2", ... and the
 * Lua side would see fogcolor having *both* string and integer keys.
 */
function tableIsSequence(lua: any, L: any, idx: number): boolean {
    // Normalise to absolute index so we can push keys without shifting.
    const absIdx = idx < 0 ? lua.lua_gettop(L) + idx + 1 : idx;
    let count = 0;
    lua.lua_pushnil(L);
    while (lua.lua_next(L, absIdx) !== 0) {
        // key at -2, value at -1
        if (lua.lua_type(L, -2) !== lua.LUA_TNUMBER) {
            lua.lua_pop(L, 2);
            return false;
        }
        const n = lua.lua_tonumber(L, -2);
        if (!Number.isInteger(n) || n < 1) {
            lua.lua_pop(L, 2);
            return false;
        }
        count++;
        lua.lua_pop(L, 1); // pop value, keep key
    }
    // After iteration, check there were exactly `count` contiguous keys
    // starting at 1. The easy way: length via lua_rawlen.
    const len = lua.lua_rawlen(L, absIdx);
    return len === count && len > 0;
}

export class LuaRuntime {
    readonly L: LuaState;
    /** User-readable name used in error messages. */
    readonly name: string;

    constructor(name: string) {
        this.name = name;
        this.L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(this.L);
    }

    /**
     * Load and execute a chunk of Lua source. Returns `null` on success
     * or an error message on failure. The chunk runs in the global env.
     */
    doString(source: string, chunkName: string = this.name): string | null {
        const L = this.L;
        const sourceBytes = to_luastring(source);
        const nameBytes = to_luastring('=' + chunkName);
        let status = lauxlib.luaL_loadbuffer(
            L, sourceBytes, sourceBytes.length, nameBytes,
        );
        if (status !== lua.LUA_OK) {
            const err = to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<unknown>'));
            lua.lua_pop(L, 1);
            return `load error: ${err}`;
        }
        status = lua.lua_pcall(L, 0, lua.LUA_MULTRET, 0);
        if (status !== lua.LUA_OK) {
            const err = to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<unknown>'));
            lua.lua_pop(L, 1);
            return `runtime error: ${err}`;
        }
        return null;
    }

    /**
     * Execute Lua source that returns a value. The source should contain
     * a `return` statement. Returns the first return value as a JS value,
     * or null on error.
     */
    evalString(source: string, chunkName: string = this.name): LuaValue {
        const L = this.L;
        const top = lua.lua_gettop(L);
        const sourceBytes = to_luastring(source);
        const nameBytes = to_luastring('=' + chunkName);
        let status = lauxlib.luaL_loadbuffer(
            L, sourceBytes, sourceBytes.length, nameBytes,
        );
        if (status !== lua.LUA_OK) {
            lua.lua_settop(L, top);
            return null;
        }
        status = lua.lua_pcall(L, 0, 1, 0);
        if (status !== lua.LUA_OK) {
            lua.lua_settop(L, top);
            return null;
        }
        if (lua.lua_gettop(L) > top) {
            const val = this.readValue(-1);
            lua.lua_settop(L, top);
            return val;
        }
        return null;
    }

    /**
     * Set a global. Accepts primitives, plain objects (→ Lua table),
     * arrays (→ Lua sequence), and functions (→ Lua C function that
     * marshals arguments back to JS).
     */
    setGlobal(key: string, value: LuaValue): void {
        this.pushValue(value);
        lua.lua_setglobal(this.L, to_luastring(key));
    }

    /**
     * Call a method on a global table with `:` (self) calling convention:
     * `TABLE:METHOD(...)`. Spring widget callins are defined with `:` —
     * `function widget:GameFrame(f)` desugars to
     * `function widget.GameFrame(self, f)`, so the engine must pass the
     * widget table as the first argument or `f` arrives in `self` and the
     * real `f` is nil.
     *
     * Returns the single primary return value (top of stack) or undefined.
     */
    callTableFn(tableName: string, fnName: string, ...args: LuaValue[]): LuaValue | undefined {
        const L = this.L;
        const top0 = lua.lua_gettop(L);

        lua.lua_getglobal(L, to_luastring(tableName));
        if (!lua.lua_istable(L, -1)) {
            lua.lua_settop(L, top0);
            return undefined;
        }
        // Stack: [..., table]
        lua.lua_getfield(L, -1, to_luastring(fnName));
        // Stack: [..., table, fn]
        if (!lua.lua_isfunction(L, -1)) {
            lua.lua_settop(L, top0);
            return undefined;
        }
        // Swap so the fn is below the table: [..., fn, table]. The table
        // becomes the first argument (self), matching `:` calling convention.
        lua.lua_insert(L, -2);
        for (const a of args) this.pushValue(a);
        // args.length + 1 because we also pass the table as self.
        const status = lua.lua_pcall(L, args.length + 1, 1, 0);
        if (status !== lua.LUA_OK) {
            const err = to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<unknown>'));
            lua.lua_pop(L, 1);
            console.error(`[lua ${this.name}] ${tableName}.${fnName} error: ${err}`);
            return undefined;
        }
        const result = this.readValue(-1);
        lua.lua_settop(L, top0);
        return result;
    }

    /** Check whether global[table].key exists and is a function. */
    hasTableFn(tableName: string, fnName: string): boolean {
        const L = this.L;
        const top0 = lua.lua_gettop(L);
        lua.lua_getglobal(L, to_luastring(tableName));
        if (!lua.lua_istable(L, -1)) { lua.lua_settop(L, top0); return false; }
        lua.lua_getfield(L, -1, to_luastring(fnName));
        const ok = lua.lua_isfunction(L, -1);
        lua.lua_settop(L, top0);
        return ok;
    }

    // --- internal marshalling ---

    /** Push a JS value onto the Lua stack. */
    pushValue(v: LuaValue): void {
        const L = this.L;
        if (v === null || v === undefined) {
            lua.lua_pushnil(L);
        } else if (typeof v === 'boolean') {
            lua.lua_pushboolean(L, v ? 1 : 0);
        } else if (typeof v === 'number') {
            lua.lua_pushnumber(L, v);
        } else if (typeof v === 'string') {
            lua.lua_pushstring(L, to_luastring(v));
        } else if (isOpaque(v)) {
            // Opaque handle (gl.*) — round-trip via lightuserdata so the
            // JS object reference stays intact.
            lua.lua_pushlightuserdata(L, v);
        } else if (isLuaTable(v)) {
            // Explicit Lua table wrapper — push as a 1-indexed sequence table.
            const items = (v as LuaTable).items;
            lua.lua_createtable(L, items.length, 0);
            for (let i = 0; i < items.length; i++) {
                this.pushValue(items[i]);
                lua.lua_rawseti(L, -2, i + 1);
            }
        } else if (Array.isArray(v)) {
            lua.lua_createtable(L, v.length, 0);
            for (let i = 0; i < v.length; i++) {
                this.pushValue(v[i]);
                lua.lua_rawseti(L, -2, i + 1); // Lua is 1-indexed
            }
        } else if (typeof v === 'function') {
            // Wrap the JS function as a Lua C closure. Arguments are read
            // from the Lua stack, the JS function is called, its return
            // value is pushed back.
            const fn = v;
            lua.lua_pushjsfunction(L, (LS: unknown) => {
                const nargs = lua.lua_gettop(LS);
                const jsArgs: LuaValue[] = [];
                for (let i = 1; i <= nargs; i++) {
                    jsArgs.push(this.readValueFrom(LS, i));
                }
                let ret: LuaValue | LuaValue[] | void;
                try {
                    ret = fn(...jsArgs);
                } catch (e) {
                    const msg = (e instanceof Error ? e.message : String(e));
                    lauxlib.luaL_error(LS, to_luastring(msg));
                    return 0;
                }
                lua.lua_settop(LS, 0); // clear args
                if (ret === undefined) return 0;
                if (Array.isArray(ret)) {
                    for (const r of ret) this.pushValueTo(LS, r);
                    return ret.length;
                }
                this.pushValueTo(LS, ret);
                return 1;
            });
        } else if (typeof v === 'object') {
            const rec = v as Record<string, LuaValue>;
            const keys = Object.keys(rec);
            lua.lua_createtable(L, 0, keys.length);
            for (const k of keys) {
                this.pushValue(rec[k]);
                lua.lua_setfield(L, -2, to_luastring(k));
            }
        } else {
            lua.lua_pushnil(L);
        }
    }

    /** Same as pushValue but targeted at a given state (for nested calls). */
    private pushValueTo(LS: unknown, v: LuaValue): void {
        // Reuse push logic but for a foreign state. In practice LS === this.L
        // (fengari only has one state per runtime), so we just call pushValue.
        const oldL = (this as any).L;
        (this as any).L = LS;
        try { this.pushValue(v); }
        finally { (this as any).L = oldL; }
    }

    /** Read a Lua value at a given stack index. */
    readValue(idx: number): LuaValue {
        return this.readValueFrom(this.L, idx);
    }

    private readValueFrom(LS: unknown, idx: number): LuaValue {
        const t = lua.lua_type(LS, idx);
        switch (t) {
            case lua.LUA_TNIL:
                return null;
            case lua.LUA_TBOOLEAN:
                return lua.lua_toboolean(LS, idx);
            case lua.LUA_TNUMBER:
                return lua.lua_tonumber(LS, idx);
            case lua.LUA_TSTRING: {
                const s = lua.lua_tostring(LS, idx);
                return s === null ? '' : to_jsstring(s);
            }
            case lua.LUA_TLIGHTUSERDATA:
                // Opaque handle round-tripped from pushValue.
                return lua.lua_touserdata(LS, idx) as LuaValue;
            case lua.LUA_TFUNCTION: {
                // Both Lua functions and C functions (JS closures pushed via
                // lua_pushjsfunction) get a registry ref + callable wrapper.
                // This is required for gl.CreateList(gl.Texture, path) where
                // gl.Texture is a C function that must survive stack cleanup
                // and be callable from JS. Registry refs are small; the leak
                // concern is bounded because table reads that encounter
                // functions are infrequent (widget init, not per-frame).
                lua.lua_pushvalue(LS, idx);
                const ref = lauxlib.luaL_ref(LS, lua.LUA_REGISTRYINDEX);
                return this.makeFunctionRef(ref) as unknown as LuaValue;
            }
            case lua.LUA_TTABLE: {
                // Prefer array form when the table is a pure sequence —
                // mapinfo tables like `fogcolor = {0.5, 0.6, 0.7}` must
                // round-trip as JS arrays so `fogcolor[1]` resolves.
                if (tableIsSequence(lua, LS, idx)) {
                    const len = lua.lua_rawlen(LS, idx);
                    const arr: LuaValue[] = [];
                    const absIdx = idx < 0 ? lua.lua_gettop(LS) + idx + 1 : idx;
                    for (let i = 1; i <= len; i++) {
                        lua.lua_rawgeti(LS, absIdx, i);
                        arr.push(this.readValueFrom(LS, -1));
                        lua.lua_pop(LS, 1);
                    }
                    return arr;
                }
                // Map form — walk keys.
                const out: Record<string, LuaValue> = {};
                lua.lua_pushnil(LS);
                const tableIdx = idx < 0 ? idx - 1 : idx;
                while (lua.lua_next(LS, tableIdx) !== 0) {
                    const kt = lua.lua_type(LS, -2);
                    let key: string;
                    if (kt === lua.LUA_TNUMBER) {
                        key = String(lua.lua_tonumber(LS, -2));
                    } else if (kt === lua.LUA_TSTRING) {
                        const ks = lua.lua_tostring(LS, -2);
                        key = ks === null ? '' : to_jsstring(ks);
                    } else {
                        key = `<k:${kt}>`;
                    }
                    out[key] = this.readValueFrom(LS, -1);
                    lua.lua_pop(LS, 1);
                }
                return out;
            }
            default:
                return null;
        }
    }

    /**
     * Build a callable JS wrapper for a Lua function stored in the
     * registry at `ref`. Invoking the wrapper pushes the function and
     * its arguments onto the stack and pcalls it. Errors are logged
     * (not thrown) to mirror Spring's callin behaviour — widgets should
     * not take down the host on a scripting fault.
     */
    private makeFunctionRef(ref: number): LuaFnRef {
        const self = this;
        const fn = ((...args: LuaValue[]): LuaValue | undefined => {
            const L = self.L;
            lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, ref);
            if (!lua.lua_isfunction(L, -1)) {
                lua.lua_pop(L, 1);
                return undefined;
            }
            for (const a of args) self.pushValue(a);
            const status = lua.lua_pcall(L, args.length, 1, 0);
            if (status !== lua.LUA_OK) {
                const err = to_jsstring(lua.lua_tostring(L, -1) ?? to_luastring('<unknown>'));
                lua.lua_pop(L, 1);
                console.error(`[lua ${self.name}] callback error: ${err}`);
                return undefined;
            }
            const result = self.readValue(-1);
            lua.lua_pop(L, 1);
            return result;
        }) as LuaFnRef;
        fn.__luaFnRef = ref;
        fn.release = () => {
            lauxlib.luaL_unref(self.L, lua.LUA_REGISTRYINDEX, ref);
        };
        return fn;
    }

    dispose(): void {
        lua.lua_close(this.L);
    }
}
