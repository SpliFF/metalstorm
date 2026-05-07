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
    /**
     * Submit a unit order for delivery to the server. Receives the raw
     * Spring command id, the affected unit ids, the parameter list, and
     * the bitfield options (SHIFT/ALT/CTRL/META). The host wires this to
     * `Connection.sendPlayerCommand`. Optional — if absent, the
     * `Spring.GiveOrder*` calls become no-ops (used by tests).
     */
    giveOrder?(cmdId: number, unitIds: number[], params: number[], options: number): void;
    /**
     * Forward a `Spring.SendLuaRulesMsg(msg)` call to the server. The
     * host wires this to `Connection.sendLuaRulesMsg`. Optional — if
     * absent, the call becomes a no-op.
     */
    sendLuaRulesMsg?(data: string): void;
    /**
     * Replace the player's current unit selection. Called by
     * `Spring.SelectUnit` / `SelectUnitArray` / `SelectUnitMap` /
     * `DeselectUnit`. The host wires this to InputManager so the
     * highlight, minimap, and build menu all update. Optional — if
     * absent, those Lua calls update only the worker-local
     * `selectedUnitIds` and have no visible effect.
     */
    setSelection?(unitIds: number[]): void;
    /**
     * Move the player's camera to look at a world point. Called by
     * `Spring.SetCameraTarget` and the position-only path of
     * `Spring.SetCameraState`. `smoothness` is Spring's seconds-ish
     * pacing hint; 0 (or undefined) means teleport. Y is ignored — the
     * RTS camera maintains its own height. Optional.
     */
    setCameraTarget?(x: number, z: number, smoothness?: number): void;
    /**
     * Resolve a unit-def id to its internal name (e.g. 549 →
     * "staticmex"). Used by GetUnitCmdDescs to fill in cmd.name and
     * cmd.action so chili widgets can look up the def via
     * UnitDefNames[name] the same way they would against a real Spring
     * client. Optional — falls back to the numeric id as a string.
     */
    getUnitDefName?(defId: number): string | undefined;
}

/** Per-unit entry in the worker's unit store. */
export interface UnitEntry {
    x: number; y: number; z: number;
    heading: number;
    healthRatio: number;
    defId: number;
    team: number;
    /** World-space velocity in elmos/second. Updated by the entityState
     *  handler from frame-to-frame position deltas. Zero on first frame. */
    vx: number; vy: number; vz: number;
    /** Packed state bits from the server (FIELD_STATE_BITS).
     *    bits 0-1: fireState (0=hold, 1=return, 2=at-will)
     *    bits 2-3: moveState (0=hold, 1=maneuver, 2=roam)
     *    bit  4:   repeatOrders
     *    bit  5:   isCloaked
     *    bit  6:   isStunned
     *    bit  7:   reserved */
    stateBits: number;
    /** Spring losStatus low nibble for the local ally team:
     *    bit 0: LOS_INLOS  bit 1: LOS_INRADAR
     *    bit 2: LOS_PREVLOS  bit 3: LOS_CONTRADAR
     *  Own-allyteam units always read 0x0F. */
    losState: number;
}

/** Per-team resource entry. All `*Pull/Expense/Share/Sent/Received/Excess`
 *  fields are per-second rates derived from the previous-second
 *  accumulators on the server. They default to 0 when the server hasn't
 *  populated them yet (older servers / first tick). */
export interface ResourceEntry {
    metal: number; maxMetal: number;
    energy: number; maxEnergy: number;
    metalIncome: number; energyIncome: number;
    metalPull: number; energyPull: number;
    metalExpense: number; energyExpense: number;
    metalShare: number; energyShare: number;
    metalSent: number; energySent: number;
    metalReceived: number; energyReceived: number;
    metalExcess: number; energyExcess: number;
}

/** Spring rules-param values are numbers or strings. */
export type RulesParamValue = number | string;

/** Player roster entry. Matches the tuple Spring.GetPlayerInfo returns. */
export interface PlayerInfo {
    name: string;
    active: boolean;
    spectator: boolean;
    team: number;
    allyTeam: number;
    pingMs: number;
    cpuUsage: number;
    country: string;
    rank: number;
    hasController: boolean;
    customKeys: Record<string, string>;
}

/** Team roster entry. Matches Spring.GetTeamInfo. */
export interface TeamInfo {
    teamId: number;
    leader: number;          // playerID of team leader, or -1 for AI/none
    isDead: boolean;
    isAiTeam: boolean;
    side: string;
    allyTeam: number;
    customKeys: Record<string, string>;
}

/** RGBA in 0..1. */
export type TeamColor = [number, number, number, number];

/** Live game state pushed from the main thread to the worker. */
export interface LiveState {
    camera: { px: number; py: number; pz: number; tx: number; ty: number; tz: number; fov: number; near: number; far: number };
    /** View and projection matrices (column-major Float32Array[16]) for WorldToScreenCoords */
    viewMatrix: Float32Array | null;
    projMatrix: Float32Array | null;
    viewport: { width: number; height: number };
    identity: { myTeam: number; myAllyTeam: number; myPlayerId: number };
    gameFrame: number;
    gameSpeed: number;
    gamePaused: boolean;
    gameOver: boolean;
    units: Map<number, UnitEntry>;
    resources: Map<number, ResourceEntry>;
    selectedUnitIds: number[];
    /** Modifier key state */
    modKeys: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
    /** Build facing direction (0-3, NESW) */
    buildFacing: number;
    /** Features on the map (static, set once from MapData) */
    features: Map<number, FeatureEntry>;
    /** Game-scoped rules params (Spring.GetGameRulesParam). */
    gameRulesParams: Map<string, RulesParamValue>;
    /** Per-team rules params (Spring.GetTeamRulesParam). */
    teamRulesParams: Map<number, Map<string, RulesParamValue>>;
    /** Per-unit rules params (Spring.GetUnitRulesParam). */
    unitRulesParams: Map<number, Map<string, RulesParamValue>>;
    /** Per-player rules params (Spring.GetPlayerRulesParam). */
    playerRulesParams: Map<number, Map<string, RulesParamValue>>;
    /** Mouse pointer state (canvas pixels, Y-up). outsideSpring is true
     *  when the cursor is over a non-game UI element / off the canvas. */
    mouse: { x: number; y: number; lmb: boolean; mmb: boolean; rmb: boolean; outsideSpring: boolean };
    /** Currently armed command (e.g. cursor in build placement mode).
     *  index is 1-based per Spring (-1 = none); cmdId is the int CMD_*
     *  constant; cmdName is the human-readable name. */
    activeCommand: { index: number; cmdId: number; cmdName: string };
    /** Roster: keyed by playerId. Includes spectators. */
    players: Map<number, PlayerInfo>;
    /** Roster: keyed by teamId. Gaia (id=1 by default) is included. */
    teams: Map<number, TeamInfo>;
    /** Per-team colour. Falls back to a deterministic palette when missing. */
    teamColors: Map<number, TeamColor>;
    /** Mod options dict, free-form key-value. */
    modOptions: Record<string, RulesParamValue>;
    /** Selection groups: Spring numbers them 0..9. Each entry is the
     *  set of unit IDs assigned to that group. Purely client-side state
     *  managed by widgets and the local user. */
    groups: Map<number, Set<number>>;
    /** Map markers (point + line). Local-only for now; broadcasting
     *  needs a server message we don't have yet. */
    markers: Array<{ kind: 'point' | 'line'; x: number; y: number; z: number;
        x2?: number; y2?: number; z2?: number; label: string; teamId: number }>;
    /** Current wind vector (elmos/sec) + magnitude + tidal multiplier.
     *  Refreshed every GameInfo broadcast (~1 Hz). */
    wind: { x: number; y: number; z: number; strength: number; tidal: number };
    /** Per-unit order queue, keyed by unit id. Server broadcasts a full
     *  snapshot at ~1 Hz; absence of a unit means an empty queue. */
    unitCommands: Map<number, UnitOrder[]>;
    /** Per-unit available command descriptors, keyed by unit id.
     *  Server streams the build (cmdId<0) entries at ~1 Hz; standing-
     *  order toggles are derived client-side from the CMD_* enum and
     *  added by Spring.GetUnitCmdDescs at read time. Absence of a
     *  unit means empty / unknown. */
    unitCmdDescs: Map<number, UnitCmdDescStored[]>;
}

