/**
 * lua-ui-host.ts — the Fengari/LuaUI half of the game-processor worker.
 *
 * Owns:
 *   - All LuaUI module-level state (runtime, bridge, liveState, def maps, etc.)
 *   - init() — bootstraps the Fengari runtime, VFS, widget handler, gadgets
 *   - runFrame() — drives the per-frame widget callins (DrawScreen / DrawWorld)
 *   - All install* helpers (installEngineGlobals, installIOStubs, installVFS)
 *   - All dispatch* callins (widgetHandler:UnitCreated etc.)
 *   - shutdown() — tears down the runtime
 *   - applyEntityStateToLiveState / removeUnitFromLiveState (liveState mutations)
 *   - Lua source constants (LUA_COMPAT_SHIM, CMD_GLOBALS_LUA, etc.)
 *
 * Reads the shared seam refs (connection, selection, renderers, lighting) from
 * gp-context.ts via gpCtx.* — NEVER imports lua-widget-worker.ts (no cycle).
 *
 * Extracted from lua-widget-worker.ts as part of PLAN-refactor-p3.md WP2b.
 */

import { LuaRuntime, type LuaValue, luaTable } from './lua-runtime.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    createDefaultLiveState,
    ensurePlayerEntry,
    parseMapInfoFields,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
} from './lua-spring-api.js';
import type { CombatEventInfo, FeatureSpawnInfo, SoundRefInfo } from './connection.js';
import { SoundCategory } from './sound-events.js';
import type { EntityStateSnapshot } from './entity-state.js';
import { applyMapLighting, type SceneLighting } from './scene-lighting.js';
import {
    mergeSunLighting, setSunDirectionLighting, loadMapAtmosphere,
    type MapLighting,
} from './map-lighting.js';
import { md5Base64 } from './vfs-hash.js';
import {
    vfsFiles, vfsPathMap, vfsDirCache, vfsSubdirCache,
    warnedVfsSha, setWarnedVfsSha,
    setVfsLogger, resetVfs,
    presentDirListEntries, vfsRegister,
    vfsExists, vfsLookup, prefetchAllGameFiles,
    vfsLoadBinary, setVfsBinaryFetcher,
    VFS_IMPLEMENTATION_LUA,
} from './worker-vfs.js';
import { gpCtx } from './gp-context.js';
import { installRmlGlobal } from '../ui/rml/rml-bridge.js';
import { fixLua51Escapes } from './lua51-escapes.js';

// Engine-bundled test widgets. Loaded only when `?widgetTest` is active.
import dbgRenderTestSrc from '../lua-test-widgets/dbg_render_test.lua?raw';
import dbgRenderTestQuit from '../lua-test-widgets/quit.png?url';
import dbgRenderTestTick from '../lua-test-widgets/tick.png?url';
import dbgRenderTestPanel from '../lua-test-widgets/panel_0001.png?url';
import dbgChiliTestSrc from '../lua-test-widgets/dbg_chili_test.lua?raw';
import dbgFontBaselineSrc from '../lua-test-widgets/dbg_font_baseline.lua?raw';
import dbgEndgameTriggerSrc from '../lua-test-widgets/dbg_endgame_trigger.lua?raw';

export interface MapDataTransfer {
    mapx: number;
    mapy: number;
    squareSize: number;
    minHeight: number;
    maxHeight: number;
    widthElmos: number;
    heightElmos: number;
    heightmap: Uint16Array;
    mapSourceUrl: string;
}

// ── Logging ────────────────────────────────────────────────────────────

// Rate-limit log posting to prevent a runaway widget loop from
// filling the main thread's postMessage queue and OOMing the tab.
// We keep a sliding window of log timestamps over the last second.
const logTimes: number[] = [];
const LOG_RATE_LIMIT_PER_SEC = 500;
let logDropCount = 0;

// Track repeated messages to suppress spamming widgets.
const recentMsgs = new Map<string, number>();

export function postLog(level: number, msg: string): void {
    // Suppress exact-duplicate messages (e.g. Key Unbinder spam).
    // Allow the first occurrence and then once every 100 repeats.
    const count = (recentMsgs.get(msg) ?? 0) + 1;
    recentMsgs.set(msg, count);
    if (count > 2 && (count & 0xff) !== 0) return;
    // Periodically clear to avoid unbounded map growth.
    if (recentMsgs.size > 500) recentMsgs.clear();

    const now = performance.now();
    while (logTimes.length && logTimes[0] < now - 1000) logTimes.shift();
    if (logTimes.length >= LOG_RATE_LIMIT_PER_SEC) {
        logDropCount++;
        if ((logDropCount & 0x3ff) === 0) {
            const post = self.postMessage as (msg: unknown) => void;
            post({ type: 'log', level: 3, msg: `[LuaUI] log rate-limited: ${logDropCount} messages dropped` });
        }
        return;
    }
    logTimes.push(now);
    postToMain({ type: 'log', level, msg });
}

// Wire the VFS logger seam now that postLog is defined.
setVfsLogger(postLog);

/// Wrap every outgoing postMessage so we can diagnose the shutdown loop.
/// Level-1 debug traffic so it's hidden from normal views but visible
/// via the debug console filter. `log` messages are skipped to avoid
/// recursive self-description of the log pipe.
export function postToMain(msg: Record<string, unknown>, transfer?: Transferable[]): void {
    const post = self.postMessage as (msg: unknown, transfer?: Transferable[]) => void;
    if (transfer && transfer.length) {
        post(msg, transfer);
    } else {
        post(msg);
    }
}

// ── SoundItem ingestion ───────────────────────────────────────────────
//
// gamedata/sounds.lua returns a `Sounds` table whose `SoundItems` map
// is the canonical metadata source for sound playback (per-item
// gain / pitch / priority / maxconcurrent / maxdist / rolloff / in3d /
// preload / looptime). ZK and other Spring games build this table
// dynamically — for example, ZK's local `AutoAdd` helper does
// `VFS.DirList("sounds/<sub>")` and emplaces every discovered file
// under a key like `<sub>/<stem>`.
//
// Because the table is built by arbitrary Lua we can't reproduce it
// from a TS parser. Loading the file here, in the worker's Fengari
// runtime with a working VFS.DirList, is the only sound way to get
// the right table on any game.
//
// We post the resulting JS-side map to the main thread, where
// AudioManager.ingestSoundItems holds it as the SoundItem lookup
// table used by SoundEventPlayer (server-emitted SoundEvents) and by
// the widget-side Spring.PlaySoundFile path.

export function loadAndPostSoundItems(rt: LuaRuntime): void {
    // Skip silently when the file isn't in the VFS — some games (like
    // Paper Tanks) don't ship a sounds.lua. The audio path falls back
    // to literal SoundRef.path lookups in that case.
    const exists = rt.evalString(`return VFS.FileExists("gamedata/sounds.lua") or VFS.FileExists("gamedata/sounds.lua", VFS.GAME) and 1 or 0`,
        'sound_items_exists');
    if (exists !== 1 && exists !== true) {
        postLog(2, '[LuaUI] no gamedata/sounds.lua — SoundItem map empty');
        return;
    }

    const items = rt.evalString(`
        -- Run gamedata/sounds.lua and pull out the SoundItems map.
        -- Wrapped in pcall because real-world sounds.lua files use
        -- arbitrary Lua and may legitimately error on missing assets;
        -- a hard failure here would break audio for the whole game.
        local ok, sounds = pcall(VFS.Include, "gamedata/sounds.lua")
        if not ok or type(sounds) ~= "table" then
            Spring.Echo("[LuaUI] gamedata/sounds.lua did not return a table: " .. tostring(sounds))
            return {}
        end
        local items = sounds.SoundItems or sounds
        if type(items) ~= "table" then return {} end

        -- Project out only the fields we honour on the JS side. The
        -- raw table can contain functions (e.g. ZK's onPlay hooks)
        -- that postMessage can't clone.
        local out = {}
        for k, v in pairs(items) do
            if type(k) == "string" and type(v) == "table" then
                out[k] = {
                    file          = type(v.file)          == "string" and v.file          or nil,
                    gain          = type(v.gain)          == "number" and v.gain          or nil,
                    pitch         = type(v.pitch)         == "number" and v.pitch         or nil,
                    gainmod       = type(v.gainmod)       == "number" and v.gainmod       or nil,
                    pitchmod      = type(v.pitchmod)      == "number" and v.pitchmod      or nil,
                    priority      = type(v.priority)      == "number" and v.priority      or nil,
                    maxconcurrent = type(v.maxconcurrent) == "number" and v.maxconcurrent or nil,
                    maxdist       = type(v.maxdist)       == "number" and v.maxdist       or nil,
                    rolloff       = type(v.rolloff)       == "number" and v.rolloff       or nil,
                    in3d          = (v.in3d ~= nil) and (v.in3d == true or v.in3d == 1) or nil,
                    dopplerscale  = type(v.dopplerscale)  == "number" and v.dopplerscale  or nil,
                    preload       = (v.preload == true) or nil,
                    looptime      = type(v.looptime)      == "number" and v.looptime      or nil,
                }
            end
        end
        return out
    `, 'sound_items_load');

    if (!items || typeof items !== 'object') {
        postLog(2, '[LuaUI] gamedata/sounds.lua produced no SoundItems');
        return;
    }
    const itemRecord = items as Record<string, unknown>;
    const count = Object.keys(itemRecord).length;
    postLog(2, `[LuaUI] gamedata/sounds.lua produced ${count} SoundItem(s)`);
    postToMain({ type: 'soundItems', items: itemRecord });
}

export function describeMessage(msg: Record<string, unknown>): string {
    const t = String(msg.type ?? '?');
    // Short summary per message type; avoids dumping huge payloads.
    switch (t) {
        case 'ready':      return `ready (fileCount=${msg.fileCount}, callins=${(msg.callins as string[])?.join(',') || 'none'})`;
        case 'error':      return `error: ${String(msg.msg ?? '')}`;
        case 'storage:set':return `storage:set key=${msg.key}`;
        case 'widgetList': return `widgetList (${String(msg.data ?? '').length} bytes)`;
        default:           return t;
    }
}

export function describeInboundMessage(msg: Record<string, unknown>): string {
    const t = String(msg?.type ?? '?');
    switch (t) {
        case 'init':        return `init (gameId=${msg.gameId})`;
        case 'shutdown':    return 'shutdown';
        case 'resize':      return `resize ${msg.width}x${msg.height}`;
        case 'keypress':    return `keypress keyCode=${msg.keyCode}`;
        case 'keyrelease':  return `keyrelease keyCode=${msg.keyCode}`;
        case 'mousepress':  return `mousepress @${msg.x},${msg.y} btn=${msg.button}`;
        case 'mouserelease':return `mouserelease @${msg.x},${msg.y} btn=${msg.button}`;
        case 'mousemove':   return `mousemove @${msg.x},${msg.y}`;
        case 'mousewheel':  return `mousewheel up=${msg.up} value=${msg.value}`;
        case 'getWidgetList': return 'getWidgetList';
        case 'toggleWidget':  return `toggleWidget name=${msg.name}`;
        case 'enableWidget':  return `enableWidget name=${msg.name}`;
        case 'disableWidget': return `disableWidget name=${msg.name}`;
        case 'stateUpdate':   return `stateUpdate frame=${msg.gameFrame}`;
        case 'entityState':   return `entityState count=${msg.count} delta=${msg.isDelta}`;
        case 'entityDestroy': return `entityDestroy id=${msg.entityId}`;
        case 'entitySensorUpdate': return `entitySensorUpdate id=${msg.entityId} type=${msg.sensorType} r=${msg.radius}`;
        case 'sendToUnsynced':     return `sendToUnsynced topic=${(msg.args as unknown[])?.[0] ? JSON.stringify((msg.args as Array<{ value?: unknown }>)[0]?.value) : '?'} argc=${(msg.args as unknown[])?.length ?? 0}`;
        case 'intelTransitions': return `intelTransitions (${(msg.events as unknown[])?.length ?? 0} events)`;
        case 'seismicPings':  return `seismicPings (${(msg.pings as unknown[])?.length ?? 0} pings)`;
        case 'losBitmap':     return `losBitmap allyTeam=${msg.allyTeam} ${msg.width}x${msg.height} frame=${msg.frame}`;
        case 'resourceUpdate':return `resourceUpdate team=${msg.team}`;
        case 'gameInfo':      return `gameInfo frame=${msg.frame}`;
        case 'commandNotify': return `commandNotify cmd=${msg.cmdId} req=${msg.requestId} params=${(msg.params as unknown[])?.length ?? 0}`;
        case 'defaultCommandTarget': return `defaultCommandTarget type=${msg.targetType} id=${msg.targetId} engineCmd=${msg.engineCmd}`;
        case 'pathResponse':  return `pathResponse req=${msg.requestId} waypoints=${(msg.waypoints as unknown[])?.length ?? 0}`;
        case 'visibleUnits':  return `visibleUnits +${(msg.added as unknown[])?.length ?? 0} -${(msg.removed as unknown[])?.length ?? 0}`;
        default:              return t;
    }
}

// ── localStorage bridge ────────────────────────────────────────────────
// Workers can't access localStorage directly. Main thread sends all
// luaui:* entries at init time; writes update the local cache AND post
// back to main thread for persistence.

const storageCache: Record<string, string> = {};

export function loadFromStorage(key: string): string | null {
    return storageCache[key] ?? null;
}

export function saveToStorage(key: string, value: string): void {
    storageCache[key] = value;
    postToMain({ type: 'storage:set', key, value });
}

// ── Main init ──────────────────────────────────────────────────────────

let runtime: LuaRuntime | null = null;
let bridge: LuaGLBridge | null = null;
let startTime = performance.now() / 1000;
let frameInterval: ReturnType<typeof setInterval> | null = null;
let initBaseUrl = '';  // saved from init() for re-fetch on enable

// Last [played, duration] in seconds for the BGMusic stream. The
// worker can't read the HTMLAudioElement directly across threads, so
// the main thread pushes a snapshot whenever music state changes;
// Spring.GetSoundStreamTime returns the cached pair. Defaults to
// (0, 0) until the first track starts.
let musicStreamPlayed = 0;
let musicStreamDuration = 0;

// Live game state updated by main thread messages, read by Spring API
export const liveState: LiveState = createDefaultLiveState();

// Per-game unit/weapon def caches, populated incrementally by
// unitDefsUpdate / weaponDefsUpdate. The wire-format defs from the
// server are minimal (id, name, model URL, texture URL) — we merge in
// safe defaults for the fields ZK widgets routinely access (health,
// metalCost, customParams, isFactory, …) so reads don't crash. Real
// def values will need a richer protocol later.
export interface MinimalUnitDefWire {
    defId: number; name: string; modelUrl: string; textureUrl: string;
    humanName?: string; tooltip?: string; wreckName?: string;
    metalCost?: number; energyCost?: number; buildTime?: number;
    metalMake?: number; energyMake?: number;
    metalUpkeep?: number; energyUpkeep?: number;
    metalStorage?: number; energyStorage?: number;
    extractsMetal?: number;
    health?: number; mass?: number; radius?: number;
    xsize?: number; zsize?: number;
    speed?: number; turnRate?: number; maxAcc?: number; maxDec?: number;
    /** MoveDef::pathType. UINT32_MAX (4294967295) = unit has no movedef
     *  (air, immobile). Surfaced as `UnitDefs[id].moveDef.id` to ZK. */
    moveDefPathType?: number;
    losRadius?: number; airLosRadius?: number;
    radarRadius?: number; sonarRadius?: number;
    jammerRadius?: number; seismicRadius?: number;
    /** Behaviour bitfield (bit assignments mirror schemas/protocol.fbs). */
    flags?: number;
    buildDistance?: number; buildSpeed?: number;
    buildOptions?: number[]; weaponDefIds?: number[];
    /** Tier 4: customParams + rare fields. */
    customParams?: Record<string, string>;
    repairSpeed?: number;
    transportSize?: number;
    transportMass?: number;
    transportCapacity?: number;
    yardmap?: string;
    script?: string;
    buildPic?: string;
    maxVelocity?: number;
    cost?: number;
    maxWeaponRange?: number;
    maxThisUnit?: number;
    canBeAssisted?: boolean;
    canSelfDestruct?: boolean;
    selfDCountdown?: number;
    categoryBits?: number;
    sounds?: SoundRefInfo[];
}
export interface MinimalWeaponDefWire {
    defId: number; name: string; projectileType: number;
    projectileSpeed: number; range: number; aoe: number; size: number;
    intensity: number; colorR: number; colorG: number; colorB: number;
    duration: number; highTrajectory: boolean;
    beamTtl?: number;
    typeName?: string; description?: string;
    defaultDamage?: number; damages?: number[];
    reloadTime?: number; salvoSize?: number; salvoDelay?: number;
    accuracy?: number; sprayAngle?: number; movingAccuracy?: number;
    targetMoveError?: number; leadLimit?: number;
    edgeEffectiveness?: number;
    impulseFactor?: number; impulseBoost?: number;
    craterMult?: number; craterBoost?: number; craterAoe?: number;
    fireStarter?: number; flightTime?: number;
    weaponAcceleration?: number; turnRate?: number;
    uptime?: number; coverageRange?: number; stockpileTime?: number;
    metalCost?: number; energyCost?: number;
    flags?: number;
    customParams?: Record<string, string>;
}
export const unitDefMap = new Map<number, MinimalUnitDefWire>();
export const weaponDefMap = new Map<number, MinimalWeaponDefWire>();

/** Wire `SoundCategory` code (`sound-events.ts`) → the `UnitDef.sounds`
 *  sub-table key Recoil authors (`LuaUnitDefs.cpp::SoundsTable`). The two
 *  naming schemes diverge (`OrderAck`→`ok`, `Move`→`arrived`,
 *  `BuildStart`→`build`, `Cancel`→`cant`) so this can't be derived by
 *  lower-casing the enum name. */
const SOUND_CATEGORY_LUA_KEY: Record<number, string> = {
    [SoundCategory.Select]: 'select',
    [SoundCategory.OrderAck]: 'ok',
    [SoundCategory.Move]: 'arrived',
    [SoundCategory.BuildStart]: 'build',
    [SoundCategory.Working]: 'working',
    [SoundCategory.UnderAttack]: 'underattack',
    [SoundCategory.Cancel]: 'cant',
    [SoundCategory.Activate]: 'activate',
    [SoundCategory.Deactivate]: 'deactivate',
};
// Recoil always pushes all 10 keys (SoundsTable), incl. `repair` — which
// has no wire category (neither our nor Recoil's own UnitDefHandler ever
// populates UnitDef::SoundStruct::repair/working from unit Lua — verified
// against ../RecoilEngine's UnitDefHandler.cpp — so `repair` faithfully
// stays an always-empty table).
const SOUND_CATEGORY_KEYS = [
    'select', 'ok', 'arrived', 'build', 'repair', 'working',
    'underattack', 'cant', 'activate', 'deactivate',
];

/** Build the Recoil-shaped `UnitDefs[id].sounds` sub-table: one key per
 *  category, each a 1-indexed sequence of `{name, volume, id}` (matching
 *  `LuaUnitDefs.cpp::PushGuiSoundSet` for an unsynced handle, which also
 *  carries `id`). Must use `luaTable()` — a plain JS object with numeric
 *  keys marshals as Lua *string* keys (`pushValue`'s generic object
 *  branch uses `lua_setfield`), which would make `#sounds.underattack`
 *  and `sounds.select[1]` fail even though the data is present. */
function buildLuaUnitSounds(refs: SoundRefInfo[] | undefined): Record<string, LuaValue> {
    const byKey = new Map<string, SoundRefInfo[]>();
    for (const key of SOUND_CATEGORY_KEYS) byKey.set(key, []);
    for (const ref of refs ?? []) {
        const key = SOUND_CATEGORY_LUA_KEY[ref.category];
        if (key) byKey.get(key)!.push(ref);
    }
    const sounds: Record<string, LuaValue> = {};
    for (const [key, entries] of byKey) {
        sounds[key] = luaTable(...entries.map((s): LuaValue => (
            { name: s.name, volume: s.volume, id: s.id }
        )));
    }
    return sounds;
}

/** Build the rich Lua-shaped UnitDef table from the wire form. The
 *  Tier 3 wire protocol carries real values for cost, health, sensor
 *  ranges, footprint, speed, and behaviour flags; we surface them here
 *  using the field names ZK widgets consume. Anything still unknown to
 *  the wire (yardmap, customParams, moveDef details) keeps a safe
 *  default so widgets don't crash on first read. */
function buildLuaUnitDef(d: MinimalUnitDefWire): Record<string, LuaValue> {
    const flags = d.flags ?? 0;
    const has = (bit: number) => (flags & (1 << bit)) !== 0;
    const isBuilder    = has(0);
    const canMove      = has(1);
    const canFly       = has(2);
    const canSubmerge  = has(3);
    const floatOnWater = has(4);
    const canCloak     = has(5);
    const canKamikaze  = has(6);
    const canManualFire= has(7);
    const stealth      = has(8);
    const sonarStealth = has(9);
    const reclaimable  = has(10);
    const isFactory    = has(11);
    const isBuilding   = has(12);
    const isAirUnit    = has(13);
    const isExtractor  = has(14);
    const hasWeapons   = has(15);

    // Spring's UnitDefs.buildOptions is a 1-indexed sequence keyed by
    // slot. Widgets like the build menu iterate `for i, defID in ipairs`.
    const buildOptionsSeq: number[] = d.buildOptions ?? [];

    // weapons table — Spring shape is { [1] = { weaponDef = id, ... }, ... }.
    // We only carry the ID for now; widgets that read weapons[i].weaponDef
    // will work, others fall through harmlessly.
    const weapons: Record<number, LuaValue> = {};
    const weaponDefIds = d.weaponDefIds ?? [];
    for (let i = 0; i < weaponDefIds.length; i++) {
        weapons[i + 1] = { weaponDef: weaponDefIds[i] };
    }

    return {
        id: d.defId, name: d.name,
        humanName: d.humanName || d.name,
        tooltip: d.tooltip || d.name,
        wreckName: d.wreckName ?? '',
        deathExplosion: '', selfDExplosion: '',
        modelUrl: d.modelUrl, textureUrl: d.textureUrl,

        // Stats from the wire.
        health: d.health ?? 0,
        mass: d.mass ?? 0,
        metalCost: d.metalCost ?? 0,
        energyCost: d.energyCost ?? 0,
        buildTime: d.buildTime ?? 0,
        radius: d.radius ?? 0,
        height: d.radius ?? 0,
        speed: d.speed ?? 0,
        maxAcc: d.maxAcc ?? 0,
        maxDec: d.maxDec ?? 0,
        turnRate: d.turnRate ?? 0,
        brakeRate: d.maxDec ?? 0,
        autoHeal: 0,

        // Footprint.
        xsize: d.xsize ?? 0,
        zsize: d.zsize ?? 0,

        // Economy.
        metalMake: d.metalMake ?? 0,
        energyMake: d.energyMake ?? 0,
        metalUpkeep: d.metalUpkeep ?? 0,
        energyUpkeep: d.energyUpkeep ?? 0,
        metalStorage: d.metalStorage ?? 0,
        energyStorage: d.energyStorage ?? 0,
        extractsMetal: d.extractsMetal ?? 0,
        extractRange: 0,

        // Sensor ranges.
        sightDistance: d.losRadius ?? 0,
        airSightDistance: d.airLosRadius ?? 0,
        radarDistance: d.radarRadius ?? 0,
        sonarDistance: d.sonarRadius ?? 0,
        sonarJamDistance: 0,
        jammerDistance: d.jammerRadius ?? 0,
        seismicDistance: d.seismicRadius ?? 0,
        stealth, sonarStealth,

        // Categorical flags.
        isFactory, isBuilder, isAirUnit, isImmobile: !canMove,
        isBuilding, isExtractor, reclaimable,
        canMove, canFly, canSubmerge, canHover: false,
        canFight: hasWeapons, canPatrol: canMove, canStop: true, canGuard: true,
        canAttack: hasWeapons, canRepair: isBuilder, canReclaim: isBuilder,
        canCapture: false, canResurrect: false,
        canCloak, canKamikaze, canManualFire,
        canSelfD: d.canSelfDestruct ?? true,
        canBeAssisted: d.canBeAssisted ?? true,
        floatOnWater,

        // Builder specifics.
        buildDistance: d.buildDistance ?? 0,
        buildSpeed: d.buildSpeed ?? 0,
        buildOptions: buildOptionsSeq,
        weapons,
        sounds: buildLuaUnitSounds(d.sounds),

        // Tier 4 fields (custom params + rare attributes).
        customParams: (d.customParams ?? {}) as Record<string, LuaValue>,
        repairSpeed: d.repairSpeed ?? 0,
        transportSize: d.transportSize ?? 0,
        transportMass: d.transportMass ?? 0,
        transportCapacity: d.transportCapacity ?? 0,
        isTransport: (d.transportCapacity ?? 0) > 0 && (d.transportMass ?? 0) > 0,
        yardMap: d.yardmap ?? '',
        script: d.script ?? '',
        buildPic: d.buildPic ?? '',
        maxVelocity: d.maxVelocity ?? d.speed ?? 0,
        cost: d.cost ?? ((d.metalCost ?? 0) + (d.energyCost ?? 0)),
        maxWeaponRange: d.maxWeaponRange ?? 0,
        maxThisUnit: d.maxThisUnit ?? 0,
        selfDCountdown: d.selfDCountdown ?? 0,
        category: d.categoryBits ?? 0,

        modCategories: {} as Record<string, LuaValue>,
        // moveDef.id mirrors MoveDef::pathType. ZK widgets read this to
        // route Spring.RequestPath through the correct mobility class
        // (kbot vs tank vs hover). The wire sentinel UINT32_MAX means
        // "no movedef" (air, immobile) — surface it as -1 here so the
        // Lua-side `if moveDef.id < 0` and `if moveDef.id == nil` checks
        // ZK widgets do both fail-close to "no pathing".
        moveDef: ((): Record<string, LuaValue> => {
            const pt = d.moveDefPathType ?? 0xFFFFFFFF;
            if (pt === 0xFFFFFFFF) return {};
            return { id: pt };
        })(),
    };
}

function buildLuaWeaponDef(d: MinimalWeaponDefWire): Record<string, LuaValue> {
    const flags = d.flags ?? 0;
    const has = (bit: number) => (flags & (1 << bit)) !== 0;
    const tracks         = has(0);
    const paralyzer      = has(1);
    const noSelfDamage   = has(2);
    const manualfire     = has(3);
    const noAutoTarget   = has(4);
    const stockpile      = has(5);
    const waterweapon    = has(6);
    const fireSubmersed  = has(7);
    const submissile     = has(8);
    const turret         = has(9);
    const onlyForward    = has(10);
    const fixedLauncher  = has(11);
    const canAttackGround= has(12);
    const avoidFriendly  = has(13);
    const avoidFeature   = has(14);
    const avoidNeutral   = has(15);
    const gravityAffected= has(16);
    const noExplode      = has(17);
    const largeBeamLaser = has(18);
    const laserHardStop  = has(19);
    const isShield       = has(20);
    const smartShield    = has(21);
    const exteriorShield = has(22);
    const visibleShield  = has(23);

    // damages — Spring widgets read this as a 1-indexed table keyed by
    // armor class. We surface the per-class array if the wire carried
    // it; otherwise fill `[1] = defaultDamage` so common code paths
    // work either way.
    const damages: Record<number, LuaValue> = {};
    const defaultDamage = d.defaultDamage ?? 0;
    if (d.damages && d.damages.length > 0) {
        for (let i = 0; i < d.damages.length; i++) damages[i + 1] = d.damages[i];
    } else {
        damages[1] = defaultDamage;
    }

    return {
        id: d.defId, name: d.name,
        type: d.typeName ?? '',
        description: d.description || d.name,
        projectileType: d.projectileType,
        projectilespeed: d.projectileSpeed,
        range: d.range,
        damageAreaOfEffect: d.aoe,
        size: d.size,
        intensity: d.intensity,
        rgbColor: [d.colorR, d.colorG, d.colorB],
        // Recoil exposes weapon colour under `WeaponDefs[i].visuals.colorR`
        // (LuaWeaponDefs.cpp). ZK's gfx_projectile_lights.lua reads exactly
        // that path (`weaponDef.visuals.colorR + 0.2`), so the `visuals`
        // sub-table must exist or the widget errors on a nil index.
        visuals: {
            colorR: d.colorR, colorG: d.colorG, colorB: d.colorB,
        },
        // BeamLaser / LightningCannon sprite linger (sim frames). Recoil's
        // `WeaponDefs[i].beamTTL`; projectile-lights fades beam lights when
        // beamTTL > 2.
        beamTTL: d.beamTtl ?? 0,
        duration: d.duration,
        highTrajectory: d.highTrajectory ? 1 : 0,

        damages,
        defaultDamage,
        reloadTime: d.reloadTime ?? 0,
        salvoSize: d.salvoSize ?? 0,
        salvoDelay: d.salvoDelay ?? 0,
        accuracy: d.accuracy ?? 0,
        sprayAngle: d.sprayAngle ?? 0,
        movingAccuracy: d.movingAccuracy ?? 0,
        targetMoveError: d.targetMoveError ?? 0,
        leadLimit: d.leadLimit ?? -1,
        edgeEffectiveness: d.edgeEffectiveness ?? 0,
        impulseFactor: d.impulseFactor ?? 1,
        impulseBoost: d.impulseBoost ?? 0,
        craterMult: d.craterMult ?? 1,
        craterBoost: d.craterBoost ?? 0,
        craterAreaOfEffect: d.craterAoe ?? 0,
        fireStarter: d.fireStarter ?? 0,
        flighttime: d.flightTime ?? 0,
        weaponAcceleration: d.weaponAcceleration ?? 0,
        turnRate: d.turnRate ?? 0,
        uptime: d.uptime ?? 0,
        coverageRange: d.coverageRange ?? 0,
        stockpileTime: d.stockpileTime ?? 0,
        metalCost: d.metalCost ?? 0,
        energyCost: d.energyCost ?? 0,

        // Behaviour flags.
        tracks, paralyzer, noSelfDamage, manualfire, noAutoTarget,
        stockpile, waterweapon, fireSubmersed, submissile,
        turret, onlyForward, fixedLauncher, canAttackGround,
        avoidFriendly, avoidFeature, avoidNeutral, avoidGround: true,
        gravityAffected, noExplode,
        largeBeamLaser, laserHardStop,
        isShield, smartShield, exteriorShield, visibleShield,

        customParams: (d.customParams ?? {}) as Record<string, LuaValue>,
    };
}

/** Republish the UnitDefs / UnitDefNames / WeaponDefs / WeaponDefNames
 *  globals from the current cache. Called from init and after every
 *  defs-update message. */
export function republishDefGlobals(rt: LuaRuntime): void {
    const unitDefs: Record<number, LuaValue> = {};
    const unitDefNames: Record<string, LuaValue> = {};
    for (const d of unitDefMap.values()) {
        const lua = buildLuaUnitDef(d);
        unitDefs[d.defId] = lua;
        if (d.name) unitDefNames[d.name] = lua;
    }
    rt.setGlobal('UnitDefs', unitDefs);
    rt.setGlobal('UnitDefNames', unitDefNames);

    const weaponDefs: Record<number, LuaValue> = {};
    const weaponDefNames: Record<string, LuaValue> = {};
    for (const d of weaponDefMap.values()) {
        const lua = buildLuaWeaponDef(d);
        weaponDefs[d.defId] = lua;
        if (d.name) weaponDefNames[d.name] = lua;
    }
    rt.setGlobal('WeaponDefs', weaponDefs);
    rt.setGlobal('WeaponDefNames', weaponDefNames);

    // 1) Convert string-numeric keys to number keys. The JS-side
    //    Record<number, T> serialises as a JS object with string keys
    //    (\`{"1": ud, "2": ud, …}\`); fengari preserves those as Lua
    //    string keys, which breaks ZK code that does \`UnitDefs[1]\` or
    //    \`for i = 1, #UnitDefs do\`. Re-key the table so numeric access
    //    and the # length operator work.
    // 2) Attach a fallback metatable so missing fields return 0 instead
    //    of nil. ZK widgets read many obscure fields at file scope (e.g.
    //    \`gunshiptrans.transportSize * 2\`) and a nil there crashes the
    //    widget at load. Returning 0 is harmless for arithmetic; tables
    //    that must always be tables (customParams, etc.) get explicit
    //    empty-table defaults via the inner table.
    rt.doString(`
        local function _renumberKeys(t)
            if type(t) ~= "table" then return t end
            local fixed = {}
            for k, v in pairs(t) do
                local nk = tonumber(k)
                if nk and math.floor(nk) == nk then
                    fixed[nk] = v
                else
                    fixed[k] = v
                end
            end
            return fixed
        end
        UnitDefs = _renumberKeys(UnitDefs)
        WeaponDefs = _renumberKeys(WeaponDefs)
        -- UnitDefNames / WeaponDefNames are keyed by string already; leave them.

        -- Default weapon entry — chains like \`ud.weapons[1].weaponDef\`
        -- are common at file scope. If weapons[i] is nil for a unit
        -- with no weapons we'd crash. Rather than a metatable on
        -- weapons (which would make ipairs(ud.weapons) never
        -- terminate, hanging the worker), seed weapons[1] with a stub
        -- entry on units whose weapons table is empty. ipairs/# stay
        -- consistent and the chain resolves to WeaponDefs[0] (also a
        -- stub).
        local _emptyWeapon = { weaponDef = 0, slavedTo = 0, mainDir = {0,0,1},
            maxAngleDif = 0, fuelUsage = 0, badTargetCat = 0, onlyTargetCat = 0 }

        local _udFieldDefaults = setmetatable({
            customParams = {},
            modCategories = {},
            springCategories = {},  -- ZK widgets gate on .fixedwing/.land etc
            buildOptions = {},
            weapons = { [1] = _emptyWeapon },  -- only used when ud.weapons missing
            wDefs = {},
            moveDef = {},
            yardMap = {},
            sfxTypes = {},
            -- Sub-tables widgets occasionally index. Empty tables with
            -- a 0-fallback metatable so things like ud.model.height /
            -- ud.model.midy return 0 instead of nil. Indexing a number
            -- errors, so 0 fallback only applies via __index here.
            model = setmetatable({}, { __index = function() return 0 end }),
            cobScript = setmetatable({}, { __index = function() return 0 end }),
            collisionVolume = setmetatable({}, { __index = function() return 0 end }),
            unitNames = {},
            iconType = "",
        }, { __index = function(_, _) return 0 end })
        local _udMeta = { __index = _udFieldDefaults }
        for _, ud in pairs(UnitDefs or {}) do
            if type(ud) == "table" and not getmetatable(ud) then
                setmetatable(ud, _udMeta)
                -- For empty weapons tables, seed slot 1 with the stub
                -- so widgets reading ud.weapons[1].weaponDef get 0
                -- instead of nil-indexing. Don't add a metatable —
                -- that would break ipairs.
                if type(ud.weapons) == "table" and ud.weapons[1] == nil then
                    ud.weapons[1] = _emptyWeapon
                end
            end
        end
        local _wdFieldDefaults = setmetatable({
            customParams = {},
            damages = setmetatable({}, { __index = function() return 0 end }),
            -- \`visuals\` is ALWAYS a sub-table in Recoil (LuaWeaponDefs.cpp:
            -- thickness / colorR/G/B / ...). The catch-all __index below
            -- returns the number 0 for any unlisted field, which makes a
            -- \`wDef.visuals.thickness\` chain crash with "index a number
            -- value" on the WeaponDefs[0] stub (and any def whose visuals
            -- table wasn't built). Provide visuals as a table explicitly so
            -- the chain resolves; missing scalars inside read 0. Real defs
            -- carry their own visuals table from buildLuaWeaponDef and never
            -- hit this default. (Fixes gui_pip.lua:7394 — BAR + ZK.)
            visuals = setmetatable({}, { __index = function() return 0 end }),
        }, { __index = function(_, _) return 0 end })
        local _wdMeta = { __index = _wdFieldDefaults }
        local _emptyWeaponDef = setmetatable({
            id = 0, name = "", type = "", description = "",
            customParams = {},
            damages = setmetatable({}, { __index = function() return 0 end }),
        }, _wdMeta)
        for _, wd in pairs(WeaponDefs or {}) do
            if type(wd) == "table" and not getmetatable(wd) then
                setmetatable(wd, _wdMeta)
            end
        end
        -- Make WeaponDefs[0] resolve to a stub def. ZK's stub-weapon
        -- entries (from our weapons-metatable) carry weaponDef = 0, and
        -- a chain like \`WeaponDefs[ud.weapons[1].weaponDef].range\` then
        -- ends at WeaponDefs[0]. Use a direct entry rather than a root
        -- __index metatable — that would make ipairs(WeaponDefs) never
        -- terminate, since every numeric key would resolve to non-nil.
        if WeaponDefs[0] == nil then WeaponDefs[0] = _emptyWeaponDef end
    `, 'def_fallback_metatables');
}

