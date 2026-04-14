/**
 * Spring compatibility API for client-side Lua widgets.
 *
 * These are thin JS implementations of the Spring Lua API that widgets
 * expect. We implement only the subset actually used by the widgets we
 * currently support — each widget we add may require more functions.
 *
 * Design:
 *   - SpringAPIContext holds per-game state (map dims, heightmap, game time)
 *     that the API functions need to answer queries.
 *   - buildSpringGlobals(ctx) returns a flat {Spring, Game, GL, VFS} object
 *     that can be installed into a LuaRuntime via setGlobal in one pass.
 *   - VFS is pre-populated with fetched .lua sources keyed by path so
 *     VFS.Include can be synchronous.
 */
import { LuaRuntime, type LuaValue } from './lua-runtime.js';
import { lua, to_luastring } from 'fengari-web';

/** Context passed in when constructing the Spring shim. */
export interface SpringAPIContext {
    /** Map width in elmos (world units). */
    mapSizeX: number;
    /** Map depth in elmos. */
    mapSizeZ: number;
    /** Heightmap — square grid of (mapx+1)*(mapy+1) corner heights in world units. */
    heightmap: Uint16Array;
    /** Heightmap grid width (mapx+1). */
    heightmapWidth: number;
    /** Heightmap grid height (mapy+1). */
    heightmapHeight: number;
    /** Height value → world Y conversion. */
    minHeight: number;
    maxHeight: number;
    /** Square size in elmos (typically 8). */
    squareSize: number;
    /**
     * Pre-fetched source files, keyed by forward-slash path. Populated
     * from the map's own `LuaUI/` tree and the currently-loaded game's
     * VFS. `VFS.Include()` looks up sources here — the widget host is
     * responsible for pre-fetching anything a widget may reference
     * synchronously.
     */
    vfsFiles: Map<string, string>;
    /** Optional game rules params (stubbed lookup). */
    gameRulesParams?: Map<string, number>;
    /** getGameSeconds callback — usually `() => Date.now()/1000 - startTime`. */
    getGameSeconds(): number;
}

/**
 * Convert Spring-style asset paths (":a:LuaUI\Images\foo.png") into
 * clean forward-slash paths ("LuaUI/Images/foo.png"). Also handles
 * plain backslash paths.
 */
export function normaliseSpringPath(path: string): string {
    let p = path;
    // Strip VFS mode prefix: `:a:`, `:r:`, `:s:` etc.
    if (p.startsWith(':') && p.length >= 3 && p[2] === ':') {
        p = p.substring(3);
    }
    // Spring uses backslashes in source even on Linux.
    p = p.replace(/\\/g, '/');
    // Strip any leading slash.
    if (p.startsWith('/')) p = p.substring(1);
    return p;
}