/** One entry from a unit's command panel as streamed by the server. */
export interface UnitCmdDescStored {
    /** Spring command id. Negative = build command (-cmdId is the unit-def id). */
    cmdId: number;
    /** Greyed-out flag (insufficient resources, tech, etc.). */
    disabled: boolean;
}

/** One queued order — mirrors Spring's Command struct. */
export interface UnitOrder {
    cmdId: number;
    params: number[];
    options: number;
    tag: number;
    timeout: number;
}

/** Per-feature entry. */
export interface FeatureEntry {
    x: number; y: number; z: number;
    defId: number;
    team: number;
    healthRatio: number;
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

/** Spring command-option bit flags. Widgets pass options either as a
 *  number (raw bitfield) or as a table — sometimes a sequence of
 *  strings (`{"shift", "alt"}`) and sometimes a map (`{shift=true}`).
 *  We accept all three. */
const ORDER_OPT_META  = 4;
const ORDER_OPT_RIGHT = 16;
const ORDER_OPT_SHIFT = 32;
const ORDER_OPT_CTRL  = 64;
const ORDER_OPT_ALT   = 128;

function orderOptionsToBits(opts: LuaValue): number {
    if (opts == null) return 0;
    if (typeof opts === 'number') return opts | 0;
    if (typeof opts !== 'object') return 0;
    const apply = (key: string): number => {
        switch (key.toLowerCase()) {
            case 'shift': return ORDER_OPT_SHIFT;
            case 'alt':   return ORDER_OPT_ALT;
            case 'ctrl':  return ORDER_OPT_CTRL;
            case 'meta':  return ORDER_OPT_META;
            case 'right': return ORDER_OPT_RIGHT;
            default:      return 0;
        }
    };
    let bits = 0;
    if (Array.isArray(opts)) {
        for (const v of opts) {
            if (typeof v === 'string') bits |= apply(v);
        }
    } else {
        for (const [k, v] of Object.entries(opts as Record<string, LuaValue>)) {
            if (v) bits |= apply(k);
        }
    }
    return bits;
}

/** Coerce the params arg to a flat number[]. Spring widgets pass a
 *  sequence (`{x, y, z}`) — we tolerate single numbers and missing
 *  values too. */
function orderParamsToArray(params: LuaValue): number[] {
    if (params == null) return [];
    if (typeof params === 'number') return [params];
    if (Array.isArray(params)) {
        const out: number[] = [];
        for (const v of params) {
            const n = Number(v);
            if (Number.isFinite(n)) out.push(n);
        }
        return out;
    }
    return [];
}

/** Coerce a Lua array of unit ids to number[]. */
function orderUnitIdsToArray(ids: LuaValue): number[] {
    if (ids == null) return [];
    if (typeof ids === 'number') return [ids | 0];
    if (Array.isArray(ids)) {
        const out: number[] = [];
        for (const v of ids) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) out.push(n | 0);
        }
        return out;
    }
    return [];
}

/** Extract numeric unit ids from the keys of a Spring unit map (the
 *  `{[unitID] = anything}` shape used by Spring.SelectUnitMap and
 *  similar). Drops keys that aren't positive integers. */
function mapKeysToUnitIds(unitMap: LuaValue): number[] {
    if (unitMap == null || typeof unitMap !== 'object') return [];
    const out: number[] = [];
    // Lua sequences round-trip to JS arrays; treat their indexes as
    // unit ids the same as orderUnitIdsToArray would.
    if (Array.isArray(unitMap)) {
        for (let i = 0; i < unitMap.length; i++) {
            // Only include slots whose value is truthy — Spring's
            // unitMap convention is `{[unitID] = true}`. A nil value
            // means "not selected".
            if (unitMap[i]) {
                const id = i + 1; // sequence is 1-based in Lua
                if (id > 0) out.push(id | 0);
            }
        }
        return out;
    }
    for (const k of Object.keys(unitMap)) {
        const v = (unitMap as Record<string, LuaValue>)[k];
        if (!v) continue;
        const n = Number(k);
        if (Number.isFinite(n) && n > 0) out.push(n | 0);
    }
    return out;
}

/** Compute the new selection list for a Spring.Select* call and push it
 *  to both the local LiveState mirror and the host (InputManager).
 *  When `append` is true, ids are merged into the existing selection;
 *  otherwise they replace it. Duplicates are stripped while preserving
 *  insertion order (Spring's selection is order-stable). */
function applySelection(ls: LiveState, ctx: SpringAPIContext, ids: number[], append: boolean): void {
    const seen = new Set<number>();
    const next: number[] = [];
    if (append) {
        for (const id of ls.selectedUnitIds) {
            if (id > 0 && !seen.has(id)) { seen.add(id); next.push(id); }
        }
    }
    for (const id of ids) {
        if (id > 0 && !seen.has(id)) { seen.add(id); next.push(id); }
    }
    ls.selectedUnitIds = next;
    ctx.setSelection?.(next.slice());
}

/** Convert a worker-side order queue into the array Spring widgets
 *  expect: each entry is a keyed table with id/params/options/tag/timeout.
 *  `count` optionally caps the number of orders returned (default: all). */
function ordersToLuaArray(orders: UnitOrder[] | undefined, count?: LuaValue): LuaValue {
    if (!orders) return luaTable();
    const cap = count != null ? Number(count) : orders.length;
    const limit = Math.max(0, Math.min(orders.length, cap));
    const result: Array<Record<string, LuaValue>> = [];
    for (let i = 0; i < limit; i++) {
        const o = orders[i];
        result.push({
            id: o.cmdId,
            params: [...o.params],
            options: o.options,
            tag: o.tag,
            timeout: o.timeout,
        });
    }
    return result;
}

/** Deterministic fallback palette when no per-team colour is known.
 *  Cycles through eight distinct hues so widgets don't render every
 *  team blue when roster data hasn't arrived yet. */
function defaultTeamColor(teamId: number): TeamColor {
    const palette: TeamColor[] = [
        [0.20, 0.40, 1.00, 1], // blue
        [1.00, 0.30, 0.30, 1], // red
        [0.30, 0.85, 0.30, 1], // green
        [1.00, 0.85, 0.20, 1], // yellow
        [0.85, 0.40, 0.95, 1], // purple
        [0.20, 0.85, 0.85, 1], // cyan
        [1.00, 0.55, 0.20, 1], // orange
        [0.55, 0.55, 0.55, 1], // grey (gaia by convention)
    ];
    return palette[((teamId % palette.length) + palette.length) % palette.length];
}

/**
 * Convert a rules-params Map into a Lua table. Spring's plural getters
 * (GetGameRulesParams, GetUnitRulesParams, …) return a single table
 * keyed by param name. An undefined input (e.g. unit/team has no entry)
 * still returns an empty table — widgets iterate the result with pairs()
 * and would throw if it were nil.
 */
function rulesParamsToTable(params: Map<string, RulesParamValue> | undefined): Record<string, RulesParamValue> {
    const out: Record<string, RulesParamValue> = {};
    if (params) {
        for (const [k, v] of params) out[k] = v;
    }
    return out;
}

/** Create a default LiveState with zeroed values. */
export function createDefaultLiveState(): LiveState {
    return {
        camera: { px: 0, py: 500, pz: 0, tx: 0, ty: 0, tz: 0, fov: 0.8, near: 1, far: 50000 },
        viewMatrix: null,
        projMatrix: null,
        viewport: { width: 1920, height: 1080 },
        identity: { myTeam: 0, myAllyTeam: 0, myPlayerId: 0 },
        gameFrame: 0,
        gameSpeed: 1,
        gamePaused: false,
        gameOver: false,
        units: new Map(),
        resources: new Map(),
        selectedUnitIds: [],
        modKeys: { alt: false, ctrl: false, meta: false, shift: false },
        buildFacing: 0,
        features: new Map(),
        gameRulesParams: new Map(),
        teamRulesParams: new Map(),
        unitRulesParams: new Map(),
        playerRulesParams: new Map(),
        mouse: { x: 0, y: 0, lmb: false, mmb: false, rmb: false, outsideSpring: true },
        activeCommand: { index: -1, cmdId: 0, cmdName: '' },
        players: new Map(),
        teams: new Map(),
        teamColors: new Map(),
        modOptions: {},
        groups: new Map(),
        markers: [],
        wind: { x: 0, y: 0, z: 0, strength: 0, tidal: 0 },
        unitCommands: new Map(),
        unitCmdDescs: new Map(),
    };
}