export async function init(
    canvas: OffscreenCanvas | null,
    gameId: string,
    lobbyUrl: string,
    mapData: MapDataTransfer,
    soloWidget?: string,
    /// GW4-c6: when set, the LuaUI runs on the game-processor worker's shared
    /// Babylon GL context (one canvas, one context) instead of a private
    /// OffscreenCanvas. In shared mode init does NOT create its own context
    /// and does NOT start the 33 ms setInterval frame loop — the gp render
    /// loop drives the UI pass after scene.render() (with state save/restore).
    sharedGl?: WebGL2RenderingContext,
): Promise<void> {
    resetVfs();

    const baseUrl = `${lobbyUrl}/api/games/data/${gameId}`;
    initBaseUrl = baseUrl;
    startTime = performance.now() / 1000;

    postLog(2, `[LuaUI] init step 1/8: VFS prefetch starting from ${baseUrl}`);

    // 1. Prefetch VFS
    await prefetchAllGameFiles(baseUrl);
    postLog(2, `[LuaUI] init step 1/8 done: VFS ${vfsFiles.size} files prefetched`);

    // 1a. Register the map's `mapinfo.lua` into the worker VFS. In real Spring
    // the map archive is mounted in the VFS, so `VFS.Include("mapinfo.lua")`
    // resolves to the map's authored table (maphardness, voidwater, gravity,
    // water/atmosphere, …). Our worker only prefetches `/api/games/data` (the
    // game tree), so the map file was absent and `VFS.Include("mapinfo.lua")`
    // returned nil — breaking BAR's `modules/lava.lua` (reads `mapinfo.voidwater`),
    // which cascades to every `Spring.Lava` consumer (cmd_context_build, gui_pip,
    // map_edge_extension2) plus `gui_mapinfo` (`mapinfo.mapHardness`). This is a
    // faithful gap, not a substitute: we serve the map's own authored file, the
    // same source `map-lighting` already fetches for sun/ambient. The map's
    // `mapinfo.lua` ends with a `getfenv()`/`VFS.DirList("mapconfig/mapinfo/")`
    // merge block — the worker provides getfenv/setfenv shims and DirList returns
    // [] when no per-map override configs are registered (the correct no-op).
    // PLAN-bar.md (map-info VFS gap).
    const mapSrcAbs = mapData.mapSourceUrl.startsWith('http')
        ? mapData.mapSourceUrl
        : `${lobbyUrl}${mapData.mapSourceUrl}`;
    try {
        const res = await fetch(`${mapSrcAbs}/mapinfo.lua`);
        if (res.ok) {
            vfsRegister('mapinfo.lua', await res.text());
            postLog(2, '[LuaUI] step 1a: registered map mapinfo.lua into VFS');
        } else {
            postLog(2, `[LuaUI] step 1a: map mapinfo.lua fetch ${res.status} — map widgets degrade`);
        }
    } catch (e) {
        postLog(2, `[LuaUI] step 1a: map mapinfo.lua fetch failed (${String(e)}) — map widgets degrade`);
    }

    // 1b. Fetch game identity from the lobby's /api/games discovery (reads
    // the game's modinfo) so the Spring `Game` table reflects the real game
    // instead of a hardcoded default (PLAN-bar.md A3). Best-effort: on any
    // failure the Game table falls back to gameId.
    let gameMeta: { displayName?: string; shortName?: string; version?: string; description?: string } = {};
    try {
        const resp = await fetch(`${lobbyUrl}/api/games`);
        if (resp.ok) {
            const games = await resp.json();
            if (Array.isArray(games)) {
                const g = games.find((x: any) => x?.id === gameId);
                if (g) gameMeta = g;
            }
        }
    } catch (e) {
        postLog(2, `[LuaUI] /api/games fetch failed (${String(e)}) — Game table falls back to gameId`);
    }

    // 2. Obtain the GL context. GW4-c6 shared mode: reuse the game-processor
    // worker's Babylon context (the LuaUI draws into the same framebuffer as
    // the world, so DrawWorld widgets can depth-test against terrain + units).
    // Legacy mode (no sharedGl): create a private context on the overlay
    // OffscreenCanvas.
    const gl = sharedGl ?? (canvas
        ? canvas.getContext('webgl2', {
            alpha: true,
            premultipliedAlpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
        }) as WebGL2RenderingContext
        : null);

    if (!gl) {
        postLog(4, 'Failed to obtain WebGL2 context for LuaUI');
        postToMain({ type: 'error', msg: 'No WebGL2 context for LuaUI' });
        return;
    }

    postLog(2, `[LuaUI] init step 2/8 done: WebGL2 context ready (${sharedGl ? 'shared/gp' : 'private/overlay'})`);

    // 3. Create Lua runtime and GL bridge
    runtime = new LuaRuntime('LuaUI');

    // Lua 5.1 escape leniency. Recoil ships Lua 5.1, which silently drops the
    // backslash on an unrecognised string escape; Fengari (5.3) rejects the
    // whole chunk, so any game file with a 5.1-ism (lava.lua `\ `, badwords.lua
    // `\s`) fails to load — and every widget that depends on it with it. Wrap
    // the Lua `load`/`loadstring` globals (the path every VFS.Include and widget
    // loadstring compiles through) to sanitise source first, faithfully matching
    // Recoil's lexer (core/lua51-escapes.ts). Installed before the VFS impl and
    // bootstrap so all game-content compilation is covered. Our own doString
    // chunks bypass this (luaL_loadbuffer direct) and are clean regardless.
    runtime.setGlobal('__fixLua51Escapes', (src: unknown) =>
        typeof src === 'string' ? fixLua51Escapes(src) : src);
    runtime.doString(`
        local _realLoad = load
        local _realLoadstring = loadstring
        -- Must forward the EXACT argument count the caller used: Lua's load()
        -- distinguishes "env omitted" (defaults to the global environment)
        -- from "env explicitly nil" (chunk gets NO environment at all). Fixed
        -- named params (chunk, chunkname, mode, env) can't tell those apart —
        -- both collapse to a local env==nil — so a naive passthrough always
        -- forwarded an explicit nil, giving every 3-arg load() a nil _ENV.
        -- This broke 100% of the unsynced gadgetHandler loader's loadfile()
        -- calls (all use the 3-arg form), silently emptying gadgetHandler.gadgets
        -- despite each failure being individually pcall-caught and logged.
        function load(...)
            local n = select('#', ...)
            local chunk, chunkname, mode, env = ...
            if type(chunk) == 'string' then chunk = __fixLua51Escapes(chunk) end
            if n >= 4 then return _realLoad(chunk, chunkname, mode, env) end
            if n == 3 then return _realLoad(chunk, chunkname, mode) end
            if n == 2 then return _realLoad(chunk, chunkname) end
            return _realLoad(chunk)
        end
        if _realLoadstring then
            function loadstring(chunk, chunkname)
                if type(chunk) == 'string' then chunk = __fixLua51Escapes(chunk) end
                return _realLoadstring(chunk, chunkname)
            end
        end
    `, 'lua51_escape_shim');

    bridge = new LuaGLBridge(gl, mapData.mapSourceUrl);
    bridge.setGameBaseUrl(baseUrl);
    // PLAN-weapon-fx Z3 — let shader source `#include "path"` against the
    // worker's VFS so authored ModelMaterials / LuaShaders content can be
    // composed from shared headers. The built-in `engine/csm.glsl`
    // snippet (PLAN-lighting L4) always takes precedence over the VFS
    // lookup; see ENGINE_SNIPPETS in glsl-translator.ts.
    bridge.setShaderIncludeResolver(vfsLookup);
    // Resolve Spring's `'#' .. unitDefID` build-pic syntax to the unit's
    // buildPic filename — chili Image controls in the Core Selector and
    // FactoryBar pass `'#' .. id` as the texture file. Without this, every
    // such image falls back to a magenta 1×1 placeholder (the "pink boxes"
    // a player sees on the commander/engineer panel and factory tiles).
    bridge.setBuildPicResolver((defId) => {
        const d = unitDefMap.get(defId);
        return d?.buildPic ? d.buildPic : null;
    });
    // Terrain-height sampler for gl.DrawGroundCircle (range rings hug the
    // ground). Lazily reads gpCtx.entityRenderer — it's null at bridge-build time
    // and assigned later in the boot sequence — mirroring rtsCam's sampler.
    bridge.setGroundSampler((x, z) => gpCtx.entityRenderer?.getGroundHeight(x, z) ?? 0);
    // gl.GetSun reads the live merged lighting store — the one the map load
    // seeds and Spring.SetSunLighting/SetSunDirection (below) merge into — so
    // widget read-modify-write cycles (ZK gfx_sun_and_atmosphere, BAR
    // map_lighting_adjuster) round-trip the authored values instead of
    // clobbering them with stale defaults (PLAN-playable G1c).
    bridge.setSunLightingReader(() => gpCtx.mapLighting);
    // Feed the map's `atmosphere` table to gl.GetAtmosphere (fog start/end +
    // sky/sun/cloud colours). The bridge starts on the Recoil defaults so reads
    // never return nil; this fire-and-forget load swaps in the per-map values
    // when mapinfo.lua resolves. Re-fetches the file the VFS-register step above
    // already pulled, so it's an HTTP cache hit. PLAN-bar UI-2 (gui_options fog
    // guard crashed on `nil <= nil`).
    const atmoBridge = bridge;
    void loadMapAtmosphere(mapSrcAbs).then((atmo) => atmoBridge.setAtmosphere(atmo));
    // UI-1b (PLAN-bar §7): expose the gl-bridge texture cache on the worker
    // global so the main-thread console can introspect HUD-texture load state:
    //   await window.__gp('__uiTextures.dump()')      — all path-loaded textures
    //   await window.__gp('__uiTextures.dump("metal")') — filter keys by substring
    //   await window.__gp('__uiTextures.magenta()')    — only unresolved placeholders
    // Prereq for the U3 resource-bar magenta root-cause. Mirrors the
    // __entityRenderer / __frameProfiler / __perfToggles hooks in game-processor.
    (globalThis as Record<string, unknown>).__uiTextures = {
        dump: (filter?: string) => bridge?.dumpTextureCache(filter) ?? [],
        magenta: () => (bridge?.dumpTextureCache() ?? []).filter((t) => t.placeholder),
        // U3c: texture refs recorded inside display lists, classified against
        // the cache — `__uiTextures.lists('metal')` shows whether the Top Bar
        // icon CallList replay binds the healed cache handle or an orphan.
        lists: (filter?: string) => bridge?.dumpListTextures(filter) ?? [],
    };
    postLog(2, '[LuaUI] init step 3/8 done: Lua runtime + GL bridge created');

    // 3b. Inject engine-bundled test widgets when solo mode is active.
    // Source + textures live under client/src/lua-test-widgets/ and ship
    // with the client bundle, so they're available regardless of which
    // game is loaded. soloWidget may be a comma-separated list of needles
    // (e.g. "api_chili.lua,dbg_chili_test"); we inject any test widget
    // whose stem appears in the list.
    const soloNeedles = (soloWidget ?? '').split(',').map(s => s.trim());
    const wants = (stem: string) => soloNeedles.some(n => n.includes(stem));
    if (wants('dbg_render_test')) {
        vfsRegister('LuaUI/Widgets/dbg_render_test.lua', dbgRenderTestSrc);
        bridge.addAssetOverride('LuaUI/Images/quit.png', dbgRenderTestQuit);
        bridge.addAssetOverride('LuaUI/Images/tick.png', dbgRenderTestTick);
        bridge.addAssetOverride(
            'LuaUI/Widgets/chili/skins/Carbon/panel_0001.png',
            dbgRenderTestPanel,
        );
        postLog(2, '[LuaUI] Injected engine-bundled dbg_render_test widget + textures');
    }
    if (wants('dbg_chili_test')) {
        vfsRegister('LuaUI/Widgets/dbg_chili_test.lua', dbgChiliTestSrc);
        postLog(2, '[LuaUI] Injected engine-bundled dbg_chili_test widget');
    }
    if (wants('dbg_font_baseline')) {
        vfsRegister('LuaUI/Widgets/dbg_font_baseline.lua', dbgFontBaselineSrc);
        postLog(2, '[LuaUI] Injected engine-bundled dbg_font_baseline widget');
    }
    if (wants('dbg_endgame_trigger')) {
        vfsRegister('LuaUI/Widgets/dbg_endgame_trigger.lua', dbgEndgameTriggerSrc);
        postLog(2, '[LuaUI] Injected engine-bundled dbg_endgame_trigger widget');
    }

    const ctx: SpringAPIContext = {
        mapSizeX: mapData.widthElmos,
        mapSizeZ: mapData.heightElmos,
        heightmap: mapData.heightmap,
        heightmapWidth: mapData.mapx + 1,
        heightmapHeight: mapData.mapy + 1,
        minHeight: mapData.minHeight,
        maxHeight: mapData.maxHeight,
        squareSize: mapData.squareSize,
        vfsFiles,
        gameId,
        modName: gameMeta.displayName,
        modShortName: gameMeta.shortName,
        modVersion: gameMeta.version,
        modDesc: gameMeta.description,
        gameRulesParams: new Map(),
        getGameSeconds: () => (performance.now() / 1000) - startTime,
        giveOrder: (cmdId, unitIds, params, options) => {
            // CommandNotify gate. Spring fires this on the widgetHandler
            // for every player-issued order so widgets like
            // cmd_no_duplicate_orders, cmd_keep_target, cmd_raw_move_issue
            // can rewrite or veto. Returning true from any widget
            // consumes the order. Widget-originated GiveOrder* calls
            // route through here so a widget can intercept another
            // widget's order issuance.
            if (dispatchCommandNotify(cmdId, params, options)) {
                return;
            }
            postToMain({ type: 'giveOrder', cmdId, unitIds, params, options });
        },
        sendLuaRulesMsg: (data) => {
            postToMain({ type: 'sendLuaRulesMsg', data });
        },
        // SendLuaUIMsg goes straight out on the worker's live game socket
        // (gpCtx.connection), like sendViewportUpdate — the server relays it back
        // (filtered by mode) to every eligible client incl. this one, where
        // onLuaUIMsg dispatches widget:RecvLuaMsg.
        sendLuaUIMsg: (data, mode) => {
            gpCtx.connection?.sendLuaUIMsg(data, mode);
        },
        setSelection: (unitIds) => {
            postToMain({ type: 'setSelection', unitIds });
        },
        setCameraTarget: (x, z, smoothness) => {
            postToMain({ type: 'setCameraTarget', x, z, smoothness });
        },
        setCameraState: (state, smoothness) => {
            postToMain({ type: 'setCameraState', state, smoothness });
        },
        // `getCameraPose` stays null: post-GW4 the render camera lives in the
        // game-processor worker (which imports this host, not vice-versa), so
        // wiring a live accessor here would be a circular import for no gain.
        // The fallback path in lua-spring-api reads `ls.camera`, which
        // gpSyncCameraToLiveState() now refreshes from the real render camera
        // every frame after scene.render() (U1) — one-frame-fresh, the same
        // freshness a live pose accessor would give.
        getCameraPose: () => null,
        getUnitDefName: (defId) => unitDefMap.get(defId)?.name,
        getUnitDefSensorRadius: (defId, type) => {
            const d = unitDefMap.get(defId);
            if (!d) return undefined;
            switch (type) {
                case 'los':         return d.losRadius;
                case 'airLos':      return d.airLosRadius;
                case 'radar':       return d.radarRadius;
                case 'sonar':       return d.sonarRadius;
                case 'radarJammer': return d.jammerRadius;
                // Sonar-jam radius isn't on the wire yet; report 0 so
                // widgets that probe it don't crash.
                case 'sonarJammer': return 0;
                case 'seismic':     return d.seismicRadius;
                default:            return undefined;
            }
        },
        getUnitDefRadius: (defId) => unitDefMap.get(defId)?.radius,
        getSelectionBox: () => gpCtx.selection?.getSelectionBoxScreen() ?? null,
        getUnitDefWeaponDefIds: (defId) => unitDefMap.get(defId)?.weaponDefIds,
        getWeaponDefStats: (weaponDefId) => {
            const w = weaponDefMap.get(weaponDefId);
            if (!w) return undefined;
            return {
                range: w.range ?? 0,
                // `reload_time` is serialized as WeaponDef.reload (seconds), which
                // is exactly what Spring.GetUnitWeaponState("reloadTime") returns
                // (weapon->reloadTime * INV_GAME_SPEED).
                reloadTime: w.reloadTime ?? 0,
                projectileSpeed: w.projectileSpeed ?? 0,
                salvoSize: w.salvoSize ?? 1,
                salvoDelay: w.salvoDelay ?? 0,
                accuracy: w.accuracy ?? 0,
                sprayAngle: w.sprayAngle ?? 0,
                targetMoveError: w.targetMoveError ?? 0,
                // `flight_time` (seconds) ≈ projectile ttl; 0 when the def has no
                // fixed lifetime. Faithful enough for the display widgets.
                ttl: w.flightTime ?? 0,
            };
        },
        getUnitDefFootprint: (defId) => {
            const d = unitDefMap.get(defId);
            if (!d) return undefined;
            const flags = d.flags ?? 0;
            // Flag bit 1 = canMove (see buildLuaUnitDef above); a def is
            // mobile if it has movement. Air units (bit 13) are also
            // mobile but never block ground squares — treat them as
            // non-blocking for build tests by reporting isMobile=true so
            // the caller can choose to skip air-unit overlap entirely.
            const canMove = (flags & (1 << 1)) !== 0;
            return {
                xsize: d.xsize ?? 0,
                zsize: d.zsize ?? 0,
                isMobile: canMove,
            };
        },
        setActiveCommand: (cmdId, mods, cmdType) => {
            postToMain({ type: 'setActiveCommand', cmdId, mods, cmdType });
        },
        playSound: (path, volume, pos, channel) => {
            postToMain({
                type: 'playSound',
                path,
                volume,
                spatial: !!pos,
                x: pos?.x ?? 0,
                y: pos?.y ?? 0,
                z: pos?.z ?? 0,
                channel,
            });
        },
        playMusicStream: (file, volume, enqueue) => {
            postToMain({ type: 'playMusicStream', file, volume, enqueue });
        },
        stopMusicStream: (fadeMs) => {
            postToMain({ type: 'stopMusicStream', fadeMs });
        },
        pauseMusicStream: () => {
            postToMain({ type: 'pauseMusicStream' });
        },
        setMusicStreamVolume: (v) => {
            postToMain({ type: 'setMusicStreamVolume', volume: v });
        },
        getMusicStreamTime: () => {
            // The worker can't synchronously read state from the main
            // thread, so this is a best-effort using a cached value
            // pushed from main on every music play / pause. Default to
            // zeroes when no track has played yet.
            return [musicStreamPlayed, musicStreamDuration];
        },
        setSoundEffectParams: (presetOrTable) => {
            postToMain({ type: 'setSoundEffectParams', value: presetOrTable });
        },
        setChannelVolume: (channel, volume) => {
            postToMain({ type: 'setChannelVolume', channel, volume });
        },
        setMasterVolume: (volume) => {
            postToMain({ type: 'setMasterVolume', volume });
        },
        // Spring.GetConfigInt / SetConfigInt store bridge. The worker has
        // no localStorage; config lives in the main-thread ClientSettings
        // store. Reads hit the worker-local storageCache (seeded at init
        // with all springConfig.* keys); writes go through saveToStorage,
        // which posts storage:set to main, where the springConfig.* key is
        // mirrored into ClientSettings so native subscribers fire
        // (PLAN-settings.md §2/§4). The host owns the springConfig. prefix.
        configGet: (key) => loadFromStorage('springConfig.' + key),
        configSet: (key, value) => saveToStorage('springConfig.' + key, value),
        setMinimapGeometry: (x, y, w, h) => {
            // Spring.SetMiniMapGeometry path (action handlers / direct
            // widget calls). gl.ConfigMiniMap reaches the host via the
            // bridge emitter below; both routes converge on the same
            // 'minimapGeometry' message so the main thread has a single
            // application point.
            postToMain({
                type: 'minimapGeometry', x, y, w, h,
                visible: w > 0 && h > 0,
            });
        },
        addMinimapMarker: (x, z) => {
            // Spring.MarkerAddPoint / MarkerAddLine path. The host
            // (lua-widget-manager) translates these into
            // minimap.pushMarkerPing so the cyan event-layer ring pulses
            // at the drop site. Coordinates are world-space elmos.
            postToMain({ type: 'minimapMarker', x, z });
        },
        requestPath: (requestId, sx, sy, sz, ex, ey, ez, moveType, goalRadius) => {
            // Spring.RequestPath path. The main thread forwards to the
            // server via Connection.sendPathRequest; the server's
            // IPathManager replies with a PathResponse routed back to
            // the worker via the 'pathResponse' postMessage above.
            postToMain({
                type: 'pathRequest',
                requestId,
                startX: sx, startY: sy, startZ: sz,
                endX: ex, endY: ey, endZ: ez,
                moveType, goalRadius,
            });
        },
        cancelPathRequest: (requestId) => {
            postToMain({ type: 'pathRequestCancel', requestId });
        },
    };

    // Populate the Game table's map physics/identity fields from the map's
    // mapinfo.lua (registered into the worker VFS at step 1a). Recoil sources
    // these from mapInfo->map/water/atmosphere (LuaConstGame.cpp); we reuse the
    // same VFS.Include parse path. BAR's gui_gameinfo / gui_top_bar read
    // Game.{mapHardness,gravity,tidal,windMin,windMax,waterDamage,mapName,
    // mapDescription} — nil there threw. See PLAN-bar.md A12 residual.
    const mapInfoSrc = vfsFiles.get('mapinfo.lua');
    if (mapInfoSrc) {
        const mi = parseMapInfoFields(mapInfoSrc, ctx);
        if (mi) {
            ctx.mapName = mi.mapName;
            ctx.mapHumanName = mi.mapHumanName;
            ctx.mapDescription = mi.mapDescription;
            ctx.mapHardness = mi.mapHardness;
            ctx.gravity = mi.gravity;
            ctx.tidal = mi.tidal;
            ctx.extractorRadius = mi.extractorRadius;
            ctx.waterDamage = mi.waterDamage;
            ctx.windMin = mi.windMin;
            ctx.windMax = mi.windMax;
            postLog(2, `[LuaUI] Game map fields from mapinfo.lua: ${mi.mapName} ` +
                `hardness=${mi.mapHardness} gravity=${mi.gravity} tidal=${mi.tidal} ` +
                `wind=${mi.windMin}-${mi.windMax}`);
        } else {
            postLog(2, '[LuaUI] mapinfo.lua parse for Game map fields failed — Game.* map fields use defaults');
        }
    }

    // gl.ConfigMiniMap / gl.DrawMiniMapEvents → main thread. The Lua-side
    // API stores the rect in liveState.minimapGeometry; we mirror that
    // here so direct bridge calls (no Spring.* wrapper) keep the API
    // consistent.
    bridge.setMinimapEmitter((cmd) => {
        if (cmd.kind === 'geometry') {
            const visible = cmd.w > 0 && cmd.h > 0;
            liveState.minimapGeometry = {
                x: cmd.x, y: cmd.y, width: cmd.w, height: cmd.h, visible,
            };
            postToMain({
                type: 'minimapGeometry',
                x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h,
                visible,
            });
        } else if (cmd.kind === 'events') {
            postToMain({ type: 'minimapEvents' });
        }
        // 'draw' has no payload — the native minimap renders continuously
        // and doesn't need a per-frame draw signal. Logged here for the
        // record but no message goes out.
    });

    // 4. Install engine globals
    installEngineGlobals(runtime, bridge, ctx, gameId);

    // Expose texture search path configuration to Lua
    runtime.setGlobal('_addTextureSearchPath', (path: LuaValue) => {
        bridge!.addTextureSearchPaths(String(path));
    });

    // PLAN.md Stage B1 (faithful projectile lights). The Lua-side collector
    // (_SpringWebCollectDeferredLights, run once per frame from runFrame)
    // gathers the lights ZK's gfx_projectile_lights.lua / gfx_unit_lights.lua
    // produce, flattens them into two fixed-stride comma strings, and calls
    // this hook. We feed them straight into the in-worker forward FxLightPool
    // (the sanctioned GL4-deferred -> WebGL2-forward substitution, now driven
    // by the game's authored light_* data).
    //
    // Stage-0 regression fix (2026-06-04): the render core + FxLightPool moved
    // into this worker in GW4, but this hook still posted the lights OUT to a
    // main-thread `onDeferredLights` sink that GW4 left unassigned — so ZK's
    // authored projectile lights never reached the worker pool, and the pool
    // ran entirely on the invented muzzle/follow stand-ins. Feed the worker
    // pool directly here (no dead round-trip) and flip the renderer's
    // authored-lights guard on the first authored frame so its invented
    // emitters suppress. Logic ported 1:1 from the old main.ts sink
    // (commit a3546c61b2).
    //
    // String marshalling is used deliberately: Lua tables cross to JS
    // callbacks as lazy LuaTable objects, fragile for a per-frame
    // variable-length list; a flat numeric string converts cleanly. Point
    // stride 7: px,py,pz, r,g,b (colMult pre-applied), radius. Beam stride 10:
    // + dx,dy,dz (start->end delta). Empty strings cost nothing.
    runtime.setGlobal('_SpringWebEmitDeferredLights',
        (pointStr: LuaValue, beamStr: LuaValue) => {
            const pool = gpCtx.fxLightPool;
            if (!pool) return;
            const point = parseDeferredLights(String(pointStr ?? ''), 7);
            const beam = parseDeferredLights(String(beamStr ?? ''), 10);
            if (!gpAuthoredLightsActive && (point.length > 0 || beam.length > 0)) {
                gpAuthoredLightsActive = true;
                gpCtx.projectileRenderer?.setAuthoredLightsActive(true);
            }
            // Short TTL: the collectors re-post every frame, so each light only
            // needs to live until the next frame's refresh.
            const TTL = 0.05;
            for (const r of point) {
                // [px,py,pz, r,g,b, radius]
                const peak = Math.max(r[3], r[4], r[5], 0.0001);
                const inv = 1 / peak;
                pool.emit(r[0], r[1], r[2],
                    [r[3] * inv, r[4] * inv, r[5] * inv],
                    peak, Math.max(40, r[6]), TTL);
            }
            for (const r of beam) {
                // [px,py,pz, r,g,b, radius, dx,dy,dz]
                const peak = Math.max(r[3], r[4], r[5], 0.0001);
                const inv = 1 / peak;
                const col: [number, number, number] =
                    [r[3] * inv, r[4] * inv, r[5] * inv];
                const range = Math.max(40, r[6]);
                // Approximate ZK's GL4 segment light with 3 forward point
                // lights along the beam (start, mid, end).
                for (let t = 0; t <= 2; t++) {
                    const f = t / 2;
                    pool.emit(r[0] + r[7] * f, r[1] + r[8] * f, r[2] + r[9] * f,
                        col, peak, range, TTL);
                }
            }
        });
    postLog(2, '[LuaUI] init step 4/8 done: engine globals installed');

    // 5. Install VFS callbacks
    installVFS(runtime);
    postLog(2, '[LuaUI] init step 5/8 done: VFS callbacks installed');

    // 6. Install error tracking — convert each arg to string before concat
    // so widgets that pass tables/numbers/userdata to Echo or Log don't
    // crash inside our wrapper. Without tostring(), a single table.concat
    // failure here propagates back up the widget's call stack and kills
    // its Initialize, leaving partial UI state behind.
    runtime.doString(`
        _widgetErrors = {}
        local function _safeJoin(...)
            local n = select("#", ...)
            local parts = {}
            for i = 1, n do
                parts[i] = tostring((select(i, ...)))
            end
            return table.concat(parts, "\\t")
        end
        local function _capture(msg)
            if msg:find("Failed to load")
                or msg:find("Error in Initialize")
                or msg:find("Removed widget")
                or msg:find("Error in Update")
                or msg:find("Error in Draw") then
                _widgetErrors[#_widgetErrors+1] = msg
            end
        end
        local origEcho = Spring.Echo
        Spring.Echo = function(...)
            _capture(_safeJoin(...))
            return origEcho(...)
        end
        local origLog = Spring.Log
        Spring.Log = function(section, level, ...)
            _capture(_safeJoin(...))
            return origLog(section, level, ...)
        end
    `, 'error_tracker');
    postLog(2, '[LuaUI] init step 6/8 done: error tracker installed');

    // 6b. Pre-install shutdown recursion guard as a delayed hook.
    // cawidgets.lua defines widgetHandler.Shutdown. We wrap it the
    // first time it's referenced (via metatable) so repeated calls
    // become no-ops. This has to be set up BEFORE camain.lua runs,
    // because widget load errors can cascade into widgetHandler
    // methods.
    runtime.doString(`
        local _shuttingDown = false
        _widgetHandler_shutdown_wrap = function(wh)
            if not wh or type(wh.Shutdown) ~= 'function' then return end
            if wh.__shutdownWrapped then return end
            wh.__shutdownWrapped = true
            local orig = wh.Shutdown
            wh.Shutdown = function(self, ...)
                if _shuttingDown then
                    Spring.Echo("[LuaUI] widgetHandler:Shutdown re-entry blocked")
                    return
                end
                _shuttingDown = true
                local ok, err = pcall(orig, self, ...)
                if not ok then
                    Spring.Echo("[LuaUI] widgetHandler:Shutdown errored: " .. tostring(err))
                end
            end
        end
    `, 'shutdown_guard_pre');
    // Pre-install a nil-safe math.round. ZK's numberfunctions.lua defines
    // one but it crashes on nil input, which happens during epicmenu's
    // include chain — this version falls back to 0 for nil. BAR ships no
    // numberfunctions.lua of its own, so BAR widgets get this baseline
    // permanently (ZK's own file still overrides it once loaded, exactly
    // as in real Spring). It must therefore match Recoil's engine-native
    // math.round (rts/Lua/LuaMathExtra.cpp — arithmetic round-half-up to
    // `idp` decimals via lua_pushnumber), NOT ZK's own Lua-authored version
    // (`("%.Nf"):format(num)`, which returns a STRING). A previous version
    // of this shim copied ZK's string-returning body verbatim, so every
    // BAR call to math.round silently returned a string — crashing
    // gui_info.lua's `math.min(speed, mathRoundResult)` with "attempt to
    // compare string with number" (Lua's relational operators, unlike its
    // arithmetic ones, never coerce strings; PLAN-bar.md U5).
    // Also install math.bit_inv — Spring engine adds it as part of its
    // bitops surface; ZK widgets call it at file scope.
    runtime.doString(`
        function math.round(num, idp)
            num = num or 0
            idp = idp or 0
            local mult = 10 ^ idp
            local xinteg = math.floor(num)
            local xfract = num - xinteg
            return xinteg + math.floor(xfract * mult + 0.5) / mult
        end
        if not math.bit_inv then
            math.bit_inv = function(x)
                if bit32 and bit32.bnot then return bit32.bnot(x or 0) end
                return -1 - (x or 0)
            end
        end
        -- Spring/ZK adds math.bit_or/and/xor on top of Lua 5.1. LUPS
        -- distortionFBO.lua calls math.bit_or at file scope; without
        -- this shim the whole class file fails to load and every
        -- distortion-dependent particle class (Jet, AirJet,
        -- JitterParticles*, ShieldJitter, ShockWave, SphereDistortion,
        -- UnitJitter) gets rejected as "hardware unsupported".
        if not math.bit_or then
            math.bit_or = function(a, b)
                if bit32 and bit32.bor then return bit32.bor(a or 0, b or 0) end
                return (a or 0) | (b or 0)
            end
        end
        if not math.bit_and then
            math.bit_and = function(a, b)
                if bit32 and bit32.band then return bit32.band(a or 0, b or 0) end
                return (a or 0) & (b or 0)
            end
        end
        if not math.bit_xor then
            math.bit_xor = function(a, b)
                if bit32 and bit32.bxor then return bit32.bxor(a or 0, b or 0) end
                return (a or 0) ~ (b or 0)
            end
        end
    `, 'math_round_fix');
    postLog(2, '[LuaUI] init step 6b/8 done: pre-guard installed');

    // 7. Bootstrap
    // Clear any cached widget order files so Chili always loads with
    // defaults (previous sessions may have saved a "disabled" state).
    // Also patch the DebugHandler source in VFS to raise the error
    // tolerance — Chili's DebugHandler self-destructs after 5 errors
    // in 5 seconds, but our incomplete GL/API surface triggers more
    // harmless errors during init than native Spring.
    runtime.doString(`
        if VFS and VFS._writeCache then
            VFS._writeCache["LuaUI/Config/ZK_order.lua"] = nil
            VFS._writeCache["LuaUI/Config/widget_data.lua"] = nil
        end
    `, 'clear_widget_config');

    // Patch debughandler.lua in VFS before bootstrap loads it
    const debugHandlerPath = 'LuaUI/Widgets/chili_old/Handlers/debughandler.lua';
    const debugHandlerSrc = vfsLookup(debugHandlerPath);
    if (debugHandlerSrc) {
        const patched = debugHandlerSrc.replace(
            'DebugHandler.maxChiliErrors = 5',
            'DebugHandler.maxChiliErrors = 9999',
        );
        if (patched !== debugHandlerSrc) {
            vfsRegister(debugHandlerPath, patched);
            postLog(2, '[LuaUI] Patched DebugHandler: maxChiliErrors = 9999');
        }
    }

    // Patch cawidgets.lua HandleError to not remove handler widgets (like
    // Chili Framework). Our incomplete API surface causes harmless callin
    // errors that the real Spring engine doesn't hit. Without this, Chili
    // is removed after a single callin error.
    const cawidgetsPath = 'LuaUI/cawidgets.lua';
    const cawidgetsSrc = vfsLookup(cawidgetsPath);
    if (cawidgetsSrc) {
        let patched = cawidgetsSrc.replace(
            `if (funcName ~= 'Shutdown') then\n\t\twidgetHandler:RemoveWidget(widget)`,
            `if (funcName ~= 'Shutdown') then\n\t\tif widget.whInfo and widget.whInfo.handler then\n\t\t\tSpring.Log("LuaUI", 0, "Suppressed removal of handler widget: " .. (widget.whInfo.name or "?") .. " error in " .. funcName)\n\t\telse\n\t\t\twidgetHandler:RemoveWidget(widget)\n\t\tend`,
        );
        if (patched !== cawidgetsSrc) {
            postLog(2, '[LuaUI] Patched cawidgets.lua: handler widgets survive callin errors');
        } else {
            postLog(3, '[LuaUI] cawidgets.lua HandleError patch did not match');
        }

        // Pre-populate WG.Translate as a passthrough fallback right after
        // `WG = {}` is set in cawidgets.lua, AND restore Spring.Utilities
        // helpers right after `Spring.Utilities = {}` clears the table.
        // ZK's api_i18n.lua / unitDefReplacements.lua replace these with
        // real implementations once they load, but many widgets call them
        // at file scope (top-level locals like
        //   local labels = { ..., WG.Translate("foo","bar") }
        //   local human = Spring.Utilities.GetHumanName(ud)
        // ) which runs *before* the providing widget loads. Without a
        // fallback those widgets crash at load and never register.
        const wgInitMarker = `WG = {}\nSpring.Utilities = {}`;
        const wgInitInjection = `WG = {}
WG.Translate = function(_ns, key, ...) return tostring(key or "") end
WG.initializeTranslation = function(_, _) return function(key) return tostring(key or "") end end
WG.langChanged = function() end
WG.GetLang = function() return "en" end
WG.SetLang = function() end
-- PLAN.md Stage B1 (faithful projectile lights). ZK's GL4 deferred-light
-- provider gfx_deferred_rendering.lua can't run on our 2D-overlay worker
-- (it samples the depth buffer and self-removes when AllowDeferredMapRendering
-- ~= 1, which is our case). Substitute its public registry HERE, before any
-- widget Initialize runs, so consumers (gfx_projectile_lights.lua,
-- gfx_unit_lights.lua) register collectors instead of self-removing with
-- "Deferred rendering widget not found", and instead append their collectors
-- to _G.__deferredLightCollectors.
--
-- B1 STATUS: fully wired and verified in-browser (2026-06-01). The consumer
-- side (per-frame collect -> marshal the light list to the main thread -> feed
-- the forward FxLightPool, the sanctioned GL4-deferred -> WebGL2-forward
-- substitution fed by authored light_* data, then retire FxLightPool's invented
-- muzzle/follow emitters) runs each frame in the DrawScreen collect loop below.
-- Two non-obvious fixes were needed for the chain to actually light projectiles:
-- (1) VFS.FileExists became mode-aware so ZK's fromZip security gate lets
-- gfx_projectile_lights receive SpringRestricted (see VFS.FileExists), and
-- (2) Spring.GetVisibleProjectiles returns a Lua table, not a JS array.
-- See memory project_faithful_proj_lights_progress.
_G.__deferredLightCollectors = _G.__deferredLightCollectors or {}
WG.DeferredLighting_RegisterFunction = function(func)
	if type(func) == "function" then
		local c = _G.__deferredLightCollectors
		c[#c + 1] = func
	end
end
Spring.Utilities = {}
Spring.Utilities.GetHumanName = function(ud, _unitID)
    if type(ud) == "table" then return ud.humanName or ud.name or "" end
    return ""
end
Spring.Utilities.GetUnitCost = function(_, ud)
    if type(ud) == "table" then return (ud.metalCost or 0) end
    return 0
end
Spring.Utilities.bit_inv = function(x)
    return bit32 and bit32.bnot(x) or 0
end
Spring.Utilities.json = { encode = function() return "{}" end, decode = function() return {} end }
Spring.Utilities.TableToString = function(t) return tostring(t) end`;
        if (patched.indexOf(wgInitMarker) !== -1) {
            patched = patched.replace(wgInitMarker, wgInitInjection);
            postLog(2, '[LuaUI] Patched cawidgets.lua: WG.Translate + Spring.Utilities fallbacks installed');
        } else {
            postLog(3, '[LuaUI] cawidgets.lua WG/Spring.Utilities anchor not found');
        }

        // Wrap widget:SetConfigData() in pcall. cawidgets calls it inline
        // during LoadWidget without any error guard; if the widget's
        // SetConfigData throws (e.g. gui_epicmenu's references langByFlag,
        // which is nil when its top-level VFS.Include for languages.lua
        // failed under our incomplete API surface) the exception
        // propagates up and aborts the ENTIRE widget scan loop. That kills
        // every widget that would have been scanned after the bad one —
        // including api_chili.lua — leaving the Framework unloaded.
        const setConfigMarker = `if (widget.SetConfigData and config) then
\t\twidget:SetConfigData(config)
\tend`;
        const setConfigGuard = `if (widget.SetConfigData and config) then
\t\tlocal _scOk, _scErr = pcall(widget.SetConfigData, widget, config)
\t\tif not _scOk then
\t\t\tSpring.Log(HANDLER_BASENAME, LOG.ERROR, "Failed to SetConfigData for " .. tostring(name) .. ": " .. tostring(_scErr))
\t\tend
\tend`;
        if (patched.indexOf(setConfigMarker) !== -1) {
            patched = patched.replace(setConfigMarker, setConfigGuard);
            postLog(2, '[LuaUI] Patched cawidgets.lua: SetConfigData wrapped in pcall');
        } else {
            postLog(3, '[LuaUI] cawidgets.lua SetConfigData anchor not found');
        }

        // Solo-widget mode: filter widgetFiles down to just the matching
        // widgets so we can isolate gl-bridge / Chili pipeline issues.
        // Accepts comma-separated needles ("api_chili.lua,dbg_chili_test").
        if (soloWidget) {
            const needles = soloWidget
                .split(',')
                .map(s => s.replace(/[\\'"`]/g, '').trim())
                .filter(s => s.length > 0);
            const luaList = needles.map(n => `"${n}"`).join(', ');
            const marker = `local widgetFiles = VFS.DirList(WIDGET_DIRNAME, "*.lua", VFSMODE)`;
            const filterBlock = `${marker}\n\tdo\n\t\tlocal _needles = { ${luaList} }\n\t\tlocal _filtered = {}\n\t\tfor _, _f in ipairs(widgetFiles) do\n\t\t\tlocal _s = tostring(_f)\n\t\t\tfor _, _n in ipairs(_needles) do\n\t\t\t\tif _s:find(_n, 1, true) then\n\t\t\t\t\t_filtered[#_filtered+1] = _f\n\t\t\t\t\tbreak\n\t\t\t\tend\n\t\t\tend\n\t\tend\n\t\twidgetFiles = _filtered\n\t\tSpring.Echo("[LuaUI] Solo widget mode: filtered to " .. #widgetFiles .. " widget(s)")\n\tend`;
            const beforeFilter = patched;
            patched = patched.replace(marker, filterBlock);
            if (patched !== beforeFilter) {
                postLog(2, `[LuaUI] Patched cawidgets.lua: solo widget filter [${needles.join(', ')}]`);
            } else {
                postLog(3, '[LuaUI] cawidgets.lua solo widget filter — anchor not found');
            }
        }

        // Guard against Spring.GetPlayerInfo returning fewer than 10 values
        // during bootstrap (live state hasn't arrived yet for the local
        // player). Without this guard `customkeys["ignored"]` errors and
        // aborts the entire widget scan, so no widgets activate at all.
        const customkeysAnchor = 'local customkeys = select(10, Spring.GetPlayerInfo(Spring.GetMyPlayerID(), true))';
        const customkeysReplacement = customkeysAnchor + '\n\tcustomkeys = customkeys or {}';
        if (patched.includes(customkeysAnchor) && !patched.includes(customkeysReplacement)) {
            patched = patched.replace(customkeysAnchor, customkeysReplacement);
            postLog(2, '[LuaUI] Patched cawidgets.lua: nil-safe customkeys guard');
        }

        if (patched !== cawidgetsSrc) {
            vfsRegister(cawidgetsPath, patched);
        }
    }

    // Patch barwidgets.lua (BAR's widget handler) widgetFailure() to embed the
    // failing widget's name in the error line. BAR echoes the error as
    //   "Error in Initialize(): <err>"
    // with the widget name only on a SEPARATE following line
    //   "Removed widget: <name>"
    // (barwidgets.lua:763-764). So a generic runtime error like
    // "attempt to index a nil value" is byte-identical across every crashing
    // widget, and the worker console's message de-dup collapses them all into
    // one un-attributed entry — you can't tell WHICH widget failed. Splicing
    // the name into the error line itself makes each line unique (defeats the
    // collapse) and self-attributing. Diagnostic only: the RemoveWidget
    // behaviour below is untouched. Mirrors the cawidgets.lua (ZK) name
    // logging above. General mechanism, BAR-only path (ZK uses cawidgets).
    // (PLAN-bar.md §7 UI-2 — un-attributed Initialize/ViewResize crashes.)
    const barwidgetsPath = 'LuaUI/barwidgets.lua';
    const barwidgetsSrc = vfsLookup(barwidgetsPath);
    if (barwidgetsSrc) {
        const anchor = `Spring.Echo(errorBase .. ' in ' .. funcName .. '(): ' .. tostring(errorMsg))`;
        const replacement = `Spring.Echo(errorBase .. ' in ' .. funcName .. '() [' .. tostring(name) .. ']: ' .. tostring(errorMsg))`;
        if (barwidgetsSrc.indexOf(anchor) !== -1) {
            vfsRegister(barwidgetsPath, barwidgetsSrc.replace(anchor, replacement));
            postLog(2, '[LuaUI] Patched barwidgets.lua: widgetFailure error line names the widget');
        } else {
            postLog(3, '[LuaUI] barwidgets.lua widgetFailure anchor not found');
        }
    }

    // Patch api_i18n.lua: when ZK's translator can't find a key, fall
    // back to returning the key itself instead of nil. Many widgets call
    // \`WG.Translate("foo", "bar") .. ":"\` at file scope and crash on
    // \`attempt to concatenate a nil value\` if the locale lookup misses.
    // Without locale data files (we don't ship them), basically every
    // call misses. Returning the key keeps file-scope concatenation safe.
    const i18nPath = 'LuaUI/Widgets/api_i18n.lua';
    const i18nSrc = vfsLookup(i18nPath);
    if (i18nSrc) {
        const oldTranslate = `local function Translate (db, text, data, opts)\n\treturn translations[db].i18n(text, data, opts)\nend`;
        // i18nlib's i18n is a TABLE with __call metamethod, not a plain function.
        // Accept both via pcall — the type check would reject the callable table.
        const newTranslate = `local function Translate (db, text, data, opts)\n\tlocal t = translations[db]\n\tif type(t) ~= "table" or t.i18n == nil then return tostring(text or "") end\n\tlocal ok, result = pcall(t.i18n, text, data, opts)\n\tif not ok or result == nil then return tostring(text or "") end\n\treturn result\nend`;
        if (i18nSrc.indexOf(oldTranslate) !== -1) {
            vfsRegister(i18nPath, i18nSrc.replace(oldTranslate, newTranslate));
            postLog(2, '[LuaUI] Patched api_i18n.lua: Translate falls back to key on miss');
        } else {
            postLog(3, '[LuaUI] api_i18n.lua Translate anchor not found');
        }
    }

    // Chili display-list caching is now LEFT ENABLED (faithful — real Spring
    // runs Chili with dlists). PLAN-perf N1 measured Chili DrawScreen at
    // 92 ms/frame precisely because a previous patch here disabled all three
    // caches (_all_dlist / _own_dlist / _children_dlist), forcing the entire
    // control tree to redraw live through the Fengari gl bridge every frame.
    // The two record-time bugs that motivated disabling them are fixed at the
    // bridge instead of by crippling the cache (PLAN-perf N2):
    //   1. The "wrong matrix context" blamed on _all_dlist was really the gl
    //      bridge not recording gl.Scissor into display lists, so cached child
    //      draws lost their client-area clipping (safeOpengl = true is the
    //      Control default). lua-gl-immediate now records + replays scissor
    //      ops; matrix ops were already recorded relative and replay correctly.
    //   2. Stale 1×1 skin UVs baked before async skin textures resolved are
    //      healed by the texture-generation-driven dlist invalidation in the
    //      per-frame chiliFix pass below (replacing the old one-shot 3 s
    //      rebuild) — it re-records whenever a skin texture actually arrives.
    // No control.lua edit needed: the shipped source keeps useDList = true.

    // Patch chili_old/Headers/links.lua: teach UnlinkSafe / CheckWeakLink
    // about our table-based newproxy polyfill. fengari does not implement
    // newproxy natively; the worker installs a polyfill that returns a
    // plain table with a `{ __isProxy = true }` metatable. chili then
    // overlays its own `_islink`/`_obj`/`__call` on that metatable, but
    // chili's UnlinkSafe loops `while type(link) == "userdata"` — which
    // is false for our table proxy, so the loop never unwraps. The visible
    // symptom is that screen.activeControl never compares equal to the
    // raw control returned by Object.IsAbove during MouseUp's
    // `CompareLinks(hovered, active)` check, so MouseClick (which fires
    // OnClick) silently never runs. That's the actual root cause of
    // PLAN-chili-menu-visibility Bug A.
    //
    // Fix: extend the loop to also unwrap a *table* whose metatable
    // carries the `_islink` flag chili sets on weak/hard links. We don't
    // unwrap arbitrary tables — only the chili-tagged ones — so this is
    // safe even if a widget passes a real Lua table to the chili
    // mouse-event chain.
    const linksPath = 'LuaUI/Widgets/chili_old/Headers/links.lua';
    const linksSrc = vfsLookup(linksPath);
    if (linksSrc) {
        const oldUnlink =
            'function UnlinkSafe(link)\n' +
            '\tlocal link = link\n' +
            '\twhile (type(link) == "userdata") do\n' +
            '\t\tlink = link()\n' +
            '\tend\n' +
            '\treturn link\n' +
            'end';
        const newUnlink =
            'function UnlinkSafe(link)\n' +
            '\tlocal link = link\n' +
            '\twhile type(link) == "userdata"\n' +
            '\t\tor (type(link) == "table"\n' +
            '\t\t\tand getmetatable(link)\n' +
            '\t\t\tand getmetatable(link)._islink) do\n' +
            '\t\tlink = link()\n' +
            '\tend\n' +
            '\treturn link\n' +
            'end';
        const oldCheck =
            'function CheckWeakLink(link)\n' +
            '  return (type(link) == "userdata") and link()\n' +
            'end';
        const newCheck =
            'function CheckWeakLink(link)\n' +
            '  if type(link) == "userdata" then return link() end\n' +
            '  if type(link) == "table" then\n' +
            '    local mt = getmetatable(link)\n' +
            '    if mt and mt._islink then return link() end\n' +
            '  end\n' +
            '  return false\n' +
            'end';
        let patched = linksSrc;
        if (patched.includes(oldUnlink)) patched = patched.replace(oldUnlink, newUnlink);
        if (patched.includes(oldCheck)) patched = patched.replace(oldCheck, newCheck);
        if (patched !== linksSrc) {
            vfsRegister(linksPath, patched);
            postLog(2, '[LuaUI] Patched links.lua: UnlinkSafe accepts table proxies');
        } else {
            postLog(3, '[LuaUI] links.lua patch — anchors not found');
        }
    }

    // Patch LuaShader.lua: silence ShowError on Delete/Finalize when the
    // shader never compiled. GL4 widgets like CAS routinely fail to compile
    // on our WebGL2 bridge, then the widget cleanup calls casShader:Finalize()
    // and LuaShader logs "Attempt to use invalid shader object in [Finalize]".
    // The cleanup is a no-op when shaderObj is nil, so the warning is just
    // noise. Patching the include preserves the strict behaviour of Activate /
    // SetUniform (which still warn) so genuinely-buggy widgets are still
    // surfaced.
    const luaShaderPaths = [
        'LuaUI/Widgets/Include/LuaShader.lua',
        'LuaRules/Gadgets/Include/LuaShader.lua',
    ];
    for (const luaShaderPath of luaShaderPaths) {
        const luaShaderSrc = vfsLookup(luaShaderPath);
        if (!luaShaderSrc) continue;
        const oldDelete =
            'function LuaShader:Delete()\n' +
            '\tif self.shaderObj ~= nil then\n' +
            '\t\tgl.DeleteShader(self.shaderObj)\n' +
            '\telse\n' +
            '\t\tlocal funcName = (debug and debug.getinfo(1).name) or "UnknownFunction"\n' +
            '\t\tself:ShowError(string.format("Attempt to use invalid shader object in [%s](). Did you call :Compile() or :Initialize()", funcName))\n' +
            '\tend\n' +
            'end';
        const newDelete =
            'function LuaShader:Delete()\n' +
            '\tif self.shaderObj ~= nil then\n' +
            '\t\tgl.DeleteShader(self.shaderObj)\n' +
            '\t\tself.shaderObj = nil\n' +
            '\tend\n' +
            'end';
        if (luaShaderSrc.includes(oldDelete)) {
            vfsRegister(luaShaderPath, luaShaderSrc.replace(oldDelete, newDelete));
            postLog(2, `[LuaUI] Patched ${luaShaderPath}: Delete is a no-op when never compiled`);
        }
    }

    // Patch object.lua: wrap Object:CallChildrenInverse with pcall so a
    // single buggy child Draw doesn't break iteration over its siblings.
    // Chili's original code calls `child[eventname](child, ...)` raw — if
    // one child errors mid-frame, every sibling that comes after it in
    // the inverse iteration is silently skipped. In ZK that means one
    // broken Label inside EconomyPanelDefaultTwo hides ProChat, Player
    // List, and nubtron entirely. The pcall wrap preserves the early-
    // return-on-truthy semantics (used by mouse / hit-test events) while
    // making errors non-fatal.
    const objectPath = 'LuaUI/Widgets/chili_old/Controls/object.lua';
    const objectSrc = vfsLookup(objectPath);
    if (objectSrc) {
        const oldCCI =
            'function Object:CallChildrenInverse(eventname, ...)\n' +
            '  local children = self.children\n' +
            '  for i=#children,1,-1 do\n' +
            '    local child = children[i]\n' +
            '    if (child) then\n' +
            '      local obj = child[eventname](child, ...)\n' +
            '      if (obj) then\n' +
            '        return obj\n' +
            '      end\n' +
            '    end\n' +
            '  end\n' +
            'end';
        const newCCI =
            'function Object:CallChildrenInverse(eventname, ...)\n' +
            '  local children = self.children\n' +
            '  for i=#children,1,-1 do\n' +
            '    local child = children[i]\n' +
            '    if (child) then\n' +
            '      local mst = (eventname == "Draw" and gl._saveMatrixState) and gl._saveMatrixState() or nil\n' +
            '      local ok, obj = pcall(child[eventname], child, ...)\n' +
            '      if mst and gl._restoreMatrixState then\n' +
            '        gl._restoreMatrixState(mst)\n' +
            '      end\n' +
            '      if ok and obj then\n' +
            '        return obj\n' +
            '      end\n' +
            '    end\n' +
            '  end\n' +
            'end';
        const oldCC =
            'function Object:CallChildren(eventname, ...)\n' +
            '  local children = self.children\n' +
            '  for i=1,#children do\n' +
            '    local child = children[i]\n' +
            '    if (child) then\n' +
            '      local obj = child[eventname](child, ...)\n' +
            '      if (obj) then\n' +
            '        return obj\n' +
            '      end\n' +
            '    end\n' +
            '  end\n' +
            'end';
        const newCC =
            'function Object:CallChildren(eventname, ...)\n' +
            '  local children = self.children\n' +
            '  for i=1,#children do\n' +
            '    local child = children[i]\n' +
            '    if (child) then\n' +
            '      local mst = (eventname == "Draw" and gl._saveMatrixState) and gl._saveMatrixState() or nil\n' +
            '      local ok, obj = pcall(child[eventname], child, ...)\n' +
            '      if mst and gl._restoreMatrixState then\n' +
            '        gl._restoreMatrixState(mst)\n' +
            '      end\n' +
            '      if ok and obj then\n' +
            '        return obj\n' +
            '      end\n' +
            '    end\n' +
            '  end\n' +
            'end';
        let patched = objectSrc;
        if (patched.includes(oldCCI)) patched = patched.replace(oldCCI, newCCI);
        if (patched.includes(oldCC)) patched = patched.replace(oldCC, newCC);
        if (patched !== objectSrc) {
            vfsRegister(objectPath, patched);
            postLog(2, '[LuaUI] Patched object.lua: CallChildren(Inverse) pcall children');
        } else {
            postLog(3, '[LuaUI] object.lua CallChildren patch — anchors not found');
        }
    }

    // Patch api_chili.lua: a previous widget's DrawScreen can leave the
    // scissor test enabled at an arbitrary box. When chili's screen0:Draw
    // then renders, every window whose geometry falls outside that box is
    // silently clipped out — only windows positioned at chili-y=0 happen
    // to overlap a typical leftover box at the canvas top. Resetting
    // scissor at the entry point of chili's draw chain ensures windows are
    // clipped only by chili's own PushScissor stack.
    const apiChiliPath = 'LuaUI/Widgets/api_chili.lua';
    const apiChiliSrc = vfsLookup(apiChiliPath);
    if (apiChiliSrc) {
        const drawAnchor =
            'function widget:DrawScreen()\n' +
            '\tif (not screen0:IsEmpty()) then\n' +
            '\t\tgl.PushMatrix()\n';
        const drawReplacement =
            'function widget:DrawScreen()\n' +
            '\tif (not screen0:IsEmpty()) then\n' +
            '\t\tgl.Scissor(false)\n' +
            '\t\tgl.PushMatrix()\n';
        const tweakAnchor =
            'function widget:TweakDrawScreen()\n' +
            '\tif (not screen0:IsEmpty()) then\n' +
            '\t\tgl.PushMatrix()\n';
        const tweakReplacement =
            'function widget:TweakDrawScreen()\n' +
            '\tif (not screen0:IsEmpty()) then\n' +
            '\t\tgl.Scissor(false)\n' +
            '\t\tgl.PushMatrix()\n';
        let patched = apiChiliSrc;
        if (patched.includes(drawAnchor)) patched = patched.replace(drawAnchor, drawReplacement);
        if (patched.includes(tweakAnchor)) patched = patched.replace(tweakAnchor, tweakReplacement);
        if (patched !== apiChiliSrc) {
            vfsRegister(apiChiliPath, patched);
            postLog(2, '[LuaUI] Patched api_chili.lua: reset scissor before screen0:Draw');
        } else {
            postLog(3, '[LuaUI] api_chili.lua scissor reset patch — anchors not found');
        }
    }

    // Patch gui_chili_facbar.lua / gui_chili_facpanel.lua: hide the empty
    // 600×200 "Factories" floating window when the player has no factories
    // and isn't in tweak mode. Without this the widget mounts a giant
    // dark-teal Evolved skin tile pattern over the screen at startup.
    // Tweak-mode visibility is preserved so the user can still position it.
    for (const facWidgetPath of [
        'LuaUI/Widgets/gui_chili_facbar.lua',
        'LuaUI/Widgets/gui_chili_facpanel.lua',
    ]) {
        const src = vfsLookup(facWidgetPath);
        if (!src) continue;
        const anchor = 'RecreateFacbar = function()\n\tenteredTweak = false\n\tif inTweak then return end';
        const replacement = 'RecreateFacbar = function()\n\tenteredTweak = false\n\tif window_facbar and window_facbar.SetVisibility then\n\t\twindow_facbar:SetVisibility(#facs > 0 or inTweak)\n\tend\n\tif inTweak then return end';
        if (src.includes(anchor)) {
            vfsRegister(facWidgetPath, src.replace(anchor, replacement));
            postLog(2, `[LuaUI] Patched ${facWidgetPath}: hide empty Factories window`);
        } else {
            postLog(3, `[LuaUI] ${facWidgetPath} hide-empty patch — anchor not found`);
        }
    }

    // Patch LuaRules/Configs/dynamic_comm_defs.lua: nil-guard the
    // wreck/heap feature lookups in the chassisDefs loop. Without
    // FeatureDefNames populated (we don't stream feature defs to the
    // widget worker yet), `wreckData = FeatureDefNames[...]` is nil
    // and the file aborts at file scope, returning nil — which then
    // breaks every Lua module that does
    // `local moduleDefs, ... = VFS.Include("dynamic_comm_defs.lua")`,
    // chiefly `LuaUI/Configs/startup_info_selector.lua` (drives the
    // commander-selector widget) and several others.
    const dynCommDefsPath = 'LuaRules/Configs/dynamic_comm_defs.lua';
    const dynCommDefsSrc = vfsLookup(dynCommDefsPath);
    if (dynCommDefsSrc) {
        const oldBlock = `\t\tlocal wreckData = FeatureDefNames[UnitDefs[data.baseUnitDef].corpse]\n\n\t\tdata.baseWreckID = wreckData.id\n\t\tdata.baseHeapID = wreckData.deathFeatureID`;
        const newBlock = `\t\tlocal baseUd = UnitDefs[data.baseUnitDef]\n\t\tlocal wreckData = baseUd and baseUd.corpse and FeatureDefNames[baseUd.corpse] or nil\n\n\t\tdata.baseWreckID = wreckData and wreckData.id or 0\n\t\tdata.baseHeapID = wreckData and wreckData.deathFeatureID or 0`;
        if (dynCommDefsSrc.includes(oldBlock)) {
            const patched = dynCommDefsSrc.replace(oldBlock, newBlock);
            vfsRegister(dynCommDefsPath, patched);
            postLog(2, '[LuaUI] Patched dynamic_comm_defs.lua: nil-safe wreck lookup');
        } else {
            postLog(3, '[LuaUI] dynamic_comm_defs wreck patch — anchor not found');
        }
    }

    // Patch modularCommAPI/api_modularcomms.lua: nil-guard the
    // commander-base unit lookup. Some predefined comm profiles
    // reference UnitDefNames["<profileID>_base"] entries that aren't
    // streamed to the client (we ship a subset of the chassis defs);
    // without the guard the entire library aborts at file scope and
    // WG.ModularCommAPI never gets defined, breaking the commander
    // selector and several context-menu / startpoint widgets.
    const commsApiPath = 'modularCommAPI/api_modularcomms.lua';
    const commsApiSrc = vfsLookup(commsApiPath);
    if (commsApiSrc) {
        const oldBlock = `\tfor profileID, profile in pairs(newCommProfilesByProfileID) do\n\t\t-- MAKE SURE THIS MATCHES WHAT UNITDEFGEN SETS\n\t\tprofile.baseUnitDefID = UnitDefNames[profileID .. \"_base\"].id\n\t\tprofile.baseWreckID = FeatureDefNames[profileID .. \"_base_dead\"].id\n\t\tprofile.baseHeapID = FeatureDefNames[profileID .. \"_base_heap\"].id\n\t\tnewProfileIDByBaseDefID[profile.baseUnitDefID] = profileID\n\tend`;
        const newBlock = `\tfor profileID, profile in pairs(newCommProfilesByProfileID) do\n\t\t-- MAKE SURE THIS MATCHES WHAT UNITDEFGEN SETS\n\t\tlocal baseUd = UnitDefNames[profileID .. \"_base\"]\n\t\tlocal wreckFd = FeatureDefNames and FeatureDefNames[profileID .. \"_base_dead\"]\n\t\tlocal heapFd = FeatureDefNames and FeatureDefNames[profileID .. \"_base_heap\"]\n\t\tprofile.baseUnitDefID = baseUd and baseUd.id or 0\n\t\tprofile.baseWreckID = wreckFd and wreckFd.id or 0\n\t\tprofile.baseHeapID = heapFd and heapFd.id or 0\n\t\tif profile.baseUnitDefID ~= 0 then\n\t\t\tnewProfileIDByBaseDefID[profile.baseUnitDefID] = profileID\n\t\tend\n\tend`;
        if (commsApiSrc.includes(oldBlock)) {
            const patched = commsApiSrc.replace(oldBlock, newBlock);
            vfsRegister(commsApiPath, patched);
            postLog(2, '[LuaUI] Patched modularCommAPI: nil-safe base def lookup');
        } else {
            postLog(3, '[LuaUI] modularCommAPI base-def patch — anchor not found');
        }
    }

    // Patch LuaUI/modfonts.lua: when the legacy font atlas can't load
    // (we don't ship Spring.MakeFont so the .lua/.png pair is missing),
    // activeFont stays nil and every text draw call crashes the calling
    // widget — flooding the log with hundreds of errors per frame from
    // AdvPlayersList and similar non-chili widgets that still use this
    // path. Replace activeFont with a stub object that has the fields
    // modfonts touches; Draw/Print methods become no-ops.
    const modfontsPath = 'LuaUI/modfonts.lua';
    const modfontsSrc = vfsLookup(modfontsPath);
    if (modfontsSrc) {
        const stub = `
local STUB_FONT = {
    name = "<stub>",
    base = "<stub>",
    opts = "",
    specs = { glyphs = setmetatable({}, { __index = function() return { adv = 0 } end }), height = 12, yStep = 14 },
    lists = setmetatable({}, { __index = function() return 0 end }),
    cache = setmetatable({}, { __index = function() return nil end, __newindex = function() end }),
    image = "",
}
if not activeFont then activeFont = STUB_FONT end
defaultFont = activeFont
`;
        const patched = modfontsSrc.replace(
            'UseFont(DefaultFontName)\ndefaultFont = activeFont',
            'UseFont(DefaultFontName)' + stub,
        );
        if (patched !== modfontsSrc) {
            vfsRegister(modfontsPath, patched);
            postLog(2, '[LuaUI] Patched modfonts.lua: stub font fallback');
        } else {
            postLog(3, '[LuaUI] modfonts.lua patch — anchor not found');
        }
    }

    // Patch chili_old/Controls/combobox.lua: harden _CloseWindow against
    // exceptions from OnSelect / OnClose listeners.
    //
    // The original close path is:
    //   _dropDownWindow:Dispose()
    //   _dropDownWindow = nil
    //
    // and the popup's OnMouseUp listener is
    //   function() self:Select(i); self:_CloseWindow() end
    //
    // If `Select` or any `OnSelect` listener errors (a real risk when
    // ZK widgets read partial UnitDefs / config state), `_CloseWindow`
    // never runs. The popup window keeps its `_dropDownWindow` ref, so
    // the next click on the combobox button takes the `else` branch
    // (`_CloseWindow()` again, which now succeeds since the window is
    // already disposed) instead of opening a fresh popup. The user has
    // to click somewhere else (which triggers FocusUpdate → does run
    // _CloseWindow) and then click the combobox to get a new dropdown.
    //
    // Fix: invert the order — null `_dropDownWindow` *before* Dispose,
    // and pcall-wrap the Dispose itself. Even if listeners further down
    // the chain throw, the next click sees a clean state. Also clear
    // `self.labels` and `self.state.pressed` regardless so the visual
    // pressed state never sticks.
    const comboboxPath = 'LuaUI/Widgets/chili_old/Controls/combobox.lua';
    const comboboxSrc = vfsLookup(comboboxPath);
    if (comboboxSrc) {
        const oldClose =
            'function ComboBox:_CloseWindow()\n' +
            '  self.labels = nil\n' +
            '  if self._dropDownWindow then\n' +
            '    self:CallListeners(self.OnClose)\n' +
            '    self._dropDownWindow:Dispose()\n' +
            '    self._dropDownWindow = nil\n' +
            '  end\n' +
            '  if (self.state.pressed) then\n' +
            '    self.state.pressed = false\n' +
            '    self:Invalidate()\n' +
            '    return self\n' +
            '  end\n' +
            'end';
        const newClose =
            'function ComboBox:_CloseWindow()\n' +
            '  self.labels = nil\n' +
            '  local win = self._dropDownWindow\n' +
            '  self._dropDownWindow = nil\n' +
            '  if win then\n' +
            '    pcall(self.CallListeners, self, self.OnClose)\n' +
            '    pcall(win.Dispose, win)\n' +
            '  end\n' +
            '  if (self.state.pressed) then\n' +
            '    self.state.pressed = false\n' +
            '    self:Invalidate()\n' +
            '    return self\n' +
            '  end\n' +
            'end';
        if (comboboxSrc.includes(oldClose)) {
            vfsRegister(comboboxPath, comboboxSrc.replace(oldClose, newClose));
            postLog(2, '[LuaUI] Patched combobox.lua: _CloseWindow null-before-dispose');
        } else {
            postLog(3, '[LuaUI] combobox.lua _CloseWindow patch — anchor not found');
        }
    }

    // Patch chili_old/Headers/util.lua: color2incolor passes floats
    // (r*255 etc.) into string.char, which fengari's Lua 5.3 rejects
    // with "number has no integer representation". Wrap with math.floor
    // so chili widgets that build inline color escapes (Chili Chat,
    // EndGame, Pro Console) load.
    const chiliUtilPath = 'LuaUI/Widgets/chili_old/Headers/util.lua';
    const chiliUtilSrc = vfsLookup(chiliUtilPath);
    if (chiliUtilSrc) {
        const patched = chiliUtilSrc.replace(
            'return string.char(255, r*255, g*255, b*255)',
            'return string.char(255, math.floor((r or 1)*255), math.floor((g or 1)*255), math.floor((b or 1)*255))',
        );
        if (patched !== chiliUtilSrc) {
            vfsRegister(chiliUtilPath, patched);
            postLog(2, '[LuaUI] Patched chili util.lua: color2incolor floor');
        } else {
            postLog(3, '[LuaUI] chili util.lua color2incolor patch — anchor not found');
        }
    }

    // Note: chili font.lua's `_GetExtra` falls through to 'a' (ascender)
    // for valign="linecenter". This is INTENTIONAL — the chili Carbon
    // skin's DrawButton (skinutils.lua) pre-adjusts y by `-size*0.35`
    // expecting the 'a' flag to position line TOP at that y, which puts
    // the visible cap text near the button's vertical centre. Patching
    // `_GetExtra` to map "linecenter" → 'x' breaks that — skin buttons
    // would then use 'x' (baseline-at-y semantics) with a y meant for
    // 'a', shifting captions far above the visible button shape.
    // chili Label uses Font:DrawInBox which calls AdjustPosToAlignment
    // — that path produces 'x' directly with a y pre-adjusted for
    // baseline-at-y, so labels still work without this patch.

    // Install Spring.SendCommands wrap BEFORE bootstrap so any
    // bind/unbind/etc. issued during widget Initialize is captured into
    // our _keyBindings table. epicmenu in particular runs `unbindall`
    // followed by `bind <key> <action>` for the entire default keymap
    // during its Initialize → LoadKeybinds → ReApplyKeybinds chain. If
    // we install the wrap post-bootstrap, those binds hit the no-op
    // pre-wrap and our table stays empty.
    //
    // The wrap looks up widgetHandler at call time (not at install
    // time), so it's fine that widgetHandler doesn't exist yet — by the
    // time SendCommands is called for a `luaui ...` line, cawidgets
    // has loaded.
    runtime.doString(`
        if not Spring then return end

        -- Keybind state. _keyBindings maps a normalised keyset string to
        -- an array of { [cmd] = args } tables (the format KeyAction in
        -- actions.lua expects from Spring.GetKeyBindings). _hotkeysFor
        -- maps an action name to an array of keyset strings.
        _keyBindings = _keyBindings or {}
        _hotkeysFor  = _hotkeysFor  or {}

        -- Normalise modifier order: alphabetical by token, lowercase key
        -- name. "Shift+Ctrl+f10" → "C+S+f10". KeyAction in actions.lua
        -- builds keysets via "A+C+M+S+<key>" so that's the canonical form.
        -- The "Any+" prefix is Spring's wildcard — bindings stored under
        -- "Any+<key>" should match presses with any modifier combination.
        local function normaliseKeyset(ks)
            ks = tostring(ks or ""):lower()
            local mods = { a = false, c = false, m = false, s = false }
            local anyMod = false
            local rest = ks
            local changed = true
            while changed do
                changed = false
                local _, _, m, tail = rest:find("^(%a)(%+)(.*)")
                if m and (m == "a" or m == "c" or m == "m" or m == "s") then
                    mods[m] = true
                    rest = tail or ""
                    changed = true
                else
                    -- also support "alt+", "ctrl+", "meta+", "shift+", "any+" long forms
                    local pre, after = rest:match("^(%a+)%+(.*)")
                    if pre == "alt" then mods.a = true; rest = after; changed = true
                    elseif pre == "ctrl" then mods.c = true; rest = after; changed = true
                    elseif pre == "meta" then mods.m = true; rest = after; changed = true
                    elseif pre == "shift" then mods.s = true; rest = after; changed = true
                    elseif pre == "any" then anyMod = true; rest = after; changed = true
                    end
                end
            end
            local out = ""
            if anyMod then
                -- Wildcard form lives in its own keyspace so GetKeyBindings
                -- can do an explicit fallback lookup against it.
                return "Any+" .. rest
            end
            if mods.a then out = out .. "A+" end
            if mods.c then out = out .. "C+" end
            if mods.m then out = out .. "M+" end
            if mods.s then out = out .. "S+" end
            return out .. rest
        end

        -- Strip modifier prefixes for the wildcard fallback lookup.
        local function bareKey(ks)
            local rest = tostring(ks or ""):lower()
            local changed = true
            while changed do
                changed = false
                local _, _, m, tail = rest:find("^(%a)(%+)(.*)")
                if m and (m == "a" or m == "c" or m == "m" or m == "s") then
                    rest = tail or ""; changed = true
                else
                    local pre, after = rest:match("^(%a+)%+(.*)")
                    if pre == "alt" or pre == "ctrl" or pre == "meta"
                            or pre == "shift" or pre == "any" then
                        rest = after; changed = true
                    end
                end
            end
            return rest
        end

        local function bindAction(keyset, cmd, args)
            keyset = normaliseKeyset(keyset)
            cmd = tostring(cmd or "")
            args = tostring(args or "")
            if cmd == "" then return end
            local list = _keyBindings[keyset]
            if not list then list = {}; _keyBindings[keyset] = list end
            -- Duplicate-bind guard: if the same keyset/cmd pair is already
            -- there, refresh its args rather than appending.
            for i = 1, #list do
                local existing = list[i]
                local k = next(existing)
                if k == cmd then
                    list[i] = { [cmd] = args }
                    return
                end
            end
            list[#list+1] = { [cmd] = args }
            local hotkeys = _hotkeysFor[cmd]
            if not hotkeys then hotkeys = {}; _hotkeysFor[cmd] = hotkeys end
            for i = 1, #hotkeys do
                if hotkeys[i] == keyset then return end
            end
            hotkeys[#hotkeys+1] = keyset
        end

        local function unbindAction(keyset, cmd)
            keyset = normaliseKeyset(keyset)
            cmd = tostring(cmd or "")
            local list = _keyBindings[keyset]
            if list then
                for i = #list, 1, -1 do
                    local k = next(list[i])
                    if cmd == "" or k == cmd then
                        table.remove(list, i)
                    end
                end
                if #list == 0 then _keyBindings[keyset] = nil end
            end
            if cmd ~= "" then
                local hotkeys = _hotkeysFor[cmd]
                if hotkeys then
                    for i = #hotkeys, 1, -1 do
                        if hotkeys[i] == keyset then table.remove(hotkeys, i) end
                    end
                    if #hotkeys == 0 then _hotkeysFor[cmd] = nil end
                end
            end
        end

        local function unbindKeyset(keyset)
            keyset = normaliseKeyset(keyset)
            local list = _keyBindings[keyset]
            if not list then return end
            for i = 1, #list do
                local k = next(list[i])
                local hotkeys = _hotkeysFor[k]
                if hotkeys then
                    for j = #hotkeys, 1, -1 do
                        if hotkeys[j] == keyset then table.remove(hotkeys, j) end
                    end
                    if #hotkeys == 0 then _hotkeysFor[k] = nil end
                end
            end
            _keyBindings[keyset] = nil
        end

        local function unbindActionEverywhere(cmd)
            cmd = tostring(cmd or "")
            local hotkeys = _hotkeysFor[cmd]
            if hotkeys then
                for i = 1, #hotkeys do
                    local list = _keyBindings[hotkeys[i]]
                    if list then
                        for j = #list, 1, -1 do
                            if next(list[j]) == cmd then table.remove(list, j) end
                        end
                        if #list == 0 then _keyBindings[hotkeys[i]] = nil end
                    end
                end
                _hotkeysFor[cmd] = nil
            end
        end

        local function unbindAll()
            _keyBindings = {}
            _hotkeysFor  = {}
        end

        -- Engine commands we accept silently (no-op until something on the
        -- C++ side can actually honor them). Anything outside this set
        -- still logs at info level so missing handlers stay visible.
        local engineNoOps = {
            ["set"] = true, ["set2"] = true, ["unset"] = true,
            ["pause"] = true,
            ["console"] = true, ["inputtextgeo"] = true,
            ["screenshot"] = true, ["quit"] = true, ["reload"] = true,
            ["fps"] = true, ["clock"] = true, ["info"] = true,
            ["chat"] = true, ["chatall"] = true, ["chatally"] = true,
            ["chatspec"] = true, ["chatswitchally"] = true,
            ["chatswitchspec"] = true, ["chatswitchall"] = true,
            ["say"] = true, ["wbynum"] = true, ["w"] = true,
            ["specfullview"] = true, ["specteam"] = true,
            ["forcestart"] = true, ["resign"] = true, ["team"] = true,
            ["spectator"] = true, ["spec"] = true, ["singlestep"] = true,
            ["nopause"] = true, ["nohelp"] = true, ["nocost"] = true,
            ["godmode"] = true, ["cheat"] = true, ["nospectatorchat"] = true,
            ["mapinfo"] = true, ["minimap"] = true,
            ["mute"] = true, ["mutebyid"] = true,
            ["disticon"] = true, ["distdraw"] = true,
            ["luaui"] = true, ["luarules"] = true, ["luagaia"] = true,
            -- Engine prints / config-load commands that ZK widgets emit during
            -- bootstrap. echo just prints to the engine console; ctrlpanel
            -- loads a legacy command-bar layout file. Neither has a client-
            -- side equivalent — silent no-op matches the engine on a server
            -- that lacks the feature.
            ["echo"] = true, ["ctrlpanel"] = true,
        }

        local seenUnhandled = {}

        local function dispatchOne(line)
            if type(line) ~= "string" then return end
            local trimmed = line:match("^%s*(.-)%s*$")
            if trimmed == "" then return end

            -- "luaui foo bar" — real Spring routes these through
            -- widgetHandler:ConfigureLayout which handles built-in commands
            -- (togglewidget, enablewidget, selector, reconf, tweakgui)
            -- before falling through to actionHandler:TextAction. Mirror
            -- that order: ConfigureLayout claims the recognised built-ins,
            -- TextAction handles widget-registered actions, and a final
            -- pass through TextCommandList lets widgets that defined
            -- :TextCommand intercept anything else (gui_epicmenu uses this
            -- for "search:" prefixes).
            local rest = trimmed:match("^luaui%s+(.+)")
            if rest and widgetHandler then
                if widgetHandler.ConfigureLayout then
                    local ok, ret = pcall(widgetHandler.ConfigureLayout,
                        widgetHandler, rest)
                    if ok and ret then return end
                end
                if widgetHandler.actionHandler
                        and widgetHandler.actionHandler.TextAction then
                    local ok, err = pcall(widgetHandler.actionHandler.TextAction,
                        widgetHandler.actionHandler, rest)
                    if not ok then
                        Spring.Echo("[SendCommands] TextAction error: " .. tostring(err))
                    end
                end
                return
            end

            -- bind <keyset> <cmd> [args...]
            local bks, bcmd, bargs = trimmed:match("^bind%s+(%S+)%s+(%S+)%s*(.*)$")
            if bks then bindAction(bks, bcmd, bargs); return end

            -- bindaction is a synonym used by some configs
            local baks, bacmd, baargs = trimmed:match("^bindaction%s+(%S+)%s+(%S+)%s*(.*)$")
            if baks then bindAction(baks, bacmd, baargs); return end

            -- unbind <keyset> <cmd>  /  unbind <keyset>
            local uks, ucmd = trimmed:match("^unbind%s+(%S+)%s+(%S+)$")
            if uks then unbindAction(uks, ucmd); return end
            local uks2 = trimmed:match("^unbind%s+(%S+)$")
            if uks2 then unbindAction(uks2, ""); return end

            -- unbindkeyset <keyset>
            local kks = trimmed:match("^unbindkeyset%s+(%S+)$")
            if kks then unbindKeyset(kks); return end

            -- unbindaction <cmd>
            local uac = trimmed:match("^unbindaction%s+(%S+)$")
            if uac then unbindActionEverywhere(uac); return end

            if trimmed == "unbindall" or trimmed:match("^unbindall%s") then
                unbindAll(); return
            end

            local head = trimmed:match("^(%S+)")
            if head and engineNoOps[head:lower()] then return end

            if head and not seenUnhandled[head] then
                seenUnhandled[head] = true
                Spring.Log("LuaUI", 2, "[SendCommands] unhandled: " .. trimmed)
            end
        end

        Spring.SendCommands = function(...)
            local args = {...}
            local lines
            if #args == 1 and type(args[1]) == "table" then
                lines = args[1]
            else
                lines = args
            end
            for i = 1, #lines do
                dispatchOne(lines[i])
            end
        end

        -- Drive Spring.GetKeyBindings off our keybind table. KeyAction in
        -- actions.lua passes a single keyset string and expects a list of
        -- {cmd=args} tables. The second arg (scanset) is treated the same.
        Spring.GetKeyBindings = function(keyset, scanset)
            if not keyset and not scanset then return {} end
            local primary = _keyBindings[normaliseKeyset(keyset or scanset)]
            if primary and #primary > 0 then return primary end
            -- Fall back to the "Any+<key>" wildcard form so a binding
            -- like "bind Any+x foo" matches a press of x with any
            -- modifier combination (or none).
            local wild = _keyBindings["Any+" .. bareKey(keyset or scanset)]
            if wild and #wild > 0 then return wild end
            if keyset and scanset then
                local secondary = _keyBindings[normaliseKeyset(scanset)]
                if secondary and #secondary > 0 then return secondary end
                local secondaryWild = _keyBindings["Any+" .. bareKey(scanset)]
                if secondaryWild and #secondaryWild > 0 then return secondaryWild end
            end
            return {}
        end

        Spring.GetActionHotKeys = function(action)
            local list = _hotkeysFor[tostring(action or "")]
            if not list then return {} end
            local copy = {}
            for i = 1, #list do copy[i] = list[i] end
            return copy
        end

        -- Friendly Spring.GetKeySymbol so MakeKeySetString in actions.lua
        -- can produce e.g. "f10" instead of "". The mapping mirrors the
        -- keycode table the manager forwards via 'keypress' messages.
        local _keySymbols = {
            [8]   = "backspace",
            [9]   = "tab",
            [13]  = "enter", [27] = "escape", [32] = "space",
            [127] = "delete",
            [273] = "up", [274] = "down", [275] = "right", [276] = "left",
            [277] = "insert", [278] = "home", [279] = "end",
            [280] = "pageup", [281] = "pagedown",
            [282] = "f1", [283] = "f2", [284] = "f3", [285] = "f4",
            [286] = "f5", [287] = "f6", [288] = "f7", [289] = "f8",
            [290] = "f9", [291] = "f10", [292] = "f11", [293] = "f12",
        }
        Spring.GetKeySymbol = function(keyCode)
            local n = tonumber(keyCode) or 0
            local s = _keySymbols[n]
            if s then return s, s end
            if n >= 32 and n < 127 then
                local c = string.char(n)
                return c, c
            end
            return "", ""
        end
        Spring.GetScanSymbol = Spring.GetScanSymbol or Spring.GetKeySymbol

        Spring.Echo("[LuaUI] Spring.SendCommands wired (luaui + keybind table)")
    `, 'send_commands_dispatch');

    // Load gamedata/sounds.lua and extract the SoundItems table.
    // We do this before the widget bootstrap because:
    //   1. The file's `AutoAdd` helper does VFS.DirList to enumerate
    //      assets — we already have those paths indexed from the VFS
    //      prefetch above, so the dynamic table built here is correct.
    //   2. The bootstrap may immediately fire `Spring.PlaySoundFile`
    //      from a widget's `Initialize()`, so the SoundItem map needs
    //      to be available on the main thread by then.
    // The map is serialised as a plain object and posted to the main
    // thread, which threads it through to AudioManager.ingestSoundItems.
    postLog(2, '[LuaUI] init step 6.5/8: loading gamedata/sounds.lua...');
    loadAndPostSoundItems(runtime);

    // Resolve the game's LuaUI entry point rather than assuming ZK's
    // camain.lua. ZK ships LuaUI/camain.lua (its Chili-based cawidgets
    // tree); BAR and stock Spring ship LuaUI/main.lua. Hardcoding camain.lua
    // meant the include resolved to nothing for BAR, the widget handler never
    // initialized, and no overlay rendered. Probe the prefetched VFS in
    // priority order and boot the first entry that exists. vfsExists handles
    // the LuaUI/ prefix + case-folding.
    //
    // NOTE: this only fixes entry-point detection. ZK's camain.lua loads the
    // Chili framework that the worker GL bridge implements; BAR's main.lua
    // loads an RML-based framework (barwidgets.lua / RmlWidgets) the bridge
    // does NOT yet implement. Full BAR overlay parity is a larger
    // PLAN-bar.md de-ZK-ing workstream — but de-hardcoding the entry gets the
    // correct handler to initialize instead of silently including nothing.
    const LUAUI_ENTRY_CANDIDATES = [
        'LuaUI/camain.lua',  // Zero-K (Chili cawidgets tree)
        'LuaUI/main.lua',    // BAR + stock Spring LuaUI entry
        'LuaUI/gui.lua',     // legacy fallback seen in some games
    ];
    const luaUiEntry = LUAUI_ENTRY_CANDIDATES.find((p) => vfsExists(p));
    if (!luaUiEntry) {
        postLog(4, `[LuaUI] no recognised LuaUI entry point in VFS (tried ${LUAUI_ENTRY_CANDIDATES.join(', ')}) — no overlay will load`);
    }
    const entryToBoot = luaUiEntry ?? 'LuaUI/camain.lua';

    // PLAN-rml.md R0: install the RmlUi global BEFORE the bootstrap. BAR's
    // rml_setup.lua / RML widgets guard `if not RmlUi then return end`; with the
    // global present they initialise and record DOM ops for the main-thread
    // overlay. Harmless for ZK (camain.lua never touches RmlUi).
    installRmlGlobal(runtime);

    postLog(2, `[LuaUI] init step 7/8: starting bootstrap (VFS.Include ${entryToBoot})...`);
    const bootStart = performance.now();
    const bootErr = runtime.doString(`
        local ok, err = pcall(function()
            VFS.Include(${JSON.stringify(entryToBoot)}, nil, VFS.GAME)
        end)
        if not ok then
            Spring.Echo("[LuaUI] Bootstrap failed: " .. tostring(err))
            error(err)
        end
    `, 'bootstrap');

    postLog(2, `[LuaUI] init step 7/8 done: bootstrap completed in ${(performance.now() - bootStart).toFixed(0)}ms`);
    if (bootErr) {
        postLog(4, `Bootstrap failed: ${bootErr}`);
    }

    // Increase Chili's DebugHandler error tolerance. The default is 5
    // errors in 5 seconds before self-destruct. Our incomplete GL/API
    // surface triggers more errors during init than native Spring, but
    // they're harmless (missing skin draw methods on controls that
    // haven't been fully realized yet).
    runtime.doString(`
        if WG and WG.Chili and WG.Chili.DebugHandler then
            WG.Chili.DebugHandler.maxChiliErrors = 999
            Spring.Echo("[LuaUI] DebugHandler.maxChiliErrors raised to 999")
        end
    `, 'chili_error_tolerance');

    // Force-enable Chili Framework if widgetHandler didn't auto-start it.
    // The api_chili.lua widget can fail to register during cawidgets' bulk
    // scan in ways we haven't fully traced (silent pcall failure during
    // bootstrap; the same LoadWidget call works fine post-bootstrap). If
    // it isn't in knownWidgets at all, load it directly here so the rest
    // of the Chili widgets have a Framework to attach to.
    runtime.doString(`
        if widgetHandler and (not WG or not WG.Chili) then
            local ki = widgetHandler.knownWidgets and widgetHandler.knownWidgets["Chili Framework"]
            if not ki then
                Spring.Echo("[LuaUI] Chili Framework missing from knownWidgets; loading directly")
                local w = widgetHandler:LoadWidget("LuaUI/Widgets/api_chili.lua")
                if w then
                    widgetHandler:InsertWidget(w)
                    widgetHandler:SaveOrderList()
                    Spring.Echo("[LuaUI] Chili Framework loaded and inserted")
                else
                    Spring.Echo("[LuaUI] Direct LoadWidget for api_chili.lua failed")
                end
            elseif not ki.active then
                Spring.Echo("[LuaUI] Force-enabling Chili Framework")
                widgetHandler:EnableWidget("Chili Framework")
            end
            -- Raise error tolerance on the freshly loaded Chili
            if WG and WG.Chili and WG.Chili.DebugHandler then
                WG.Chili.DebugHandler.maxChiliErrors = 999
            end
        end
    `, 'chili_force_enable');

    // PLAN-weapon-fx Z1 — Boot LUPS (Lua Particle System).
    //
    // ZK loads LUPS via `LuaUI/Widgets/lups_wrapper.lua`, which does
    // `VFS.Include("lups/lups.lua")` and lets the lups module attach
    // its callins (Initialize, DrawWorld, etc.) to the enclosing widget
    // table. The Initialize() callin walks `lups/ParticleClasses/*.lua`,
    // calls each class's GetInfo() + Initialize(), and exposes the
    // surviving classes via `WG.Lups.AddParticles` etc.
    //
    // If the wrapper widget isn't in `knownWidgets` (e.g. silent pcall
    // failure during the bulk widget scan, or order-file disabled), we
    // load it directly — same pattern as the Chili Framework fallback.
    // After load we publish a diagnostic:
    //   - LUPS classes registered vs. expected (30 ParticleClasses).
    //   - Class-by-class HasParticleClass probe for the canonical names.
    //   - The error log for classes rejected by hardware-cap checks or
    //     their own Initialize() returning false.
    //
    // This is the cascade-investigation surface called out in the plan:
    // we don't fix every class in one shot — we surface the failures so
    // the next pass can pick them off one by one.
    runtime.doString(`
        if widgetHandler then
            local function widgetReport(label, ok)
                Spring.Echo("[LUPS] " .. label .. ": " .. (ok and "ok" or "MISSING"))
            end

            -- Force-load lups_wrapper.lua if widget discovery missed it.
            local ki = widgetHandler.knownWidgets and widgetHandler.knownWidgets["Lups"]
            if not ki then
                Spring.Echo("[LUPS] widget 'Lups' missing from knownWidgets; force-loading lups_wrapper.lua")
                local w = widgetHandler:LoadWidget("LuaUI/Widgets/lups_wrapper.lua")
                if w then
                    widgetHandler:InsertWidget(w)
                    widgetHandler:SaveOrderList()
                    Spring.Echo("[LUPS] lups_wrapper.lua loaded + inserted")
                else
                    Spring.Echo("[LUPS] direct LoadWidget for lups_wrapper.lua FAILED")
                end
            elseif not ki.active then
                Spring.Echo("[LUPS] knownWidgets['Lups'] present but inactive; enabling")
                widgetHandler:EnableWidget("Lups")
            else
                Spring.Echo("[LUPS] widget 'Lups' discovered by widgetHandler")
            end

            -- Diagnostic probe: did Initialize() populate WG.Lups?
            if WG and WG.Lups then
                local fnCount = 0
                for _ in pairs(WG.Lups) do fnCount = fnCount + 1 end
                Spring.Echo("[LUPS] WG.Lups populated with " .. tostring(fnCount) .. " entries")

                -- Class-by-class probe. Names taken from
                -- content/games/zk/lups/ParticleClasses/*.lua. HasParticleClass
                -- lowercases internally, so case doesn't matter.
                local probeClasses = {
                    "Jet", "SimpleParticles", "SimpleParticles2",
                    "JitterParticles", "JitterParticles2",
                    "Ribbons", "RingParticles", "ShockWave",
                    "Sphere", "SphereDistortion",
                    "ShieldSphere", "ShieldSphereColor", "ShieldSphereColorHQ",
                    "ShieldSphereColorFallback", "ShieldJitter",
                    "NanoParticles", "NanoLasers", "NanoLasersNoShader",
                    "Bursts", "Groundflash", "AirJet",
                    "OverdriveParticles", "StaticParticles",
                    "UnitSmoke", "UnitJitter",
                    "UnitPieceLight", "UnitCloaker",
                }
                local present, missing = {}, {}
                for _, name in ipairs(probeClasses) do
                    if WG.Lups.HasParticleClass and WG.Lups.HasParticleClass(name) then
                        present[#present + 1] = name
                    else
                        missing[#missing + 1] = name
                    end
                end
                Spring.Echo(string.format("[LUPS] classes: %d/%d present",
                    #present, #probeClasses))
                if #present > 0 then
                    Spring.Echo("[LUPS] present: " .. table.concat(present, ", "))
                end
                if #missing > 0 then
                    Spring.Echo("[LUPS] missing: " .. table.concat(missing, ", "))
                end

                -- Surface LUPS's internal error log so class init failures
                -- (hardware-cap rejections, shader compile errors, etc.)
                -- end up in the console alongside the boot report. The
                -- PRIO_LESS sink captures everything LUPS logs at the
                -- "warning and below" verbosity.
                if WG.Lups.GetErrorLog then
                    local errlog = WG.Lups.GetErrorLog(5)
                    if errlog and #errlog > 0 then
                        Spring.Echo("[LUPS] error log:\\n" .. errlog)
                    end
                end
            else
                Spring.Echo("[LUPS] BOOT FAILED — WG.Lups is nil after wrapper load")
                if widgetHandler.knownWidgets then
                    local k = widgetHandler.knownWidgets["Lups"]
                    if k then
                        Spring.Echo(string.format(
                            "[LUPS] knownWidgets['Lups']: active=%s, fromZip=%s",
                            tostring(k.active), tostring(k.fromZip)))
                    end
                end
            end
        end
    `, 'lups_boot');

    // PLAN-weapon-fx Phase Z5 — bridge WG.Lups → global GG.Lups + install
    // the emission audit.
    //
    // (1) GG bridge. The producer gadgets (lups_projectiles.lua, lups_*.lua,
    //     and unit-script-driven FX) read `GG['Lups']` from the global gadget
    //     env, but lups.lua only ever populates `WG.Lups` (its line-138
    //     `local GG = (widget and WG) or GG` resolves to WG when loaded via
    //     the widget wrapper). Without this bridge every authored emitter
    //     hits `attempt to index nil (global GG)` and dies inside its
    //     DispatchSyncAction pcall — the wire is live (Z1.5) but the payload
    //     never reaches AddParticles. Point GG.Lups at the same table.
    //
    // (2) Emission audit. Wrap AddParticles + AddParticlesArray to tally
    //     unknown class names and malformed param shapes into a queryable
    //     global (`WG.__lupsAudit`). Z5's exit gate is "zero [lups] unknown
    //     class warnings across weapon-showcase + a 10-min skirmish"; this is
    //     the instrument that measures it. HasParticleClass lowercases
    //     internally so case-variant class names still resolve. The wrapper
    //     is idempotent (guarded by __auditInstalled) and always calls
    //     through, so it never changes emission behaviour.
    runtime.doString(`
        if WG and WG.Lups then
            GG = GG or {}
            GG.Lups = WG.Lups

            local L = WG.Lups
            if L.AddParticles and not L.__auditInstalled then
                L.__auditInstalled = true
                WG.__lupsAudit = {
                    unknown = {}, badParams = {},
                    totalAdd = 0, totalUnknown = 0, totalBad = 0,
                    -- Phase V per-class coverage. [lowerClassName] = {
                    --   calls    = AddParticles invocations,
                    --   created  = returned a live id (>0) => entered the
                    --              RenderSequence => will be drawn,
                    --   failed   = returned -1 (unknown class / invalid unit
                    --              / Create returned nil) => draws nothing,
                    --   maxAliveFx / maxAlivePart = peak live counts seen by
                    --              SampleLupsAudit (GetStats snapshot). }
                    byClass = {}, samples = 0,
                }
                local audit = WG.__lupsAudit
                local has = L.HasParticleClass

                local function bump(Class)
                    if type(Class) ~= "string" then return nil end
                    local k = string.lower(Class)
                    local b = audit.byClass[k]
                    if not b then
                        b = { calls = 0, created = 0, failed = 0,
                              maxAliveFx = 0, maxAlivePart = 0 }
                        audit.byClass[k] = b
                    end
                    return b
                end

                local function record(Class, Options)
                    audit.totalAdd = audit.totalAdd + 1
                    if type(Class) ~= "string" then
                        local k = "<non-string class:" .. type(Class) .. ">"
                        audit.badParams[k] = (audit.badParams[k] or 0) + 1
                        audit.totalBad = audit.totalBad + 1
                    elseif has and not has(Class) then
                        audit.unknown[Class] = (audit.unknown[Class] or 0) + 1
                        audit.totalUnknown = audit.totalUnknown + 1
                        Spring.Echo("[lups] unknown class '" .. Class .. "'")
                    end
                    if Options == nil then
                        local k = "nil-options:" .. tostring(Class)
                        audit.badParams[k] = (audit.badParams[k] or 0) + 1
                        audit.totalBad = audit.totalBad + 1
                    elseif type(Options) ~= "table" then
                        local k = "non-table-options:" .. tostring(Class) ..
                            ":" .. type(Options)
                        audit.badParams[k] = (audit.badParams[k] or 0) + 1
                        audit.totalBad = audit.totalBad + 1
                    end
                end

                local origAdd = L.AddParticles
                L.AddParticles = function(Class, Options, ...)
                    record(Class, Options)
                    local id = origAdd(Class, Options, ...)
                    local b = bump(Class)
                    if b then
                        b.calls = b.calls + 1
                        if type(id) == "number" and id > 0 then
                            b.created = b.created + 1
                        else
                            b.failed = b.failed + 1
                        end
                    end
                    return id
                end

                if L.AddParticlesArray then
                    local origArr = L.AddParticlesArray
                    L.AddParticlesArray = function(array, ...)
                        -- origArr calls the module-local AddParticles (not our
                        -- wrapped L.AddParticles), so per-element created/failed
                        -- is not observable here; tally calls only.
                        if type(array) == "table" then
                            for i = 1, #array do
                                local e = array[i]
                                if type(e) == "table" then
                                    record(e.class, e)
                                    local b = bump(e.class)
                                    if b then b.calls = b.calls + 1 end
                                end
                            end
                        end
                        return origArr(array, ...)
                    end
                end

                -- Re-point GG.Lups (it captured the pre-wrap table above) so
                -- gadgets calling GG.Lups.AddParticles hit the audited path.
                GG.Lups = L

                -- Phase V live-coverage sampler. Snapshots GetStats() (per-
                -- class fx/particle counts as they sit in the RenderSequence)
                -- and folds the peak into byClass. Call periodically during a
                -- capture dwell to catch the alive peak, which lags emission.
                _G.SampleLupsAudit = function()
                    if not L.GetStats then return end
                    local ok, count, layers, effects = pcall(L.GetStats)
                    if not ok or type(effects) ~= "table" then return end
                    audit.samples = audit.samples + 1
                    audit.lastCount = count
                    for name, t in pairs(effects) do
                        local b = bump(name)
                        if b then
                            local fxN, partN = t[1] or 0, t[2] or 0
                            if fxN > b.maxAliveFx then b.maxAliveFx = fxN end
                            if partN > b.maxAlivePart then b.maxAlivePart = partN end
                        end
                    end
                    return count
                end

                -- Per-class verdict string (also the evaluate_widget_lua
                -- return payload). Each row: class | calls | created | failed |
                -- peakFx | peakPart, so "645 calls / 4 live" resolves to which
                -- classes fire, which create FX, and which silently fail.
                _G.LupsAuditReport = function()
                    local a = WG.__lupsAudit
                    local rows = {}
                    rows[#rows+1] = string.format(
                        "[lups] %d adds | %d unknown | %d bad | %d samples",
                        a.totalAdd, a.totalUnknown, a.totalBad, a.samples)
                    rows[#rows+1] =
                        "class | calls created failed peakFx peakPart"
                    -- stable-ish: sort by calls desc via simple selection
                    local keys = {}
                    for k in pairs(a.byClass) do keys[#keys+1] = k end
                    table.sort(keys, function(x, y)
                        return a.byClass[x].calls > a.byClass[y].calls
                    end)
                    for _, k in ipairs(keys) do
                        local b = a.byClass[k]
                        rows[#rows+1] = string.format(
                            "%s | %d %d %d %d %d", k,
                            b.calls, b.created, b.failed,
                            b.maxAliveFx, b.maxAlivePart)
                    end
                    return table.concat(rows, "\\n")
                end

                -- Convenience console dump (echoes the report line-by-line).
                _G.DumpLupsAudit = function()
                    _G.SampleLupsAudit()
                    for line in string.gmatch(
                            _G.LupsAuditReport() .. "\\n", "(.-)\\n") do
                        if line ~= "" then Spring.Echo(line) end
                    end
                end

                Spring.Echo("[lups] Z5/Phase-V emission audit installed; GG.Lups bridged")
            end
        else
            Spring.Echo("[lups] Z5 audit skipped — WG.Lups absent")
        end
    `, 'lups_gg_bridge');

    // PLAN-weapon-fx Phase Z1.5 — Load the unsynced halves of every
    // LuaRules gadget whose `else`-branch produces visible particle /
    // shader / FX work. Each candidate is one of ZK's `lups_*.lua`,
    // `weapon_*.lua`, or similar where the synced half runs on the
    // headless server and SendToUnsynced-bridges payload over to the
    // client; here we load the dormant unsynced-side scope so the
    // matching `gadgetHandler:AddSyncAction(topic, fn)` registrations
    // happen and the DispatchSyncAction wire path lights up.
    //
    // Files with no `else` branch are pure-synced and skipped — they
    // already run server-side via the headless LuaRules.
    //
    // Must run after LUPS boots (gadgets like lups_flame_jitter.lua
    // capture `GG.Lups` in their Initialize) and after camain.lua so
    // `Spring.*` is populated.
    {
        const candidatePaths: string[] = [];
        for (const p of vfsFiles.keys()) {
            if (!p.startsWith('LuaRules/Gadgets/')) continue;
            if (!p.endsWith('.lua')) continue;
            if (p.includes('/Include/')) continue;
            const src = vfsFiles.get(p);
            if (!src) continue;
            // Cheap test: gadget files use `if (gadgetHandler:IsSyncedCode()) then`
            // followed by `else` to gate the unsynced half. A file without
            // that `else` keyword on a fresh line either is synced-only or
            // didn't follow the convention — either way, nothing for us.
            if (!/\nelse\b/.test(src)) continue;
            candidatePaths.push(p);
        }
        candidatePaths.sort();
        postLog(2, `[gadgetHandler] init step 7.5/8: loading ${candidatePaths.length} unsynced gadget halves`);
        let loaded = 0;
        for (const p of candidatePaths) {
            const err = runtime.doString(gadgetLoaderLua(p), `load:${p}`);
            if (!err) loaded++;
        }
        postLog(2, `[gadgetHandler] init step 7.5/8 done: ${loaded}/${candidatePaths.length} gadgets loaded`);
    }

    // Auto-enable a curated set of Chili widgets that ZK ships with
    // `enabled = false` by default but which provide important UI we
    // want active in our environment. Each is gated on
    // `not kw.active` so we don't fight a user choice that's already
    // been applied.
    runtime.doString(`
        if widgetHandler then
            local autoEnable = {
                "Chili Chat 2.2",        -- chat console (replaces Pro Console)
                -- FactoryBar/FactoryPanel are user-toggled. They mount empty
                -- floating windows at startup before any factory exists,
                -- which looks broken; the Integral Menu already covers
                -- factory build queues. Re-enable from EPIC Menu when
                -- desired.
            }
            for _, name in ipairs(autoEnable) do
                local kw = widgetHandler.knownWidgets and widgetHandler.knownWidgets[name]
                if kw and not kw.active then
                    local ok = pcall(widgetHandler.EnableWidget, widgetHandler, name)
                    if ok then
                        Spring.Echo("[LuaUI] Auto-enabled " .. name)
                    end
                end
            end
        end
    `, 'chili_auto_enable');

    // Patch Chili's widget:Dispose to guard against nil screen0.
    // The old-chili path defines Dispose as `screen0:Dispose()` but
    // screen0 is an upvalue that stays nil if texturehandler fails
    // during Initialize. Without this guard, every Chili Dispose call
    // recurses through the DebugHandler error handler, producing
    // hundreds of log messages that consume the rate limit budget.
    runtime.doString(`
        if widgetHandler then
            for _, w in ipairs(widgetHandler.widgets) do
                if w.whInfo and w.whInfo.name == "Chili Framework" and w.Dispose then
                    local origDispose = w.Dispose
                    w.Dispose = function(self, ...)
                        local ok, err = pcall(origDispose, self, ...)
                        if not ok then
                            -- Silently ignore nil screen0 errors
                        end
                    end
                    break
                end
            end
        end
    `, 'chili_dispose_guard');

    // Apply the pre-installed shutdown guard to widgetHandler now that
    // camain.lua has loaded it.
    runtime.doString(`
        if _widgetHandler_shutdown_wrap and widgetHandler then
            _widgetHandler_shutdown_wrap(widgetHandler)
        end
    `, 'shutdown_guard_apply');
    postLog(2, '[LuaUI] init done: shutdown recursion guard applied');

    // Post-bootstrap API patches: install our Spring.Utilities fallbacks AFTER
    // the game's own bootstrap. This is fill-missing on purpose — a game that
    // ships a complete Spring.Utilities (BAR via common/springFunctions.lua:
    // Gametype, Color, GetTeamColor, …) keeps its own; ZK's cawidgets installs
    // its table; a game with none (papertanks) gets ours created here. Running
    // pre-bootstrap instead would shadow the game's table via its
    // `Spring.Utilities = Spring.Utilities or X` idiom (drops BAR's Gametype).
    runtime.doString(`
        Spring.Utilities = Spring.Utilities or {}
        local U = Spring.Utilities
        U.GetHumanName = U.GetHumanName or function(ud)
            if type(ud) == "table" and ud.humanName then return ud.humanName end
            if type(ud) == "table" and ud.name then return ud.name end
            return tostring(ud or "")
        end
        U.bit_inv = U.bit_inv or function(x)
            return bit32 and bit32.bnot(x) or (~x)
        end
        U.CopyTable = U.CopyTable or function(t, deep)
            if type(t) ~= "table" then return t end
            local copy = {}
            for k, v in pairs(t) do
                if deep and type(v) == "table" then copy[k] = U.CopyTable(v, true)
                else copy[k] = v end
            end
            return copy
        end
        U.MergeTable = U.MergeTable or function(dst, src)
            for k, v in pairs(src) do if dst[k] == nil then dst[k] = v end end
            return dst
        end
        U.json = U.json or { encode = function() return "{}" end, decode = function() return {} end }
        U.TableToString = U.TableToString or function(t) return tostring(t) end
        if not Spring.Translate then
            Spring.Translate = function(key) return tostring(key or "") end
        end
        if not Spring.GetHumanName then
            Spring.GetHumanName = function(defName) return tostring(defName or "") end
        end
        -- NOTE: Spring.SetLogSectionFilterLevel is installed in the core engine
        -- Spring table (lua-spring-api.ts) BEFORE the LuaUI bootstrap, because
        -- widgets call it from Initialize() (which runs during bootstrap). A
        -- post-bootstrap stub here lands too late and the widget crashes on load.
    `, 'post_bootstrap_api_stubs');

    // Bridge bound-key → text-action. ZK widgets register most actions as
    // text-only ("AddAction(name, fn, nil, 't')") because real Spring's
    // engine dispatches bound keys *as text commands* — bind f10
    // crudesubmenu causes pressing F10 to run the same code path as
    // typing `/crudesubmenu`. actions.lua's KeyAction only consults the
    // keyPressActions / keyRepeatActions / keyReleaseActions tables, so
    // when our keybind table maps f10 → crudesubmenu but crudesubmenu is
    // text-only, KeyAction returns false and the key does nothing. Wrap
    // KeyAction to fall through to TextAction on miss. We do this here
    // (post-bootstrap) so the actionHandler is the populated one.
    runtime.doString(`
        if widgetHandler and widgetHandler.actionHandler then
            local ah = widgetHandler.actionHandler
            local origKeyAction = ah.KeyAction
            ah.KeyAction = function(self, press, key, mods, isRepeat, scanCode, actions)
                -- Bare modifier-press never dispatches actions. SDL maps
                -- LSHIFT=304 RSHIFT=303 LCTRL=306 RCTRL=305 LALT=308 RALT=307
                -- LMETA=310 RMETA=309. ZK's GetKeyBindings("") matches a
                -- naked Any+anything binding when the key has no symbol;
                -- without this guard, a bare Shift press has triggered
                -- actions like crudesubmenu/menu in the past.
                if key and (key == 303 or key == 304 or key == 305 or key == 306
                        or key == 307 or key == 308 or key == 309 or key == 310) then
                    return false
                end
                local handled = origKeyAction(self, press, key, mods, isRepeat, scanCode, actions)
                if handled then return true end
                -- Only press events trigger text fall-through; releases are
                -- mostly used for state-tracking actions that don't have a
                -- text equivalent.
                if not press then return false end
                if not actions then
                    -- KeyAction would have computed actions via GetKeyBindings.
                    -- Repeat that here so we can probe.
                    local _, defSym = (Spring.GetKeySymbol or function() return "", "" end)(key)
                    local keyset = ""
                    if mods and mods.alt   then keyset = keyset .. "A+" end
                    if mods and mods.ctrl  then keyset = keyset .. "C+" end
                    if mods and mods.meta  then keyset = keyset .. "M+" end
                    if mods and mods.shift then keyset = keyset .. "S+" end
                    keyset = keyset .. (defSym or "")
                    actions = Spring.GetKeyBindings(keyset)
                end
                if not (actions and #actions > 0) then return false end
                -- Claim consumption as soon as we *dispatch* a bound action,
                -- regardless of its return value. ZK widgets routinely omit
                -- "return true" from their action handlers (gui_epicmenu's
                -- ActionSubmenu just toggles the menu and falls through),
                -- but the user clearly meant for the keypress to do that —
                -- not to fall through to the engine widget-list overlay.
                local dispatched = false
                for i = 1, #actions do
                    local cmd, opts = next(actions[i])
                    if cmd then
                        local line = (opts and opts ~= "") and (cmd .. " " .. opts) or cmd
                        local ok = pcall(ah.TextAction, self, line)
                        if ok then dispatched = true end
                    end
                end
                return dispatched
            end
        end
    `, 'keyaction_textaction_bridge');

    // EPIC menu submenu watchdog. The user-visible bug is that clicking
    // any epicmenu top-bar button (Main Menu, Game, Help, ...) runs the
    // OnClick listener (we can see ActionSubmenu in the trace) but no
    // submenu Window appears.
    //
    // We can't trace MakeSubWindow easily because it's a *file-local* in
    // gui_epicmenu (forward-declared, then assigned). But every chili
    // OnClick listener resolves `ActionSubmenu` against the widget's
    // _ENV (the widget table, since cawidgets calls
    // setfenv(chunk, widget)). So replacing `widget.ActionSubmenu` on
    // the EPIC Menu widget table redirects every menubar click to our
    // wrapper. The wrapper logs a one-line probe and force-attaches the
    // freshly created `widget.window_sub_cur` to screen0 if Window:New's
    // parent kwarg didn't add it. Defensive belt-and-suspenders for the
    // case where the wrapped/unwrapped screen0 reference resolves to a
    // different hardlink than the renderer iterates.
    //
    // Logging is rate-limited to the first three submenu events so a
    // chat-driven open/close cycle doesn't spam the console.
    runtime.doString(`
        WG = WG or {}
        WG._submenuWatchdog = WG._submenuWatchdog or {
            installed = false,
            logged = 0,
            maxLog = 3,
        }

        local function probeWindow(label, win)
            if not win then return end
            local screen = WG.Chili and WG.Chili.Screen0 or nil
            local found = false
            local nKids = 0
            if screen and screen.children then
                local kids = screen.children
                nKids = #kids
                for i = 1, nKids do
                    local k = kids[i]
                    if k == win then
                        found = true
                        break
                    end
                end
            end
            local wd = WG._submenuWatchdog
            if wd.logged < wd.maxLog then
                wd.logged = wd.logged + 1
                local msg = string.format(
                    "[epicmenu] %s name=%s class=%s xy=%s,%s wh=%sx%s visible=%s hidden=%s screenKids=%d inScreen=%s",
                    tostring(label),
                    tostring(win.name), tostring(win.classname),
                    tostring(win.x), tostring(win.y),
                    tostring(win.width), tostring(win.height),
                    tostring(win.visible), tostring(win.hidden),
                    nKids, tostring(found))
                Spring.Log("LuaUI", 2, msg)
            end

            -- Defensive: if the new window isn't in screen0.children
            -- despite passing parent = screen0 to Window:New, force-add.
            -- This only triggers when the symptom is reproducing, so it
            -- doesn't fight a healthy code path.
            if screen and not found and screen.AddChild then
                pcall(screen.AddChild, screen, win)
                if win.BringToFront then pcall(win.BringToFront, win) end
                if wd.logged <= wd.maxLog then
                    Spring.Log("LuaUI", 2, "[epicmenu] re-attached " ..
                        tostring(win.name) .. " to screen0")
                end
            end
            if win.hidden and win.Show then pcall(win.Show, win) end
        end

        local function findEpicMenu()
            if not widgetHandler or not widgetHandler.widgets then return nil end
            for _, w in ipairs(widgetHandler.widgets) do
                if w and w.whInfo and w.whInfo.name == "EPIC Menu" then
                    return w
                end
            end
            return nil
        end

        local function ensureWatchdog()
            if WG._submenuWatchdog.installed then return end
            local w = findEpicMenu()
            if not w then return end
            -- file-local in epicmenu, not a widget-table key. We can't
            -- reach MakeSubWindow directly. But ActionSubmenu IS exposed
            -- on the widget _ENV (top-level "function ActionSubmenu(...)"
            -- with setfenv → widget). Wrap it; every menubar OnClick
            -- closure resolves the name through _ENV at call time.
            if type(w.ActionSubmenu) ~= "function" then return end

            local orig = w.ActionSubmenu
            w.ActionSubmenu = function(_, submenu)
                local ok, err = pcall(orig, _, submenu)
                if not ok then
                    Spring.Log("LuaUI", 2, "[epicmenu] ActionSubmenu error: " ..
                        tostring(err))
                end
                if w.window_sub_cur then
                    probeWindow("ActionSubmenu submenu=" .. tostring(submenu),
                        w.window_sub_cur)
                else
                    local wd = WG._submenuWatchdog
                    if wd.logged < wd.maxLog then
                        wd.logged = wd.logged + 1
                        Spring.Log("LuaUI", 2,
                            "[epicmenu] ActionSubmenu returned with no window (submenu=" ..
                            tostring(submenu) .. ")")
                    end
                end
            end
            -- Same shape for ActionExitWindow / ActionMenu, both feed
            -- through MakeSubWindow.
            for _, fname in ipairs({ "ActionExitWindow", "ActionMenu" }) do
                local origFn = rawget(w, fname)
                if type(origFn) == "function" then
                    rawset(w, fname, function(...)
                        local ok, err = pcall(origFn, ...)
                        if not ok then
                            Spring.Log("LuaUI", 2,
                                "[epicmenu] " .. fname .. " error: " .. tostring(err))
                        end
                        if w.window_sub_cur then
                            probeWindow(fname, w.window_sub_cur)
                        end
                    end)
                end
            end
            WG._submenuWatchdog.installed = true
            Spring.Echo("[LuaUI] epicmenu submenu watchdog installed")
        end
        WG._submenuWatchdog.ensure = ensureWatchdog

        -- Try right now (epicmenu's Initialize runs during cawidgets bulk
        -- load, which has finished by the time post-bootstrap doStrings
        -- run). If the widget hasn't loaded yet — e.g. the user toggled
        -- it off and re-enabled it — wrap actionHandler.AddAction so we
        -- catch the next "crudesubmenu" registration.
        if widgetHandler and widgetHandler.actionHandler
                and widgetHandler.actionHandler.AddAction then
            local ah = widgetHandler.actionHandler
            local origAdd = ah.AddAction
            ah.AddAction = function(self, addon, cmd, func, data, types)
                local ret = origAdd(self, addon, cmd, func, data, types)
                if cmd == "crudesubmenu" then
                    pcall(ensureWatchdog)
                end
                return ret
            end
        end
        pcall(ensureWatchdog)
    `, 'epicmenu_submenu_watchdog');

    // Fix Chili TaskHandler queue desync: fengari's weak table GC
    // collects entries from the TaskHandler's objects/objects2 queues
    // before Update() processes them. This causes controls to be stuck
    // with __inUpdateQueue=true but not in any queue, so they never get
    // their Update() called and never create display lists.
    //
    // Fix: remove __mode="v" from the queue tables (make them strong)
    // and install a per-frame repair that resets stuck controls.
    runtime.doString(`
        -- Deferred: runs after first DrawGenesis when WG.Chili exists
        _chiliTaskFix = function()
            if not WG or not WG.Chili then return false end
            local th = WG.Chili.TaskHandler
            if not th then return false end

            -- Remove weak-table mode from TaskHandler's internal tables.
            -- We can't access the locals directly, but we can patch
            -- RequestUpdate to use strong tables instead.
            local strongQueue = {}
            local strongQueue2 = {}
            local strongCount = 0
            local strongInstant = {}
            local strongInstant2 = {}
            local strongInstantCount = 0

            local origRequestUpdate = th.RequestUpdate
            local origRequestInstant = th.RequestInstantUpdate
            local origRemoveObject = th.RemoveObject
            local origUpdate = th.Update

            local _reqLog = 0
            th.RequestUpdate = function(obj)
                obj = (type(obj) == "table" and obj.__target) and obj.__target or obj
                if not obj.__inUpdateQueue then
                    obj.__inUpdateQueue = true
                    strongCount = strongCount + 1
                    strongQueue[strongCount] = obj
                    _reqLog = _reqLog + 1
                    if _reqLog <= 20 then
                        Spring.Echo("[TaskHandler] RequestUpdate: " .. tostring(obj.name or obj.classname) .. " count=" .. strongCount)
                    end
                end
            end

            th.RequestInstantUpdate = function(obj)
                obj = (type(obj) == "table" and obj.__target) and obj.__target or obj
                if not obj.__inUpdateQueue then
                    obj.__inUpdateQueue = true
                    strongInstantCount = strongInstantCount + 1
                    strongInstant[strongInstantCount] = obj
                end
            end

            th.RemoveObject = function(obj)
                obj = (type(obj) == "table" and obj.__target) and obj.__target or obj
                -- Call original for globalDisposeListeners
                pcall(origRemoveObject, obj)
                -- Also remove from our strong queue
                if obj.__inUpdateQueue then
                    obj.__inUpdateQueue = false
                    for i = 1, strongCount do
                        if strongQueue[i] == obj then
                            strongQueue[i] = strongQueue[strongCount]
                            strongQueue[strongCount] = nil
                            strongCount = strongCount - 1
                            return true
                        end
                    end
                end
                return false
            end

            th.Update = function()
                -- Process type1 queue
                local cnt = strongCount
                if cnt > 0 then
                    Spring.Echo("[TaskHandler] Processing " .. cnt .. " queued controls")
                end
                strongCount = 0
                strongQueue, strongQueue2 = strongQueue2, strongQueue
                for i = 1, cnt do
                    local obj = strongQueue2[i]
                    strongQueue2[i] = nil  -- clear processed entry
                    if obj and not obj.disposed then
                        obj.__inUpdateQueue = false
                        local Update = obj.Update
                        if Update then
                            local ok, err = pcall(Update, obj)
                            if not ok then
                                Spring.Echo("[TaskHandler] Update error on " .. tostring(obj.name or obj.classname) .. ": " .. tostring(err):sub(1,100))
                            end
                        end
                    end
                end

                -- Process type2 (instant) queue
                local runCounter = 0
                while strongInstantCount > 0 do
                    local icnt = strongInstantCount
                    strongInstantCount = 0
                    strongInstant, strongInstant2 = strongInstant2, strongInstant
                    for i = 1, icnt do
                        local obj = strongInstant2[i]
                        strongInstant2[i] = nil
                        if obj and not obj.disposed then
                            obj.__inUpdateQueue = false
                            local InstantUpdate = obj.InstantUpdate
                            if InstantUpdate then
                                pcall(InstantUpdate, obj)
                            end
                        end
                    end
                    runCounter = runCounter + 1
                    if runCounter > 20 then break end
                end
            end

            -- Reset all stuck controls and re-enqueue them
            local s = WG.Chili.Screen0
            if s then
                local function resetTree(ctrl)
                    if ctrl.__inUpdateQueue then
                        ctrl.__inUpdateQueue = false
                    end
                    if ctrl.children then
                        for _, child in ipairs(ctrl.children) do
                            if type(child) == "table" then
                                resetTree(child)
                            end
                        end
                    end
                end
                resetTree(s)
                -- Invalidate to trigger re-enqueue
                if s.Invalidate then pcall(s.Invalidate, s) end
                for _, c in ipairs(s.children or {}) do
                    if c.Invalidate then pcall(c.Invalidate, c) end
                end
            end

            -- Configure texture search paths so short texture names (like
            -- ":cl:panel_0011_small.png") resolve to the right skin folder.
            -- The bridge tries paths in order and uses the FIRST one that
            -- yields a valid texture, so list the active skin first; then
            -- the default skin (a fallback for textures the active skin
            -- doesn't override); then every other skin in case of cross-
            -- skin references. Without active-skin priority, Carbon (the
            -- first iterator entry) overrides Evolved's same-named files,
            -- and the Evolved skin's tile coordinates (e.g. 175,1,102,10
            -- for a 440×32 texture) end up slicing Carbon's 32×32 file —
            -- which is what made the menubar / commands / eco panel
            -- backgrounds render as garbled stripes instead of a slab.
            local sh = WG.Chili.SkinHandler
            local activeName = WG.Chili.theme and WG.Chili.theme.skin
                and WG.Chili.theme.skin.general
                and WG.Chili.theme.skin.general.skinName
            local activeDir = nil
            if sh and sh.knownSkins and activeName then
                local s = sh.knownSkins[activeName] or sh.knownSkins[tostring(activeName):lower()]
                if s and s.info and s.info.dir then activeDir = s.info.dir end
            end
            if activeDir then _addTextureSearchPath(activeDir) end
            _addTextureSearchPath((WG.Chili.CHILI_DIRNAME or "LuaUI/Widgets/chili_old/") .. "skins/default/")
            _addTextureSearchPath(WG.Chili.SKIN_DIRNAME or "LuaUI/Widgets/chili_old/skins/")
            if sh and sh.knownSkins then
                for _, skin in pairs(sh.knownSkins) do
                    if type(skin) == "table" and skin.info and skin.info.dir
                            and skin.info.dir ~= activeDir then
                        _addTextureSearchPath(skin.info.dir)
                    end
                end
            end

            Spring.Echo("[LuaUI] TaskHandler patched: strong queues, " .. tostring(strongCount) .. " controls enqueued")
            _chiliTaskFix = nil  -- run once
            return true
        end
    `, 'taskhandler_fix');

    // 8. Start frame loop (30fps — matches Spring's GAME_SPEED)
    // Guard against re-entry: if a previous frame is still running
    // (e.g. a widget's Update is slow), skip rather than stacking.
    // GW4-c6: in shared mode the gp render loop drives the UI pass
    // (gpRunUiPass) after scene.render() instead — DO NOT start the
    // independent setInterval (it would clear/draw the shared framebuffer
    // out of sync with Babylon). Hand the gl + active flag to the gp loop.
    if (sharedGl) {
        gpCtx.uiGl = sharedGl;
        gpCtx.luaUiActive = true;
    } else {
        let frameRunning = false;
        frameInterval = setInterval(() => {
            if (!runtime || shuttingDown || frameRunning) return;
            frameRunning = true;
            try {
                runFrame(runtime, gl);
            } finally {
                frameRunning = false;
            }
        }, 33);
    }

    // Report which callins widgets registered so main thread only sends needed events
    const registeredCallins = getRegisteredCallins(runtime);
    postToMain({ type: 'ready', fileCount: vfsFiles.size, callins: registeredCallins });
}

export function runFrame(rt: LuaRuntime, gl: WebGL2RenderingContext, clearColor = true, worldPass = false): void {
    // N3: reset the immediate renderer's per-pass GL state shadow. Babylon's
    // world render (and gpRunUiPass's outer save/restore) leaves different
    // program/VAO/buffer bindings between passes, so the first flush of this
    // pass must re-issue all state rather than trust last pass's shadow.
    bridge?.beginImmediatePass();
    // Set up GL state for 2D overlay rendering
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    // GW4-c6: in shared mode (clearColor=false) the 3D world has already been
    // drawn into this same framebuffer — clearing color here would erase it.
    // The legacy private-overlay context owns its buffer and clears each frame.
    if (clearColor) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    // U3c: re-run RenderToTexture bakes whose async textures finished loading
    // since last frame (a bake that sampled a still-loading texture captured
    // its magenta placeholder — BAR top-bar icons). Runs here, after the 2D
    // baseline above, so the re-bake sees the same GL state as the widget's
    // own DrawScreen-time bake.
    bridge?.runPendingRebakes();

    // Callins: Update → GameFrame (per-tick) → DrawGenesis → DrawScreen
    rt.doString(`
        -- PLAN-perf N1: while the widget profiler is active (__wprof set by
        -- widget-profiler.ts via window.test.uiProfileStart) accumulate
        -- per-block wall time so the Fengari slice of the LuaUI pass can be
        -- attributed. Zero cost when not profiling (_wp is nil).
        local _wp = __wprof
        local _wpNow = _wp and _SpringWebPerfNow
        local _wpT0 = _wp and _wpNow()
        local function _wpAdd(k, t)
            _wp.blocks[k] = (_wp.blocks[k] or 0) + (_wpNow() - t)
        end
        local _wpT

        -- Deferred Chili TaskHandler patch (runs once after WG.Chili exists)
        if _chiliTaskFix then _chiliTaskFix() end

        if _wp then _wpT = _wpNow() end
        if Update then pcall(Update) end
        if _wp then _wpAdd('update', _wpT) end

        if _wp then _wpT = _wpNow() end
        -- GameStart dispatch (fires once). Spring fires widget:GameStart at
        -- frame 1; we fire the first time the worker observes frame >= 1.
        -- A late-booting worker that first sees a higher frame still fires
        -- once — matching Spring's "missed it, fire on first opportunity"
        -- behaviour for widgets loaded after the countdown.
        do
            local f = (Spring.GetGameFrame and Spring.GetGameFrame()) or 0
            if f >= 1 and not _gameStartFired then
                _gameStartFired = true
                if widgetHandler and widgetHandler.GameStart then
                    pcall(widgetHandler.GameStart, widgetHandler)
                end
                if _SpringWebRunGadgetCallin then
                    pcall(_SpringWebRunGadgetCallin, 'GameStart')
                end
            end
        end

        -- GameFrame dispatch. Server entity-state messages bump
        -- liveState.gameFrame; we forward the latest frame through to
        -- widgetHandler:GameFrame so widgets that gate on the modulo
        -- (chili Economy Panel reads n%TEAM_SLOWUPDATE_RATE, ZK Core
        -- Selector reads n%UNIT_SLOWUPDATE_RATE, etc.) actually get
        -- ticked. We only fire when the frame advances, so the worker
        -- doesn't spam GameFrame on rAF when the sim is paused.
        do
            local f = (Spring.GetGameFrame and Spring.GetGameFrame()) or 0
            local last = _lastDispatchedGameFrame or -1
            if f > last then
                _lastDispatchedGameFrame = f
                if widgetHandler and widgetHandler.GameFrame then
                    pcall(widgetHandler.GameFrame, widgetHandler, f)
                end
                -- PLAN-weapon-fx Z1.5 — fan-out to gadget unsynced halves
                -- that registered \`function gadget:GameFrame(n)\`. The
                -- handler is installed by GADGET_HANDLER_LUA before any
                -- gadget loads.
                if _SpringWebRunGadgetGameFrame then
                    pcall(_SpringWebRunGadgetGameFrame, f)
                end
            end
        end
        if _wp then _wpAdd('gameFrame', _wpT) end

        if _wp then _wpT = _wpNow() end
        -- PLAN.md Stage B1 (faithful projectile lights). Run the deferred-light
        -- collectors ZK registered via WG.DeferredLighting_RegisterFunction
        -- (gfx_projectile_lights.lua, gfx_unit_lights.lua), thread the standard
        -- (beamLights, beamCount, pointLights, pointCount) accumulators across
        -- them, then flatten to two fixed-stride comma strings and hand them to
        -- _SpringWebEmitDeferredLights for the forward FxLightPool. colMult is
        -- pre-applied here so the main thread consumes final colours. Point
        -- stride 7: px,py,pz,r,g,b,radius. Beam stride 10: + dx,dy,dz.
        do
            local collectors = __deferredLightCollectors
            if collectors and #collectors > 0 and _SpringWebEmitDeferredLights then
                local beamLights, beamCount, pointLights, pointCount = {}, 0, {}, 0
                for i = 1, #collectors do
                    local ok, bl, bc, pl, pc = pcall(
                        collectors[i], beamLights, beamCount, pointLights, pointCount)
                    if ok and pc ~= nil then
                        beamLights, beamCount, pointLights, pointCount = bl, bc, pl, pc
                    end
                end
                local pParts, bParts = {}, {}
                for i = 1, pointCount do
                    local L = pointLights[i]
                    local pr = type(L) == "table" and L.param
                    if pr then
                        local cm = L.colMult or 1
                        pParts[#pParts + 1] = string.format(
                            "%.2f,%.2f,%.2f,%.3f,%.3f,%.3f,%.1f",
                            L.px or 0, L.py or 0, L.pz or 0,
                            (tonumber(pr.r) or 0) * cm,
                            (tonumber(pr.g) or 0) * cm,
                            (tonumber(pr.b) or 0) * cm,
                            tonumber(pr.radius) or 0)
                    end
                end
                for i = 1, beamCount do
                    local L = beamLights[i]
                    local pr = type(L) == "table" and L.param
                    if pr then
                        local cm = L.colMult or 1
                        bParts[#bParts + 1] = string.format(
                            "%.2f,%.2f,%.2f,%.3f,%.3f,%.3f,%.1f,%.2f,%.2f,%.2f",
                            L.px or 0, L.py or 0, L.pz or 0,
                            (tonumber(pr.r) or 0) * cm,
                            (tonumber(pr.g) or 0) * cm,
                            (tonumber(pr.b) or 0) * cm,
                            tonumber(pr.radius) or 0,
                            L.dx or 0, L.dy or 0, L.dz or 0)
                    end
                end
                _SpringWebEmitDeferredLights(
                    table.concat(pParts, ";"), table.concat(bParts, ";"))
            end
        end
        if _wp then _wpAdd('lightFlatten', _wpT) end

        if _wp then _wpT = _wpNow() end
        if DrawGenesis then pcall(DrawGenesis) end
        if _wp then _wpAdd('drawGenesis', _wpT) end

        if _wp then _wpT = _wpNow() end

        -- Force-update any Chili controls stuck without display lists.
        -- The TaskHandler queue loses entries due to fengari's weak table
        -- GC behavior. This brute-force walk runs once per second (not
        -- every frame) to keep overhead low.
        if WG and WG.Chili and WG.Chili.Screen0 then
            _chiliFixTimer = (_chiliFixTimer or 0) + 1
            if _chiliFixTimer % 30 == 1 then  -- every ~1 second at 30fps
                local s = WG.Chili.Screen0

                -- Fix orphaned controls: AddChild sometimes fails to set
                -- parent (fengari table identity issue). Without parent,
                -- IsInView() returns false and Update() skips dlist creation.
                for _, c in ipairs(s.children or {}) do
                    if type(c) == "table" and c.parent == nil then
                        c.parent = s
                        c._needRedraw = true
                        c.__inUpdateQueue = false
                    end
                end

                local function fixTree(ctrl, depth)
                    if depth > 10 then return end
                    if ctrl._needRedraw and ctrl.visible and not ctrl._own_dlist
                       and ctrl.parent and ctrl.Update then
                        ctrl.__inUpdateQueue = false
                        pcall(ctrl.Update, ctrl)
                    end
                    if ctrl.children then
                        for _, ch in ipairs(ctrl.children) do
                            if type(ch) == "table" then fixTree(ch, depth + 1) end
                        end
                    end
                end
                pcall(fixTree, s, 0)
            end

            -- Rebuild display lists when async skin textures resolve. Chili
            -- records skin 9-slice UVs from gl.TextureInfo, which reports the
            -- 1x1 placeholder until the real texture arrives; a dlist recorded
            -- before then bakes stale UVs (a tiled grid instead of a seamless
            -- frame). The gl bridge bumps a monotonic counter on every resolved
            -- async load; whenever it advances we invalidate every control's
            -- cached lists so Chili re-records at correct dimensions. This
            -- self-heals late loads (superseding the old one-shot 3s rebuild)
            -- and is debounced to at most ~once per 15 frames so a burst of
            -- streaming loads at boot doesn't thrash. (PLAN-perf N2, bug #2.)
            local texGen = (gl._textureLoadGeneration and gl._textureLoadGeneration()) or 0
            if texGen ~= _chiliTexGen
               and (_chiliFixTimer - (_chiliTexRebuildFrame or -100)) >= 15 then
                _chiliTexGen = texGen
                _chiliTexRebuildFrame = _chiliFixTimer
                -- Invalidate all controls so Chili fully rebuilds every
                -- display list (_own_dlist, _all_dlist, _children_dlist).
                -- Control:Draw short-circuits on _all_dlist, so just
                -- rebuilding _own_dlist is not enough.
                local function invalidateAll(ctrl, depth)
                    if depth > 12 then return end
                    if ctrl._all_dlist then gl.DeleteList(ctrl._all_dlist); ctrl._all_dlist = nil end
                    if ctrl._own_dlist then gl.DeleteList(ctrl._own_dlist); ctrl._own_dlist = nil end
                    if ctrl._children_dlist then gl.DeleteList(ctrl._children_dlist); ctrl._children_dlist = nil end
                    ctrl._needRedraw = true
                    ctrl.__inUpdateQueue = false
                    for _, ch in ipairs(ctrl.children or {}) do
                        if type(ch) == "table" then invalidateAll(ch, depth + 1) end
                    end
                end
                pcall(invalidateAll, s, 0)
            end
        end
        if _wp then _wpAdd('chiliFix', _wpT) end

        if _wp then _wpT = _wpNow() end
        -- GW4-c6-2: world-space pass. The 3D world (terrain + units) is already
        -- in this framebuffer with its depth buffer; load the camera matrices,
        -- enable depth so overlays occlude behind hills/units, and run the
        -- DrawWorld callins. widgetHandler exposes _G.DrawWorldPreUnit/_G.DrawWorld
        -- when a widget registers them (same mechanism as DrawScreen). Spring
        -- runs PreUnit before units; we can't interleave with Babylon's render,
        -- so both run after the world (PreUnit draws on top — accepted deviation).
        if ${worldPass ? 'true' : 'false'} and (DrawWorldPreUnit or DrawWorld) then
            gl.MatrixMode(GL.PROJECTION)
            gl.LoadMatrix("projection")
            gl.MatrixMode(GL.MODELVIEW)
            gl.LoadMatrix("view")
            gl.DepthTest(true)
            gl.Texture(false)
            gl.Color(1, 1, 1, 1)
            if DrawWorldPreUnit then pcall(DrawWorldPreUnit) end
            if DrawWorld then pcall(DrawWorld) end
            gl.DepthTest(false)
            -- Unbind any custom shader a world widget left active (e.g. if it
            -- errored before its own gl.UseShader(0)) so it can't leak into the
            -- DrawScreen chili pass — the bridge clears the immediate-mode
            -- shader override here.
            gl.UseShader(0)
            -- Reset matrices so the DrawScreen block's Ortho setup starts clean.
            gl.MatrixMode(GL.PROJECTION)
            gl.LoadIdentity()
            gl.MatrixMode(GL.MODELVIEW)
            gl.LoadIdentity()
        end
        if _wp then _wpAdd('drawWorld', _wpT) end

        if _wp then _wpT = _wpNow() end
        if DrawScreen then
            local vsx, vsy = Spring.GetViewSizes()
            -- Spring's DrawScreen uses Y-up ortho (y=0 at bottom).
            -- Chili internally does Translate(0,vsy,0)+Scale(1,-1,1) to
            -- flip to its Y-down coordinate system. Using the wrong ortho
            -- causes a double-flip that inverts textures and positions.
            gl.MatrixMode(GL.PROJECTION)
            gl.LoadIdentity()
            gl.Ortho(0, vsx, 0, vsy, -1, 1)
            gl.MatrixMode(GL.MODELVIEW)
            gl.LoadIdentity()
            -- Reset sticky GL state from previous frame. Chili widgets bind
            -- skin textures, set scissor regions, etc. and frequently leave
            -- them set when they return. The next frame's first widget then
            -- sees the leftovers — gl.Rect samples the wrong texture, draws
            -- get scissored away, and the result is "invisible" output.
            gl.Texture(false)
            gl.Scissor(false)
            gl.DepthTest(false)
            gl.Color(1, 1, 1, 1)
            pcall(DrawScreen, vsx, vsy)
        end
        if _wp then
            _wpAdd('drawScreen', _wpT)
            -- Whole-chunk wall time. The JS-measured runFrame duration minus
            -- this is the per-frame compile + doString dispatch overhead
            -- (this chunk is re-parsed every frame).
            _wpAdd('chunkExec', _wpT0)
            _wp.frames = _wp.frames + 1
        end
    `, 'callin:frame');
}

// ── Engine globals ─────────────────────────────────────────────────────

export function installEngineGlobals(
    rt: LuaRuntime,
    glBridge: LuaGLBridge,
    ctx: SpringAPIContext,
    gameId: string,
): void {
    // Tripwire (no-silent-failures): Game.maxUnits is the unit/feature ID-space
    // boundary that must match the server's unitHandler.MaxUnits() exactly, or
    // feature-targeted orders misdecode. It's streamed via GameInfo.max_units,
    // sent reliably on auth so it should be in liveState before this boot. If
    // it isn't, the Game table falls back to MAX_UNITS=32000 — surface the race
    // loudly rather than ship a silently-wrong boundary. See PLAN-bar.md.
    if (liveState.maxUnits <= 0) {
        postLog(1, '[LuaUI] WARN Game.maxUnits: GameInfo.max_units not received ' +
            'before LuaUI boot — using MAX_UNITS=32000 fallback; feature-targeted ' +
            'order IDs may misdecode if the server uses a different value (PLAN-bar.md).');
    }
    const springGlobals = buildSpringGlobals(ctx, liveState);
    const glGlobal = glBridge.buildGlGlobal();

    // Override Spring.Echo to route to main thread
    (springGlobals.Spring as Record<string, LuaValue>).Echo =
        (...args: LuaValue[]) => {
            const msg = args.map(a => String(a ?? '')).join('\t');
            const level = msg.includes('error') || msg.includes('Error') ? 4
                : msg.includes('warn') || msg.includes('Warn') ? 3 : 2;
            postLog(level, msg);
        };

    // Spring.Translate — i18n stub that returns the key.
    // Must be set BEFORE setGlobal — the Lua table is a snapshot of the JS
    // object at push time; later JS mutations are not reflected.
    (springGlobals.Spring as Record<string, LuaValue>).Translate = (key: LuaValue) => String(key ?? '');
    (springGlobals.Spring as Record<string, LuaValue>).GetHumanName = (defName: LuaValue) => String(defName ?? '');
    // Spring.Orig is installed Lua-side after setGlobal (see post-install
    // doString below) — assigning it here would create a JS object cycle
    // (Spring.Orig === Spring) and pushValue's recursive traversal has no
    // cycle detection, so it would stack-overflow during init.
    // Stubs for Spring APIs ZK widgets call at Initialize-time.
    // Returning nothing is fine — these widgets gate on the result.
    (springGlobals.Spring as Record<string, LuaValue>).GetAIInfo = (_team: LuaValue) => [-1, '', '', '', '', {}];
    (springGlobals.Spring as Record<string, LuaValue>).GetSkirmishAIInfo = (_team: LuaValue) => [-1, '', '', '', '', {}];
    // Spring.AssignMouseCursor(name, file, hotspotX?, hotspotY?, overwrite?)
    // — register a cursor file under a logical name. ZK widgets call this
    // at Initialize-time to swap in their own animated PNG packs over the
    // engine defaults. We post the assignment to main thread which keeps
    // the AnimatedCursor's per-name table in sync.
    (springGlobals.Spring as Record<string, LuaValue>).AssignMouseCursor = (
        name: LuaValue, file: LuaValue,
        hotX: LuaValue, hotY: LuaValue, overwrite: LuaValue,
    ) => {
        const n = String(name ?? '');
        const f = String(file ?? '');
        if (!n || !f) return false;
        postToMain({
            type: 'assignMouseCursor',
            name: n, file: f,
            hotspotX: typeof hotX === 'number' ? hotX : null,
            hotspotY: typeof hotY === 'number' ? hotY : null,
            overwrite: overwrite === undefined ? true : !!overwrite,
        });
        return true;
    };
    // Spring.ReplaceMouseCursor — Spring documents this as a synonym for
    // AssignMouseCursor with overwrite=true. Same forwarding path.
    (springGlobals.Spring as Record<string, LuaValue>).ReplaceMouseCursor = (
        name: LuaValue, file: LuaValue,
        hotX: LuaValue, hotY: LuaValue,
    ) => {
        const n = String(name ?? '');
        const f = String(file ?? '');
        if (!n || !f) return false;
        postToMain({
            type: 'assignMouseCursor',
            name: n, file: f,
            hotspotX: typeof hotX === 'number' ? hotX : null,
            hotspotY: typeof hotY === 'number' ? hotY : null,
            overwrite: true,
        });
        return true;
    };
    // Spring.SetMouseCursor(name) — switch the active cursor. Pass empty
    // string / nil to revert to the native arrow.
    (springGlobals.Spring as Record<string, LuaValue>).SetMouseCursor = (name: LuaValue) => {
        postToMain({ type: 'setMouseCursor', name: name == null ? '' : String(name) });
    };
    (springGlobals.Spring as Record<string, LuaValue>).SetDrawSelectionInfo = (_show: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).SetDrawGroundDeprecated = (_show: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).GetFrameTimeOffset = () => 0;
    (springGlobals.Spring as Record<string, LuaValue>).IsGodModeEnabled = () => false;
    // ── Map-rendering runtime setters (LuaUnsyncedCtrl) ──────────────
    // BAR's lighting/water/atmosphere adjuster widgets (gui_options,
    // map_lighting_adjuster, …) drive these ~96× to retune the scene at
    // runtime. They're client-only rendering (sanctioned deviation — see
    // feedback_lighting_client_only). Sun lighting + sun direction now apply
    // to the live sun/ambient/CSM by merging into gpCtx.mapLighting and re-running
    // applyMapLighting (the same mapping the authored mapinfo.lua uses, so
    // there is one code path). Atmosphere/water/maprendering stay loud no-ops
    // until the underlying renderer features exist (no fog/water/splat path
    // yet — PLAN.md Stage 1). postLog de-dupes so the standins warn ~once.

    // Spring.SetSunLighting{groundAmbientColor=…, unitDiffuseColor=…, …}
    (springGlobals.Spring as Record<string, LuaValue>).SetSunLighting = (params: LuaValue) => {
        const { lighting, unknown } = mergeSunLighting(
            gpCtx.mapLighting, params as Record<string, LuaValue> | null);
        gpCtx.mapLighting = lighting;
        if (gpCtx.sceneLighting) applyMapLighting(lighting, gpCtx.sceneLighting);
        if (unknown.length) {
            postLog(2, `[Spring] SetSunLighting: ignored unknown key(s): ${unknown.join(', ')}`);
        }
        return undefined;
    };
    // Spring.SetSunDirection(x, y, z, intensity?)
    (springGlobals.Spring as Record<string, LuaValue>).SetSunDirection = (
        x: LuaValue, y: LuaValue, z: LuaValue, _intensity: LuaValue,
    ) => {
        gpCtx.mapLighting = setSunDirectionLighting(
            gpCtx.mapLighting, Number(x) || 0, Number(y) || 0, Number(z) || 0);
        if (gpCtx.sceneLighting) applyMapLighting(gpCtx.mapLighting, gpCtx.sceneLighting);
        return undefined;
    };

    // FIDELITY-STANDIN: atmosphere/water/maprendering have no live renderer
    // path yet (no fog tint, no water surface, no terrain splat controls).
    const mapRenderStandin = (fn: string) => (..._args: LuaValue[]) => {
        postLog(2, `[Spring] FIDELITY-STANDIN: ${fn} not applied to the live ` +
            `scene yet (no fog/water/splat renderer path — PLAN.md Stage 1); no-op.`);
        return undefined;
    };
    // Spring.SetAtmosphere{fogStart=…, fogColor={…}, …} — merge into the GL
    // bridge's atmosphere store so a later gl.GetAtmosphere reads back the set
    // value (faithful Get/Set round-trip, Recoil LuaUnsyncedCtrl::SetAtmosphere).
    // The store is the read seam only — there is no fog/sky renderer path yet, so
    // the *visual* effect remains a FIDELITY-STANDIN (warned once below).
    (springGlobals.Spring as Record<string, LuaValue>).SetAtmosphere = (params: LuaValue) => {
        const unknown = glBridge.setAtmosphereParams(
            (params && typeof params === 'object' && !Array.isArray(params))
                ? params as Record<string, LuaValue> : null);
        postLog(2, `[Spring] FIDELITY-STANDIN: SetAtmosphere stored but not applied ` +
            `to the live scene (no fog/sky renderer path — PLAN.md Stage 1).`);
        if (unknown.length) {
            postLog(2, `[Spring] SetAtmosphere: ignored unknown key(s): ${unknown.join(', ')}`);
        }
        return undefined;
    };
    (springGlobals.Spring as Record<string, LuaValue>).SetWaterParams = mapRenderStandin('SetWaterParams');
    (springGlobals.Spring as Record<string, LuaValue>).SetMapRenderingParams = mapRenderStandin('SetMapRenderingParams');
    (springGlobals.Spring as Record<string, LuaValue>).SetCameraOffset = (_x: LuaValue, _y: LuaValue, _z: LuaValue, _tx: LuaValue, _ty: LuaValue, _tz: LuaValue) => undefined;
    // GetTeamStartPosition / GetAllyTeamStartBox are implemented in
    // buildSpringGlobals (lua-spring-api.ts), reading liveState fed by the
    // server's TeamStartInfo message — no stub override here (PLAN-bar.md §3b).
    (springGlobals.Spring as Record<string, LuaValue>).GetCurrentTooltip = () => '';
    (springGlobals.Spring as Record<string, LuaValue>).GetVisibleFeatures = (
        _allyTeamID: LuaValue,
        _radius: LuaValue,
        _icons: LuaValue,
        _geos: LuaValue,
    ) => luaTable();
    (springGlobals.Spring as Record<string, LuaValue>).GetConsoleBuffer = (_count: LuaValue) => luaTable();
    // GetTeamStatsHistory is now a real read in buildSpringGlobals (lua-spring-api.ts),
    // backed by liveState.teamStatsHistory (fed by the server's TeamStatsHistoryBatch
    // stream) with Recoil's alliance gate — no stub override here (PLAN-bar §6).

    // Spring.Utilities is intentionally NOT stubbed here. A game that ships its
    // own (BAR's common/springFunctions.lua → Gametype, Color, …) installs it
    // during bootstrap via `Spring.Utilities = Spring.Utilities or <theirs>`; a
    // pre-set empty {} here is truthy and makes that `or` keep our empty table,
    // dropping the game's helpers. Our fallback helpers are filled POST-bootstrap
    // (fill-missing) so the game's table wins. See "Post-bootstrap API patches".

    // Install all globals except VFS (set up separately in Lua)
    for (const [k, v] of Object.entries(springGlobals)) {
        if (k === 'VFS') continue;
        rt.setGlobal(k, v);
    }
    rt.setGlobal('gl', glGlobal);

    // Spring.Orig — snapshot of the unwrapped Spring.* callouts before
    // any widget hooks them. Real Spring exposes this so widgets can
    // bypass other widgets' wrappers. ZK's `lups.lua` calls
    // `Spring.Orig.GetViewGeometry()` at load time (line 183) and ZK's
    // `LuaRules/Utilities/function_override.lua` REPLACES
    // `Spring.GetViewGeometry` with a wrapper that calls
    // `Spring.Orig.GetViewGeometry()` — so Spring.Orig must be a
    // SHALLOW COPY, not a reference. `Spring.Orig = Spring` would make
    // the wrapper call itself and stack-overflow on first invocation.
    rt.doString(
        'local copy = {}\n' +
        'for k, v in pairs(Spring) do copy[k] = v end\n' +
        'Spring.Orig = copy\n',
        'engine_globals_spring_orig',
    );

    // gl.Utilities — table of helper draw functions used by some ZK widgets
    // (e.g. cmd_factory_plate_placer uses gl.Utilities.DrawCircle).
    // Must be set before the fallback metatable, which would auto-stub it
    // as a plain function.
    rt.doString(`
        gl.Utilities = {
            DrawCircle = function() end,
            DrawGroundCircle = function() end,
        }
    `, 'gl_utilities');

    // gl fallback metatable
    rt.doString(`
        setmetatable(gl, {
            __index = function(t, k)
                local stub = function(...) end
                rawset(t, k, stub)
                return stub
            end
        })
    `, 'gl_fallback');

    // Lua-side gl.CreateList: calls the function IN Lua so table arguments
    // (like `self`) keep their metatables. The JS-side createList loses
    // metatables during the readValue→pushValue round-trip, which breaks
    // gl.CreateList(self.DrawControl, self) — DrawControl receives a plain
    // table without methods.
    rt.doString(`
        gl.CreateList = function(fn, ...)
            if type(fn) ~= "function" then return 0 end
            gl._startRecording()
            local ok, err = pcall(fn, ...)
            local id = gl._stopRecording()
            if not ok then
                -- Partial recording is still valid (e.g. texture-only lists)
            end
            return id
        end
    `, 'gl_createlist_lua');

    rt.setGlobal('LUAUI_DIRNAME', 'LuaUI/');
    rt.setGlobal('LUAUI_VERSION', `spring-web LuaUI v0.3 (${gameId})`);

    // Spring engine constants exposed as Lua globals. Spring's LuaUI host
    // sets these via RegisterGlobals; widgets reference them in inner-loop
    // checks like `if n % TEAM_SLOWUPDATE_RATE ~= 0 then return end` (chili
    // Economy Panel) or `n % UNIT_SLOWUPDATE_RATE` (selector widgets).
    // Without them widget GameFrame callins error out silently and the UI
    // appears to "work" but the numbers never refresh.
    //   Values match upstream Spring (Sim/Misc/GlobalConstants.h):
    //     GAME_SPEED 30, TEAM_SLOWUPDATE_RATE 15, UNIT_SLOWUPDATE_RATE 15.
    //   LOS_PRECISION is 31 in mainline; we don't simulate fractional LOS,
    //   so the value mostly drives integer-modulo branching and 31 is fine.
    rt.setGlobal('GAME_SPEED', 30);
    rt.setGlobal('TEAM_SLOWUPDATE_RATE', 15);
    rt.setGlobal('UNIT_SLOWUPDATE_RATE', 15);
    rt.setGlobal('LOS_PRECISION', 31);
    rt.setGlobal('MAX_TEAMS', 255);
    rt.setGlobal('MAX_PLAYERS', 251);

    // Spring's host runs Lua 5.1 where numeric coercion in string.char
    // and string.format("%d"/"%i", ...) silently truncates floats;
    // fengari is Lua 5.3 and rejects them with "number has no integer
    // representation". ZK widgets routinely build inline color escapes
    // via `string.char(255, r*255, g*255, b*255)` (chili util's
    // color2incolor, Economy Panel's odEffStr at line 967, many overdrive
    // formatters) and call `("%i / %i"):format(stored, capacity)` with
    // float aggregates (Economy Panel line 1042). We patch the relevant
    // call sites in chili util.lua individually, but widget-authors
    // writing the same pattern keep hitting it. Wrap both globally to
    // floor the offending args — matches Spring's behaviour exactly and
    // unblocks any widget that ports the same pattern.
    //
    // Lua 5.1 also represents all numbers as the same "number" type and
    // uses `%.14g` for tostring — so `tostring(100.0)` is "100", not
    // "100.0". Lua 5.3 split number into integer/float subtypes; floats
    // always serialise with at least one decimal digit, which surfaces
    // as ugly "100.0" cost ribbons across every chili widget that
    // assigns numbers directly to `caption` or feeds them through `..`.
    // Restore Lua 5.1's `%.14g` formatting in the global tostring so
    // game widgets don't have to be patched per-author.
    rt.doString(`
        local _unpack = table.unpack or unpack

        local origChar = string.char
        string.char = function(...)
            local n = select('#', ...)
            local args = {...}
            for i = 1, n do
                local v = args[i]
                if type(v) == 'number' and v ~= math.floor(v) then
                    args[i] = math.floor(v)
                end
            end
            return origChar(_unpack(args, 1, n))
        end

        -- string.format integer specs: scan the format string for
        -- %d / %i / %x / %X / %o / %u / %c (width/flags allowed) and
        -- floor the matching positional args. Spring's Lua 5.1 always
        -- coerced; fengari's strict 5.3 errors on fractions.
        local origFormat = string.format
        string.format = function(fmt, ...)
            if type(fmt) ~= 'string' then return origFormat(fmt, ...) end
            local n = select('#', ...)
            local args = {...}
            local idx = 0
            for _ in fmt:gmatch('%%[%-%+%# 0]*[%d%.]*[diouxXc]') do
                idx = idx + 1
                if idx > n then break end
                local v = args[idx]
                if type(v) == 'number' and v ~= math.floor(v) then
                    args[idx] = math.floor(v)
                end
            end
            return origFormat(fmt, _unpack(args, 1, n))
        end

        -- tostring: Lua 5.1 used "%.14g" for numbers, which prints
        -- whole-valued floats as integers ("100", not "100.0"). Lua
        -- 5.3 prints floats with at least one fractional digit. The
        -- string-concat operator also dispatches through this path in
        -- fengari, so overriding tostring fixes both tostring(n) and
        -- n .. "" chains used by chili's Label:DrawInBox.
        local origTostring = tostring
        tostring = function(v)
            if type(v) == 'number' then
                if v ~= v then return 'nan' end
                if v == math.huge then return 'inf' end
                if v == -math.huge then return '-inf' end
                return origFormat('%.14g', v)
            end
            return origTostring(v)
        end
    `, 'string_lib_lua51_compat');

    rt.setGlobal('Script', {
        CreateScream: () => ({ func: null, _scream: { func: null } }),
        GetSynced: () => false,
        GetName: () => 'LuaUI',
        IsEngineMinVersion: () => true,
        UpdateCallIn: () => {},
    });

    // Script.LuaUI / Script.LuaRules / Script.LuaGaia — callable tables
    // with auto-stub methods. Widgets do Script.LuaUI.SomeCallin(...) to
    // call across handler boundaries.
    rt.doString(`
        local function makeScriptProxy()
            return setmetatable({}, {
                __index = function(t, k)
                    local stub = function(...) return false end
                    rawset(t, k, stub)
                    return stub
                end,
                __call = function() return {} end,
            })
        end
        Script.LuaUI = makeScriptProxy()
        Script.LuaRules = makeScriptProxy()
        Script.LuaGaia = makeScriptProxy()
    `, 'script_proxies');

    rt.setGlobal('LOG', { ERROR: 0, WARNING: 1, INFO: 2, DEBUG: 3 });

    // Platform table — GL4 widgets/gadgets gate on this. WebGL2 (GLSL ES
    // 3.00) cannot do GL4's compute/SSBO/geometry/bindless path, so
    // glHaveGL4 is explicitly false (PLAN-bar.md §4). It was previously
    // omitted and relied on `nil` reading falsy — correct for the common
    // `not Platform.glHaveGL4` / `~= true` gates, but a widget testing
    // `Platform.glHaveGL4 == false` would NOT self-disable on nil. Setting
    // it false also makes ZK/BAR's `cus_gl4.lua` print its own
    // "No GL4 support … disabling" notice (the authored self-disable), and
    // BAR units fall to the engine-default material. FIDELITY-STANDIN: GL4
    // content (BAR's CUS material, *_gl4 overlays) is absent, not wrong.
    rt.setGlobal('Platform', {
        glVersionShort: 'WebGL 2.0',
        glVersion: 'WebGL 2.0',
        glslVersionShort: '300',
        glslVersion: '300 es',
        gpuVendor: 'WebGL',
        gpuName: 'WebGL2',
        glHaveGL4: false,
        glSupportClipSpaceControl: false,
        glSupport24bitDepthBuffer: true,
        glSupportRestartPrimitive: false,
        glSupportFragDepthLayout: false,
        numCompressedTexFormats: 0,
        // FIDELITY-STANDIN: Recoil enumerates every OS-reported video mode per
        // display (rts/Rendering/GL/myGL.cpp → globalRenderingInfo); a browser
        // tab has no equivalent API (no display enumeration, no refresh-rate
        // query). This was entirely absent, so `ipairs(Platform.availableVideoModes)`
        // indexed nil and crashed BAR's cmd_resolution_switcher.lua on every boot
        // (PLAN-bar.md U5). Report the one "mode" we actually have — the live
        // canvas viewport — so the widget's resolution list is honest (one
        // entry) instead of absent (crash). hz is a guess (60): no cross-browser
        // API exposes display refresh rate.
        availableVideoModes: [{
            display: 1,
            displayName: '',
            w: liveState.viewport.width,
            h: liveState.viewport.height,
            bpp: 32,
            hz: 60,
        }],
    });

    // Publish whatever defs have already arrived (the def stream may
    // race the worker bootstrap; pending entries replay here).
    republishDefGlobals(rt);
    rt.setGlobal('FeatureDefs', {});
    rt.setGlobal('FeatureDefNames', {});

    rt.doString(CMD_GLOBALS_LUA, 'cmd_globals');

    // PLAN-weapon-fx Phase Z1.5 — install gadgetHandler stub before any
    // gadget unsynced halves load. Must be in place before camain.lua
    // bootstraps widgets (LuaUI doesn't touch gadgetHandler today, but
    // we want the global table to exist by the time any code references
    // it). The gadget *files* themselves are loaded later, after LUPS
    // boots, because most of them register GG.Lups.* sync actions and
    // need WG.Lups already present.
    rt.doString(GADGET_HANDLER_LUA, 'gadget_handler');

    rt.doString(`
        tracy = setmetatable({}, {
            __index = function() return function() end end
        })
    `, 'tracy_stub');

    rt.doString(LUA_COMPAT_SHIM, 'compat_shim');

    // Spring.Translate / GetHumanName fallbacks (Spring.*, harmless pre-bootstrap
    // so widgets that snapshot Spring before bootstrap see them). The
    // Spring.Utilities helpers are installed POST-bootstrap as a fill-missing
    // pass (see "Post-bootstrap API patches" below) — NOT here. A game that
    // ships its own Spring.Utilities (BAR's common/springFunctions.lua provides
    // Gametype, Color, etc.) does `Spring.Utilities = Spring.Utilities or
    // springFunctions.Utilities`, so any stub we set pre-bootstrap would discard
    // the game's full table. Creating it only post-bootstrap lets the game win.
    rt.doString(`
        if not Spring.Translate then
            Spring.Translate = function(key) return tostring(key or "") end
        end
        if not Spring.GetHumanName then
            Spring.GetHumanName = function(defName) return tostring(defName or "") end
        end
    `, 'spring_translate_stub');

    rt.setGlobal('os', {
        remove: () => [null, 'os.remove disabled in browser'],
        rename: () => [null, 'os.rename disabled in browser'],
        clock: () => performance.now() / 1000,
        time: () => Math.floor(Date.now() / 1000),
        date: (_fmt: LuaValue) => new Date().toISOString(),
        difftime: (t2: LuaValue, t1: LuaValue) => Number(t2 ?? 0) - Number(t1 ?? 0),
    });

    // io/loadfile stubs
    installIOStubs(rt, gameId);
}

export function installIOStubs(rt: LuaRuntime, gameId: string): void {
    const storagePrefix = `luaui:${gameId}:`;

    rt.doString(`
        local _storagePrefix = "${escapeLuaString(storagePrefix)}"

        function loadfile(path)
            if not path then return nil, "no path" end
            local source = VFS._writeCache and (VFS._writeCache[path] or VFS._writeCache[path:lower()])
            if not source then
                local stored = _loadFromStorage(_storagePrefix .. path)
                if stored then source = stored end
            end
            if not source and VFS and VFS.LoadFile then
                -- Fall through to the VFS so loadfile() reaches prefetched
                -- archive content (LuaRules/Gadgets/*.lua etc.), not just
                -- runtime-written files. Without this Z1.5's unsynced
                -- gadget loader silently fails for every candidate.
                source = VFS.LoadFile(path)
            end
            if not source then
                return nil, "file not found: " .. path
            end
            return load(source, path, "t")
        end

        function dofile(path)
            local chunk, err = loadfile(path)
            if not chunk then error(err, 2) end
            return chunk()
        end
    `, 'loadfile_shim');

    rt.setGlobal('_loadFromStorage', (key: LuaValue) => {
        return loadFromStorage(String(key));
    });
    rt.setGlobal('_saveToStorage', (key: LuaValue, value: LuaValue) => {
        saveToStorage(String(key), String(value));
    });
    // VFS storage fallback (PLAN-settings.md §3). VFS.FileExists / lookups
    // consult this so files persisted via io.open (e.g. ZK's
    // Config/ZK_data.lua settings, written by table.save) are visible
    // after a reload — without it, FileExists returns false on the gated
    // config load and saved settings never come back. The widget-ORDER
    // files are excluded so the intentional "boot with all widgets
    // enabled" default (the _writeCache clear at bootstrap) still holds.
    const VFS_STORAGE_EXCLUDE = new Set([
        'luaui/config/zk_order.lua',
        'luaui/config/widget_data.lua',
    ]);
    rt.setGlobal('_vfsStorageLookup', (path: LuaValue) => {
        const p = String(path);
        if (VFS_STORAGE_EXCLUDE.has(p.toLowerCase())) return null;
        return loadFromStorage(storagePrefix + p);
    });

    rt.doString(`
        local _storagePrefix = "${escapeLuaString(storagePrefix)}"
        io = io or {}
        io.open = function(path, mode)
            if not path then return nil, "no path" end
            mode = mode or "r"
            if mode:find("w") or mode:find("a") then
                local buf = {}
                local f = {}
                function f:write(...)
                    for _, s in ipairs({...}) do
                        buf[#buf + 1] = tostring(s)
                    end
                end
                function f:flush() end
                function f:close()
                    local content = table.concat(buf)
                    _saveToStorage(_storagePrefix .. path, content)
                    VFS._writeCache[path] = content
                end
                return f
            else
                local content = VFS._writeCache and (VFS._writeCache[path]
                    or VFS._writeCache[path:lower()])
                if not content then
                    content = _loadFromStorage(_storagePrefix .. path)
                end
                if not content and VFS and VFS.LoadFile then
                    content = VFS.LoadFile(path)
                end
                if not content then
                    return nil, "file not found: " .. path
                end
                local pos = 1
                local f = {}
                function f:read(fmt)
                    if pos > #content then return nil end
                    if fmt == "*a" then
                        local r = content:sub(pos)
                        pos = #content + 1
                        return r
                    end
                    local nl = content:find("\\n", pos, true)
                    local line
                    if nl then
                        line = content:sub(pos, nl - 1)
                        pos = nl + 1
                    else
                        line = content:sub(pos)
                        pos = #content + 1
                    end
                    return line
                end
                function f:close() end
                return f
            end
        end
        io.read = function() return nil end
        io.write = function() end
        io.close = function() end
    `, 'io_shim');
}

// ── VFS installation ───────────────────────────────────────────────────

/// One-time notice that VFS.LoadFile is doing synchronous on-demand binary
/// loads (per the no-silent-failures principle: a real but blocking path).
let warnedSyncBinaryLoad = false;

/// Synchronously fetch a file's raw bytes from the game asset plane,
/// returned byte-1:1 (latin1). Used by VFS.LoadFile for binary assets that
/// aren't held as text (audio/images indexed path-only). Synchronous because
/// VFS.LoadFile's Lua contract is synchronous — there is no async seam. Sync
/// XMLHttpRequest is permitted in a Worker (the response='arraybuffer'
/// restriction only applies on a Window). Bytes are cached by worker-vfs so
/// each file blocks at most once. Faithful to Recoil's LoadFile; the only
/// cost is a brief worker stall on first touch of an un-cached binary file.
function syncFetchBinary(baseUrl: string, diskPath: string): string | null {
    if (!baseUrl) return null;
    if (!warnedSyncBinaryLoad) {
        warnedSyncBinaryLoad = true;
        postLog(2, '[VFS] VFS.LoadFile is loading binary assets synchronously on ' +
            'demand (e.g. .wav headers for sound scheduling); first read of each ' +
            'file does a blocking fetch, cached thereafter.');
    }
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', `${baseUrl}/${diskPath}`, false); // sync — worker-only
        xhr.responseType = 'arraybuffer';
        xhr.send();
        if (xhr.status < 200 || xhr.status >= 300) return null;
        const buf = xhr.response as ArrayBuffer | null;
        if (!buf) return null;
        const u8 = new Uint8Array(buf);
        // Build a byte-1:1 string in chunks (apply() has an arg-count cap).
        let s = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < u8.length; i += CHUNK) {
            s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
        }
        return s;
    } catch {
        return null;
    }
}

export function installVFS(rt: LuaRuntime): void {
    // Supply worker-vfs with the synchronous raw-byte transport so
    // VFS.LoadFile can faithfully return bytes for path-only binary assets.
    // initBaseUrl is module-level and set in init() before any widget runs.
    setVfsBinaryFetcher((diskPath: string) => syncFetchBinary(initBaseUrl, diskPath));

    rt.setGlobal('_vfsLookup', (path: LuaValue) => {
        return vfsLookup(String(path)) ?? null;
    });

    rt.setGlobal('_vfsLoadBinary', (path: LuaValue) => {
        return vfsLoadBinary(String(path)) ?? null;
    });

    /// Existence check that succeeds for path-only entries (audio,
    /// other binary assets). VFS.FileExists must short-circuit via
    /// this rather than relying on _vfsLookup, which intentionally
    /// returns nil for entries that have no Lua-loadable content.
    rt.setGlobal('_vfsExists', (path: LuaValue) => {
        return vfsExists(String(path));
    });

    rt.setGlobal('_vfsDirList', (dir: LuaValue) => {
        const d = String(dir).toLowerCase();
        return luaTable(...presentDirListEntries(d, vfsDirCache.get(d) ?? []));
    });

    rt.setGlobal('_vfsSubDirs', (dir: LuaValue) => {
        const d = String(dir).toLowerCase();
        return luaTable(...(vfsSubdirCache.get(d) ?? []));
    });

    // VFS.CalculateHash(input, 0) → base64(MD5). Reaching BAR/ZK consumers
    // (barwidgets widget-hash table, gui_changelog_info "new since seen?",
    // ana_report_widgets content id) all use type 0 for *local* dedup. Without
    // this the call is `nil`, so those widgets die on load with "attempt to
    // call a nil value". See vfs-hash.ts for the (documented) UTF-8-input
    // deviation. type 1 (SHA512) has no reaching consumer → loud standin.
    rt.setGlobal('_vfsCalculateHash', (input: LuaValue, hashType: LuaValue) => {
        const ht = Number(hashType) || 0;
        if (ht === 0) return md5Base64(String(input));
        if (!warnedVfsSha) {
            setWarnedVfsSha(true);
            postLog(2, '[VFS] FIDELITY-STANDIN: VFS.CalculateHash type 1 (SHA512) ' +
                'is not implemented (no reaching consumer); returning nil.');
        }
        return null;
    });

    // Purge a file from the VFS cache so the next VFS.LoadFile re-fetches
    // it from the server. Used by enableWidget to force a reload.
    rt.setGlobal('_vfsPurge', (path: LuaValue) => {
        const p = String(path);
        vfsFiles.delete(p);
        const lower = p.toLowerCase();
        const canonical = vfsPathMap.get(lower);
        if (canonical) {
            vfsFiles.delete(canonical);
            vfsPathMap.delete(lower);
        }
    });

    rt.doString(VFS_IMPLEMENTATION_LUA, 'vfs_impl');
}

// ── Callin detection ───────────────────────────────────────────────────

/** Check which input-related callins have widget handlers registered */
export function getRegisteredCallins(rt: LuaRuntime): string[] {
    const result = rt.evalString(`
        local callins = {}
        if widgetHandler then
            -- cawidgets.lua creates FooList tables for each callin with registered widgets
            local names = {
                'KeyPress', 'KeyRelease',
                'MousePress', 'MouseRelease', 'MouseMove', 'MouseWheel',
                'IsAbove', 'GetTooltip',
                'TextInput', 'TextEditing',
            }
            for _, name in ipairs(names) do
                local list = widgetHandler[name .. 'List']
                if list and #list > 0 then
                    callins[#callins+1] = name
                end
            end
        end
        return table.concat(callins, ",")
    `);
    if (!result || result === '') return [];
    return String(result).split(',');
}

// ── Widget list query ──────────────────────────────────────────────────

export function getWidgetList(): string {
    if (!runtime) return '';
    // Returns one line per widget. Fields are pipe-delimited:
    //   status|name|author|basename|error|desc|date|license|layer|enabled|handler
    return String(runtime.evalString(`
        local entries = {}
        local function esc(s)
            return (tostring(s or "")):gsub("|", "/"):gsub("\\n", " "):gsub("\\r", "")
        end
        local seen = {}
        if widgetHandler then
            -- Active widgets
            for _, w in ipairs(widgetHandler.widgets or {}) do
                local info = w.whInfo or {}
                local gi = (w.GetInfo and type(w.GetInfo) == "function") and w:GetInfo() or {}
                seen[info.name] = true
                entries[#entries+1] = "active|" .. esc(info.name) .. "|" .. esc(info.author)
                    .. "|" .. esc(info.basename) .. "||" .. esc(gi.desc or info.desc)
                    .. "|" .. esc(gi.date) .. "|" .. esc(gi.license)
                    .. "|" .. esc(gi.layer or info.layer) .. "|" .. esc(tostring(gi.enabled))
                    .. "|" .. esc(tostring(gi.handler))
            end
            -- Known but inactive widgets (disabled or failed after knownWidgets registration)
            for name, info in pairs(widgetHandler.knownWidgets or {}) do
                if not info.active then
                    seen[name] = true
                    entries[#entries+1] = "disabled|" .. esc(name) .. "|" .. esc(info.author)
                        .. "|" .. esc(info.basename) .. "||" .. esc(info.desc)
                        .. "|||" .. esc(info.layer or "") .. "||"
                end
            end
            -- Widgets that failed before reaching knownWidgets (parse errors, pcall failures)
            for _, errMsg in ipairs(_widgetErrors or {}) do
                local bname = errMsg:match("Failed to load:%s+(%S+)")
                if bname and not seen[bname] then
                    seen[bname] = true
                    entries[#entries+1] = "failed|" .. esc(bname) .. "|||" .. esc(errMsg) .. "||||||"
                end
            end
            -- Cross-check: find widget files VFS knows about that didn't appear anywhere.
            -- Build a set of known basenames from active widgets and knownWidgets.
            local seenBasenames = {}
            for _, w in ipairs(widgetHandler.widgets or {}) do
                if w.whInfo and w.whInfo.basename then
                    seenBasenames[w.whInfo.basename] = true
                end
            end
            for _, info in pairs(widgetHandler.knownWidgets or {}) do
                if info.basename then
                    seenBasenames[info.basename] = true
                end
            end
            -- Also mark basenames from _widgetErrors
            for _, errMsg in ipairs(_widgetErrors or {}) do
                local bname = errMsg:match("Failed to load:%s+(%S+)")
                if bname then seenBasenames[bname] = true end
            end
            local ok, files = pcall(function()
                return VFS.DirList("LuaUI/Widgets/", "*.lua", VFS.RAW_FIRST)
            end)
            if ok and files then
                for _, fpath in ipairs(files) do
                    local bname = fpath:match("([^/\\\\]+)$")
                    if bname and not seenBasenames[bname] then
                        entries[#entries+1] = "failed|" .. esc(bname) .. "|||silent load failure||||||"
                    end
                end
            end
        end
        return table.concat(entries, "\\n")
    `) ?? '');
}

export function escapeLuaStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Order-insensitive equality for the worker's selection-id snapshots —
 *  Spring's engine emits SelectionChanged when the *set* changes, not on
 *  reorders. */
export function sameIdSet(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    if (a.length === 0) return true;
    const s = new Set(a);
    for (const id of b) if (!s.has(id)) return false;
    return true;
}

/** Rebuild `widgetHandler.commands` from the first selected unit's
 *  cmd-descs and fire the CommandsChanged callin so chili widgets
 *  (integral menu, command buttons, factory bar) refresh their button
 *  grid. Spring's engine does this implicitly via the LayoutCommands
 *  callback every frame the command set changes; we trigger it
 *  explicitly when a streamed UnitCmdDescsUpdate or selection change
 *  invalidates the previous layout. Safe to call before the runtime is
 *  bootstrapped (no-op if widgetHandler isn't installed yet). */
/** widgetHandler:SelectionChanged(newSelection) — Spring fires this when
 *  the selected unit set changes (independent of CommandsChanged, which
 *  fires when the *commands available* change). gui_chili_integral_menu,
 *  gui_attackrange_gl4, unit_state_icons all register for this. */
export function dispatchSelectionChanged(ids: ReadonlyArray<number>): void {
    if (!runtime) return;
    const tableLit = ids.length === 0
        ? '{}'
        : '{' + ids.join(',') + '}';
    runtime.doString(`
        if widgetHandler and widgetHandler.SelectionChanged then
            pcall(widgetHandler.SelectionChanged, widgetHandler, ${tableLit})
        end
    `, 'dispatchSelectionChanged');
}

/** widgetHandler:UnitCreated(unitID, unitDefID, unitTeam, builderID) —
 *  fires once when a unit first appears in the local world. Two
 *  sources can fire this:
 *   - Server `UnitLifecycleKind.Created` event (own + allied teams,
 *     carries builderId).
 *   - Entity-stream first-visibility synthesis (every team; no
 *     builderId — passed as nil).
 *  The two sources are deduplicated by `serverFiredUnitCreated`: any
 *  unit the server has already fired for is skipped by the synthesis
 *  path, and allied-team entity-stream appearances are deferred by
 *  one tick to let the server event arrive first. */
export function dispatchUnitCreated(
    unitId: number, defId: number, team: number,
    builderId: number,
): void {
    if (!runtime) return;
    const builderArg = builderId > 0 ? String(builderId) : 'nil';
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitCreated then
            pcall(widgetHandler.UnitCreated, widgetHandler,
                ${unitId}, ${defId}, ${team}, ${builderArg})
        end
    `, 'dispatchUnitCreated');
}

/** widgetHandler:UnitFromFactory(unitID, unitDefID, unitTeam,
 *  factoryID, factoryDefID, userOrders) — fires when a factory
 *  completes a unit. ZK's `unit_start_state` and `cmd_unit_mover`
 *  depend on this. Sourced from the server's UnitLifecycleBatch — we
 *  can't synthesise it client-side because the entity stream doesn't
 *  carry the factory id. */
export function dispatchUnitFromFactory(
    unitId: number, defId: number, team: number,
    factoryId: number, factoryDefId: number, userOrders: boolean,
): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitFromFactory then
            pcall(widgetHandler.UnitFromFactory, widgetHandler,
                ${unitId}, ${defId}, ${team},
                ${factoryId}, ${factoryDefId}, ${userOrders ? 'true' : 'false'})
        end
    `, 'dispatchUnitFromFactory');
}

