/**
 * LuaUI Web Worker — runs fengari and all widget Lua code off the main thread.
 *
 * Receives an OffscreenCanvas for 2D UI rendering (DrawScreen).
 * World-space callins (DrawWorldPreUnit etc.) produce a command buffer
 * sent back to the main thread for replay on the Babylon GL context.
 *
 * Message protocol:
 *   Main → Worker:
 *     {type:'init', canvas, gameId, lobbyUrl, mapData}
 *     {type:'frame', viewMatrix, projMatrix}
 *     {type:'keypress', keyCode, alt, ctrl, meta, shift}
 *     {type:'getWidgetList'}
 *     {type:'shutdown'}
 *
 *   Worker → Main:
 *     {type:'log', level, msg}
 *     {type:'ready', fileCount}
 *     {type:'widgetList', data}
 *     {type:'worldGLCommands', commands}  (future — command buffer for world-space rendering)
 *     {type:'error', msg}
 */

import { LuaRuntime, type LuaValue, luaTable } from './lua-runtime.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    createDefaultLiveState,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
    type FeatureEntry,
} from './lua-spring-api.js';

// Engine-bundled test widgets. Loaded only when `?widgetTest` is active.
// Bundled here (not in any game's content) so the gl-bridge / Chili
// pipeline can be exercised against known-good widgets regardless of
// which game is loaded.
import dbgRenderTestSrc from '../lua-test-widgets/dbg_render_test.lua?raw';
import dbgRenderTestQuit from '../lua-test-widgets/quit.png?url';
import dbgRenderTestTick from '../lua-test-widgets/tick.png?url';
import dbgRenderTestPanel from '../lua-test-widgets/panel_0001.png?url';
import dbgChiliTestSrc from '../lua-test-widgets/dbg_chili_test.lua?raw';
import dbgFontBaselineSrc from '../lua-test-widgets/dbg_font_baseline.lua?raw';
import dbgEndgameTriggerSrc from '../lua-test-widgets/dbg_endgame_trigger.lua?raw';

// ── Types ──────────────────────────────────────────────────────────────