/** Build the global-table set a Lua widget needs. */
export function buildSpringGlobals(ctx: SpringAPIContext, liveState?: LiveState): Record<string, LuaValue> {
    const ls = liveState ?? createDefaultLiveState();
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
        // Armor types — indexed array; widgets use this to build damage tables
        armorTypes: { 0: 'default' },
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
        GetGameSeconds: () => ls.gameFrame / 30,
        GetGameFrame: () => ls.gameFrame,
        GetWind: () => {
            // Spring returns 7 values: wx, wy, wz, wStrength, dx, dy, dz
            // where (wx,wy,wz) is the wind vector and (dx,dy,dz) is its
            // unit-length direction.
            const w = ls.wind;
            const inv = w.strength > 1e-6 ? 1 / w.strength : 0;
            return [w.x, w.y, w.z, w.strength, w.x * inv, w.y * inv, w.z * inv];
        },
        GetTidal: () => ls.wind.tidal,
        GetGroundHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), Number(z));
        },
        GetGroundOrigHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), Number(z));
        },
        GetGameRulesParam: (key: LuaValue) => {
            const k = String(key);
            const v = ls.gameRulesParams.get(k);
            if (v !== undefined) return v;
            return ctx.gameRulesParams?.get(k) ?? null;
        },
        GetGameRulesParams: () => rulesParamsToTable(ls.gameRulesParams),
        Echo: (...args: LuaValue[]) => {
            console.log('[Spring.Echo]', ...args.map(a => String(a)));
        },
        SendCommands: (_cmd: LuaValue) => {
            // Console commands — ignored in browser client.
        },
        GetConfigInt: (_key: LuaValue, def: LuaValue) => Number(def ?? 0),
        GetConfigFloat: (_key: LuaValue, def: LuaValue) => Number(def ?? 0),
        GetConfigString: (_key: LuaValue, def: LuaValue) => String(def ?? ''),
        GetModOptions: () => ({ ...ls.modOptions }),
        GetViewGeometry: () => {
            return [ls.viewport.width, ls.viewport.height, 0, 0];
        },
        GetViewSizes: () => {
            return [ls.viewport.width, ls.viewport.height];
        },
        GetWindowGeometry: () => {
            return [ls.viewport.width, ls.viewport.height, 0, 0];
        },
        GetSpectatingState: () => {
            // Spring returns: spec, fullView, fullSelect.
            // We don't model fullView/fullSelect so always emit false for those.
            const me = ls.players.get(ls.identity.myPlayerId);
            return [me?.spectator ?? false, false, false];
        },
        IsReplay: () => false,
        GetLocalPlayerID: () => ls.identity.myPlayerId,
        GetMyPlayerID: () => ls.identity.myPlayerId,
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

        // --- Player/Team API ---
        // NOTE: Functions returning Lua tables use luaTable() wrapper.
        // Plain JS arrays become multiple return values; luaTable() → single table.
        GetPlayerList: (teamId?: LuaValue, activeOnly?: LuaValue) => {
            const ids: number[] = [];
            const filterTeam = teamId == null ? null : Number(teamId);
            const onlyActive = Boolean(activeOnly);
            for (const [id, p] of ls.players) {
                if (filterTeam !== null && p.team !== filterTeam) continue;
                if (onlyActive && !p.active) continue;
                ids.push(id);
            }
            return luaTable(...ids);
        },
        GetPlayerInfo: (_playerId: LuaValue, _withKeys: LuaValue) => {
            const id = Number(_playerId ?? -1);
            const p = ls.players.get(id);
            if (!p) {
                return [null];
            }
            return [
                p.name, p.active, p.spectator, p.team, p.allyTeam,
                p.pingMs, p.cpuUsage, p.country, p.rank, p.hasController,
                p.customKeys,
            ];
        },
        GetAllyTeamList: () => {
            const set = new Set<number>();
            for (const t of ls.teams.values()) set.add(t.allyTeam);
            return luaTable(...[...set].sort((a, b) => a - b));
        },
        GetTeamList: (_allyTeamId?: LuaValue) => {
            const filter = _allyTeamId == null ? null : Number(_allyTeamId);
            const ids: number[] = [];
            for (const [id, t] of ls.teams) {
                if (filter !== null && t.allyTeam !== filter) continue;
                ids.push(id);
            }
            ids.sort((a, b) => a - b);
            return luaTable(...ids);
        },
        GetTeamInfo: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? 0);
            const t = ls.teams.get(tid);
            if (!t) return [null];
            return [t.teamId, t.leader, t.isDead, t.isAiTeam, t.side, t.allyTeam, t.customKeys];
        },
        GetPlayerRulesParam: (playerId: LuaValue, key: LuaValue) => {
            const params = ls.playerRulesParams.get(Number(playerId));
            return params?.get(String(key)) ?? null;
        },
        GetPlayerRulesParams: (playerId: LuaValue) => {
            return rulesParamsToTable(ls.playerRulesParams.get(Number(playerId)));
        },
        GetTeamColor: (_teamId: LuaValue) => {
            const id = Number(_teamId ?? 0);
            return ls.teamColors.get(id) ?? defaultTeamColor(id);
        },
        GetMyTeamID: () => ls.identity.myTeam,
        GetMyAllyTeamID: () => ls.identity.myAllyTeam,
        GetTeamUnitCount: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            let count = 0;
            for (const u of ls.units.values()) {
                if (u.team === tid) count++;
            }
            return count;
        },

        // --- Map draw mode ---
        GetMapDrawMode: () => 'normal',

        // --- Shock front (camera shake) ---
        SetShockFrontFactors: () => {},

        // --- Selection ---
        GetSelectedUnits: () => luaTable(...ls.selectedUnitIds),
        GetSelectedUnitsCount: () => ls.selectedUnitIds.length,
        GetSelectedUnitsSorted: () => {
            const sorted: Record<number, number[]> = {};
            for (const id of ls.selectedUnitIds) {
                const u = ls.units.get(id);
                const defId = u?.defId ?? 0;
                if (!sorted[defId]) sorted[defId] = [];
                sorted[defId].push(id);
            }
            return sorted;
        },
        GetSelectedUnitsCounts: () => {
            const counts: Record<number, number> = {};
            for (const id of ls.selectedUnitIds) {
                const u = ls.units.get(id);
                const defId = u?.defId ?? 0;
                counts[defId] = (counts[defId] ?? 0) + 1;
            }
            return counts;
        },

        // --- Unit queries ---
        GetUnitDefID: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? u.defId : null;
        },
        GetUnitTeam: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? u.team : null;
        },
        GetUnitPosition: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? [u.x, u.y, u.z] : null;
        },
        GetUnitHealth: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            // healthRatio is 0-1; derive hp assuming max=1000 (best guess without def data)
            const maxHp = 1000;
            const hp = u.healthRatio * maxHp;
            return [hp, maxHp, 0, u.healthRatio, 0];
        },
        GetUnitStates: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const bits = u.stateBits;
            const fireState = bits & 0x03;
            const moveState = (bits >> 2) & 0x03;
            const repeat    = (bits & (1 << 4)) !== 0;
            const cloak     = (bits & (1 << 5)) !== 0;
            // Spring's GetUnitStates returns a keyed table. We provide
            // the subset the wire format carries; engine-only fields
            // (autoLand, trajectory, autoRepairLevel) default to safe
            // values rather than nil so widget reads don't crash.
            return {
                firestate:        fireState,
                movestate:        moveState,
                repeat:           repeat,
                cloak:            cloak,
                active:           true,
                trajectory:       false,
                autoLand:         false,
                autoRepairLevel:  0,
                loopbackAttack:   false,
            };
        },
        GetUnitRulesParam: (id: LuaValue, key: LuaValue) => {
            const params = ls.unitRulesParams.get(Number(id));
            return params?.get(String(key)) ?? null;
        },
        GetUnitRulesParams: (id: LuaValue) => {
            return rulesParamsToTable(ls.unitRulesParams.get(Number(id)));
        },
        GetUnitIsStunned: (id: LuaValue) => {
            // Spring returns 3 booleans: stunnedOrInBuild, stunned, beingBuilt.
            // We only model "stunned" via the wire bits — beingBuilt derives
            // from health < 1. Combined first return is stunned || beingBuilt.
            const u = ls.units.get(Number(id));
            if (!u) return [false, false, false];
            const stunned    = (u.stateBits & (1 << 6)) !== 0;
            const beingBuilt = u.healthRatio < 1;
            return [stunned || beingBuilt, stunned, beingBuilt];
        },
        GetUnitIsCloaked: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            return (u.stateBits & (1 << 5)) !== 0;
        },
        ValidUnitID: (id: LuaValue) => ls.units.has(Number(id)),
        GetUnitIsDead: (id: LuaValue) => !ls.units.has(Number(id)),

        GetUnitAllyTeam: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const t = ls.teams.get(u.team);
            return t ? t.allyTeam : u.team;
        },
        IsUnitAllied: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return false;
            const t = ls.teams.get(u.team);
            const ally = t ? t.allyTeam : u.team;
            return ally === ls.identity.myAllyTeam;
        },
        IsUnitSelected: (id: LuaValue) => {
            return ls.selectedUnitIds.includes(Number(id));
        },
        // ── LOS / radar visibility ─────────────────────────────────
        // The server stamps every entity with its losStatus byte for
        // the receiving session's ally team. Own-allyteam units are
        // always 0x0F (fully visible). Spring widgets read these via
        // GetUnitLosState / IsUnitInLos / IsUnitInRadar / IsUnitInJammer.
        GetUnitLosState: (id: LuaValue, _allyTeam?: LuaValue, raw?: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const bits = u.losState & 0x0F;
            // Spring's optional 3rd arg returns the raw bitfield.
            // Otherwise: a keyed table of booleans { los=, radar=, typed= }.
            if (raw) return bits;
            return {
                los:    (bits & 0x01) !== 0,
                radar:  (bits & 0x02) !== 0,
                typed:  (bits & 0x04) !== 0,  // PREVLOS — "ghost" / type known
            };
        },
        IsUnitInLos: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return false;
            return (u.losState & 0x01) !== 0;
        },
        IsUnitInAirLos: (id: LuaValue) => {
            // We don't track air-LOS separately yet; widgets fall back
            // on regular LOS (same behaviour as games without air-only
            // sensors). Air-only contacts can be wired in once the
            // server-side losStatus exposes the air bit.
            const u = ls.units.get(Number(id));
            if (!u) return false;
            return (u.losState & 0x01) !== 0;
        },
        IsUnitInRadar: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return false;
            return (u.losState & 0x02) !== 0;
        },
        IsUnitInJammer: () => {
            // Jamming state isn't streamed yet — placeholder so widgets
            // that call this don't crash.
            return false;
        },

        IsUnitInView: (id: LuaValue) => {
            // All units in the store are server-sent and thus in view
            return ls.units.has(Number(id));
        },
        GetUnitVelocity: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const speed = Math.sqrt(u.vx * u.vx + u.vy * u.vy + u.vz * u.vz);
            return [u.vx, u.vy, u.vz, speed];
        },
        GetUnitShieldState: () => null,

        // Experience isn't streamed yet — return zeros so widgets like
        // unit_rank_icons render the lowest rank instead of crashing on a
        // nil-method call.
        GetUnitExperience: (id: LuaValue) => {
            if (!ls.units.has(Number(id))) return null;
            return [0, 0];
        },

        GetUnitHeading: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            // heading is u16 (0-65535) → Spring heading (-32768 to 32767)
            return u.heading > 32767 ? u.heading - 65536 : u.heading;
        },

        // --- Team resources ---
        // Spring returns: current, storage, pull, income, expense, share,
        // sent, received. The Spring engine also pads with `excess` and
        // `received` in some forks, but the canonical 8-tuple is widely
        // assumed by Spring widgets — keep it.
        GetTeamResources: (teamId: LuaValue, resType: LuaValue) => {
            const tid = Number(teamId ?? ls.identity.myTeam);
            const r = ls.resources.get(tid);
            if (!r) return [0, 0, 0, 0, 0, 0, 0, 0];
            const t = String(resType ?? 'metal');
            if (t === 'metal') {
                return [r.metal, r.maxMetal, r.metalPull, r.metalIncome,
                        r.metalExpense, r.metalShare, r.metalSent, r.metalReceived];
            } else {
                return [r.energy, r.maxEnergy, r.energyPull, r.energyIncome,
                        r.energyExpense, r.energyShare, r.energySent, r.energyReceived];
            }
        },
        GetTeamAllyTeamID: (teamId: LuaValue) => {
            const t = ls.teams.get(Number(teamId));
            return t ? t.allyTeam : Number(teamId ?? 0);
        },
        AreTeamsAllied: (t1: LuaValue, t2: LuaValue) => {
            const a = ls.teams.get(Number(t1));
            const b = ls.teams.get(Number(t2));
            if (a && b) return a.allyTeam === b.allyTeam;
            return Number(t1) === Number(t2);
        },

        // --- Feature queries ---
        GetAllFeatures: () => luaTable(...ls.features.keys()),
        GetFeaturesInRectangle: (x1: LuaValue, z1: LuaValue, x2: LuaValue, z2: LuaValue) => {
            const rx1 = Number(x1), rz1 = Number(z1), rx2 = Number(x2), rz2 = Number(z2);
            const ids: number[] = [];
            for (const [id, f] of ls.features) {
                if (f.x >= rx1 && f.x <= rx2 && f.z >= rz1 && f.z <= rz2) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetFeatureDefID: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            return f ? f.defId : null;
        },
        GetFeaturePosition: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            return f ? [f.x, f.y, f.z] : null;
        },
        GetFeatureHealth: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            if (!f) return null;
            const maxHp = 1000;
            return [f.healthRatio * maxHp, maxHp, 0];
        },
        GetFeatureTeam: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            return f ? f.team : null;
        },
        GetFeatureResources: (id: LuaValue) => {
            return ls.features.has(Number(id)) ? [0, 0] : null; // metal, energy reclaim value
        },
        ValidFeatureID: (id: LuaValue) => ls.features.has(Number(id)),

        // --- Misc ---
        GetTimer: () => performance.now() / 1000,
        DiffTimers: (t1: LuaValue, t2: LuaValue) => Number(t1 ?? 0) - Number(t2 ?? 0),
        GetDrawFrame: () => ls.gameFrame,
        GetFPS: () => 60,
        WorldToScreenCoords: (_x: LuaValue, _y: LuaValue, _z: LuaValue) => {
            const wx = Number(_x), wy = Number(_y), wz = Number(_z);
            if (ls.viewMatrix && ls.projMatrix) {
                const sx = projectToScreen(wx, wy, wz, ls.viewMatrix, ls.projMatrix, ls.viewport.width, ls.viewport.height);
                if (sx) return sx;
            }
            return [ls.viewport.width / 2, ls.viewport.height / 2, 0];
        },
        ScreenToWorldCoords: (_x: LuaValue, _y: LuaValue) => {
            if (!ls.viewMatrix || !ls.projMatrix) return [0, 0, 0];
            const hit = screenPointToGround(
                Number(_x), Number(_y),
                ls.viewMatrix, ls.projMatrix,
                ls.viewport.width, ls.viewport.height,
                ctx,
            );
            return hit ?? [0, 0, 0];
        },
        TraceScreenRay: (_x: LuaValue, _y: LuaValue, _onlyCoords: LuaValue) => {
            if (!ls.viewMatrix || !ls.projMatrix) return null;
            const hit = screenPointToGround(
                Number(_x), Number(_y),
                ls.viewMatrix, ls.projMatrix,
                ls.viewport.width, ls.viewport.height,
                ctx,
            );
            if (!hit) return null;
            // Spring's contract returns (description, params). With
            // onlyCoords=true, params is the {x,y,z} position table.
            // ZK widgets pattern is `local _, pos = TraceScreenRay(...)`
            // — pos must be the table (2nd return), not a coord scalar.
            return ['ground', luaTable(hit[0], hit[1], hit[2])];
        },
        GetCameraPosition: () => [ls.camera.px, ls.camera.py, ls.camera.pz],
        GetCameraDirection: () => {
            // Derive direction from position → target
            const dx = ls.camera.tx - ls.camera.px;
            const dy = ls.camera.ty - ls.camera.py;
            const dz = ls.camera.tz - ls.camera.pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            return [dx / len, dy / len, dz / len];
        },
        GetCameraState: () => {
            const dx = ls.camera.tx - ls.camera.px;
            const dy = ls.camera.ty - ls.camera.py;
            const dz = ls.camera.tz - ls.camera.pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            return {
                px: ls.camera.px, py: ls.camera.py, pz: ls.camera.pz,
                rx: Math.asin(-dy / len),
                ry: Math.atan2(dx, dz),
                rz: 0,
                // ZK's COFC camera tools (TraceCursorToGround,
                // api_preselection) read cs.fov directly. Provide a
                // sensible default in degrees.
                fov: ls.camera.fov ? ls.camera.fov * (180 / Math.PI) : 45,
                name: 'free',
                mode: 0,
            };
        },
        // Spring.SetCameraState(state, smoothness) — partial implementation:
        // we only handle the "move to (px,_,pz)" case, which is what ZK's
        // SetCameraTargetBox / WG.COFC_SetCameraTarget fall back to. Other
        // fields (rx, ry, height, mode, name) are no-ops; the RTS camera
        // owns its own height and rotation.
        SetCameraState: (state: LuaValue, smoothness: LuaValue) => {
            if (state == null || typeof state !== 'object' || Array.isArray(state)) return;
            const s = state as Record<string, LuaValue>;
            const px = Number(s.px);
            const pz = Number(s.pz);
            if (!Number.isFinite(px) || !Number.isFinite(pz)) return;
            ctx.setCameraTarget?.(px, pz, Number(smoothness) || 0);
        },
        // Spring.SetCameraTarget(x, y, z, smoothness) — focus the RTS
        // camera on the (x,z) ground point. Y is ignored (the camera
        // keeps its current height). smoothness <= 0 teleports; otherwise
        // it's interpreted as a duration-seconds hint. ZK's core selector
        // calls this with no smoothness for instant snap-to-commander.
        SetCameraTarget: (x: LuaValue, _y: LuaValue, z: LuaValue, smoothness: LuaValue) => {
            const cx = Number(x);
            const cz = Number(z);
            if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
            ctx.setCameraTarget?.(cx, cz, Number(smoothness) || 0);
        },
        GetCameraFOV: () => ls.camera.fov * (180 / Math.PI),
        GetCameraVectors: () => {
            const dx = ls.camera.tx - ls.camera.px;
            const dy = ls.camera.ty - ls.camera.py;
            const dz = ls.camera.tz - ls.camera.pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const fx = dx / len, fy = dy / len, fz = dz / len;
            // Right = forward × up (world up = 0,1,0)
            const rx = fz, rz = -fx; // cross(forward, up) simplified
            const rlen = Math.sqrt(rx * rx + rz * rz) || 1;
            const rnx = rx / rlen, rnz = rz / rlen;
            // Up = right × forward
            const ux = rnz * fy - 0 * fz;
            const uy = 0 * fx - rnx * fz; // simplified cross product with ry=0
            const uz = rnx * fy - rnz * fx;
            return {
                forward: luaTable(fx, fy, fz),
                up: luaTable(ux, uy, uz),
                right: luaTable(rnx, 0, rnz),
            };
        },
        GetGroundInfo: (x: LuaValue, z: LuaValue) => {
            // Real Spring returns: ix, iz, type, hardness, tankSpeed, kbotSpeed,
            // hovSpeed, shipSpeed, ground-name, depth. Without per-tile ground
            // metadata we fill the spatial coords + plausible defaults.
            const wx = Number(x), wz = Number(z);
            const sq = ctx.squareSize || 8;
            const ix = Math.floor(wx / sq);
            const iz = Math.floor(wz / sq);
            const elev = sampleHeight(ctx, wx, wz);
            return [ix, iz, 0, 1.0, 1.0, 1.0, 1.0, 1.0, 'default', Math.max(0, -elev)];
        },
        GetGroundNormal: (x: LuaValue, z: LuaValue) => {
            return computeGroundNormal(ctx, Number(x), Number(z));
        },
        GetSmoothMeshHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), Number(z));
        },
        IsPosInLos: () => true,
        IsPosInRadar: () => false,
        GetUnitsInRectangle: (x1: LuaValue, z1: LuaValue, x2: LuaValue, z2: LuaValue) => {
            const rx1 = Number(x1), rz1 = Number(z1), rx2 = Number(x2), rz2 = Number(z2);
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                if (u.x >= rx1 && u.x <= rx2 && u.z >= rz1 && u.z <= rz2) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetUnitsInCylinder: (x: LuaValue, z: LuaValue, r: LuaValue) => {
            const cx = Number(x), cz = Number(z), rad = Number(r);
            const r2 = rad * rad;
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                const dx = u.x - cx, dz = u.z - cz;
                if (dx * dx + dz * dz <= r2) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetUnitsInSphere: (x: LuaValue, y: LuaValue, z: LuaValue, r: LuaValue) => {
            const cx = Number(x), cy = Number(y), cz = Number(z), rad = Number(r);
            const r2 = rad * rad;
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                const dx = u.x - cx, dy = u.y - cy, dz = u.z - cz;
                if (dx * dx + dy * dy + dz * dz <= r2) ids.push(id);
            }
            return luaTable(...ids);
        },
        IsSphereInView: () => true, // conservative — server already LOS-filters
        GetVisibleUnits: () => luaTable(...ls.units.keys()),
        GetAllUnits: () => luaTable(...ls.units.keys()),
        GetTeamUnits: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                if (u.team === tid) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetTeamUnitsSorted: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const sorted: Record<number, number[]> = {};
            for (const [id, u] of ls.units) {
                if (u.team !== tid) continue;
                if (!sorted[u.defId]) sorted[u.defId] = [];
                sorted[u.defId].push(id);
            }
            return sorted;
        },
        GetTeamUnitDefCount: (_teamId: LuaValue, _defId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const did = Number(_defId ?? 0);
            let count = 0;
            for (const u of ls.units.values()) {
                if (u.team === tid && u.defId === did) count++;
            }
            return count;
        },

        // --- Local team ---
        GetLocalTeamID: () => ls.identity.myTeam,
        GetLocalAllyTeamID: () => ls.identity.myAllyTeam,

        // --- Game speed ---
        GetGameSpeed: () => [ls.gameSpeed, ls.gameSpeed, ls.gamePaused],
        IsGameOver: () => ls.gameOver,

        // --- GUI state ---
        IsGUIHidden: () => false,
        GetModKeyState: () => [ls.modKeys.alt, ls.modKeys.ctrl, ls.modKeys.meta, ls.modKeys.shift],
        GetKeyState: (_keyCode: LuaValue) => false, // would need per-key tracking
        ScaledGetMouseState: () => {
            const m = ls.mouse;
            return [m.x, m.y, m.lmb, m.mmb, m.rmb, m.outsideSpring];
        },
        GetMouseCursor: () => ['', 1.0], // name, scale
        SetMouseCursor: () => {},
        IsAboveMiniMap: () => false,
        GetMiniMapGeometry: () => [0, 0, 200, 200], // x, y, w, h
        GetBuildFacing: () => ls.buildFacing,
        SetBuildFacing: (_facing: LuaValue) => {
            ls.buildFacing = Number(_facing ?? 0) % 4;
        },
        GetInvertQueueKey: () => false,

        // --- Ground extremes ---
        GetGroundExtremes: () => [ctx.minHeight, ctx.maxHeight],

        // --- Custom command draw data ---
        SetCustomCommandDrawData: () => {},

        // --- Map markers ---
        // Local-only for now: appended to ls.markers but not broadcast.
        // Real Spring drops/erases markers within Spring.SQUARE_SIZE * 2.
        MarkerAddPoint: (x: LuaValue, y: LuaValue, z: LuaValue, label: LuaValue, _localOnly?: LuaValue) => {
            ls.markers.push({
                kind: 'point',
                x: Number(x), y: Number(y), z: Number(z),
                label: String(label ?? ''),
                teamId: ls.identity.myTeam,
            });
        },
        MarkerAddLine: (x1: LuaValue, y1: LuaValue, z1: LuaValue,
                        x2: LuaValue, y2: LuaValue, z2: LuaValue, _localOnly?: LuaValue) => {
            ls.markers.push({
                kind: 'line',
                x: Number(x1), y: Number(y1), z: Number(z1),
                x2: Number(x2), y2: Number(y2), z2: Number(z2),
                label: '',
                teamId: ls.identity.myTeam,
            });
        },
        MarkerErasePosition: (x: LuaValue, _y: LuaValue, z: LuaValue) => {
            const radius = (ctx.squareSize || 8) * 2;
            const cx = Number(x), cz = Number(z);
            ls.markers = ls.markers.filter(m => {
                const dx = m.x - cx, dz = m.z - cz;
                return Math.sqrt(dx * dx + dz * dz) > radius;
            });
        },
        SetActiveCommand: (a: LuaValue, _b?: LuaValue, _c?: LuaValue, _d?: LuaValue,
                          _e?: LuaValue, _f?: LuaValue, _g?: LuaValue, _h?: LuaValue) => {
            // Spring overloads: SetActiveCommand(idx) | SetActiveCommand(cmdName, btn, lc, rc, alt, ctrl, meta, shift)
            // We have no command-desc table, so just store whatever the caller gave us.
            if (typeof a === 'number') {
                ls.activeCommand = { index: a, cmdId: ls.activeCommand.cmdId, cmdName: ls.activeCommand.cmdName };
            } else if (typeof a === 'string') {
                ls.activeCommand = { index: -1, cmdId: 0, cmdName: a };
            } else {
                ls.activeCommand = { index: -1, cmdId: 0, cmdName: '' };
            }
            return true;
        },
        GiveOrderToUnit: (unitId: LuaValue, cmdId: LuaValue, params: LuaValue, options: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const id = Number(unitId) | 0;
            if (id <= 0) return false;
            ctx.giveOrder(Number(cmdId) | 0, [id], orderParamsToArray(params), orderOptionsToBits(options));
            return true;
        },
        GiveOrderToUnitArray: (unitIds: LuaValue, cmdId: LuaValue, params: LuaValue, options: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const ids = orderUnitIdsToArray(unitIds);
            if (ids.length === 0) return false;
            ctx.giveOrder(Number(cmdId) | 0, ids, orderParamsToArray(params), orderOptionsToBits(options));
            return true;
        },
        GiveOrder: (cmdId: LuaValue, params: LuaValue, options: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const ids = ls.selectedUnitIds.slice();
            if (ids.length === 0) return false;
            ctx.giveOrder(Number(cmdId) | 0, ids, orderParamsToArray(params), orderOptionsToBits(options));
            return true;
        },
        // Order queue readers — all backed by ls.unitCommands. Spring
        // returns an array of {id, params, options, tag} tables; we
        // include `timeout` too (zero-cost extra info).
        GetUnitCommands: (unitId: LuaValue, count: LuaValue) => {
            return ordersToLuaArray(ls.unitCommands.get(Number(unitId)), count);
        },
        // Factory commands are stored in the same queue as regular
        // orders for our wire format; the engine separates them
        // internally but widgets read them through the same shape.
        GetFactoryCommands: (unitId: LuaValue, count: LuaValue) => {
            return ordersToLuaArray(ls.unitCommands.get(Number(unitId)), count);
        },
        GetCommandQueue: (unitId: LuaValue, count: LuaValue) => {
            return ordersToLuaArray(ls.unitCommands.get(Number(unitId)), count);
        },
        GetFullBuildQueue: (unitId: LuaValue) => {
            // Spring returns: { [defId] = count, ... } summarising the
            // build orders queued on a factory.
            const orders = ls.unitCommands.get(Number(unitId));
            const out: Record<number, number> = {};
            if (orders) {
                for (const o of orders) {
                    if (o.cmdId < 0) {
                        const defId = -o.cmdId;
                        out[defId] = (out[defId] ?? 0) + 1;
                    }
                }
            }
            return out;
        },
        // Spring.SelectUnitArray(unitArray[, append]) — replace the player's
        // selection with `unitArray`, or merge into it when append=true.
        // An empty array clears the selection. Updates the worker-local
        // mirror immediately so widgets observing GetSelectedUnits within
        // the same call see the new state.
        SelectUnitArray: (unitArray: LuaValue, append: LuaValue) => {
            const ids = orderUnitIdsToArray(unitArray);
            applySelection(ls, ctx, ids, !!append);
        },
        // Spring.SelectUnitMap(unitMap[, append]) — selects every unit whose
        // id is a key in `unitMap`. ZK's gui_selection_hierarchy.lua calls
        // this on every Core-Selector button click. The map values are
        // ignored — keys carry the unit ids.
        SelectUnitMap: (unitMap: LuaValue, append: LuaValue) => {
            applySelection(ls, ctx, mapKeysToUnitIds(unitMap), !!append);
        },
        SetUnitGroup: (unitId: LuaValue, groupId: LuaValue) => {
            const uid = Number(unitId);
            const gid = Number(groupId);
            // Drop the unit from any group it was already in.
            for (const g of ls.groups.values()) g.delete(uid);
            // Group -1 / nil clears assignment.
            if (gid < 0 || !Number.isFinite(gid)) return true;
            let bucket = ls.groups.get(gid);
            if (!bucket) { bucket = new Set(); ls.groups.set(gid, bucket); }
            bucket.add(uid);
            return true;
        },
        GetGroupList: () => {
            // Spring returns a table of {[groupId] = unitCount}.
            const out: Record<number, number> = {};
            for (const [gid, units] of ls.groups) {
                if (units.size > 0) out[gid] = units.size;
            }
            return out;
        },
        GetGroupUnits: (groupId: LuaValue) => {
            const bucket = ls.groups.get(Number(groupId));
            return bucket ? luaTable(...bucket) : luaTable();
        },
        GetGroupUnitsSorted: (groupId: LuaValue) => {
            const bucket = ls.groups.get(Number(groupId));
            const out: Record<number, number[]> = {};
            if (bucket) {
                for (const uid of bucket) {
                    const u = ls.units.get(uid);
                    const did = u?.defId ?? 0;
                    (out[did] ??= []).push(uid);
                }
            }
            return out;
        },
        GetGroupUnitsCounts: (groupId: LuaValue) => {
            const bucket = ls.groups.get(Number(groupId));
            const out: Record<number, number> = {};
            if (bucket) {
                for (const uid of bucket) {
                    const u = ls.units.get(uid);
                    const did = u?.defId ?? 0;
                    out[did] = (out[did] ?? 0) + 1;
                }
            }
            return out;
        },

        // --- Extension queries ---
        HasExtension: () => true,

        // --- Active command ---
        GetActiveCommand: () => {
            const ac = ls.activeCommand;
            return [ac.index, ac.cmdId, ac.cmdName];
        },

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
        GetTeamRulesParam: (teamId: LuaValue, key: LuaValue) => {
            const params = ls.teamRulesParams.get(Number(teamId));
            return params?.get(String(key)) ?? null;
        },
        GetTeamRulesParams: (teamId: LuaValue) => {
            return rulesParamsToTable(ls.teamRulesParams.get(Number(teamId)));
        },

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

        // --- SDL text input (no-op in browser) ---
        SDLStartTextInput: () => {},
        SDLStopTextInput: () => {},
        SDLSetTextInputRect: () => {},

        // --- Mouse ---
        GetMouseState: () => {
            const m = ls.mouse;
            return [m.x, m.y, m.lmb, m.mmb, m.rmb];
        },
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

        // --- Game info ---
        IsCheatingEnabled: () => false,
        FixedAllies: () => true,
        GetMenuName: () => '',

        // --- Minimap ---
        GetMiniMapDualScreen: () => false,
        GetMiniMapRotation: () => 0,
        GetMouseMiniMapState: () => [false, false, false],

        // --- Team color ---
        SetTeamColor: () => {},
        GetTeamOrigColor: (_teamId: LuaValue) => {
            const id = Number(_teamId ?? 0);
            const colors = [
                [0, 0, 1, 1], [1, 0, 0, 1], [0, 1, 0, 1], [1, 1, 0, 1],
            ];
            return colors[id % colors.length];
        },
        ArePlayersAllied: (p1: LuaValue, p2: LuaValue) => {
            const a = ls.players.get(Number(p1));
            const b = ls.players.get(Number(p2));
            if (a && b) return a.allyTeam === b.allyTeam;
            return Number(p1) === Number(p2);
        },

        // --- Debug / profiler ---
        GetLuaMemUsage: () => [0, 0, 0, 0, 0, 0], // luaUI, luaRules, luaGaia mem usage
        LoadCmdColorsConfig: () => {},

        // --- Command descriptions ---
        GetActiveCmdDescs: () => luaTable(),
        // Return an empty table (NOT null) so widgets that index the
        // result without nil-checking — e.g. gui_easyFacing.lua reads
        // `cmdDesc["type"]` directly — get nil for missing fields
        // instead of erroring on nil-indexing.
        GetActiveCmdDesc: () => luaTable(),
        GetDefaultCommand: () => [0, 0, ''],
        GetCmdDescIndex: () => null,
        FindUnitCmdDesc: () => null,

        // --- Selection commands ---
        // Spring.SelectUnit(unitID[, append]) — replace the selection with
        // a single unit, or add it to the current selection. A nil/zero
        // unitID clears the selection.
        SelectUnit: (unitId: LuaValue, append: LuaValue) => {
            const id = Number(unitId) | 0;
            const ids = id > 0 ? [id] : [];
            applySelection(ls, ctx, ids, !!append);
        },
        // Spring.DeselectUnit(unitID) — remove a single unit from the
        // selection. No-op if it wasn't selected.
        DeselectUnit: (unitId: LuaValue) => {
            const id = Number(unitId) | 0;
            if (id <= 0 || !ls.selectedUnitIds.includes(id)) return;
            const next = ls.selectedUnitIds.filter(u => u !== id);
            ls.selectedUnitIds = next;
            ctx.setSelection?.(next.slice());
        },

        // --- Unit queries that some widgets need ---
        GetUnitIsBuilding: () => null,
        GetUnitIsBeingBuilt: (_id: LuaValue) => {
            const u = ls.units.get(Number(_id));
            return u ? u.healthRatio < 1 : null;
        },
        // Spring.GetUnitCmdDescs(unitID) — return the unit's command
        // descriptors as a 1-indexed Lua array. Server streams the build
        // entries (cmdId<0) at ~1 Hz; we publish the minimum surface
        // chili / ZK widgets read on the cmd-descs side: id, name,
        // action, type, params, disabled. The widget then looks up the
        // human name and tooltip from UnitDefs[-cmd.id] itself, exactly
        // as it would against a real Spring client. Standing-order
        // toggles (move/stop/attack/patrol/...) are not streamed —
        // chili's command panel reads them off the CMD_* enum on its
        // own, so an empty list for textureless units is fine.
        GetUnitCmdDescs: (unitId: LuaValue) => {
            const uid = Number(unitId);
            const stored = ls.unitCmdDescs.get(uid);
            if (!stored || stored.length === 0) return luaTable();
            const arr: LuaValue[] = stored.map(d => {
                if (d.cmdId < 0) {
                    const defId = -d.cmdId;
                    const name  = ctx.getUnitDefName?.(defId) ?? String(defId);
                    return {
                        id:       d.cmdId,
                        disabled: d.disabled,
                        name,
                        action:   `buildunit_${name.toLowerCase()}`,
                        type:     20, // CMDTYPE_ICON_BUILDING
                        queueing: true,
                        params:   luaTable(),
                    };
                }
                return {
                    id:       d.cmdId,
                    disabled: d.disabled,
                    name:     `cmd_${d.cmdId}`,
                    action:   '',
                    type:     0, // CMDTYPE_ICON
                    params:   luaTable(),
                };
            });
            return luaTable(...arr);
        },
        GetUnitCommandCount: (unitId: LuaValue) => {
            return ls.unitCommands.get(Number(unitId))?.length ?? 0;
        },
        GetUnitCurrentCommand: (unitId: LuaValue) => {
            // Spring returns id, options, tag, params... as multiple values.
            // The current command is the front of the queue.
            const orders = ls.unitCommands.get(Number(unitId));
            const o = orders?.[0];
            if (!o) return null;
            return [o.cmdId, o.options, o.tag, ...o.params];
        },
        GetUnitGroup: (unitId: LuaValue) => {
            const uid = Number(unitId);
            for (const [gid, bucket] of ls.groups) {
                if (bucket.has(uid)) return gid;
            }
            return -1;
        },
        GetUnitDirection: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const h = u.heading / 65535 * Math.PI * 2;
            return [Math.sin(h), 0, Math.cos(h)];
        },
        GetUnitResources: () => [0, 0, 0, 0, 0, 0], // metalMake, metalUse, energyMake, energyUse
        IsUnitVisible: (id: LuaValue) => ls.units.has(Number(id)),
        IsUnitIcon: () => false,

        // --- Camera rotation ---
        GetCameraRotation: () => {
            const dx = ls.camera.tx - ls.camera.px;
            const dy = ls.camera.ty - ls.camera.py;
            const dz = ls.camera.tz - ls.camera.pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            return [Math.asin(-dy / len), Math.atan2(dx, dz), 0];
        },

        // --- Pos to build grid ---
        Pos2BuildPos: (_unitDefId: LuaValue, x: LuaValue, _y: LuaValue, z: LuaValue) => {
            // Snap to grid (squareSize = 8 typically)
            const sq = ctx.squareSize || 8;
            return [Math.floor(Number(x) / sq) * sq + sq / 2, 0, Math.floor(Number(z) / sq) * sq + sq / 2];
        },

        // --- View range ---
        GetViewRange: () => ls.camera.far,

        // --- Audio (post to main thread via worker message) ---
        PlaySoundFile: () => true, // accepted but no-op in worker
        StopSoundStream: () => {},
        SetSoundStreamVolume: () => {},

        // --- Lua message passing ---
        // SendLuaRulesMsg forwards a binary-safe payload to the server's
        // synced LuaRules state, where it surfaces as
        // `gadget:RecvLuaMsg(msg, playerID)`. ZK widgets (e.g.
        // gui_contextmenu) call this to reach commands gated to the
        // authoritative side. SendLuaUIMsg/SendLuaGaiaMsg are still
        // unwired — the former needs server-mediated broadcast to peer
        // clients, the latter needs LuaGaia to be loaded.
        SendLuaUIMsg: () => {},
        SendLuaRulesMsg: (msg: LuaValue) => {
            if (msg == null) return;
            ctx.sendLuaRulesMsg?.(String(msg));
        },
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
 * Project a world-space point to screen coordinates using view+projection matrices.
 * Returns [screenX, screenY, depth] or null if behind camera.
 */