/** widgetHandler:UnitTaken(unitID, unitDefID, oldTeam, newTeam) —
 *  fires when a unit is transferred between teams (called BEFORE
 *  UnitGiven, while the unit is still assigned to oldTeam). */
export function dispatchUnitTaken(
    unitId: number, defId: number, oldTeam: number, newTeam: number,
): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitTaken then
            pcall(widgetHandler.UnitTaken, widgetHandler,
                ${unitId}, ${defId}, ${oldTeam}, ${newTeam})
        end
    `, 'dispatchUnitTaken');
}

/** widgetHandler:UnitGiven(unitID, unitDefID, newTeam, oldTeam) —
 *  fires when a unit is transferred between teams (called AFTER
 *  UnitTaken, after the team field has been updated). Spring's
 *  argument order is `(unitId, defId, newTeam, oldTeam)` — note the
 *  reversed team pair vs UnitTaken. */
export function dispatchUnitGiven(
    unitId: number, defId: number, oldTeam: number, newTeam: number,
): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitGiven then
            pcall(widgetHandler.UnitGiven, widgetHandler,
                ${unitId}, ${defId}, ${newTeam}, ${oldTeam})
        end
    `, 'dispatchUnitGiven');
}

/** widgetHandler:DefaultCommand(targetType, targetID, engineCmd) — fires
 *  when the cursor's hover-target changes (a different unit/feature, or
 *  none). The first widget to return a non-nil cmdID overrides the
 *  default right-click action. ZK uses it for cmd_mex_placement,
 *  unit_default_commands, gui_highlight_geos, and a handful of others.
 *
 *  We dispatch via widgetHandler.DefaultCommandList (the standard
 *  cawidgets list) and return the resolved cmdId — fall back to
 *  engineCmd when no widget overrode. */