interface MapDataTransfer {
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

// ── VFS state ──────────────────────────────────────────────────────────

const vfsFiles = new Map<string, string>();
const vfsPathMap = new Map<string, string>();
const vfsDirCache = new Map<string, string[]>();
const vfsSubdirCache = new Map<string, string[]>();

function vfsIndexPath(path: string): void {
    vfsPathMap.set(path.toLowerCase(), path);

    const lastSlash = path.lastIndexOf('/');
    if (lastSlash >= 0) {
        const dir = path.substring(0, lastSlash + 1);
        const file = path.substring(lastSlash + 1);

        // Use lowercase keys for directory caches so case-insensitive
        // lookups work (ZK code uses "skins/" but disk has "Skins/").
        const dirKey = dir.toLowerCase();
        if (!vfsDirCache.has(dirKey)) vfsDirCache.set(dirKey, []);
        const dirArr = vfsDirCache.get(dirKey)!;
        if (!dirArr.includes(file)) dirArr.push(file);

        const parts = path.split('/');
        for (let i = 1; i < parts.length - 1; i++) {
            const parent = parts.slice(0, i).join('/').toLowerCase() + '/';
            const child = parts[i];
            if (!vfsSubdirCache.has(parent)) vfsSubdirCache.set(parent, []);
            const subs = vfsSubdirCache.get(parent)!;
            // Avoid duplicate subdirs with different case
            if (!subs.some(s => s.toLowerCase() === child.toLowerCase())) {
                subs.push(child);
            }
        }
    }
}

function vfsRegister(path: string, content: string): void {
    vfsFiles.set(path, content);
    vfsIndexPath(path);
}

/// Register a path that exists on disk but whose bytes aren't stored
/// in the worker. Used for binary assets (audio, images) so widgets
/// can probe via VFS.FileExists / VFS.DirList without us prefetching
/// megabytes of content the Lua side can't consume anyway. AudioManager
/// fetches the actual bytes directly when a SoundEvent fires.
function vfsRegisterPath(path: string): void {
    if (vfsPathMap.has(path.toLowerCase())) return;
    vfsIndexPath(path);
}

/// Audio extensions mirror ContentServer.cpp's whitelist. Kept in
/// sync so a file servable over HTTP is discoverable via VFS.
const AUDIO_EXTS = ['.wav', '.ogg', '.webm', '.m4a', '.mp3'];
function isAudioFile(nameLower: string): boolean {
    for (const ext of AUDIO_EXTS) {
        if (nameLower.endsWith(ext)) return true;
    }
    return false;
}

/// Existence check that succeeds for both content-bearing and
/// path-only registrations. vfsLookup intentionally returns undefined
/// for path-only entries so VFS.LoadFile yields nil on binary assets,
/// so we can't piggyback on it for existence semantics.
function vfsExists(path: string): boolean {
    if (vfsFiles.has(path)) return true;
    if (vfsFiles.has('LuaUI/' + path)) return true;
    const lower = path.toLowerCase();
    if (vfsPathMap.has(lower)) return true;
    if (vfsPathMap.has(('LuaUI/' + path).toLowerCase())) return true;
    return false;
}

function vfsLookup(path: string): string | undefined {
    const exact = vfsFiles.get(path);
    if (exact !== undefined) return exact;
    const withPrefix = vfsFiles.get('LuaUI/' + path);
    if (withPrefix !== undefined) return withPrefix;
    const lower = path.toLowerCase();
    const canonical = vfsPathMap.get(lower);
    if (canonical) return vfsFiles.get(canonical);
    const canonicalPrefixed = vfsPathMap.get(('LuaUI/' + path).toLowerCase());
    if (canonicalPrefixed) return vfsFiles.get(canonicalPrefixed);
    return undefined;
}

// ── HTTP VFS prefetch ──────────────────────────────────────────────────

async function prefetchAllGameFiles(baseUrl: string): Promise<void> {
    // Top-level game files that some widgets VFS.Include directly
    // (e.g. ModOptions.lua, modinfo.lua). The BFS below starts from
    // subdirectories so root files would otherwise never be fetched.
    const ROOT_FILES = ['ModOptions.lua', 'modoptions.lua', 'modinfo.lua'];
    await Promise.all(ROOT_FILES.map(async (fp) => {
        try {
            const fRes = await fetch(`${baseUrl}/${fp}`);
            if (fRes.ok) vfsRegister(fp, await fRes.text());
        } catch { /* silent */ }
    }));
    const queue = [
        'LuaUI', 'LuaRules', 'LuaRules/Utilities',
        'LuaRules/Configs', 'Configs',
        // Chili UI framework has deep directory trees that may not
        // be reached by BFS from LuaUI if the walker doesn't descend
        // into all Widget subdirectories quickly enough.
        'LuaUI/Widgets/chili', 'LuaUI/Widgets/chili_old',
        'gamedata',
        // ZK keeps shared library code in top-level dirs that root-BFS
        // would otherwise skip. modularCommAPI/ is referenced by
        // api_modularcomms.lua → drives WG.ModularCommAPI → drives
        // commander selector and several context-menu widgets.
        'modularCommAPI',
        // Game-root audio. ZK's snd_noises and friends probe
        // `Sounds/reply/<unit>.WAV` via VFS.FileExists; without this
        // descent the audio paths aren't indexed and every probe
        // returns false even though the bytes are on disk.
        'sounds',
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const dir = queue.shift()!;
        if (visited.has(dir.toLowerCase())) continue;
        visited.add(dir.toLowerCase());

        try {
            const res = await fetch(`${baseUrl}/${dir}`);
            if (!res.ok) continue;
            const entries = await res.json() as { name: string; type: string }[];

            // Batch file fetches in groups of 30 to avoid overwhelming
            // the single-threaded lobby HTTP server with hundreds of
            // concurrent connections. Failing files are retried once.
            const toFetch: string[] = [];
            for (const e of entries) {
                const fullPath = `${dir}/${e.name}`;
                if (e.type === 'file') {
                    const lower = e.name.toLowerCase();
                    if (lower.endsWith('.lua') || lower.endsWith('.txt') ||
                        lower.endsWith('.json')) {
                        if (vfsFiles.has(fullPath)) continue;
                        toFetch.push(fullPath);
                    } else if (isAudioFile(lower)) {
                        // Path-only index — AudioManager fetches the bytes
                        // on demand when a SoundEvent fires.
                        vfsRegisterPath(fullPath);
                    }
                } else if (e.type === 'dir' || e.type === 'directory') {
                    queue.push(fullPath);
                }
            }
            const BATCH = 30;
            const failed: string[] = [];
            for (let i = 0; i < toFetch.length; i += BATCH) {
                const batch = toFetch.slice(i, i + BATCH);
                await Promise.all(batch.map(async (fp) => {
                    try {
                        const fRes = await fetch(`${baseUrl}/${fp}`);
                        if (fRes.ok) vfsRegister(fp, await fRes.text());
                        else failed.push(fp);
                    } catch { failed.push(fp); }
                }));
            }
            // Retry once for files that failed (transient network issues)
            for (const fp of failed) {
                try {
                    const fRes = await fetch(`${baseUrl}/${fp}`);
                    if (fRes.ok) vfsRegister(fp, await fRes.text());
                } catch { /* silent */ }
            }
        } catch { /* silent */ }
    }
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

function postLog(level: number, msg: string): void {
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

/// Wrap every outgoing postMessage so we can diagnose the shutdown loop.
/// Level-1 debug traffic so it's hidden from normal views but visible
/// via the debug console filter. `log` messages are skipped to avoid
/// recursive self-description of the log pipe.
function postToMain(msg: Record<string, unknown>, transfer?: Transferable[]): void {
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

function loadAndPostSoundItems(rt: LuaRuntime): void {
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

function describeMessage(msg: Record<string, unknown>): string {
    const t = String(msg.type ?? '?');
    // Short summary per message type; avoids dumping huge payloads.
    switch (t) {
        case 'ready':      return `ready (fileCount=${msg.fileCount}, callins=${(msg.callins as string[])?.join(',') || 'none'})`;
        case 'error':      return `error: ${String(msg.msg ?? '')}`;
        case 'storage:set':return `storage:set key=${msg.key}`;
        case 'widgetList': return `widgetList (${String(msg.data ?? '').length} bytes)`;
        case 'worldGLCommands': return `worldGLCommands (${(msg.commands as unknown[])?.length ?? '?'} cmds)`;
        default:           return t;
    }
}

function describeInboundMessage(msg: Record<string, unknown>): string {
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
        case 'intelTransitions': return `intelTransitions (${(msg.events as unknown[])?.length ?? 0} events)`;
        case 'seismicPings':  return `seismicPings (${(msg.pings as unknown[])?.length ?? 0} pings)`;
        case 'losBitmap':     return `losBitmap allyTeam=${msg.allyTeam} ${msg.width}x${msg.height} frame=${msg.frame}`;
        case 'resourceUpdate':return `resourceUpdate team=${msg.team}`;
        case 'gameInfo':      return `gameInfo frame=${msg.frame}`;
        default:              return t;
    }
}

// ── localStorage bridge ────────────────────────────────────────────────
// Workers can't access localStorage directly. Main thread sends all
// luaui:* entries at init time; writes update the local cache AND post
// back to main thread for persistence.

const storageCache: Record<string, string> = {};

function loadFromStorage(key: string): string | null {
    return storageCache[key] ?? null;
}

function saveToStorage(key: string, value: string): void {
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
const liveState: LiveState = createDefaultLiveState();

// Per-game unit/weapon def caches, populated incrementally by
// unitDefsUpdate / weaponDefsUpdate. The wire-format defs from the
// server are minimal (id, name, model URL, texture URL) — we merge in
// safe defaults for the fields ZK widgets routinely access (health,
// metalCost, customParams, isFactory, …) so reads don't crash. Real
// def values will need a richer protocol later.
interface MinimalUnitDefWire {
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
}
interface MinimalWeaponDefWire {
    defId: number; name: string; visualType: number;
    projectileSpeed: number; range: number; aoe: number; size: number;
    intensity: number; colorR: number; colorG: number; colorB: number;
    duration: number; highTrajectory: boolean;
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
const unitDefMap = new Map<number, MinimalUnitDefWire>();
const weaponDefMap = new Map<number, MinimalWeaponDefWire>();

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
        moveDef: {} as Record<string, LuaValue>,
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
        visualType: d.visualType,
        projectilespeed: d.projectileSpeed,
        range: d.range,
        damageAreaOfEffect: d.aoe,
        size: d.size,
        intensity: d.intensity,
        rgbColor: [d.colorR, d.colorG, d.colorB],
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
function republishDefGlobals(rt: LuaRuntime): void {
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

async function init(
    canvas: OffscreenCanvas,
    gameId: string,
    lobbyUrl: string,
    mapData: MapDataTransfer,
    soloWidget?: string,
): Promise<void> {
    const baseUrl = `${lobbyUrl}/api/games/data/${gameId}`;
    initBaseUrl = baseUrl;
    startTime = performance.now() / 1000;

    postLog(2, `[LuaUI] init step 1/8: VFS prefetch starting from ${baseUrl}`);

    // 1. Prefetch VFS
    await prefetchAllGameFiles(baseUrl);
    postLog(2, `[LuaUI] init step 1/8 done: VFS ${vfsFiles.size} files prefetched`);

    // 2. Create GL context on OffscreenCanvas for 2D UI rendering
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext;

    if (!gl) {
        postLog(4, 'Failed to create WebGL2 context on OffscreenCanvas');
        postToMain({ type: 'error', msg: 'No WebGL2 on OffscreenCanvas' });
        return;
    }

    postLog(2, '[LuaUI] init step 2/8 done: WebGL2 context ready');

    // 3. Create Lua runtime and GL bridge
    runtime = new LuaRuntime('LuaUI');
    bridge = new LuaGLBridge(gl, mapData.mapSourceUrl);
    bridge.setGameBaseUrl(baseUrl);
    // Resolve Spring's `'#' .. unitDefID` build-pic syntax to the unit's
    // buildPic filename — chili Image controls in the Core Selector and
    // FactoryBar pass `'#' .. id` as the texture file. Without this, every
    // such image falls back to a magenta 1×1 placeholder (the "pink boxes"
    // a player sees on the commander/engineer panel and factory tiles).
    bridge.setBuildPicResolver((defId) => {
        const d = unitDefMap.get(defId);
        return d?.buildPic ? d.buildPic : null;
    });
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
        setSelection: (unitIds) => {
            postToMain({ type: 'setSelection', unitIds });
        },
        setCameraTarget: (x, z, smoothness) => {
            postToMain({ type: 'setCameraTarget', x, z, smoothness });
        },
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
        setActiveCommand: (cmdId, mods) => {
            postToMain({ type: 'setActiveCommand', cmdId, mods });
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
    };

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
    // Pre-install a nil-safe math.round. ZK's numberfunctions.lua
    // defines one but it crashes on nil input, which happens during
    // epicmenu's include chain. This version falls back to 0 for nil.
    // Also install math.bit_inv — Spring engine adds it as part of its
    // bitops surface; ZK widgets call it at file scope.
    runtime.doString(`
        function math.round(num, idp)
            num = num or 0
            return ("%." .. (((num==0) and 0) or idp or 0) .. "f"):format(num)
        end
        if not math.bit_inv then
            math.bit_inv = function(x)
                if bit32 and bit32.bnot then return bit32.bnot(x or 0) end
                return -1 - (x or 0)
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

    // Patch control.lua: disable _all_dlist caching. Chili's Control:Draw
    // checks _all_dlist first and short-circuits, skipping _own_dlist and
    // DrawChildren. The _all_dlist is recorded during Update (before
    // DrawScreen sets up projection/modelview), so the captured content
    // renders in the wrong matrix context. Disabling it forces the
    // individual _own_dlist + DrawChildren path which draws live each frame.
    const controlPath = 'LuaUI/Widgets/chili_old/controls/control.lua';
    const controlSrc = vfsLookup(controlPath);
    if (controlSrc) {
        // Disable _UpdateAllDList so _all_dlist is never created
        let patched = controlSrc.replace(
            'self:_UpdateAllDList()',
            '-- self:_UpdateAllDList() -- disabled: web renderer draws live',
        );
        // Also disable _children_dlist creation
        patched = patched.replace(
            'self._children_dlist = gl.CreateList(self.DrawChildrenForList,self)',
            '-- self._children_dlist = gl.CreateList(self.DrawChildrenForList,self) -- disabled',
        );
        // Also disable _own_dlist caching. Skin draws (DrawWindow / DrawPanel
        // etc.) call gl.TextureInfo to get TileImage dimensions for 9-slice
        // UV math. The first invocation runs before the async-loaded skin
        // texture has resolved, so TextureInfo returns the 1x1 placeholder
        // dimensions and the recorded UVs are wrong (out of [0,1], producing
        // a tiled-texture grid instead of a seamless 9-slice frame). Drawing
        // live each frame avoids stale-UV recordings — the cost is one extra
        // skin draw per frame per visible control.
        patched = patched.replace(
            'self._own_dlist = gl.CreateList(self.DrawControl, self)',
            '-- self._own_dlist = gl.CreateList(self.DrawControl, self) -- disabled: live draw',
        );
        if (patched !== controlSrc) {
            vfsRegister(controlPath, patched);
            postLog(2, '[LuaUI] Patched control.lua: disabled all dlist caching (live draws)');
        }
    }

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

    postLog(2, '[LuaUI] init step 7/8: starting bootstrap (VFS.Include camain.lua)...');
    const bootStart = performance.now();
    const bootErr = runtime.doString(`
        local ok, err = pcall(function()
            VFS.Include("LuaUI/camain.lua", nil, VFS.GAME)
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

    // Post-bootstrap API patches: ZK's bootstrap replaces Spring.Utilities
    // with its own table, so any pre-bootstrap additions are lost. Add
    // missing stubs that ZK widgets expect but ZK's own utilities don't provide.
    runtime.doString(`
        if Spring.Utilities then
            Spring.Utilities.GetHumanName = Spring.Utilities.GetHumanName or function(ud)
                if type(ud) == "table" and ud.humanName then return ud.humanName end
                if type(ud) == "table" and ud.name then return ud.name end
                return tostring(ud or "")
            end
            Spring.Utilities.bit_inv = Spring.Utilities.bit_inv or function(x)
                return bit32 and bit32.bnot(x) or (~x)
            end
        end
        if not Spring.Translate then
            Spring.Translate = function(key) return tostring(key or "") end
        end
        if not Spring.GetHumanName then
            Spring.GetHumanName = function(defName) return tostring(defName or "") end
        end
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

    // Report which callins widgets registered so main thread only sends needed events
    const registeredCallins = getRegisteredCallins(runtime);
    postToMain({ type: 'ready', fileCount: vfsFiles.size, callins: registeredCallins });
}

function runFrame(rt: LuaRuntime, gl: WebGL2RenderingContext): void {
    // Set up GL state for 2D overlay rendering
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    // Callins: Update → GameFrame (per-tick) → DrawGenesis → DrawScreen
    rt.doString(`
        -- Deferred Chili TaskHandler patch (runs once after WG.Chili exists)
        if _chiliTaskFix then _chiliTaskFix() end

        if Update then pcall(Update) end

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
            end
        end

        if DrawGenesis then pcall(DrawGenesis) end

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

            -- Rebuild display lists after async texture loads complete.
            -- Skin textures load asynchronously but gl.TextureInfo returns
            -- placeholder dimensions (1x1) at first recording. The 9-slice
            -- UV math uses texWidth/texHeight, so stale dimensions produce
            -- wildly wrong UVs. We do a one-time full rebuild after textures
            -- have had time to load (~3 seconds after init).
            if not _chiliTextureRebuildDone and _chiliFixTimer > 90 then
                _chiliTextureRebuildDone = true
                -- Invalidate all controls so Chili fully rebuilds every
                -- display list (_own_dlist, _all_dlist, _children_dlist).
                -- Control:Draw short-circuits on _all_dlist, so just
                -- rebuilding _own_dlist is not enough.
                local function invalidateAll(ctrl, depth)
                    if depth > 10 then return end
                    -- Delete ALL cached display lists
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
                Spring.Echo("[LuaUI] Invalidated all Chili display lists for texture rebuild")
            end
        end

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
    `, 'callin:frame');
}

// ── Engine globals ─────────────────────────────────────────────────────

function installEngineGlobals(
    rt: LuaRuntime,
    glBridge: LuaGLBridge,
    ctx: SpringAPIContext,
    gameId: string,
): void {
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
    // Stubs for Spring APIs ZK widgets call at Initialize-time.
    // Returning nothing is fine — these widgets gate on the result.
    (springGlobals.Spring as Record<string, LuaValue>).GetAIInfo = (_team: LuaValue) => [-1, '', '', '', '', {}];
    (springGlobals.Spring as Record<string, LuaValue>).GetSkirmishAIInfo = (_team: LuaValue) => [-1, '', '', '', '', {}];
    (springGlobals.Spring as Record<string, LuaValue>).AssignMouseCursor = (_name: LuaValue, _file: LuaValue, _hotX: LuaValue, _hotY: LuaValue) => true;
    (springGlobals.Spring as Record<string, LuaValue>).ReplaceMouseCursor = (_name: LuaValue, _file: LuaValue, _hotX: LuaValue, _hotY: LuaValue) => true;
    (springGlobals.Spring as Record<string, LuaValue>).SetDrawSelectionInfo = (_show: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).SetDrawGroundDeprecated = (_show: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).GetFrameTimeOffset = () => 0;
    (springGlobals.Spring as Record<string, LuaValue>).IsGodModeEnabled = () => false;
    (springGlobals.Spring as Record<string, LuaValue>).SetSunLighting = (_params: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).SetAtmosphere = (_params: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).SetCameraOffset = (_x: LuaValue, _y: LuaValue, _z: LuaValue, _tx: LuaValue, _ty: LuaValue, _tz: LuaValue) => undefined;
    (springGlobals.Spring as Record<string, LuaValue>).GetTeamStartPosition = (_team: LuaValue) => [0, 0, 0];
    (springGlobals.Spring as Record<string, LuaValue>).GetCurrentTooltip = () => '';
    (springGlobals.Spring as Record<string, LuaValue>).GetVisibleFeatures = (
        _allyTeamID: LuaValue,
        _radius: LuaValue,
        _icons: LuaValue,
        _geos: LuaValue,
    ) => luaTable();
    (springGlobals.Spring as Record<string, LuaValue>).GetConsoleBuffer = (_count: LuaValue) => luaTable();
    (springGlobals.Spring as Record<string, LuaValue>).GetTeamStatsHistory = (
        _teamID: LuaValue,
        startIndex: LuaValue,
        _endIndex: LuaValue,
    ) => (startIndex === undefined || startIndex === null ? 0 : luaTable());

    // Spring.Utilities — stub table; Lua-side code below adds CopyTable etc.
    (springGlobals.Spring as Record<string, LuaValue>).Utilities = {};

    // Install all globals except VFS (set up separately in Lua)
    for (const [k, v] of Object.entries(springGlobals)) {
        if (k === 'VFS') continue;
        rt.setGlobal(k, v);
    }
    rt.setGlobal('gl', glGlobal);

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

    // Platform table — some GL4 widgets check this
    rt.setGlobal('Platform', {
        glVersionShort: 'WebGL 2.0',
        glVersion: 'WebGL 2.0',
        glslVersionShort: '300',
        glslVersion: '300 es',
        gpuVendor: 'WebGL',
        gpuName: 'WebGL2',
        glSupportClipSpaceControl: false,
        glSupport24bitDepthBuffer: true,
        glSupportRestartPrimitive: false,
        glSupportFragDepthLayout: false,
        numCompressedTexFormats: 0,
    });

    // Publish whatever defs have already arrived (the def stream may
    // race the worker bootstrap; pending entries replay here).
    republishDefGlobals(rt);
    rt.setGlobal('FeatureDefs', {});
    rt.setGlobal('FeatureDefNames', {});

    rt.doString(CMD_GLOBALS_LUA, 'cmd_globals');

    rt.doString(`
        tracy = setmetatable({}, {
            __index = function() return function() end end
        })
    `, 'tracy_stub');

    rt.doString(LUA_COMPAT_SHIM, 'compat_shim');

    // Spring.Utilities Lua-side: needs metatables for CopyTable, json, etc.
    rt.doString(`
        Spring.Utilities = Spring.Utilities or {}
        Spring.Utilities.CopyTable = function(t, deep)
            if type(t) ~= "table" then return t end
            local copy = {}
            for k, v in pairs(t) do
                if deep and type(v) == "table" then
                    copy[k] = Spring.Utilities.CopyTable(v, true)
                else
                    copy[k] = v
                end
            end
            return copy
        end
        Spring.Utilities.MergeTable = function(dst, src)
            for k, v in pairs(src) do
                if dst[k] == nil then dst[k] = v end
            end
            return dst
        end
        Spring.Utilities.json = { encode = function() return "{}" end, decode = function() return {} end }
        Spring.Utilities.TableToString = function(t) return tostring(t) end

        -- Ensure Spring.Translate and GetHumanName are in the Lua table.
        -- The JS-side assignment covers the initial push, but widgets that
        -- snapshot Spring before this doString runs would miss them.
        if not Spring.Translate then
            Spring.Translate = function(key) return tostring(key or "") end
        end
        if not Spring.GetHumanName then
            Spring.GetHumanName = function(defName) return tostring(defName or "") end
        end
        -- Spring.Utilities.GetHumanName — some ZK widgets call this path
        Spring.Utilities.GetHumanName = Spring.Utilities.GetHumanName or function(ud)
            if type(ud) == "table" and ud.humanName then return ud.humanName end
            if type(ud) == "table" and ud.name then return ud.name end
            return tostring(ud or "")
        end
        -- Bit operation helpers used by some ZK widgets
        Spring.Utilities.bit_inv = Spring.Utilities.bit_inv or function(x)
            return bit32 and bit32.bnot(x) or (~x)
        end
    `, 'spring_utilities');

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

function installIOStubs(rt: LuaRuntime, gameId: string): void {
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

function installVFS(rt: LuaRuntime): void {
    rt.setGlobal('_vfsLookup', (path: LuaValue) => {
        return vfsLookup(String(path)) ?? null;
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
        return luaTable(...(vfsDirCache.get(d) ?? []));
    });

    rt.setGlobal('_vfsSubDirs', (dir: LuaValue) => {
        const d = String(dir).toLowerCase();
        return luaTable(...(vfsSubdirCache.get(d) ?? []));
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
function getRegisteredCallins(rt: LuaRuntime): string[] {
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

function getWidgetList(): string {
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

function escapeLuaStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Order-insensitive equality for the worker's selection-id snapshots —
 *  Spring's engine emits SelectionChanged when the *set* changes, not on
 *  reorders. */
function sameIdSet(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
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
function dispatchSelectionChanged(ids: ReadonlyArray<number>): void {
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
 *  fires once when a unit first appears in the local world. Without a
 *  dedicated server event we synthesise it from the entity-state
 *  stream: any id that wasn't in liveState.units before now counts as
 *  newly seen. This conflates "created" with "entered LOS for the
 *  first time", which is close enough for most widgets — Spring's own
 *  UnitCreated also fires only when a unit becomes visible to LuaUI. */
function dispatchUnitCreated(unitId: number, defId: number, team: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitCreated then
            pcall(widgetHandler.UnitCreated, widgetHandler, ${unitId}, ${defId}, ${team})
        end
    `, 'dispatchUnitCreated');
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
function dispatchCommandNotify(
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

/** widgetHandler:UnitDestroyed(unitID, unitDefID, unitTeam) — fires on
 *  the EntityDestroy event. */
function dispatchUnitDestroyed(unitId: number, defId: number, team: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitDestroyed then
            pcall(widgetHandler.UnitDestroyed, widgetHandler, ${unitId}, ${defId}, ${team})
        end
    `, 'dispatchUnitDestroyed');
}

function dispatchCommandsChanged(): void {
    if (!runtime) return;
    // Spring exposes the union of every selected unit's cmd-descs as
    // widgetHandler.commands — a builder selected alongside a factory
    // shows both their build options. Picking only sel[1] used to hide
    // half the options in mixed-builder selections; dedupe by cmd id so
    // a build available on two units doesn't double up.
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
            widgetHandler.commands = merged
            widgetHandler.commands.n = #merged
            widgetHandler:CommandsChanged()
        end
    `, 'dispatchCommandsChanged');
}

/** Toggle a widget by name. */
function toggleWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            widgetHandler:ToggleWidget("${escapeLuaStr(name)}")
        end
    `, 'toggleWidget');
}

/** Enable a widget by name. Re-fetches its source from the server
 *  first so enable after disable acts as a reload. */
async function enableWidget(name: string): Promise<void> {
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
function disableWidget(name: string): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler then
            widgetHandler:DisableWidget("${escapeLuaStr(name)}")
        end
    `, 'disableWidget');
}

let shuttingDown = false;

function shutdown(): void {
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

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    // Debug-level trace of inbound messages (skip high-frequency
    // channels to avoid drowning real log entries: pointer movement,
    // per-frame stateUpdate from the main thread's mouseState/camera
    // tracker, gameInfo (frame/speed/wind ticking every frame), and
    // the entityState snapshot stream).
    if (msg.type !== 'mousemove'
        && msg.type !== 'stateUpdate'
        && msg.type !== 'gameInfo'
        && msg.type !== 'entityState') {
        postLog(1, `[LuaUI:main→worker] ${describeInboundMessage(msg)}`);
    }
    switch (msg.type) {
        case 'init':
            try {
                // Pre-load localStorage data into cache before init
                if (msg.storageData) {
                    for (const [k, v] of Object.entries(msg.storageData as Record<string, string>)) {
                        storageCache[k] = v;
                    }
                }
                await init(msg.canvas, msg.gameId, msg.lobbyUrl, msg.mapData, msg.soloWidget);
            } catch (err) {
                postLog(4, `Init failed: ${err}`);
                postToMain({ type: 'error', msg: String(err) });
            }
            break;

        case 'keypress':
            // Route through widgetHandler so its KeyPressList and the
            // actionHandler (for keybindings like F10/F11) both run. The
            // dispatcher then forwards to each widget's :KeyPress callin.
            // Calling a global `KeyPress` would miss every widget — none
            // of them install themselves into the global namespace; they
            // register via widgetHandler.
            if (runtime) {
                const consumed = runtime.evalString(`
                    if widgetHandler and widgetHandler.KeyPress then
                        local ok, ret = pcall(widgetHandler.KeyPress, widgetHandler, ${msg.keyCode}, { alt=${msg.alt}, ctrl=${msg.ctrl}, meta=${msg.meta}, shift=${msg.shift} }, false)
                        return ok and ret and "1" or "0"
                    end
                    return "0"
                `);
                postToMain({ type: 'inputConsumed', kind: 'keypress', consumed: consumed === '1' });
            }
            break;

        case 'keyrelease':
            if (runtime) {
                runtime.doString(`
                    if widgetHandler and widgetHandler.KeyRelease then
                        pcall(widgetHandler.KeyRelease, widgetHandler, ${msg.keyCode}, { alt=${msg.alt}, ctrl=${msg.ctrl}, meta=${msg.meta}, shift=${msg.shift} })
                    end
                `, 'callin:KeyRelease');
            }
            break;

        case 'mousepress':
            if (runtime) {
                const consumedStr = runtime.evalString(`
                    if widgetHandler and widgetHandler.MousePress then
                        local ok, ret = pcall(widgetHandler.MousePress, widgetHandler, ${msg.x}, ${msg.y}, ${msg.button})
                        return ok and ret and "1" or "0"
                    end
                    return "0"
                `);
                postToMain({ type: 'inputConsumed', kind: 'mousepress', consumed: consumedStr === '1' });
            }
            break;

        case 'mouserelease':
            if (runtime) {
                runtime.doString(`
                    if widgetHandler and widgetHandler.MouseRelease then
                        pcall(widgetHandler.MouseRelease, widgetHandler, ${msg.x}, ${msg.y}, ${msg.button})
                    end
                `, 'callin:MouseRelease');
            }
            break;

        case 'mousewheel':
            if (runtime) {
                runtime.doString(`
                    if widgetHandler and widgetHandler.MouseWheel then
                        pcall(widgetHandler.MouseWheel, widgetHandler, ${msg.up}, ${msg.value})
                    end
                `, 'callin:MouseWheel');
            }
            break;

        case 'mousemove':
            if (runtime) {
                // Dispatch the move and ask widgetHandler:IsAbove() in the
                // same Lua call — IsAbove drives chili's hover state and
                // also tells the main thread whether the cursor is over UI
                // (so InputManager can suppress ground selection).
                const above = runtime.evalString(`
                    if widgetHandler then
                        if widgetHandler.MouseMove then
                            pcall(widgetHandler.MouseMove, widgetHandler, ${msg.x}, ${msg.y}, ${msg.dx}, ${msg.dy}, ${msg.button})
                        end
                        if widgetHandler.IsAbove then
                            local ok, ret = pcall(widgetHandler.IsAbove, widgetHandler, ${msg.x}, ${msg.y})
                            return ok and ret and "1" or "0"
                        end
                    end
                    return "0"
                `);
                postToMain({ type: 'uiHover', above: above === '1' });
            }
            break;

        case 'getWidgetList':
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'toggleWidget':
            toggleWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'enableWidget':
            await enableWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;


        case 'disableWidget':
            disableWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'resize':
            if (bridge && msg.width && msg.height) {
                bridge.resizeCanvas(msg.width, msg.height);
            }
            break;

        case 'evalLua': {
            if (!runtime) break;
            const evalResult = runtime.evalString(String(msg.code ?? ''));
            postToMain({ type: 'evalResult', result: String(evalResult ?? 'nil') });
            break;
        }

        case 'musicStreamTime':
            // Main thread pushes a snapshot of the BGMusic
            // HTMLAudioElement's currentTime / duration whenever
            // playback state changes. Spring.GetSoundStreamTime
            // reads these cached values.
            musicStreamPlayed = Number(msg.played ?? 0);
            musicStreamDuration = Number(msg.duration ?? 0);
            break;

        case 'pauseFrames':
            if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
            break;
        case 'resumeFrames':
            if (!frameInterval && runtime && bridge) {
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
            break;

        case 'stateUpdate': {
            const prevSel = liveState.selectedUnitIds;
            // Camera, viewport, identity, gameFrame from main thread
            if (msg.camera) liveState.camera = msg.camera;
            if (msg.viewport) liveState.viewport = msg.viewport;
            if (msg.identity) liveState.identity = msg.identity;
            if (msg.gameFrame !== undefined) liveState.gameFrame = msg.gameFrame as number;
            if (msg.selectedUnitIds) liveState.selectedUnitIds = msg.selectedUnitIds as number[];
            if (msg.viewMatrix) liveState.viewMatrix = msg.viewMatrix as Float32Array;
            if (msg.projMatrix) liveState.projMatrix = msg.projMatrix as Float32Array;
            if (msg.modKeys) liveState.modKeys = msg.modKeys as { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
            if (msg.mouse) liveState.mouse = msg.mouse as typeof liveState.mouse;
            // Selection delta → re-run the layout callback so the
            // integral menu rebuilds its build/orders palette. Without
            // this, switching the selected unit would leave widgetHandler.
            // commands stale and the menu fixed on the previous unit.
            if (msg.selectedUnitIds && !sameIdSet(prevSel, liveState.selectedUnitIds)) {
                dispatchSelectionChanged(liveState.selectedUnitIds);
                dispatchCommandsChanged();
            }
            break;
        }

        case 'entityState': {
            // Rebuild/merge the units Map from typed arrays
            const count = msg.count as number;
            const isDelta = msg.isDelta as boolean;
            const entityIds = msg.entityIds as Uint32Array | null;
            const posX = msg.positionsX as Float32Array | null;
            const posY = msg.positionsY as Float32Array | null;
            const posZ = msg.positionsZ as Float32Array | null;
            const headings = msg.headings as Uint16Array | null;
            const health = msg.health as Uint16Array | null;
            const defIds = msg.defIds as Uint16Array | null;
            const teams = msg.teams as Uint8Array | null;
            const stateBits = msg.stateBits as Uint8Array | null;
            const losStates = msg.losStates as Uint8Array | null;

            // Velocity is computed from frame-to-frame position deltas.
            // The sim ticks at 30 Hz so each entity-state batch nominally
            // covers 1/30 s; multiplying the delta by the inverse gives
            // elmos/second. (We don't have a precise per-message timestamp
            // — adequate for HUD readouts and lead-shot calculations.)
            const tickRate = 30;
            // Track newly-seen ids in this batch so we can fire
            // UnitCreated callins after the merge completes. Spring's
            // engine fires UnitCreated on initial visibility, so
            // synthesising it from "id not in prior map" is the right
            // shape for widgets like unit_state_icons that snapshot a
            // unit's static metadata on creation.
            const createdIds: Array<{ id: number; defId: number; team: number }> = [];
            if (!isDelta) {
                // Full snapshot — rebuild. Only keep IDs in this snapshot.
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
                        newUnits.set(id, {
                            x: nx, y: ny, z: nz,
                            heading: headings ? headings[i] : 0,
                            healthRatio: health ? health[i] / 65535 : 1,
                            defId,
                            team,
                            vx: prev ? (nx - prev.x) * tickRate : 0,
                            vy: prev ? (ny - prev.y) * tickRate : 0,
                            vz: prev ? (nz - prev.z) * tickRate : 0,
                            stateBits: stateBits ? stateBits[i] : 0,
                            losState: losStates ? losStates[i] : 0x0F,
                        });
                        if (!prev) createdIds.push({ id, defId, team });
                    }
                }
                liveState.units = newUnits;
            } else {
                // Delta — merge changed units
                if (entityIds) {
                    for (let i = 0; i < count; i++) {
                        const id = entityIds[i];
                        const existing = liveState.units.get(id);
                        const entry: UnitEntry = existing ?? {
                            x: 0, y: 0, z: 0, heading: 0, healthRatio: 1,
                            defId: 0, team: 0, vx: 0, vy: 0, vz: 0,
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
                        liveState.units.set(id, entry);
                        if (!existing) {
                            createdIds.push({ id, defId: entry.defId, team: entry.team });
                        }
                    }
                }
            }
            for (const c of createdIds) {
                dispatchUnitCreated(c.id, c.defId, c.team);
            }
            break;
        }

        case 'entityDestroy': {
            const id = msg.entityId as number;
            const u = liveState.units.get(id);
            // Snapshot the unit's defId / team before we drop it so the
            // callin signature matches Spring's UnitDestroyed(unitID,
            // unitDefID, unitTeam). Widgets that key off either need
            // them — unit_state_icons clears its pip cache on this.
            const defId = u?.defId ?? 0;
            const team = u?.team ?? 0;
            liveState.units.delete(id);
            liveState.unitRulesParams.delete(id);
            liveState.unitCommands.delete(id);
            liveState.unitCmdDescs.delete(id);
            liveState.sensorOverrides.delete(id);
            dispatchUnitDestroyed(id, defId, team);
            break;
        }

        case 'entitySensorUpdate': {
            // Per-unit sensor radius override emitted by
            // Spring.SetUnitSensorRadius on the server. We store it
            // in liveState.sensorOverrides so Spring.GetUnitSensorRadius
            // returns the runtime value rather than the UnitDef baseline.
            // The string key matches the argument widgets pass to
            // GetUnitSensorRadius (matches SpringWeb::SensorType ordering).
            const id = msg.entityId as number;
            const sensorType = msg.sensorType as number;
            const radius = msg.radius as number;
            const SENSOR_NAMES = ['los', 'airLos', 'radar', 'sonar',
                                  'seismic', 'radarJammer', 'sonarJammer'];
            const name = SENSOR_NAMES[sensorType];
            if (!name) break;
            let m = liveState.sensorOverrides.get(id);
            if (!m) {
                m = new Map();
                liveState.sensorOverrides.set(id, m);
            }
            m.set(name, radius);
            break;
        }

        case 'intelTransitions': {
            // Synthesised LOS / radar / cloak transitions (see
            // intel-transitions.ts on the main thread). Each entry
            // dispatches the matching widgetHandler:Unit* callin so
            // ZK widgets like gui_spotter, unit_attack_warning, and
            // gfx_deferred_rendering_gl4 fire their handlers. The
            // viewer's own ally team is read from liveState.identity
            // so the (unitID, unitTeam, allyTeam, unitDefID) signature
            // matches Recoil's widgetHandler dispatch.
            if (!runtime) break;
            const events = msg.events as Array<{
                kind: 'enteredLos' | 'leftLos' | 'enteredRadar' | 'leftRadar' | 'cloaked' | 'decloaked';
                unitId: number; unitTeam: number; unitDefId: number;
            }> | undefined;
            if (!events || events.length === 0) break;
            const myAllyTeam = liveState.identity?.myAllyTeam ?? 0;

            // Build one Lua chunk per batch — cheaper than a doString
            // per event when ~tens of transitions can fire at once
            // (e.g. a scout reveals a base).
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
                        // widgetHandler:UnitCloaked(unitID, unitDefID, unitTeam) — note arg order.
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
            break;
        }

        case 'seismicPings': {
            // widgetHandler:UnitSeismicPing(x, y, z, strength, allyTeamID, unitID, unitDefID)
            // The server already filtered by ally team; we don't have unit
            // ids for the source (that's the whole point of seismic pings
            // — anonymous "something is moving"), so we pass 0/0 for the
            // last two args. ZK's minimap_events / unit_attack_warning
            // widgets only read x/y/z/strength.
            if (!runtime) break;
            const pings = msg.pings as Array<{
                x: number; y: number; z: number; strength: number; allyTeam: number;
            }> | undefined;
            if (!pings || pings.length === 0) break;
            const lines: string[] = [];
            for (const p of pings) {
                lines.push(`if widgetHandler and widgetHandler.UnitSeismicPing then pcall(widgetHandler.UnitSeismicPing, widgetHandler, ${p.x}, ${p.y}, ${p.z}, ${p.strength}, ${p.allyTeam}, 0, 0) end`);
            }
            runtime.doString(lines.join('\n'), 'callin:seismicPings');
            break;
        }

        case 'losBitmap': {
            // Per-allyteam fog-of-war bitmap snapshot (~1 Hz). Stored
            // on `liveState.losBitmaps` so `Spring.IsPosInLos / InRadar
            // / InAirLos` can sample it inside widget callbacks.
            const allyTeam = msg.allyTeam as number;
            const width    = msg.width    as number;
            const height   = msg.height   as number;
            const frame    = msg.frame    as number;
            const inLos    = msg.inLos    as Uint8Array;
            const inRadar  = msg.inRadar  as Uint8Array;
            const explored = msg.explored as Uint8Array;
            if (!inLos || !inRadar || !explored) break;
            liveState.losBitmaps.set(allyTeam, {
                width, height, frame, inLos, inRadar, explored,
            });
            break;
        }

        case 'unitCommandQueues': {
            // Snapshot replacement: clear stale queues, install fresh ones.
            // Units not present in the snapshot are treated as empty.
            const queues = msg.queues as Array<{
                unitId: number;
                orders: Array<{ cmdId: number; params: number[]; options: number; tag: number; timeout: number }>;
            }> | undefined;
            if (!queues) break;
            liveState.unitCommands.clear();
            for (const q of queues) {
                liveState.unitCommands.set(q.unitId, q.orders.map(o => ({
                    cmdId: o.cmdId, params: [...o.params],
                    options: o.options, tag: o.tag, timeout: o.timeout,
                })));
            }
            // Build queue counts on the chili integral menu read from
            // GetRealBuildQueue inside CommandsChanged; without dispatch
            // here, the badges would only refresh when cmd-descs change.
            dispatchCommandsChanged();
            break;
        }

        case 'unitCmdDescs': {
            // Snapshot replacement, mirroring unitCommandQueues. Server
            // currently streams only build entries (cmdId<0); a unit
            // missing from the snapshot has no streamed cmd-descs.
            const updates = msg.units as Array<{
                unitId: number;
                cmds: Array<{
                    cmdId: number;
                    disabled: boolean;
                    name: string;
                    action: string;
                    texture: string;
                    tooltip: string;
                    type: number;
                    params: string[];
                    hidden: boolean;
                }>;
            }> | undefined;
            if (!updates) break;
            liveState.unitCmdDescs.clear();
            for (const u of updates) {
                liveState.unitCmdDescs.set(u.unitId, u.cmds.map(c => ({
                    cmdId:    c.cmdId,
                    disabled: c.disabled,
                    name:     c.name    ?? '',
                    action:   c.action  ?? '',
                    texture:  c.texture ?? '',
                    tooltip:  c.tooltip ?? '',
                    type:     c.type    ?? 0,
                    params:   c.params  ?? [],
                    hidden:   c.hidden  ?? false,
                })));
            }
            // Refresh the integral menu's command panel — Spring's
            // engine drives this from a layout callback every frame the
            // command set changes; we mirror that here so chili's
            // CommandsChanged callin actually fires.
            dispatchCommandsChanged();
            break;
        }

        case 'unitDefsUpdate': {
            const defs = msg.defs as MinimalUnitDefWire[] | undefined;
            if (!defs) break;
            // DEBUG: log first def's keys + customParams to confirm wire shape
            if (defs.length > 0) {
                const first = defs[0] as unknown as Record<string, unknown>;
                const keys = Object.keys(first).slice(0, 50).join(',');
                const cp = first.customParams as Record<string, string> | undefined;
                const cpStr = cp ? Object.keys(cp).slice(0, 5).join(',') : 'undef';
                postLog(2, `[debug] unitDefsUpdate first def keys=[${keys}] cp=[${cpStr}]`);
            }
            for (const d of defs) unitDefMap.set(d.defId, d);
            if (runtime) republishDefGlobals(runtime);
            break;
        }

        case 'weaponDefsUpdate': {
            const defs = msg.defs as MinimalWeaponDefWire[] | undefined;
            if (!defs) break;
            for (const d of defs) weaponDefMap.set(d.defId, d);
            if (runtime) republishDefGlobals(runtime);
            break;
        }

        case 'rosterUpdate': {
            // Replace the entire roster snapshot. Cheap (a few hundred
            // entries at most) and avoids the bookkeeping overhead of
            // diff-based updates for what is essentially session-static
            // data. msg shape: { players?, teams?, teamColors?, modOptions? }
            const players = msg.players as Array<{
                id: number; name?: string; active?: boolean; spectator?: boolean;
                team: number; allyTeam?: number; pingMs?: number; cpuUsage?: number;
                country?: string; rank?: number; hasController?: boolean;
                customKeys?: Record<string, string>;
            }> | undefined;
            const teams = msg.teams as Array<{
                id: number; allyTeam?: number; leader?: number; isDead?: boolean;
                isAi?: boolean; side?: string; customKeys?: Record<string, string>;
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
            break;
        }

        case 'rulesParamUpdate': {
            // Patch rules-params from the host. msg shape:
            //   scope: 'game' | 'team' | 'unit' | 'player'
            //   id?:   number              (required for non-game scopes)
            //   params: Record<string, number | string | null>
            //                              (null = delete that key)
            //   replace?: boolean          (true = clear before applying)
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

            if (!targetMap) break;
            if (replace) targetMap.clear();
            for (const [k, v] of Object.entries(params)) {
                if (v === null) targetMap.delete(k);
                else targetMap.set(k, v);
            }
            break;
        }

        case 'resourceUpdate':
            liveState.resources.set(msg.team as number, {
                metal: msg.metal as number,
                maxMetal: msg.maxMetal as number,
                energy: msg.energy as number,
                maxEnergy: msg.maxEnergy as number,
                metalIncome: msg.metalIncome as number,
                energyIncome: msg.energyIncome as number,
                metalPull: (msg.metalPull as number) ?? 0,
                energyPull: (msg.energyPull as number) ?? 0,
                metalExpense: (msg.metalExpense as number) ?? 0,
                energyExpense: (msg.energyExpense as number) ?? 0,
                metalShare: (msg.metalShare as number) ?? 0,
                energyShare: (msg.energyShare as number) ?? 0,
                metalSent: (msg.metalSent as number) ?? 0,
                energySent: (msg.energySent as number) ?? 0,
                metalReceived: (msg.metalReceived as number) ?? 0,
                energyReceived: (msg.energyReceived as number) ?? 0,
                metalExcess: (msg.metalExcess as number) ?? 0,
                energyExcess: (msg.energyExcess as number) ?? 0,
            });
            break;

        case 'gameInfo':
            if (msg.frame !== undefined) liveState.gameFrame = msg.frame as number;
            if (msg.speed !== undefined) liveState.gameSpeed = msg.speed as number;
            if (msg.paused !== undefined) liveState.gamePaused = msg.paused as boolean;
            if (msg.gameOver !== undefined) liveState.gameOver = msg.gameOver as boolean;
            if (msg.wind) liveState.wind = msg.wind as typeof liveState.wind;
            break;

        case 'mapFeatures': {
            // Populate features map from MapData
            const feats = msg.features as Array<{ id: number; x: number; y: number; z: number; defId: number; team: number; healthRatio: number }>;
            liveState.features.clear();
            for (const f of feats) {
                liveState.features.set(f.id, {
                    x: f.x, y: f.y, z: f.z,
                    defId: f.defId, team: f.team, healthRatio: f.healthRatio,
                });
            }
            break;
        }

        case 'shutdown':
            shutdown();
            break;
    }
};

// ── Lua constants (shared with old widget manager) ─────────────────────

const LUA_COMPAT_SHIM = `
if not loadstring then loadstring = load end
if not unpack then unpack = table.unpack end
if not table.getn then table.getn = function(t) return #t end end
if not math.mod then math.mod = math.fmod end
if not math.atan2 then math.atan2 = math.atan end
if not math.pow then math.pow = function(x, y) return x ^ y end end
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

const VFS_IMPLEMENTATION_LUA = `
VFS = VFS or {}
VFS.RAW_ONLY = 1; VFS.ZIP_ONLY = 2; VFS.RAW_FIRST = 3; VFS.ZIP_FIRST = 4
VFS.ZIP = 5; VFS.RAW = 6; VFS.MAP = 7; VFS.GAME = 8; VFS.BASE = 9; VFS.MENU = 10
VFS.DEF_MODE = 5
VFS._writeCache = {}

local function normalizePath(path)
    if not path then return nil end
    path = path:gsub("\\\\", "/")
    if path:sub(1,1) == "/" then path = path:sub(2) end
    if path:sub(1,1) == ":" and #path >= 3 and path:sub(3,3) == ":" then
        path = path:sub(4)
    end
    return path
end

local function vfsLookup(path)
    local cached = VFS._writeCache[path]
    if cached then return cached end
    return _vfsLookup(path)
end

-- Include-loop detection
local _includeStack = {}

VFS.Include = function(path, env, mode)
    if not path then return nil end
    path = normalizePath(path)
    if _includeStack[path] then
        Spring.Echo("[VFS.Include] circular include detected: " .. path)
        return nil
    end
    local source = vfsLookup(path)
    if not source then
        Spring.Echo("[VFS.Include] not found: " .. path)
        return nil
    end
    _includeStack[path] = true
    if env == nil then
        local info = debug.getinfo(2, "f")
        if info and info.func then
            local i = 1
            while true do
                local name, val = debug.getupvalue(info.func, i)
                if name == "_ENV" then env = val; break
                elseif not name then break end
                i = i + 1
            end
        end
        env = env or _G
    end
    -- Intentionally do NOT add a __index=_G metatable to env here.
    -- Spring's real VFS.Include does NOT do that, and adding it turns
    -- the widget's environment into a leaky proxy to _G — widgets then
    -- accidentally invoke _G globals (like Shutdown, the widgetHandler
    -- dispatcher), triggering widgetHandler:Shutdown recursion.
    local chunk, err = load(source, path, "t", env)
    if not chunk then
        _includeStack[path] = nil
        Spring.Echo("[VFS.Include] compile error in " .. path .. ": " .. (err or ""))
        return nil
    end
    -- Capture ALL return values from the included chunk. Spring's real
    -- VFS.Include returns multi-values; chunks like languages.lua use
    -- "return a, b, c" and callers destructure with three locals. If we
    -- only return the first, downstream upvalues like flagByLang are nil
    -- and widgets that depend on it (gui_epicmenu cascade to
    -- ChiliGlobalCommands, ChiliMinimap, SimpleSettings) silently die.
    local results = { pcall(chunk) }
    _includeStack[path] = nil
    if not results[1] then
        Spring.Echo("[VFS.Include] runtime error in " .. path .. ": " .. tostring(results[2]))
        return nil
    end
    -- results[1] is the pcall ok flag; results[2..n] are the chunk's
    -- return values. unpack(results, 2, #results) returns idx 2 to N.
    return unpack(results, 2, #results)
end

VFS.FileExists = function(path, mode)
    if not path then return false end
    path = normalizePath(path)
    if VFS._writeCache[path] ~= nil then return true end
    return _vfsExists(path)
end

VFS.LoadFile = function(path, mode)
    if not path then return nil end
    path = normalizePath(path)
    return vfsLookup(path)
end

VFS.DirList = function(path, pattern, mode)
    path = path or ""
    path = path:gsub("\\\\", "/")
    if path:sub(-1) ~= "/" then path = path .. "/" end
    local files = _vfsDirList(path)
    if not files or #files == 0 then return {} end
    if pattern then
        local ext = pattern:match("^%*(.+)$")
        if ext then
            local result = {}
            for i = 1, #files do
                local f = files[i]
                if f:sub(-#ext) == ext then
                    result[#result + 1] = path .. f
                end
            end
            return result
        end
    end
    local result = {}
    for i = 1, #files do
        result[#result + 1] = path .. files[i]
    end
    return result
end

-- Pack/Unpack helpers used by ZK widgets (AllyCursors stores 16-bit
-- coords in shared messages). Provide string-based stubs so the call
-- site doesn't crash; the round-trip is opaque to widgets that don't
-- transmit these across the network.
VFS.PackU8 = VFS.PackU8 or function(n) return string.char(math.floor(n) % 256) end
VFS.PackU16 = VFS.PackU16 or function(n)
    n = math.floor(n)
    return string.char(n % 256) .. string.char(math.floor(n / 256) % 256)
end
VFS.PackU32 = VFS.PackU32 or function(n)
    n = math.floor(n)
    return string.char(n % 256)
        .. string.char(math.floor(n / 256) % 256)
        .. string.char(math.floor(n / 65536) % 256)
        .. string.char(math.floor(n / 16777216) % 256)
end
VFS.UnpackU8 = VFS.UnpackU8 or function(s, i) return s:byte(i or 1) or 0 end
VFS.UnpackU16 = VFS.UnpackU16 or function(s, i)
    i = i or 1
    return (s:byte(i) or 0) + (s:byte(i+1) or 0) * 256
end
VFS.UnpackU32 = VFS.UnpackU32 or function(s, i)
    i = i or 1
    return (s:byte(i) or 0) + (s:byte(i+1) or 0) * 256
        + (s:byte(i+2) or 0) * 65536 + (s:byte(i+3) or 0) * 16777216
end

VFS.SubDirs = function(path, pattern, mode)
    path = path or ""
    path = path:gsub("\\\\", "/")
    if path:sub(-1) ~= "/" then path = path .. "/" end
    local subs = _vfsSubDirs(path)
    if not subs or #subs == 0 then return {} end
    local result = {}
    for i = 1, #subs do
        result[#result + 1] = path .. subs[i] .. "/"
    end
    return result
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

// ── Helpers ────────────────────────────────────────────────────────────

function escapeLuaString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}