function projectToScreen(
    wx: number, wy: number, wz: number,
    view: Float32Array, proj: Float32Array,
    vpW: number, vpH: number,
): [number, number, number] | null {
    // view * worldPos (column-major 4x4)
    const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12];
    const vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13];
    const vz = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
    const vw = view[3] * wx + view[7] * wy + view[11] * wz + view[15];
    // proj * viewPos
    const cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw;
    const cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw;
    const cz = proj[2] * vx + proj[6] * vy + proj[10] * vz + proj[14] * vw;
    const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;
    if (cw <= 0) return null; // behind camera
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    // NDC [-1,1] → screen coords. Spring Y is bottom-up.
    const sx = (ndcX * 0.5 + 0.5) * vpW;
    const sy = (1 - (ndcY * 0.5 + 0.5)) * vpH;
    return [sx, sy, cz / cw];
}

/**
 * Invert a column-major 4×4 matrix in-place into `out`. Returns false (and
 * leaves out untouched) when the matrix is singular. Adapted from the
 * standard cofactor expansion used by gluInvertMatrix.
 */
function mat4Inverse(m: ArrayLike<number>, out: Float32Array): boolean {
    const m00 = m[0],  m01 = m[1],  m02 = m[2],  m03 = m[3];
    const m10 = m[4],  m11 = m[5],  m12 = m[6],  m13 = m[7];
    const m20 = m[8],  m21 = m[9],  m22 = m[10], m23 = m[11];
    const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

    const c00 =  m11 * (m22 * m33 - m23 * m32) - m12 * (m21 * m33 - m23 * m31) + m13 * (m21 * m32 - m22 * m31);
    const c01 = -m10 * (m22 * m33 - m23 * m32) + m12 * (m20 * m33 - m23 * m30) - m13 * (m20 * m32 - m22 * m30);
    const c02 =  m10 * (m21 * m33 - m23 * m31) - m11 * (m20 * m33 - m23 * m30) + m13 * (m20 * m31 - m21 * m30);
    const c03 = -m10 * (m21 * m32 - m22 * m31) + m11 * (m20 * m32 - m22 * m30) - m12 * (m20 * m31 - m21 * m30);

    const det = m00 * c00 + m01 * c01 + m02 * c02 + m03 * c03;
    if (Math.abs(det) < 1e-12) return false;
    const invDet = 1 / det;

    const c10 = -m01 * (m22 * m33 - m23 * m32) + m02 * (m21 * m33 - m23 * m31) - m03 * (m21 * m32 - m22 * m31);
    const c11 =  m00 * (m22 * m33 - m23 * m32) - m02 * (m20 * m33 - m23 * m30) + m03 * (m20 * m32 - m22 * m30);
    const c12 = -m00 * (m21 * m33 - m23 * m31) + m01 * (m20 * m33 - m23 * m30) - m03 * (m20 * m31 - m21 * m30);
    const c13 =  m00 * (m21 * m32 - m22 * m31) - m01 * (m20 * m32 - m22 * m30) + m02 * (m20 * m31 - m21 * m30);
    const c20 =  m01 * (m12 * m33 - m13 * m32) - m02 * (m11 * m33 - m13 * m31) + m03 * (m11 * m32 - m12 * m31);
    const c21 = -m00 * (m12 * m33 - m13 * m32) + m02 * (m10 * m33 - m13 * m30) - m03 * (m10 * m32 - m12 * m30);
    const c22 =  m00 * (m11 * m33 - m13 * m31) - m01 * (m10 * m33 - m13 * m30) + m03 * (m10 * m31 - m11 * m30);
    const c23 = -m00 * (m11 * m32 - m12 * m31) + m01 * (m10 * m32 - m12 * m30) - m02 * (m10 * m31 - m11 * m30);
    const c30 = -m01 * (m12 * m23 - m13 * m22) + m02 * (m11 * m23 - m13 * m21) - m03 * (m11 * m22 - m12 * m21);
    const c31 =  m00 * (m12 * m23 - m13 * m22) - m02 * (m10 * m23 - m13 * m20) + m03 * (m10 * m22 - m12 * m20);
    const c32 = -m00 * (m11 * m23 - m13 * m21) + m01 * (m10 * m23 - m13 * m20) - m03 * (m10 * m21 - m11 * m20);
    const c33 =  m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);

    // Adjugate / det, column-major: out[col*4 + row] = cof[row][col] * invDet
    out[0]  = c00 * invDet; out[1]  = c10 * invDet; out[2]  = c20 * invDet; out[3]  = c30 * invDet;
    out[4]  = c01 * invDet; out[5]  = c11 * invDet; out[6]  = c21 * invDet; out[7]  = c31 * invDet;
    out[8]  = c02 * invDet; out[9]  = c12 * invDet; out[10] = c22 * invDet; out[11] = c32 * invDet;
    out[12] = c03 * invDet; out[13] = c13 * invDet; out[14] = c23 * invDet; out[15] = c33 * invDet;
    return true;
}