export function dispatchDefaultCommand(
    targetType: 'unit' | 'feature' | null,
    targetId: number,
    engineCmd: number,
): number {
    if (!runtime) return engineCmd;
    const typeLit = targetType === null ? 'nil' : `"${targetType}"`;
    const idLit = targetType === null ? 'nil' : String(targetId | 0);
    // cawidgets.lua installs widgetHandler:DefaultCommand which iterates
    // self.DefaultCommandList and returns the first numeric override (or
    // nil if no widget claimed it). Returning nil → fall back to engineCmd.
    const result = runtime.evalString(`
        if not (widgetHandler and widgetHandler.DefaultCommand) then
            return "${engineCmd | 0}"
        end
        local ok, ret = pcall(widgetHandler.DefaultCommand, widgetHandler,
            ${typeLit}, ${idLit}, ${engineCmd | 0})
        if ok and type(ret) == "number" then
            return tostring(math.floor(ret))
        end
        return "${engineCmd | 0}"
    `);
    const parsed = Number.parseInt(typeof result === 'string' ? result : String(result ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : engineCmd;
}

/** widgetHandler:CommandNotify(cmdID, cmdParams, cmdOptions) — Spring
 *  fires this once for every player-issued command BEFORE it enters
 *  the queue. Any widget that returns true consumes the command. ZK
 *  uses this for ~17 widgets that veto duplicate build orders, rewrite
 *  raw-move into formation-move, keep targets across queues, etc.
 *
 *  cmdOptions in Spring is a table with named flag keys ({alt=,
 *  ctrl=, shift=, right=, meta=}). We rebuild that shape from the
 *  flag bits the caller passes through. Returns true if any widget
 *  consumed the order — caller should suppress the actual send. */
export function dispatchCommandNotify(
    cmdId: number,
    params: readonly number[],
    optionBits: number,
): boolean {
    if (!runtime) return false;
    const paramsLit = params.length === 0
        ? '{}'
        : '{' + params.map(n => Number.isFinite(n) ? String(n) : '0').join(',') + '}';
    // Bit layout matches command-buffer.ts: META=1, RIGHT=4, CTRL=64,
    // ALT=128, SHIFT=32. cawidgets.lua's CommandNotify dispatch reads
    // the cmdOptions.{alt,ctrl,shift,right,meta} booleans, plus an
    // internal `coded` int that some widgets check.
    const alt    = (optionBits & 128) !== 0 ? 'true' : 'false';
    const ctrl   = (optionBits & 64)  !== 0 ? 'true' : 'false';
    const shift  = (optionBits & 32)  !== 0 ? 'true' : 'false';
    const right  = (optionBits & 16)  !== 0 ? 'true' : 'false';
    const meta   = (optionBits & 4)   !== 0 ? 'true' : 'false';
    const consumed = runtime.evalString(`
        if widgetHandler and widgetHandler.CommandNotify then
            local ok, ret = pcall(widgetHandler.CommandNotify, widgetHandler,
                ${cmdId | 0},
                ${paramsLit},
                { alt=${alt}, ctrl=${ctrl}, shift=${shift}, right=${right}, meta=${meta}, coded=${optionBits | 0} })
            return ok and ret and "1" or "0"
        end
        return "0"
    `);
    return consumed === '1';
}

/** widgetHandler:PlayerChanged(playerId) — Spring fires this when the
 *  local player's team/spec status changes, when the leader changes,
 *  or when another player on the team is reassigned. ZK's
 *  unit_cloakfirestate2 uses it to re-fetch the local player's start
 *  state; cmd_factory_plate_placer rebuilds its plate map. We dispatch
 *  with the local playerId only; widgets that care about *other*
 *  players' transitions filter the arg themselves. */
export function dispatchPlayerChanged(playerId: number): void {
    if (!runtime) return;
    ensureRosteredForCallin(playerId);
    runtime.doString(`
        if widgetHandler and widgetHandler.PlayerChanged then
            pcall(widgetHandler.PlayerChanged, widgetHandler, ${playerId | 0})
        end
    `, 'dispatchPlayerChanged');
}

/** Enforce Recoil's invariant before a player-status callin: the engine
 *  always holds the player in `playerHandler` when PlayerChanged/PlayerAdded
 *  fires, so a widget reading `Spring.GetPlayerInfo(id)` gets a valid name.
 *  The primary roster seed is now seedPlayersFromRoster() at gp:init (the
 *  lobby room snapshot), so `liveState.players` is populated before LuaUI boots.
 *  This stays as a defensive fallback for an id that isn't in that snapshot
 *  (e.g. a future mid-game join before a roster restream); for the local player
 *  we know team/allyTeam from identity. ensurePlayerEntry is a no-op when the
 *  id is already seeded. See BAR gui_chat crash (PLAN-bar.md UI-2). */
function ensureRosteredForCallin(playerId: number): void {
    const seed = playerId === liveState.identity.myPlayerId
        ? { team: liveState.identity.myTeam, allyTeam: liveState.identity.myAllyTeam }
        : undefined;
    ensurePlayerEntry(liveState.players, playerId, seed);
}

/** widgetHandler:PlayerAdded(playerId) — Spring fires this when a player
 *  (re)joins. No server call site emits it today, but the wire enum reserves
 *  the kind so a future reconnect/join path lights it up without a code change. */
export function dispatchPlayerAdded(playerId: number): void {
    if (!runtime) return;
    ensureRosteredForCallin(playerId);
    runtime.doString(`
        if widgetHandler and widgetHandler.PlayerAdded then
            pcall(widgetHandler.PlayerAdded, widgetHandler, ${playerId | 0})
        end
    `, 'dispatchPlayerAdded');
}

/** widgetHandler:PlayerRemoved(playerId, reason) — fires when a player leaves
 *  (quit/kick/timeout). reason: 0=quit, 1=kicked, 2=timeout. Recoil's
 *  `playerHandler` never deletes a departed player's entry (only marks it
 *  inactive), so `Spring.GetPlayerInfo` still resolves a name inside this
 *  callin — same invariant as PlayerChanged/PlayerAdded above. Missing this
 *  guard crashed BAR's snd_notifications_addon_playerstatus.lua:29 ("table
 *  index is nil") whenever PlayerRemoved fired for an id that raced ahead of
 *  the roster seed (PLAN-bar.md U5). */
export function dispatchPlayerRemoved(playerId: number, reason: number): void {
    if (!runtime) return;
    ensureRosteredForCallin(playerId);
    runtime.doString(`
        if widgetHandler and widgetHandler.PlayerRemoved then
            pcall(widgetHandler.PlayerRemoved, widgetHandler, ${playerId | 0}, ${reason | 0})
        end
    `, 'dispatchPlayerRemoved');
}

/** widgetHandler:TeamDied(teamId) — fires when a team is eliminated. */
export function dispatchTeamDied(teamId: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.TeamDied then
            pcall(widgetHandler.TeamDied, widgetHandler, ${teamId | 0})
        end
    `, 'dispatchTeamDied');
}

/** Build a binary-safe Lua string literal (incl. surrounding quotes) from
 *  raw bytes. Printable ASCII passes through; `"`, `\` and every other byte
 *  become `\ddd` decimal escapes — bulletproof for embedded NULs / high bytes
 *  (ZK widgets occasionally pack binary fields into a LuaUI message). */
export function luaBytesLiteral(bytes: Uint8Array): string {
    let out = '"';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b >= 32 && b <= 126 && b !== 34 /* " */ && b !== 92 /* \ */) {
            out += String.fromCharCode(b);
        } else {
            out += '\\' + b;
        }
    }
    return out + '"';
}

/** widgetHandler:RecvLuaMsg(msg, playerID) — a relayed Spring.SendLuaUIMsg
 *  from another (or this) player. Faithful to Recoil's LUA_HANDLE_ORDER_UI
 *  dispatch: LuaUI messages go to widgets only (the LuaRules `$RecvLuaMsg`
 *  path handles gadget halves separately). */
export function dispatchRecvLuaUIMsg(data: Uint8Array, playerId: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.RecvLuaMsg then
            pcall(widgetHandler.RecvLuaMsg, widgetHandler, ${luaBytesLiteral(data)}, ${playerId | 0})
        end
    `, 'dispatchRecvLuaUIMsg');
}

/** widgetHandler:UnitDestroyed(unitID, unitDefID, unitTeam) — fires on
 *  the EntityDestroy event. */
export function dispatchUnitDestroyed(unitId: number, defId: number, team: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitDestroyed then
            pcall(widgetHandler.UnitDestroyed, widgetHandler, ${unitId}, ${defId}, ${team})
        end
    `, 'dispatchUnitDestroyed');
}

