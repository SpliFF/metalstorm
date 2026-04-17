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
import { LuaRuntime, type LuaValue, luaTable } from './lua-runtime.js';
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
        // Comparison functions (stencil, depth, alpha)
        NEVER: 0x0200,
        LESS: 0x0201,
        EQUAL: 0x0202,
        LEQUAL: 0x0203,
        GREATER: 0x0204,
        NOTEQUAL: 0x0205,
        GEQUAL: 0x0206,
        ALWAYS: 0x0207,
        // Stencil operations
        KEEP: 0x1E00,
        REPLACE: 0x1E01,
        INCR: 0x1E02,
        DECR: 0x1E03,
        INVERT: 0x150A,
        INCR_WRAP: 0x8507,
        DECR_WRAP: 0x8508,
        // Polygon mode (not supported in WebGL but needed as constants)
        POINT: 0x1B00,
        LINE: 0x1B01,
        FILL: 0x1B02,
        FRONT: 0x0404,
        BACK: 0x0405,
        FRONT_AND_BACK: 0x0408,
        // Internal formats for RBO
        DEPTH24_STENCIL8: 0x88F0,
        DEPTH_COMPONENT16: 0x81A5,
        DEPTH_COMPONENT24: 0x81A6,
        DEPTH_COMPONENT32F: 0x8CAC,
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
        // Map physics — from mapdefaults.lua; epicmenu reads these
        gravity: 130 * 900,     // 130 elmo/s² × (30 frames/s)²
        waterDamage: 0,
        tidal: 0,
        mapDescription: '',
        extractorRadius: 0,
        maxUnits: 5000,
        // Game metadata — engine provides these from the mod archive
        modName: 'Zero-K',
        modShortName: 'ZK',
        modDesc: '',
        modVersion: '1.0',
        gameName: 'Zero-K',
        gameVersion: '1.0',
        mapName: '',
        mapHumanName: '',
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
        GetViewGeometry: () => {
            // Return real canvas size if available, else reasonable fallback
            const c = typeof document !== 'undefined'
                ? document.querySelector('canvas')
                : null;
            return [c?.width ?? 1920, c?.height ?? 1080, 0, 0];
        },
        GetViewSizes: () => {
            const c = typeof document !== 'undefined'
                ? document.querySelector('canvas')
                : null;
            return [c?.width ?? 1920, c?.height ?? 1080];
        },
        GetWindowGeometry: () => {
            return [window?.innerWidth ?? 1920, window?.innerHeight ?? 1080, 0, 0];
        },
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

        // --- Config set (no-op in browser) ---
        SetConfigInt: (_key: LuaValue, _val: LuaValue) => {},
        SetConfigFloat: (_key: LuaValue, _val: LuaValue) => {},
        SetConfigString: (_key: LuaValue, _val: LuaValue) => {},

        // --- Logging ---
        Log: (_section: LuaValue, _level: LuaValue, ...args: LuaValue[]) => {
            console.log('[Spring.Log]', ...args.map(a => String(a ?? '')));
        },

        // --- Player/Team API (stubs returning minimal valid data) ---
        // NOTE: Functions returning Lua tables use luaTable() wrapper.
        // Plain JS arrays become multiple return values; luaTable() → single table.
        GetPlayerList: () => luaTable(0),
        GetPlayerInfo: (_playerId: LuaValue, _withKeys: LuaValue) => {
            // Pre-104.0.536: name, active, spectator, teamID, allyTeamID, ping, cpuUsage, country, rank, customkeys
            // Post-104.0.536 (what engine_compat expects): r1..r9, r10=customkeys(or desyncs), r11=customkeys(or desyncs)
            // engine_compat swaps r10<->r11, so we need at least 11 returns.
            // Returns: name, active, spectator, teamID, allyTeamID, ping, cpuUsage, country, rank, desyncs, customkeys, nbReadyMsgs
            return ['Player', true, false, 0, 0, 0, 0, '', '', 0, {}, 0];
        },
        GetAllyTeamList: () => luaTable(0, 1),
        GetTeamList: (_allyTeamId?: LuaValue) => luaTable(0, 1),
        GetTeamInfo: (_teamId: LuaValue) => {
            // teamID, leader, isDead, isAI, side, allyTeam, customKeys
            return [Number(_teamId ?? 0), 0, false, false, '', 0, {}];
        },
        GetPlayerRulesParam: () => null,
        GetTeamColor: (_teamId: LuaValue) => {
            // Return RGBA floats (multiple return values)
            const id = Number(_teamId ?? 0);
            const colors = [
                [0, 0, 1, 1], [1, 0, 0, 1], [0, 1, 0, 1], [1, 1, 0, 1],
            ];
            return colors[id % colors.length];
        },
        GetMyTeamID: () => 0,
        GetMyAllyTeamID: () => 0,
        GetTeamUnitCount: () => 0,

        // --- Map draw mode ---
        GetMapDrawMode: () => 'normal',

        // --- Shock front (camera shake) ---
        SetShockFrontFactors: () => {},

        // --- Selection ---
        GetSelectedUnits: () => luaTable(),
        GetSelectedUnitsCount: () => 0,
        GetSelectedUnitsSorted: () => ({}),
        GetSelectedUnitsCounts: () => ({}),

        // --- Unit queries (stubs) ---
        GetUnitDefID: () => null,
        GetUnitTeam: () => 0,
        GetUnitPosition: () => [0, 0, 0],
        GetUnitHealth: () => [100, 100, 0, 1, 0],
        GetUnitStates: () => ({}),
        GetUnitRulesParam: () => null,
        GetUnitIsStunned: () => [false, false, false],
        ValidUnitID: () => false,
        GetUnitIsDead: () => true,

        // --- Feature queries (stubs) ---
        GetFeatureDefID: () => null,
        ValidFeatureID: () => false,

        // --- Misc ---
        GetTimer: () => performance.now() / 1000,
        DiffTimers: (t1: LuaValue, t2: LuaValue) => Number(t1 ?? 0) - Number(t2 ?? 0),
        GetDrawFrame: () => 0,
        GetFPS: () => 60,
        WorldToScreenCoords: (_x: LuaValue, _y: LuaValue, _z: LuaValue) => [0, 0, 0],
        GetCameraPosition: () => [0, 500, 0],
        GetCameraDirection: () => [0, -1, 0],
        GetCameraState: () => ({ px: 0, py: 500, pz: 0, rx: 0, ry: 0, rz: 0 }),
        SetCameraState: () => {},
        GetGroundInfo: (_x: LuaValue, _z: LuaValue) => [0, 0, 0, 0, 0, 0, '', 0],
        GetGroundNormal: () => [0, 1, 0],
        GetSmoothMeshHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), Number(z));
        },
        IsPosInLos: () => true,
        IsPosInRadar: () => false,
        GetUnitsInRectangle: () => luaTable(),
        GetUnitsInCylinder: () => luaTable(),
        GetVisibleUnits: () => luaTable(),
        GetAllUnits: () => luaTable(),
        GetTeamUnits: () => luaTable(),
        GetTeamUnitsSorted: () => ({}),
        GetTeamUnitDefCount: () => 0,

        // --- Local team ---
        GetLocalTeamID: () => 0,

        // --- Game speed ---
        GetGameSpeed: () => [1, 1, false], // speed, wantedSpeed, paused

        // --- GUI state ---
        IsGUIHidden: () => false,

        // --- Ground extremes ---
        GetGroundExtremes: () => [0, 100], // minHeight, maxHeight

        // --- Custom command draw data ---
        SetCustomCommandDrawData: () => {},

        // --- Misc missing ---
        MarkerAddPoint: () => {},
        MarkerErasePosition: () => {},
        SetActiveCommand: () => {},
        GiveOrderToUnit: () => {},
        GiveOrderToUnitArray: () => {},
        GiveOrder: () => {},
        GetUnitCommands: () => luaTable(),
        GetFactoryCommands: () => luaTable(),
        GetCommandQueue: () => luaTable(),
        GetFullBuildQueue: () => luaTable(),
        SelectUnitArray: () => {},
        SetUnitGroup: () => {},
        GetGroupList: () => ({}),
        GetGroupUnits: () => luaTable(),
        GetGroupUnitsSorted: () => ({}),
        GetGroupUnitsCounts: () => ({}),

        // --- Extension queries ---
        HasExtension: () => true,

        // --- Active command ---
        GetActiveCommand: () => [0, 0, ''],

        // --- Sun ---
        GetSun: (_param: LuaValue) => {
            const p = String(_param ?? '');
            if (p === 'pos') return [500, 1000, 500];
            if (p === 'dir') return [0.5, -0.7, 0.5];
            if (p === 'specular') return [1, 1, 1];
            if (p === 'diffuse') return [1, 1, 1];
            if (p === 'ambient') return [0.3, 0.3, 0.3];
            return [1, 1, 1];
        },

        // --- Team rules params ---
        GetTeamRulesParam: () => null,

        // --- Keyboard ---
        GetKeyCode: (keyName: LuaValue) => {
            // Map Spring key names to key codes (DOM KeyboardEvent.keyCode compatible)
            const name = String(keyName ?? '').toLowerCase();
            const map: Record<string, number> = {
                'backspace': 8, 'tab': 9, 'return': 13, 'enter': 13,
                'esc': 27, 'escape': 27, 'space': 32,
                'delete': 127, 'del': 127,
                'left': 276, 'right': 275, 'up': 273, 'down': 274,
                'home': 278, 'end': 279,
                'pageup': 280, 'pagedown': 281,
                'insert': 277,
                'shift': 304, 'ctrl': 306, 'alt': 308, 'meta': 310,
                'a': 97, 'b': 98, 'c': 99, 'd': 100, 'e': 101,
                'f': 102, 'g': 103, 'h': 104, 'i': 105, 'j': 106,
                'k': 107, 'l': 108, 'm': 109, 'n': 110, 'o': 111,
                'p': 112, 'q': 113, 'r': 114, 's': 115, 't': 116,
                'u': 117, 'v': 118, 'w': 119, 'x': 120, 'y': 121, 'z': 122,
                '0': 48, '1': 49, '2': 50, '3': 51, '4': 52,
                '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
            };
            return map[name] ?? 0;
        },
        GetKeySymbol: (_keyCode: LuaValue) => {
            return ['', ''];
        },
        GetKeyBindings: () => ({}),
        GetActionHotKeys: () => luaTable(),

        // --- Clipboard ---
        GetClipboard: () => '',
        SetClipboard: () => {},

        // --- Mouse ---
        GetMouseState: () => [0, 0, false, false, false],
        WarpMouse: () => {},

        // --- Team AI ---
        GetTeamLuaAI: () => '',

        // --- Engine info for camain/cawidgets bootstrap ---
        Ping: () => {},
        GetActivePage: () => 0,
        ForceLayoutUpdate: () => {},
        GetLastUpdateSeconds: () => 0.016,
        MakeFont: () => {},
        Yield: null as LuaValue,  // nil = no yielding

        // --- Lua message passing ---
        SendLuaUIMsg: () => {},
        SendLuaRulesMsg: () => {},
        SendLuaGaiaMsg: () => {},
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