/** Multiply two column-major 4×4 matrices: out = a * b. */
function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>, out: Float32Array): void {
    for (let col = 0; col < 4; col++) {
        const b0 = b[col * 4], b1 = b[col * 4 + 1], b2 = b[col * 4 + 2], b3 = b[col * 4 + 3];
        out[col * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
        out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
        out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
}

const _invVP = new Float32Array(16);
const _mvp   = new Float32Array(16);

/**
 * Cast a ray from a screen pixel through the world and return where it
 * meets the heightmap, or null if the screen point is invalid (no VP
 * matrices yet, ray parallel to ground, hit behind camera).
 *
 * sx/sy are Spring screen coords: pixels with Y-up (y=0 at bottom).
 */
function screenPointToGround(
    sx: number, sy: number,
    view: Float32Array, proj: Float32Array,
    vpW: number, vpH: number,
    ctx: SpringAPIContext,
): [number, number, number] | null {
    mat4Mul(proj, view, _mvp);
    if (!mat4Inverse(_mvp, _invVP)) return null;

    const ndcX = (sx / vpW) * 2 - 1;
    const ndcY = (sy / vpH) * 2 - 1;

    // Unproject near (ndcZ=-1) and far (ndcZ=+1) NDC points.
    const unproject = (nz: number): [number, number, number] | null => {
        const x = _invVP[0] * ndcX + _invVP[4] * ndcY + _invVP[8]  * nz + _invVP[12];
        const y = _invVP[1] * ndcX + _invVP[5] * ndcY + _invVP[9]  * nz + _invVP[13];
        const z = _invVP[2] * ndcX + _invVP[6] * ndcY + _invVP[10] * nz + _invVP[14];
        const w = _invVP[3] * ndcX + _invVP[7] * ndcY + _invVP[11] * nz + _invVP[15];
        if (Math.abs(w) < 1e-9) return null;
        return [x / w, y / w, z / w];
    };
    const near = unproject(-1);
    const far  = unproject(+1);
    if (!near || !far) return null;

    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];

    // Intersect with horizontal plane y=0 first (cheap), then refine the
    // y by sampling the heightmap. This is good enough for mostly-flat
    // terrain; ray-marching the heightmap would be more accurate on cliffs
    // but adds complexity we don't yet need.
    if (Math.abs(dy) < 1e-6) return null;
    const t = -near[1] / dy;
    if (t < 0) return null;
    const wx = near[0] + dx * t;
    const wz = near[2] + dz * t;
    const wy = sampleHeight(ctx, wx, wz);
    return [wx, wy, wz];
}

/**
 * Approximate the ground normal at world position (x, z) from the
 * heightmap gradient. Cross product of the local east/south vectors
 * including their height differences produces an outward-facing
 * normal; we normalise it before returning. Mirrors Spring's
 * Spring.GetGroundNormal output shape (returns x, y, z, slope).
 */
function computeGroundNormal(ctx: SpringAPIContext, x: number, z: number): [number, number, number, number] {
    const sq = ctx.squareSize || 8;
    const hL = sampleHeight(ctx, x - sq, z);
    const hR = sampleHeight(ctx, x + sq, z);
    const hD = sampleHeight(ctx, x, z - sq);
    const hU = sampleHeight(ctx, x, z + sq);
    // dx/dz are local tangents; cross(dz, dx) yields a +Y normal.
    const nx = (hL - hR);
    const nz = (hD - hU);
    const ny = 2 * sq;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const ix = nx / len, iy = ny / len, iz = nz / len;
    // Slope = 1 - dot(normal, up) — a flat surface returns 0.
    return [ix, iy, iz, 1 - iy];
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