/** widgetHandler:UnitFinished(unitID, unitDefID, unitTeam) — fires when
 *  a unit completes construction. We derive it from a buildProgress
 *  < 1 → >= 1 transition in the entity-state stream rather than waiting
 *  for a dedicated server event; close enough for ZK widgets like
 *  unit_building_starter, unit_start_state, cmd_no_duplicate_orders. */
export function dispatchUnitFinished(unitId: number, defId: number, team: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitFinished then
            pcall(widgetHandler.UnitFinished, widgetHandler, ${unitId}, ${defId}, ${team})
        end
    `, 'dispatchUnitFinished');
}

/** widgetHandler:UnitDamaged(unitID, unitDefID, unitTeam, damage, paralyzer,
 *  weaponDefID, projectileID, attackerID, attackerDefID, attackerTeam) —
 *  fired from the server CombatEvent stream (envelope inside GameEventBatch).
 *  Both ZK (cawidgets.lua) and BAR (barwidgets.lua) implement the handler
 *  fan-out, so one dispatch reaches every subscribed widget in either game.
 *
 *  Faithful subset — the wire carries weapon-combat hits only:
 *    - non-weapon damage (falling, self-destruct, debris, terrain) is not
 *      represented (no CombatEvent is emitted for it server-side);
 *    - `paralyzer` is always false — CombatResult has no paralyze flag on the
 *      wire (FIDELITY gap: ZK widgets like unit_morph/paralysis FX won't see
 *      the EMP/non-EMP split until it's added to the schema);
 *    - `projectileID` is -1 — projectile ids aren't carried on CombatEvent.
 *  Target/attacker defID+team are resolved from liveState; an event whose
 *  target is not a known live unit is skipped (a feature hit, or a unit
 *  outside our vision — no widget keyed on it can care). */
export function dispatchUnitDamaged(events: CombatEventInfo[]): void {
    if (!runtime) return;
    let chunk = '';
    for (const e of events) {
        if (!(e.damage > 0) || !Number.isFinite(e.damage)) continue;
        const target = liveState.units.get(e.targetId);
        if (!target) continue;
        const atk = e.attackerId ? liveState.units.get(e.attackerId) : undefined;
        const attackerId = e.attackerId || -1;
        const attackerDefId = atk ? atk.defId : -1;
        const attackerTeam = atk ? atk.team : -1;
        chunk += `if widgetHandler and widgetHandler.UnitDamaged then `
            + `pcall(widgetHandler.UnitDamaged, widgetHandler, ${e.targetId}, `
            + `${target.defId}, ${target.team}, ${e.damage}, false, `
            + `${e.weaponDefId}, -1, ${attackerId}, ${attackerDefId}, `
            + `${attackerTeam}) end\n`;
    }
    if (chunk) runtime.doString(chunk, 'dispatchUnitDamaged');
}

/** featureID → allyTeam, captured on spawn so FeatureDestroyed can pass the
 *  same allyTeam Recoil supplies (the removed-stream carries only ids). */
const featureAllyTeams = new Map<number, number>();

/** widgetHandler:FeatureCreated(featureID, allyTeam) /
 *  widgetHandler:FeatureDestroyed(featureID, allyTeam) — fired from the server
 *  feature-lifecycle stream (runtime wrecks/debris/reclaim spawns + removals).
 *  BAR's barwidgets.lua registers + fans these out (13 subscribing widgets);
 *  ZK's cawidgets.lua does not register them, so the guarded call no-ops there.
 *  Pre-placed map features are NOT re-fired here — widgets needing the full set
 *  read Spring.GetAllFeatures() in Initialize, matching the engine's load
 *  order. */
export function dispatchFeatureLifecycle(spawns: FeatureSpawnInfo[], removed: number[]): void {
    if (!runtime) return;
    let chunk = '';
    for (const s of spawns) {
        featureAllyTeams.set(s.featureId, s.allyTeam);
        chunk += `if widgetHandler and widgetHandler.FeatureCreated then `
            + `pcall(widgetHandler.FeatureCreated, widgetHandler, ${s.featureId}, `
            + `${s.allyTeam}) end\n`;
    }
    for (const id of removed) {
        const allyTeam = featureAllyTeams.get(id) ?? -1;
        featureAllyTeams.delete(id);
        chunk += `if widgetHandler and widgetHandler.FeatureDestroyed then `
            + `pcall(widgetHandler.FeatureDestroyed, widgetHandler, ${id}, `
            + `${allyTeam}) end\n`;
    }
    if (chunk) runtime.doString(chunk, 'dispatchFeatureLifecycle');
}

/** widgetHandler:VisibleUnitAdded(unitID, unitDefID, unitTeam) — fires
 *  when a unit enters the camera viewing frustum. Distinct from
 *  UnitEnteredLos (vision-based) — VisibleUnitAdded is a render-side
 *  hook so per-frame overlay widgets (gui_attackrange_gl4) only iterate
 *  the units actually on screen. Sourced from main-thread frustum diff
 *  in LuaWidgetManager.updateVisibleUnits. */
export function dispatchVisibleUnitAdded(
    unitId: number, defId: number, team: number,
): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.VisibleUnitAdded then
            pcall(widgetHandler.VisibleUnitAdded, widgetHandler,
                ${unitId}, ${defId}, ${team})
        end
    `, 'dispatchVisibleUnitAdded');
}