/** Build the global-table set a Lua widget needs. */
export function buildSpringGlobals(ctx: SpringAPIContext): Record<string, LuaValue> {
    // --- GL constants table. Only the values lava_layer touches. ---
    const GL: Record<string, LuaValue> = {
        // Draw primitives
        TRIANGLES: 0x0004,
        TRIANGLE_STRIP: 0x0005,
        TRIANGLE_FAN: 0x0006,
        QUADS: 0x0007,
        LINES: 0x0001,
        LINE_LOOP: 0x0002,
        LINE_STRIP: 0x0003,
        POINTS: 0x0000,
        // Blend factors
        ZERO: 0x0000,
        ONE: 0x0001,
        SRC_ALPHA: 0x0302,
        ONE_MINUS_SRC_ALPHA: 0x0303,
        DST_ALPHA: 0x0304,
        ONE_MINUS_DST_ALPHA: 0x0305,
        SRC_COLOR: 0x0300,
        ONE_MINUS_SRC_COLOR: 0x0301,
        DST_COLOR: 0x0306,
        ONE_MINUS_DST_COLOR: 0x0307,
        // Clear bits
        COLOR_BUFFER_BIT: 0x00004000,
        DEPTH_BUFFER_BIT: 0x00000100,
        STENCIL_BUFFER_BIT: 0x00000400,
        // Attrib bits (Spring passes these to gl.PushAttrib — we mostly ignore)
        ALL_ATTRIB_BITS: 0xFFFFFFFF,
        CURRENT_BIT: 0x00000001,
        ENABLE_BIT: 0x00002000,
        COLOR_BUFFER_BIT_A: 0x00004000,
        // Matrix modes
        PROJECTION: 0x1701,
        MODELVIEW: 0x1700,
        TEXTURE_MATRIX: 0x1702,
        // Texture formats
        RGBA: 0x1908,
        RGB: 0x1907,
        LUMINANCE: 0x1909,
        ALPHA: 0x1906,
        // Texture filters
        NEAREST: 0x2600,
        LINEAR: 0x2601,
        NEAREST_MIPMAP_NEAREST: 0x2700,
        LINEAR_MIPMAP_NEAREST: 0x2701,
        LINEAR_MIPMAP_LINEAR: 0x2703,
        // Wrap modes
        CLAMP_TO_EDGE: 0x812F,
        CLAMP: 0x2900,
        REPEAT: 0x2901,
        MIRRORED_REPEAT: 0x8370,
    };

    // --- Game table: static map/game constants. ---
    //
    // Spring exposes two flavours of map size:
    //   mapSizeX / mapSizeZ — world coordinates in elmos (1 square = 8 elmos)
    //   mapX    / mapY     — heightmap grid squares (mapSizeX/8)
    // Widgets use either depending on purpose; provide both so neither
    // tries to arithmetic on nil.
    const squareSize = ctx.squareSize || 8;
    const Game: Record<string, LuaValue> = {
        mapSizeX: ctx.mapSizeX,
        mapSizeZ: ctx.mapSizeZ,
        mapSizeY: ctx.mapSizeZ, // Spring uses Z for depth; some scripts use Y
        mapX: Math.floor(ctx.mapSizeX / squareSize),
        mapY: Math.floor(ctx.mapSizeZ / squareSize),
        squareSize: squareSize,
        gameSpeed: 30,
    };

    // --- VFS mode constants ---
    //
    // Spring's VFS functions take an optional mode argument that picks
    // which archive layer(s) to search. Real Spring uses bitmasks; we
    // just export distinct sentinel numbers because our VFS is a flat
    // pre-fetched map that doesn't honour layering yet. Widgets that
    // pass these as an argument get back whatever we have.
    const VFS_MODES: Record<string, number> = {
        RAW_ONLY:  1,
        ZIP_ONLY:  2,
        RAW_FIRST: 3,
        ZIP_FIRST: 4,
        ZIP:       5,
        RAW:       6,
        MAP:       7,
        GAME:      8,
        BASE:      9,
        MENU:      10,
        DEF_MODE:  5,
    };

    // --- VFS table. Synchronous Include backed by pre-fetched cache. ---
    // Spring's VFS.Include returns the chunk's return value. Many mapinfo.lua
    // files end with `return mapinfo` so we have to execute and capture the
    // final return. We do that by loading the source into the *same* Lua
    // state that called Include — but since we only have access to the JS
    // layer here, we use a fresh sub-runtime. For mapinfo.lua specifically,
    // that's fine: it's side-effect free and returns a pure table.
    //
    // NOTE: circular includes are possible if a file includes itself via a
    // different path. We don't guard against this yet.
    const VFS: Record<string, LuaValue> = {
        ...VFS_MODES,
        Include: (path: LuaValue) => {
            const normalised = normaliseSpringPath(String(path));
            const source = ctx.vfsFiles.get(normalised);
            if (!source) {
                console.warn(`[VFS] Include missing: ${normalised}`);
                return null;
            }
            // Execute the chunk in a fresh sub-runtime to capture return value.
            // This is inefficient for frequent calls but acceptable for the
            // one-time mapinfo.lua include in widget init.
            return includeLuaFile(source, normalised, ctx);
        },
        FileExists: (path: LuaValue) => {
            return ctx.vfsFiles.has(normaliseSpringPath(String(path)));
        },
        LoadFile: (path: LuaValue) => {
            return ctx.vfsFiles.get(normaliseSpringPath(String(path))) ?? null;
        },
        DirList: (_path: LuaValue, _pattern: LuaValue, _mode: LuaValue) => {
            // Stub — returns empty table
            return [];
        },
    };

    // --- Spring table: per-call query functions. ---
    const Spring: Record<string, LuaValue> = {
        GetGameSeconds: () => ctx.getGameSeconds(),
        GetGameFrame: () => Math.floor(ctx.getGameSeconds() * 30),
        GetWind: () => {
            // Spring returns 7 values: wx, wy, wz, wStr, dx, dy, dz
            // We stub a gentle breeze — stationary for now.
            return [0, 0, 0, 0, 0, 0, 0];
        },
        GetGroundHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), Number(z));
        },
        GetGroundOrigHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), Number(z));
        },
        GetGameRulesParam: (key: LuaValue) => {
            return ctx.gameRulesParams?.get(String(key)) ?? 0;
        },
        Echo: (...args: LuaValue[]) => {
            console.log('[Spring.Echo]', ...args.map(a => String(a)));
        },
        SendCommands: (_cmd: LuaValue) => {
            // Console commands — ignored in browser client.
        },
        GetConfigInt: (_key: LuaValue, def: LuaValue) => Number(def ?? 0),
        GetConfigFloat: (_key: LuaValue, def: LuaValue) => Number(def ?? 0),
        GetConfigString: (_key: LuaValue, def: LuaValue) => String(def ?? ''),
        GetModOptions: () => ({}),
        GetViewGeometry: () => [1920, 1080, 0, 0],
        GetSpectatingState: () => [false, false, false],
        IsReplay: () => false,
        GetLocalPlayerID: () => 0,
        GetMyPlayerID: () => 0,
        GetGaiaTeamID: () => 1,
        CreateDir: (_path: LuaValue) => true,
        // LOS view colours — arrays of 3 floats each. los_brightness_modifier
        // reads these at init. Defaults mirror Spring's hard-coded baselines.
        GetLosViewColors: () => [
            [0.2, 0.2, 0.2],   // always
            [0.3, 0.3, 0.3],   // LOS
            [0.3, 0.3, 0.3],   // radar
            [0.15, 0.15, 0.15],// jammer
            [0.3, 0.3, 0.3],   // radar2
        ],
        SetLosViewColors: (..._args: LuaValue[]) => {
            // No-op: the client renders its own LOS overlay out-of-band.
        },
    };

    // --- io stub ---
    //
    // Some widgets (e.g. scorched_crossing's export_metalmap.lua) use
    // `io.open` to dump debugging data to disk. That's impossible in a
    // browser — we provide a stub so the widget errors cleanly at call
    // time rather than NPE'ing on module access. Returning nil + error
    // mirrors Lua's standard `io.open` on permission failure.
    const io: Record<string, LuaValue> = {
        open: (_path: LuaValue, _mode: LuaValue) => {
            return [null, 'io disabled in browser widget runtime'];
        },
        read:  () => null,
        write: () => null,
        close: () => null,
    };

    // --- LuaUI globals ---
    //
    // Path-like constants and the version string the base widgets.lua
    // might expect. Paper Tanks' game-level widgets.lua (fetched from
    // /api/games/data/papertanks/LuaUI/widgets.lua) also sets these, but
    // providing them here means widgets that run before the game base
    // is prefetched still see sane values.
    const LUAUI_DIRNAME = 'LuaUI/';
    const LUAUI_VERSION = 'spring-web LuaUI v0.1';

    return {
        GL, Game, VFS, Spring,
        io,
        LUAUI_DIRNAME,
        LUAUI_VERSION,
    };
}