/** widgetHandler:VisibleUnitRemoved(unitID) — fires when a unit leaves
 *  the camera viewing frustum. See dispatchVisibleUnitAdded for context. */
export function dispatchVisibleUnitRemoved(unitId: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.VisibleUnitRemoved then
            pcall(widgetHandler.VisibleUnitRemoved, widgetHandler, ${unitId})
        end
    `, 'dispatchVisibleUnitRemoved');
}

/** Build a Lua table literal for an array of floats. Used to pass the
 *  `cmdParams` argument of `widgetHandler:UnitCommand` / `UnitCmdDone`
 *  callins; the worker can't construct a Lua array from JS-side any
 *  other way without a marshalling shim. */
export function paramsTableLiteral(params: ReadonlyArray<number>): string {
    if (params.length === 0) return '{}';
    return '{' + params.map(p => Number.isFinite(p) ? String(p) : '0').join(',') + '}';
}

/** widgetHandler:UnitCommand(unitID, unitDefID, unitTeam, cmdID,
 *  cmdParams, cmdOpts, cmdTag, playerID, fromSynced, fromLua) — fires
 *  after the engine has added a command to a unit's queue. ZK
 *  cawidgets accepts both the short (cmdTag only) and long form;
 *  the worker emits the long form so widgets that read the optional
 *  trailing args still get correct values. */
export function dispatchUnitCommand(
    unitId: number, defId: number, team: number,
    cmdId: number, params: ReadonlyArray<number>, options: number, tag: number,
    playerId: number, fromSynced: boolean, fromLua: boolean,
): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitCommand then
            pcall(widgetHandler.UnitCommand, widgetHandler,
                ${unitId}, ${defId}, ${team},
                ${cmdId}, ${paramsTableLiteral(params)}, ${options}, ${tag},
                ${playerId}, ${fromSynced ? 'true' : 'false'}, ${fromLua ? 'true' : 'false'})
        end
    `, 'dispatchUnitCommand');
}

/** widgetHandler:UnitCmdDone(unitID, unitDefID, unitTeam, cmdID,
 *  cmdParams, cmdOpts, cmdTag) — fires when a queued command
 *  completes or is cleared from a unit's queue. ZK `cmd_keep_target`
 *  uses it to know when to forget the target state it cached on
 *  UnitCommand. */
export function dispatchUnitCmdDone(
    unitId: number, defId: number, team: number,
    cmdId: number, params: ReadonlyArray<number>, options: number, tag: number,
): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitCmdDone then
            pcall(widgetHandler.UnitCmdDone, widgetHandler,
                ${unitId}, ${defId}, ${team},
                ${cmdId}, ${paramsTableLiteral(params)}, ${options}, ${tag})
        end
    `, 'dispatchUnitCmdDone');
}

// Signature of everything the integral-menu rebuild actually depends on:
// the selection, each selected unit's cmd-descs (id / disabled / hidden /
// type / params), and each selected unit's order queue (drives the build-
// queue count badges via GetRealBuildQueue / GetFactoryCommands). When this
// is unchanged there is nothing for CommandsChanged to do, so we skip the
// full panel teardown. Recomputed cheaply (~1 Hz) from worker-local state.
let lastCommandSignature: string | null = null;

export function computeCommandSignature(): string {
    const parts: string[] = [];
    for (const id of liveState.selectedUnitIds) {
        parts.push('u' + id);
        const descs = liveState.unitCmdDescs.get(id);
        if (descs) {
            for (const d of descs) {
                parts.push(
                    d.cmdId + ':' + (d.disabled ? 1 : 0) + ':' +
                    (d.hidden ? 1 : 0) + ':' + d.type + ':' + d.params.join(','),
                );
            }
        }
        const orders = liveState.unitCommands.get(id);
        if (orders) {
            // Only the cmd-id sequence matters for the build-queue strip;
            // move-order progress (params unchanged until completed) won't
            // perturb this, so we don't rebuild the palette on every tick a
            // mobile unit is travelling.
            for (const o of orders) parts.push('o' + o.cmdId);
        }
    }
    return parts.join('|');
}

export function dispatchCommandsChanged(force = false): void {
    if (!runtime) return;

    // Spring fires CommandsChanged only when the command set actually
    // changes. Our server snapshots arrive on a fixed ~1 Hz cadence, so
    // without this gate the integral menu tore down and rebuilt its whole
    // panel every second — flickering buttons, dropped hover, and (the
    // reported bug) the build tab snapping back to "orders". Skip the
    // rebuild when nothing relevant moved.
    const sig = computeCommandSignature();
    if (!force && sig === lastCommandSignature) return;
    lastCommandSignature = sig;

    // Spring exposes the union of every selected unit's cmd-descs as
    // widgetHandler.commands — a builder selected alongside a factory
    // shows both their build options. Picking only sel[1] used to hide
    // half the options in mixed-builder selections; dedupe by cmd id so
    // a build available on two units doesn't double up.
    //
    // After merging, defer to ZK's installed `LayoutButtons` global (set
    // by widgetHandler:ConfigLayoutHandler from cmd_layout_handler.lua).
    // The handler may inject custom commands (page-num button, build-
    // queue strip), reorder, or override params — without this hook the
    // integral menu's special buttons never appear.
    runtime.doString(`
        if widgetHandler then
            local sel = Spring.GetSelectedUnits()
            local merged, seen = {}, {}
            if sel then
                for i = 1, #sel do
                    local descs = Spring.GetUnitCmdDescs(sel[i])
                    if descs then
                        for j = 1, #descs do
                            local d = descs[j]
                            local id = d and d.id
                            if id and not seen[id] then
                                seen[id] = true
                                merged[#merged + 1] = d
                            end
                        end
                    end
                end
            end

            local commands = merged
            local cmdCount = #merged

            if type(_G.LayoutButtons) == "function" then
                -- xIcons / yIcons size the engine's native command panel,
                -- which we don't render — chili re-derives its own layout.
                -- But ZK's default handler (LuaUI/layout.lua DefaultHandler)
                -- computes \`ipp = xIcons * yIcons\` then does \`pos % ipp\`;
                -- passing zeros makes the modulo throw. Use Spring's
                -- standard 6x6 integral-menu grid so the math is safe
                -- regardless of which handler the game installed.
                local ok, menuName, xIcons, yIcons,
                      removeCmds, customCmds, onlyTexCmds, reTexCmds,
                      reNamedCmds, reTooltipCmds, reParamsCmds, iconList
                    = pcall(_G.LayoutButtons, 6, 6, cmdCount, commands)

                if ok then
                    -- LayoutButtons may have mutated widgetHandler.commands
                    -- in-place (cmd_layout_handler.lua does exactly this).
                    -- Trust the handler's authoritative copy if present.
                    if type(widgetHandler.commands) == "table" then
                        commands = widgetHandler.commands
                    end

                    if type(customCmds) == "table" then
                        widgetHandler.customCommands = widgetHandler.customCommands or {}
                        for i = 1, #customCmds do
                            widgetHandler.customCommands[#widgetHandler.customCommands + 1] = customCmds[i]
                        end
                    end

                    if type(reParamsCmds) == "table" and type(widgetHandler.customCommands) == "table" then
                        for descID, paramsArr in pairs(reParamsCmds) do
                            for i = 1, #widgetHandler.customCommands do
                                if widgetHandler.customCommands[i].cmdDescID == descID then
                                    widgetHandler.customCommands[i].params = paramsArr
                                    break
                                end
                            end
                        end
                    end
                    -- menuName / xIcons / yIcons / removeCmds / onlyTexCmds /
                    -- reTexCmds / reNamedCmds / reTooltipCmds / iconList
                    -- target Spring's native command panel, which we don't
                    -- render — chili re-derives its own layout.
                else
                    Spring.Log("LuaUI", LOG.WARNING,
                        "[LayoutButtons] handler errored: " .. tostring(menuName))
                end
            end

            widgetHandler.commands = commands
            widgetHandler.commands.n = #commands
            widgetHandler:CommandsChanged()
        end
    `, 'dispatchCommandsChanged');
}

/** Toggle a widget by name. */
export function toggleWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            widgetHandler:ToggleWidget("${escapeLuaStr(name)}")
        end
    `, 'toggleWidget');
}

/** Enable a widget by name. Re-fetches its source from the server
 *  first so enable after disable acts as a reload. */
export async function enableWidget(name: string): Promise<void> {
    if (!runtime) return;
    // Get the widget's filename from knownWidgets
    const filename = String(runtime.evalString(`
        local ki = widgetHandler and widgetHandler.knownWidgets and widgetHandler.knownWidgets["${escapeLuaStr(name)}"]
        return ki and ki.filename or ""
    `) ?? '');
    // Re-fetch the file from server if we have a filename and a base URL
    if (filename && initBaseUrl) {
        try {
            const res = await fetch(`${initBaseUrl}/${filename}`);
            if (res.ok) {
                const text = await res.text();
                vfsRegister(filename, text);
                postLog(2, `[LuaUI] re-fetched ${filename} (${text.length} bytes)`);
            }
        } catch { /* silent */ }
    }
    runtime?.doString(`
        if widgetHandler then
            widgetHandler:EnableWidget("${escapeLuaStr(name)}")
        end
    `, 'enableWidget');
}

/** Disable a widget by name. */
export function disableWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            widgetHandler:DisableWidget("${escapeLuaStr(name)}")
        end
    `, 'disableWidget');
}

let shuttingDown = false;

export function shutdown(): void {
    // Idempotent: multiple shutdown messages from the main thread (e.g.
    // the startGame→dispose→new-manager path) shouldn't trigger multiple
    // widgetHandler:Shutdown runs. Each run iterates all ZK widgets and
    // can produce thousands of log entries — repeated runs compound into
    // a browser-killing flood.
    if (shuttingDown) {
        postLog(2, '[LuaUI] shutdown() ignored (already shutting down)');
        return;
    }
    shuttingDown = true;

    if (frameInterval) {
        clearInterval(frameInterval);
        frameInterval = null;
    }
    if (runtime) {
        runtime.doString(`
            if Shutdown then
                local ok, err = xpcall(Shutdown, function(e) return e end)
                if not ok then
                    Spring.Echo("[LuaUI] Shutdown error (non-fatal): " .. tostring(err))
                end
            end
        `, 'shutdown');
        runtime.dispose();
        runtime = null;
    }
    bridge = null;
}

export function applyEntityStateToLiveState(snap: EntityStateSnapshot, isDelta: boolean): void {
    const count = snap.count;
    const entityIds = snap.entityIds;
    const posX = snap.positionsX;
    const posY = snap.positionsY;
    const posZ = snap.positionsZ;
    const headings = snap.headings;
    const health = snap.health;
    const defIds = snap.defIds;
    const teams = snap.teams;
    const stateBits = snap.stateBits;
    const losStates = snap.losStates;
    const buildProgress = snap.buildProgress;

    const tickRate = 30;
    const createdIds: Array<{ id: number; defId: number; team: number }> = [];
    const finishedIds: Array<{ id: number; defId: number; team: number }> = [];
    const decodeProgress = (i: number) => buildProgress ? buildProgress[i] / 255 : 1;
    if (!isDelta) {
        const prevUnits = liveState.units;
        const newUnits = new Map<number, UnitEntry>();
        if (entityIds) {
            for (let i = 0; i < count; i++) {
                const id = entityIds[i];
                const prev = prevUnits.get(id);
                const nx = posX ? posX[i] : 0;
                const ny = posY ? posY[i] : 0;
                const nz = posZ ? posZ[i] : 0;
                const defId = defIds ? defIds[i] : 0;
                const team = teams ? teams[i] : 0;
                const bp = decodeProgress(i);
                newUnits.set(id, {
                    x: nx, y: ny, z: nz,
                    heading: headings ? headings[i] : 0,
                    healthRatio: health ? health[i] / 65535 : 1,
                    defId,
                    team,
                    buildProgress: bp,
                    vx: prev ? (nx - prev.x) * tickRate : 0,
                    vy: prev ? (ny - prev.y) * tickRate : 0,
                    vz: prev ? (nz - prev.z) * tickRate : 0,
                    stateBits: stateBits ? stateBits[i] : 0,
                    losState: losStates ? losStates[i] : 0x0F,
                });
                if (!prev) createdIds.push({ id, defId, team });
                else if (prev.buildProgress < 1 && bp >= 1) {
                    finishedIds.push({ id, defId, team });
                }
            }
        }
        liveState.units = newUnits;
    } else {
        if (entityIds) {
            for (let i = 0; i < count; i++) {
                const id = entityIds[i];
                const existing = liveState.units.get(id);
                const entry: UnitEntry = existing ?? {
                    x: 0, y: 0, z: 0, heading: 0, healthRatio: 1,
                    defId: 0, team: 0, buildProgress: 1,
                    vx: 0, vy: 0, vz: 0,
                    stateBits: 0, losState: 0x0F,
                };
                if (posX) {
                    const nx = posX[i];
                    entry.vx = existing ? (nx - entry.x) * tickRate : 0;
                    entry.x = nx;
                }
                if (posY) {
                    const ny = posY[i];
                    entry.vy = existing ? (ny - entry.y) * tickRate : 0;
                    entry.y = ny;
                }
                if (posZ) {
                    const nz = posZ[i];
                    entry.vz = existing ? (nz - entry.z) * tickRate : 0;
                    entry.z = nz;
                }
                if (headings) entry.heading = headings[i];
                if (health) entry.healthRatio = health[i] / 65535;
                if (defIds) entry.defId = defIds[i];
                if (teams) entry.team = teams[i];
                if (stateBits) entry.stateBits = stateBits[i];
                if (losStates) entry.losState = losStates[i];
                if (buildProgress) {
                    const prevBp = entry.buildProgress;
                    const newBp = buildProgress[i] / 255;
                    entry.buildProgress = newBp;
                    if (existing && prevBp < 1 && newBp >= 1) {
                        finishedIds.push({ id, defId: entry.defId, team: entry.team });
                    }
                }
                liveState.units.set(id, entry);
                if (!existing) {
                    createdIds.push({ id, defId: entry.defId, team: entry.team });
                }
            }
        }
    }
    // Flush deferred allied appearances from the previous tick (skip any the
    // server's own Created event has since covered).
    if (liveState.pendingSynthCreated.size > 0) {
        for (const [id, entry] of liveState.pendingSynthCreated) {
            if (!liveState.serverFiredUnitCreated.has(id)) {
                dispatchUnitCreated(id, entry.defId, entry.team, 0);
                liveState.serverFiredUnitCreated.add(id);
            }
        }
        liveState.pendingSynthCreated.clear();
    }
    const myAllyTeam = liveState.identity.myAllyTeam;
    for (const c of createdIds) {
        if (liveState.serverFiredUnitCreated.has(c.id)) continue;
        const teamInfo = liveState.teams.get(c.team);
        const allied = teamInfo ? teamInfo.allyTeam === myAllyTeam : false;
        if (allied) {
            liveState.pendingSynthCreated.set(c.id, { defId: c.defId, team: c.team });
        } else {
            dispatchUnitCreated(c.id, c.defId, c.team, 0);
            liveState.serverFiredUnitCreated.add(c.id);
        }
    }
    for (const f of finishedIds) {
        dispatchUnitFinished(f.id, f.defId, f.team);
    }
}