/**
 * Sample the heightmap at world position (x, z). Uses bilinear interpolation
 * over the 4 nearest corner heights. Mirrors Spring's Spring.GetGroundHeight.
 */
function sampleHeight(ctx: SpringAPIContext, x: number, z: number): number {
    const squareSize = ctx.squareSize;
    const gx = Math.max(0, Math.min(ctx.heightmapWidth - 2, x / squareSize));
    const gz = Math.max(0, Math.min(ctx.heightmapHeight - 2, z / squareSize));
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const stride = ctx.heightmapWidth;
    const h00 = ctx.heightmap[iz * stride + ix];
    const h10 = ctx.heightmap[iz * stride + ix + 1];
    const h01 = ctx.heightmap[(iz + 1) * stride + ix];
    const h11 = ctx.heightmap[(iz + 1) * stride + ix + 1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    const raw = h0 * (1 - fz) + h1 * fz;
    // Heightmap stores uint16 in the range [0, 65535] mapped linearly
    // to [minHeight, maxHeight].
    return ctx.minHeight + (raw / 65535) * (ctx.maxHeight - ctx.minHeight);
}

/**
 * Load a Lua source string in a *sub-runtime* and return the value the
 * chunk returns. Used by VFS.Include. We can't use the caller's runtime
 * because loading source into it would pollute globals; executing in a
 * fresh state captures the return cleanly.
 */
function includeLuaFile(source: string, chunkName: string, ctx: SpringAPIContext): LuaValue {
    const sub = new LuaRuntime(`include:${chunkName}`);
    // Install the same stub surface the caller had. mapinfo.lua uses
    // VFS.Include("maphelper/mapinfo.lua"), Spring.*, Game.*, so we need
    // to recursively provide these.
    const subGlobals = buildSpringGlobals(ctx);
    for (const [k, v] of Object.entries(subGlobals)) sub.setGlobal(k, v);
    // Patch the source: many mapinfo.lua files end with `return mapinfo`
    // but some just define the global. If there's no explicit return,
    // append one so the chunk yields a value.
    const patched = /\breturn\s+\w+\s*$/m.test(source)
        ? source
        : source + '\nreturn mapinfo';
    const err = sub.doString(patched, chunkName);
    if (err) {
        console.warn(`[VFS.Include] ${chunkName}: ${err}`);
        sub.dispose();
        return null;
    }
    // Read the return value at the top of the stack. doString uses pcall
    // with LUA_MULTRET so the chunk's return value (if any) is there.
    let result: LuaValue = null;
    if (lua.lua_gettop(sub.L) > 0) {
        result = sub.readValue(-1);
    }
    if (result === null) {
        // Fallback: grab the `mapinfo` global directly.
        lua.lua_getglobal(sub.L, to_luastring('mapinfo'));
        result = sub.readValue(-1);
    }
    sub.dispose();
    return result;
}