/// GW4-c6-1b: drop a unit from `liveState` and fire UnitDestroyed. Mirrors the
/// legacy `entityDestroy` handler. NOTE: the connection's onEntityDestroy fires
/// on "left view OR died" (pre-GW4 the main thread had the same conflation), so
/// a unit leaving LOS also synthesises UnitDestroyed — acceptable parity until
/// the server distinguishes the two.
export function removeUnitFromLiveState(id: number): void {
    const u = liveState.units.get(id);
    const defId = u?.defId ?? 0;
    const team = u?.team ?? 0;
    liveState.units.delete(id);
    liveState.unitRulesParams.delete(id);
    liveState.unitCommands.delete(id);
    liveState.unitCmdDescs.delete(id);
    liveState.sensorOverrides.delete(id);
    liveState.serverFiredUnitCreated.delete(id);
    liveState.pendingSynthCreated.delete(id);
    dispatchUnitDestroyed(id, defId, team);
}

const LUA_COMPAT_SHIM = `
if not loadstring then loadstring = load end
if not unpack then unpack = table.unpack end
if not table.getn then table.getn = function(t) return #t end end
if not math.mod then math.mod = math.fmod end
if not math.atan2 then math.atan2 = math.atan end
if not math.pow then math.pow = function(x, y) return x ^ y end end
-- Recoil LuaMathExtra (rts/Lua/LuaMathExtra.cpp) adds these to the math table;
-- they are not standard Lua, so Fengari lacks them. BAR widgets use them
-- heavily (gui_fonthandler:114 math.clamp breaks font sizing → cascades to
-- every font-using widget). Faithful reproductions of the C++ definitions.
if not math.clamp then
    math.clamp = function(x, lo, hi)
        if x < lo then return lo elseif x > hi then return hi else return x end
    end
end
if not math.sgn then
    math.sgn = function(x) if x > 0 then return 1 elseif x < 0 then return -1 else return 0 end end
end
if not math.mix then
    math.mix = function(a, b, t) return a + (b - a) * t end
end
if not math.round then
    math.round = function(x)
        if x >= 0 then return math.floor(x + 0.5) else return math.ceil(x - 0.5) end
    end
end
if not math.hypot then
    math.hypot = function(a, b) return math.sqrt(a * a + b * b) end
end
if not math.diag then
    math.diag = function(...)
        local s = 0
        for _, v in ipairs({...}) do s = s + v * v end
        return math.sqrt(s)
    end
end
if not math.smoothstep then
    math.smoothstep = function(e0, e1, v)
        local t = (v - e0) / (e1 - e0)
        if t < 0 then t = 0 elseif t > 1 then t = 1 end
        return t * t * (3 - 2 * t)
    end
end
-- Lua 5.1 had math.log10; 5.3 dropped it in favour of math.log(x, 10). BAR's
-- gui_advplayerslist_music uses math.log10.
if not math.log10 then math.log10 = function(x) return math.log(x, 10) end end
-- math.tau (= 2*pi). Not standard, but BAR widgets (gui_projectile_target_aoe)
-- read it as a circle constant.
if not math.tau then math.tau = 2 * math.pi end
if not table.maxn then
    table.maxn = function(t)
        local n = 0
        for k, _ in pairs(t) do
            if type(k) == "number" and k > n then n = k end
        end
        return n
    end
end

if not newproxy then
    function newproxy(hasMeta)
        if hasMeta then
            local t = {}
            setmetatable(t, { __isProxy = true })
            return t
        else
            return {}
        end
    end
end

if not debug.getfenv then
    debug.getfenv = function(obj)
        if type(obj) == "function" then
            local i = 1
            while true do
                local name, val = debug.getupvalue(obj, i)
                if name == "_ENV" then return val
                elseif not name then break end
                i = i + 1
            end
        end
        return _ENV or _G
    end
end
if not debug.setfenv then
    debug.setfenv = function(obj, env)
        if type(obj) == "function" then
            local i = 1
            while true do
                local name = debug.getupvalue(obj, i)
                if name == "_ENV" then
                    debug.upvaluejoin(obj, i, (function() return env end), 1)
                    return obj
                elseif not name then break end
                i = i + 1
            end
        end
        return obj
    end
end

if not setfenv then
    function setfenv(fn, env)
        if type(fn) == "number" then return env end
        local i = 1
        while true do
            local name = debug.getupvalue(fn, i)
            if name == "_ENV" then
                debug.upvaluejoin(fn, i, (function() return env end), 1)
                return fn
            elseif not name then break end
            i = i + 1
        end
        return fn
    end
end

if not getfenv then
    function getfenv(fn)
        if fn == nil or fn == 0 then
            -- Return the caller's _ENV (stack level 2)
            local info = debug.getinfo(2, "f")
            if info and info.func then
                local i = 1
                while true do
                    local name, val = debug.getupvalue(info.func, i)
                    if name == "_ENV" then return val
                    elseif not name then break end
                    i = i + 1
                end
            end
            return _G
        end
        if type(fn) == "number" then
            -- Stack level: 1=getfenv itself, 2=caller, fn+1=target
            local info = debug.getinfo(fn + 1, "f")
            if info and info.func then
                local i = 1
                while true do
                    local name, val = debug.getupvalue(info.func, i)
                    if name == "_ENV" then return val
                    elseif not name then break end
                    i = i + 1
                end
            end
            return _G
        end
        -- fn is a function
        local i = 1
        while true do
            local name, val = debug.getupvalue(fn, i)
            if name == "_ENV" then return val
            elseif not name then break end
            i = i + 1
        end
        return _G
    end
end

if not table.shallowcopy then
    function table.shallowcopy(t)
        local copy = {}
        for k, v in pairs(t) do copy[k] = v end
        return copy
    end
end
if not table.merge then
    function table.merge(dst, src)
        for k, v in pairs(src) do
            if dst[k] == nil then dst[k] = v end
        end
        return dst
    end
end

if not gcinfo then
    gcinfo = function()
        return math.floor(collectgarbage("count"))
    end
end
`;

const CMD_GLOBALS_LUA = `
CMD = CMD or {}
setmetatable(CMD, { __index = function() return 0 end })
CMD.STOP = 0; CMD.INSERT = 1; CMD.REMOVE = 2
CMD.WAIT = 5; CMD.TIMEWAIT = 6; CMD.DEATHWAIT = 7
CMD.SQUADWAIT = 8; CMD.GATHERWAIT = 9; CMD.MOVE = 10
CMD.PATROL = 15; CMD.FIGHT = 16; CMD.ATTACK = 20
CMD.GUARD = 25; CMD.REPAIR = 40; CMD.FIRE_STATE = 45
CMD.MOVE_STATE = 50; CMD.REPEAT = 55; CMD.SELFD = 65
CMD.SET_WANTED_MAX_SPEED = 70; CMD.LOAD_UNITS = 75
CMD.UNLOAD_UNIT = 80; CMD.UNLOAD_UNITS = 81
CMD.ONOFF = 85; CMD.RECLAIM = 90; CMD.CLOAK = 95
CMD.STOCKPILE = 100; CMD.MANUALFIRE = 105; CMD.RESURRECT = 125
CMD.OPT_META = 4; CMD.OPT_INTERNAL = 8; CMD.OPT_RIGHT = 16
CMD.OPT_SHIFT = 32; CMD.OPT_CTRL = 64; CMD.OPT_ALT = 128

CMDTYPE = CMDTYPE or {}
CMDTYPE.ICON = 0; CMDTYPE.ICON_MODE = 5; CMDTYPE.ICON_MAP = 10
CMDTYPE.ICON_AREA = 11; CMDTYPE.ICON_UNIT = 12
CMDTYPE.ICON_UNIT_OR_MAP = 13; CMDTYPE.ICON_FRONT = 14
CMDTYPE.COMBO_BOX = 15; CMDTYPE.ICON_UNIT_OR_AREA = 16
CMDTYPE.NEXT = 17; CMDTYPE.PREV = 18; CMDTYPE.ICON_UNIT_FEATURE_OR_AREA = 19
CMDTYPE.ICON_BUILDING = 20; CMDTYPE.CUSTOM = 21
CMDTYPE.ICON_UNIT_OR_RECTANGLE = 22; CMDTYPE.NUMBER = 23

cmdColors = cmdColors or {}
`;

// PLAN-weapon-fx Phase Z1.5 — gadgetHandler stub for the unsynced halves
// of LuaRules gadgets. The headless server kills the unsynced LuaRules
// handle (rts/Lua/LuaHandleSynced.cpp:InitUnsynced), so the unsynced
// `else`-branches of `lups_*.lua` / `weapon_*.lua` etc. need a host on
// the client. This is the minimum surface those gadgets touch:
//
//   gadgetHandler:IsSyncedCode()            -- returns false
//   gadgetHandler:AddSyncAction(name, fn)   -- per-topic handler
//   gadgetHandler:RemoveSyncAction(name)
//   gadgetHandler:RegisterGlobal(name, fn)  -- exposes a global function
//   gadgetHandler:DeregisterGlobal(name)
//   gadgetHandler:AddGadget(g, name)        -- tracked for GameFrame fan-out
//   gadgetHandler:DispatchSyncAction(topic, ...) -- called from the worker
//                                                   on each SendToUnsynced
//
// DispatchSyncAction matches CUnsyncedLuaHandle::RecvFromSynced's shape:
// the topic is the first arg and is also forwarded as the action's first
// parameter (ZK gadgets typically discard it via the param name `_`).
const GADGET_HANDLER_LUA = `
gadgetHandler = gadgetHandler or {
    gadgets = {},
    knownGadgets = {},
    syncActions = {},
    globals = {},
    CMDIDs = {},
}

function gadgetHandler:IsSyncedCode() return false end
-- Top-level mirror — some gadgets check this before they've resolved
-- gadgetHandler (legacy compat shim from upstream Spring).
function IsSyncedCode() return false end

-- Shared gadget table. In real ZK this is gadgets.lua's \`GG = {}\` field,
-- injected into every gadget's env. We run the unsynced gadget halves in
-- the single worker global env and use the stub instead of gadgets.lua, so
-- GG would otherwise be nil — every \`GG.Lups\`, \`GG.lockPlayerIDs\`, etc.
-- read would crash. Create it once here. \`GG.Lups\` is bridged from the
-- widget-side \`WG.Lups\` after LUPS boots (see the lups_gg_bridge block);
-- lups.lua's line 138 (\`local GG = (widget and WG) or GG\`) populates
-- WG.Lups when loaded via the widget wrapper, not the global GG the
-- producer gadgets read.
GG = GG or {}

-- gadgetHandler.GG is the SAME shared table as the global GG. Real ZK
-- gadgets.lua makes \`GG\` a field of the handler (line 61, \`GG = {}\`) and
-- injects \`gadget.GG = self.GG\` into every gadget env; the global and the
-- handler field are one table. engine_compat_post.lua writes
-- \`gadgetHandler.GG.Disable_RequestPath\` / \`gadgetHandler.GG._AddUnitDamage_teamID\`
-- while producer gadgets read the global \`GG\` — alias them so both see the
-- same state (without this, \`gadgetHandler.GG\` is nil → index-nil crash).
gadgetHandler.GG = GG

-- Spring.UnitRendering / FeatureRendering: ZK's custom unit/feature draw hooks
-- (e.g. unit_enlarger calls \`Spring.UnitRendering.SetUnitLuaDraw\`). The worker
-- has no Lua-driven custom-unit-draw path, so these are no-op stubs that let the
-- gadgets load. The metatable returns a no-op for ANY method so we don't have to
-- enumerate the full engine API. FIDELITY-STANDIN: revisit if a gadget's
-- custom-render effect becomes visually important.
local _renderingNoop = function() end
Spring.UnitRendering = Spring.UnitRendering or setmetatable({}, {
    __index = function() return _renderingNoop end,
})
Spring.FeatureRendering = Spring.FeatureRendering or setmetatable({}, {
    __index = function() return _renderingNoop end,
})

function gadgetHandler:AddSyncAction(name, fn)
    if type(name) ~= "string" or type(fn) ~= "function" then return false end
    self.syncActions[name] = fn
    return true
end

function gadgetHandler:RemoveSyncAction(name)
    if type(name) ~= "string" then return false end
    self.syncActions[name] = nil
    return true
end

function gadgetHandler:DispatchSyncAction(topic, ...)
    if type(topic) ~= "string" then return end
    local fn = self.syncActions[topic]
    if not fn then return end
    local ok, err = pcall(fn, topic, ...)
    if not ok then
        Spring.Echo("[gadgetHandler] sync action error in '" .. topic .. "': " .. tostring(err))
    end
end

function gadgetHandler:RegisterGlobal(name, value)
    if type(name) ~= "string" then return false end
    self.globals[name] = value
    _G[name] = value
    return true
end

function gadgetHandler:DeregisterGlobal(name)
    if type(name) ~= "string" then return false end
    self.globals[name] = nil
    _G[name] = nil
    return true
end

function gadgetHandler:AddGadget(g, name)
    self.gadgets[#self.gadgets + 1] = g
    if name then self.knownGadgets[name] = g end
    return true
end

-- Custom command IDs. ZK gadgets.lua:933 validates (>=1000, non-dup) then stores
-- CMDIDs[id] = gadget. On the unsynced client there is no engine command to
-- register; we only need the call to succeed and to remember the owner so
-- RemoveGadget can clear it. Gadgets call this as \`gadgetHandler:RegisterCMDID(id)\`.
function gadgetHandler:RegisterCMDID(id)
    if id then self.CMDIDs[id] = gadget or true end
    return true
end

-- Self-disable. ZK gadgets.lua:645 — gadgets call \`gadgetHandler:RemoveGadget()\`
-- with no arg to remove themselves; the loader's global \`gadget\` is the one
-- currently running. Run its Shutdown, drop it from the fan-out list, and clear
-- any CMDIDs it owned.
function gadgetHandler:RemoveGadget(g)
    g = g or gadget
    if not g then return end
    if g.Shutdown then pcall(g.Shutdown, g) end
    for i = #self.gadgets, 1, -1 do
        if self.gadgets[i] == g then table.remove(self.gadgets, i) end
    end
    for id, owner in pairs(self.CMDIDs) do
        if owner == g then self.CMDIDs[id] = nil end
    end
end

-- Chat actions. ZK proxies \`gadget:AddChatAction\` to actionHandler (gadgets.lua:515).
-- No chat-command dispatch is wired in the worker, so we store the handler (the
-- call succeeds; the command is inert until a dispatch exists). FIDELITY-STANDIN.
function gadgetHandler:AddChatAction(cmd, fn, help)
    self.chatActions = self.chatActions or {}
    if type(cmd) == "string" and type(fn) == "function" then
        self.chatActions[cmd] = fn
    end
    return true
end

-- actionHandler: ZK's actions.lua module (gadgets.lua:43). dbg_* gadgets reach it
-- as \`gadgetHandler.actionHandler.AddSyncAction(gadget, name, fn)\` — note the dot
-- call with an explicit gadget first arg. Delegate to the sync-action table we own.
gadgetHandler.actionHandler = gadgetHandler.actionHandler or {
    AddSyncAction       = function(_g, name, fn) return gadgetHandler:AddSyncAction(name, fn) end,
    RemoveSyncAction    = function(_g, name)     return gadgetHandler:RemoveSyncAction(name) end,
    AddChatAction       = function(_g, cmd, fn, help) return gadgetHandler:AddChatAction(cmd, fn, help) end,
    RemoveChatAction    = function(_g, cmd) if gadgetHandler.chatActions then gadgetHandler.chatActions[cmd] = nil end end,
    RemoveGadgetActions = function(_g) end,
}

-- Per-tick fan-out — called from the worker's GameFrame handler so
-- gadgets with their own \`function gadget:GameFrame(n)\` callin fire.
function _SpringWebRunGadgetGameFrame(n)
    local gs = gadgetHandler.gadgets
    for i = 1, #gs do
        local g = gs[i]
        if g.GameFrame then pcall(g.GameFrame, g, n) end
    end
end

-- Generic per-callin fan-out to gadget unsynced halves. Used for
-- GameStart/GameOver and any other low-frequency callin the worker
-- forwards. Up to three positional args cover every current caller.
function _SpringWebRunGadgetCallin(name, a, b, c)
    local gs = gadgetHandler.gadgets
    for i = 1, #gs do
        local g = gs[i]
        if g[name] then pcall(g[name], g, a, b, c) end
    end
end
`;

// Lua source executed once per LuaRules/Gadgets/*.lua file whose
// unsynced half we want to host. Wraps the load in a per-file env so
// the gadget table can be captured and the action handlers can register
// before \`gadget:Initialize()\` runs. Errors are caught and surfaced to
// the console instead of aborting the whole scan.
function gadgetLoaderLua(path: string): string {
    const escaped = escapeLuaString(path);
    return `
do
    local _path = "${escaped}"
    local _ok, _err = pcall(function()
        gadget = {}
        local _chunk, _cerr = loadfile(_path)
        if not _chunk then error(_cerr or "no chunk") end
        _chunk()
        -- No GetInfo after running the chunk means the gadget is synced-only:
        -- its top-level \`if not gadgetHandler:IsSyncedCode() then return end\`
        -- early-returned, so nothing was defined. The \`\\nelse\` scan that picked
        -- this file false-positived on an unrelated else branch. There is no
        -- unsynced half to host — skip quietly (not an error).
        if not gadget.GetInfo then return end
        local _info = gadget:GetInfo()
        gadget.whInfo = _info
        if gadget.Initialize then gadget:Initialize() end
        gadgetHandler:AddGadget(gadget, _info and _info.name)
    end)
    if not _ok then
        Spring.Echo("[gadgetHandler] failed to load " .. _path .. ": " .. tostring(_err))
    end
    gadget = nil
end
`;
}

// ── Helpers ────────────────────────────────────────────────────────────

export function escapeLuaString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}

// ── Accessor seams ──────────────────────────────────────────────────────
// Exported let bindings are read-only at import sites; anything the GP half
// needs to READ gets a getter; anything it needs to WRITE gets a setter.
// Kept minimal and named obviously.

/** Get the current Fengari LuaRuntime (null if not yet booted or shut down). */
export function getRuntime(): LuaRuntime | null { return runtime; }

/** Get the current LuaGLBridge (null if not yet booted or shut down). */
export function getBridge(): LuaGLBridge | null { return bridge; }

/** Update the cached BGMusic stream position/duration from the main thread. */
export function setMusicStreamTime(played: number, duration: number): void {
    musicStreamPlayed = played;
    musicStreamDuration = duration;
}

/** Latch gpCtx.luaUiActive to false after a hard UI-pass error so gpRunUiPass
 *  stops spamming on failure. */
export function setLuaUiActiveFalse(): void {
    gpCtx.luaUiActive = false;
}

// ── GP-seam state that lives here because it's only used in installEngineGlobals ──

/** Whether any Lua-emitted deferred lights have been seen this session.
 *  Latched true on first non-empty _SpringWebEmitDeferredLights call so the
 *  projectile renderer's fallback stand-ins can suppress. Reset on shutdown. */
let gpAuthoredLightsActive = false;

/** Parse one of the flattened deferred-light strings emitted by the Lua
 *  collector. Records are ';'-separated, fields ','-separated; a record is
 *  kept only if it has at least `stride` finite numbers. Point stride 7
 *  (px,py,pz,r,g,b,radius); beam stride 10 (+dx,dy,dz). */
function parseDeferredLights(str: string, stride: number): number[][] {
    if (!str) return [];
    const out: number[][] = [];
    for (const rec of str.split(';')) {
        if (!rec) continue;
        const nums = rec.split(',').map(Number);
        if (nums.length >= stride && nums.every((n) => Number.isFinite(n))) {
            out.push(nums);
        }
    }
    return out;
}

/** Reset the authored-lights latch (called by shutdown). */
export function resetAuthoredLightsActive(): void { gpAuthoredLightsActive = false; }

/** Seed the storage cache from the main thread's localStorage snapshot
 *  (called before init() in the 'init' dispatcher case). */
export function seedStorageCache(data: Record<string, string>): void {
    for (const [k, v] of Object.entries(data)) {
        storageCache[k] = v;
    }
}

/** Get the current frameInterval handle (null if not running). */
export function getFrameInterval(): ReturnType<typeof setInterval> | null { return frameInterval; }

/** Whether the LuaUI runtime is in the process of shutting down. */
export function isShuttingDown(): boolean { return shuttingDown; }

/** Current BGMusic stream position (seconds). */
export function getMusicStreamPlayed(): number { return musicStreamPlayed; }

/** Current BGMusic stream duration (seconds). */
export function getMusicStreamDuration(): number { return musicStreamDuration; }

/** Pause the standalone frame loop (used by the legacy 'pauseFrames' message). */
export function pauseFramesHost(): void {
    if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
}

/** Resume the standalone frame loop (used by the legacy 'resumeFrames' message). */
export function resumeFramesHost(): void {
    if (frameInterval || !runtime || !bridge) return;
    const gl2 = bridge.getGL();
    if (gl2) {
        let running = false;
        frameInterval = setInterval(() => {
            if (!runtime || shuttingDown || running) return;
            running = true;
            try { runFrame(runtime!, gl2); } finally { running = false; }
        }, 33);
    }
}

// ── Dispatcher handler functions (called from lua-widget-worker.ts) ─────────
// These move large case bodies out of the dispatcher so the entry file stays
// thin (spec §2.5). Each handler owns the liveState mutations and Lua callins
// for its message type.

/** Handle the 'stateUpdate' message (camera/viewport/identity/selection sync). */
export function handleStateUpdate(msg: Record<string, unknown>): void {
    const prevSel = liveState.selectedUnitIds;
    const prevIdentity = liveState.identity;
    if (msg.camera) liveState.camera = msg.camera as typeof liveState.camera;
    if (msg.viewport) liveState.viewport = msg.viewport as typeof liveState.viewport;
    if (msg.identity) liveState.identity = msg.identity as typeof liveState.identity;
    if (msg.gameFrame !== undefined) liveState.gameFrame = msg.gameFrame as number;
    if (msg.selectedUnitIds) liveState.selectedUnitIds = msg.selectedUnitIds as number[];
    if (msg.viewMatrix) liveState.viewMatrix = msg.viewMatrix as Float32Array;
    if (msg.projMatrix) liveState.projMatrix = msg.projMatrix as Float32Array;
    if (msg.modKeys) liveState.modKeys = msg.modKeys as { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
    if (msg.mouse) liveState.mouse = msg.mouse as typeof liveState.mouse;
    if (msg.selectedUnitIds && !sameIdSet(prevSel, liveState.selectedUnitIds)) {
        dispatchSelectionChanged(liveState.selectedUnitIds);
        dispatchCommandsChanged(true);
    }
    if (msg.identity && prevIdentity.myPlayerId > 0
        && (prevIdentity.myTeam !== liveState.identity.myTeam
            || prevIdentity.myAllyTeam !== liveState.identity.myAllyTeam
            || prevIdentity.myPlayerId !== liveState.identity.myPlayerId)) {
        dispatchPlayerChanged(liveState.identity.myPlayerId);
    }
}

/** Handle the 'rosterUpdate' message (players/teams/teamColors/modOptions). */
export function handleRosterUpdate(msg: Record<string, unknown>): void {
    const players = msg.players as Array<{
        id: number; name?: string; active?: boolean; spectator?: boolean;
        team: number; allyTeam?: number; pingMs?: number; cpuUsage?: number;
        country?: string; rank?: number; hasController?: boolean;
        customKeys?: Record<string, string>;
    }> | undefined;
    const teams = msg.teams as Array<{
        id: number; allyTeam?: number; leader?: number; isDead?: boolean;
        isAi?: boolean; side?: string; incomeMultiplier?: number;
        customKeys?: Record<string, string>;
    }> | undefined;
    const teamColors = msg.teamColors as Array<{
        team: number; r: number; g: number; b: number; a?: number;
    }> | undefined;
    const modOptions = msg.modOptions as Record<string, number | string> | undefined;

    if (players) {
        liveState.players.clear();
        for (const p of players) {
            liveState.players.set(p.id, {
                name: p.name ?? `Player${p.id}`,
                active: p.active ?? true,
                spectator: p.spectator ?? false,
                team: p.team,
                allyTeam: p.allyTeam ?? p.team,
                pingMs: p.pingMs ?? 0,
                cpuUsage: p.cpuUsage ?? 0,
                country: p.country ?? '',
                rank: p.rank ?? 0,
                hasController: p.hasController ?? true,
                customKeys: p.customKeys ?? {},
            });
        }
    }
    if (teams) {
        liveState.teams.clear();
        for (const t of teams) {
            liveState.teams.set(t.id, {
                teamId: t.id,
                leader: t.leader ?? -1,
                isDead: t.isDead ?? false,
                isAiTeam: t.isAi ?? false,
                side: t.side ?? '',
                allyTeam: t.allyTeam ?? t.id,
                incomeMultiplier: t.incomeMultiplier ?? 1,
                customKeys: t.customKeys ?? {},
            });
        }
    }
    if (teamColors) {
        liveState.teamColors.clear();
        for (const c of teamColors) {
            liveState.teamColors.set(c.team, [c.r, c.g, c.b, c.a ?? 1]);
        }
    }
    if (modOptions) {
        liveState.modOptions = { ...modOptions };
    }
}

/** Handle the 'rulesParamUpdate' message (game/team/unit/player rules params). */
export function handleRulesParamUpdate(msg: Record<string, unknown>): void {
    const scope = msg.scope as 'game' | 'team' | 'unit' | 'player';
    const id = msg.id as number | undefined;
    const params = (msg.params as Record<string, number | string | null> | undefined) ?? {};
    const replace = msg.replace as boolean | undefined;

    const targetMap: Map<string, number | string> | undefined = (() => {
        if (scope === 'game') return liveState.gameRulesParams;
        if (id === undefined) return undefined;
        const bucket =
            scope === 'team'   ? liveState.teamRulesParams   :
            scope === 'unit'   ? liveState.unitRulesParams   :
            scope === 'player' ? liveState.playerRulesParams :
            undefined;
        if (!bucket) return undefined;
        let m = bucket.get(id);
        if (!m) { m = new Map(); bucket.set(id, m); }
        return m;
    })();

    if (!targetMap) return;
    if (replace) targetMap.clear();
    for (const [k, v] of Object.entries(params)) {
        if (v === null) targetMap.delete(k);
        else targetMap.set(k, v);
    }
}

/** Handle the 'sendToUnsynced' message (Spring.SendToUnsynced from LuaRules). */
export function handleSendToUnsynced(msg: Record<string, unknown>): void {
    if (!runtime) return;
    const args = msg.args as Array<
        | { kind: 'nil' }
        | { kind: 'bool'; value: boolean }
        | { kind: 'number'; value: number }
        | { kind: 'string'; value: string }
    > | undefined;
    if (!args || args.length === 0) return;
    // SendLuaRulesMsg forward (server LuaUnsyncedCtrl::SendLuaRulesMsg)
    // — arg[0] is the "$RecvLuaMsg" sentinel topic, arg[1] the message
    // string, arg[2] the playerID. Faithful routing: dispatch to every
    // loaded unsynced gadget half's gadget:RecvLuaMsg(msg, playerID)
    // (Spring's LuaRules message callin), not a registered sync action.
    if (args[0].kind === 'string' && args[0].value === '$RecvLuaMsg') {
        const body = args[1] && args[1].kind === 'string' ? args[1].value : '';
        const pid = args[2] && args[2].kind === 'number' && Number.isFinite(args[2].value)
            ? args[2].value : 0;
        runtime.doString(
            `if gadgetHandler and gadgetHandler.gadgets then ` +
            `for _, g in ipairs(gadgetHandler.gadgets) do ` +
            `if g.RecvLuaMsg then pcall(g.RecvLuaMsg, g, "${escapeLuaString(body)}", ${pid}) end ` +
            `end end`,
            'recvLuaMsg',
        );
        return;
    }
    const parts: string[] = [];
    for (const a of args) {
        switch (a.kind) {
            case 'nil':    parts.push('nil'); break;
            case 'bool':   parts.push(a.value ? 'true' : 'false'); break;
            case 'number': parts.push(Number.isFinite(a.value) ? String(a.value) : 'nil'); break;
            case 'string': parts.push(`"${escapeLuaString(a.value)}"`); break;
        }
    }
    runtime.doString(
        `if gadgetHandler and gadgetHandler.DispatchSyncAction then ` +
        `gadgetHandler:DispatchSyncAction(${parts.join(', ')}) end`,
        'sendToUnsynced',
    );
}

/** Handle the 'intelTransitions' message (LOS/radar/cloak transitions). */
export function handleIntelTransitions(msg: Record<string, unknown>): void {
    if (!runtime) return;
    const events = msg.events as Array<{
        kind: 'enteredLos' | 'leftLos' | 'enteredRadar' | 'leftRadar' | 'cloaked' | 'decloaked';
        unitId: number; unitTeam: number; unitDefId: number;
    }> | undefined;
    if (!events || events.length === 0) return;
    const myAllyTeam = liveState.identity?.myAllyTeam ?? 0;
    const lines: string[] = [];
    for (const ev of events) {
        const u = ev.unitId, t = ev.unitTeam, d = ev.unitDefId;
        switch (ev.kind) {
            case 'enteredLos':
                lines.push(`if widgetHandler and widgetHandler.UnitEnteredLos then pcall(widgetHandler.UnitEnteredLos, widgetHandler, ${u}, ${t}, ${myAllyTeam}, ${d}) end`);
                break;
            case 'leftLos':
                lines.push(`if widgetHandler and widgetHandler.UnitLeftLos then pcall(widgetHandler.UnitLeftLos, widgetHandler, ${u}, ${t}, ${myAllyTeam}, ${d}) end`);
                break;
            case 'enteredRadar':
                lines.push(`if widgetHandler and widgetHandler.UnitEnteredRadar then pcall(widgetHandler.UnitEnteredRadar, widgetHandler, ${u}, ${t}, ${myAllyTeam}, ${d}) end`);
                break;
            case 'leftRadar':
                lines.push(`if widgetHandler and widgetHandler.UnitLeftRadar then pcall(widgetHandler.UnitLeftRadar, widgetHandler, ${u}, ${t}, ${myAllyTeam}, ${d}) end`);
                break;
            case 'cloaked':
                lines.push(`if widgetHandler and widgetHandler.UnitCloaked then pcall(widgetHandler.UnitCloaked, widgetHandler, ${u}, ${d}, ${t}) end`);
                break;
            case 'decloaked':
                lines.push(`if widgetHandler and widgetHandler.UnitDecloaked then pcall(widgetHandler.UnitDecloaked, widgetHandler, ${u}, ${d}, ${t}) end`);
                break;
        }
    }
    if (lines.length > 0) {
        runtime.doString(lines.join('\n'), 'callin:intelTransitions');
    }
}

/** Handle the 'standingOrders' message (full snapshot replacement). */
export function handleStandingOrders(msg: Record<string, unknown>): void {
    const orders = Array.isArray(msg.orders) ? msg.orders as Array<Record<string, unknown>> : [];
    liveState.standingOrders.clear();
    for (const o of orders) {
        const id = Number(o.orderId ?? 0) | 0;
        if (id <= 0) continue;
        const condsIn = (o.conditions ?? {}) as Record<string, unknown>;
        const wc = condsIn.withinCenter as [number, number, number] | undefined;
        const oc = condsIn.outsideCenter as [number, number, number] | undefined;
        liveState.standingOrders.set(id, {
            orderId: id,
            ownerTeam: Number(o.ownerTeam ?? 0) | 0,
            type: String(o.type ?? 'DefendArea'),
            priority: Number(o.priority ?? 0) | 0,
            params: Array.isArray(o.params)
                ? (o.params as number[]).map(Number)
                : [],
            conditions: {
                idleOnly: Boolean(condsIn.idleOnly ?? true),
                squadTypes: Array.isArray(condsIn.squadTypes)
                    ? (condsIn.squadTypes as number[]).map(n => Number(n) | 0)
                    : [],
                withinCenter: wc ? [Number(wc[0]), Number(wc[1]), Number(wc[2])] : [0, 0, 0],
                withinRadius: Number(condsIn.withinRadius ?? 0),
                outsideCenter: oc ? [Number(oc[0]), Number(oc[1]), Number(oc[2])] : [0, 0, 0],
                outsideRadius: Number(condsIn.outsideRadius ?? 0),
                minStrength: Number(condsIn.minStrength ?? 0),
                hasCapabilities: Array.isArray(condsIn.hasCapabilities)
                    ? (condsIn.hasCapabilities as string[]).map(String)
                    : [],
            },
            assignedSquadCount: Number(o.assignedSquadCount ?? 0) | 0,
            active: Boolean(o.active ?? true),
            createdAtFrame: Number(o.createdAtFrame ?? 0) | 0,
            expiresAtFrame: Number(o.expiresAtFrame ?? 0) | 0,
        });
    }
}

/** Handle the 'unitCommandQueues' message (snapshot replacement). */
export function handleUnitCommandQueues(msg: Record<string, unknown>): void {
    const queues = msg.queues as Array<{
        unitId: number;
        orders: Array<{ cmdId: number; params: number[]; options: number; tag: number; timeout: number }>;
    }> | undefined;
    if (!queues) return;
    liveState.unitCommands.clear();
    for (const q of queues) {
        liveState.unitCommands.set(q.unitId, q.orders.map(o => ({
            cmdId: o.cmdId, params: [...o.params],
            options: o.options, tag: o.tag, timeout: o.timeout,
        })));
    }
    dispatchCommandsChanged();
}

