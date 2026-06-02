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

import { Engine, Scene, FreeCamera, Vector3, Color3, Color4, Mesh, MeshBuilder, StandardMaterial } from '@babylonjs/core';
import type { GpInitToWorker, GpMinimapBlips, GpMinimapLos } from './game-worker-protocol.js';
// GW4-c2: the WebTransport game connection now lives in the worker. Connection
// is host-agnostic (runs on WebTransportAdapter, no DOM refs after the
// onServerRestart callback was extracted) so it imports + runs here unchanged.
import { Connection } from './connection.js';
// GW4-c3: terrain + lighting + map parse move into the worker so terrain
// renders from here (first light). All of these are worker-safe (Babylon
// DynamicTexture allocates an OffscreenCanvas in a worker; the dev-hook
// `window.__*` injections in scene-lighting/client-settings were switched to
// `globalThis` for this move — PLAN-game-worker.md GW4 Bucket-2).
import {
    buildTerrainMesh, loadTerrainTextures, TerrainFog, DeformableTerrain,
    type MapDimensions,
} from './terrain.js';
import { fetchMapDataHttp, type ParsedMapData } from './map-data.js';
import { loadMapLighting, type MapLighting } from './map-lighting.js';
import { createSceneLighting, applyMapLighting, type SceneLighting } from './scene-lighting.js';
import { LosBitmapStore, type LosBitmap } from './los-bitmap.js';
// GW4-c4: world entity rendering moves into the worker. Side-effect import
// registers Babylon's KTX2 loader + pins the transcoder URLs (previously only
// done in main.ts) so unit `.ktx2` textures transcode here.
import './ktx2-config.js';
import { EntityRenderer, setLightingStyle, setUseZKMaterial } from './entity-renderer.js';
import { BuildingPlateRenderer } from './building-plate-renderer.js';
import { DefCache } from './def-cache.js';
import { fetchAndIngestDefs } from './defs-fetch.js';
import { PresentationClock } from './presentation-clock.js';
// GW4-c5: weapon-FX / projectile / decal / build render modules fold into the
// worker (audited worker-safe — no DOM/audio; the `window.__*` dev hooks they
// set are switched to `globalThis`). Ported from main.ts@d6301137f7^.
import { ProjectileRenderer } from './projectile-renderer.js';
import { ProjectileTextureResolver } from './projectile-texture-resolver.js';
import { CegRuntime } from './ceg-runtime.js';
import { setParticleBudget } from './ceg-translator.js';
import { clientSettings } from './client-settings.js';
import { BuildBeamRenderer } from './build-beam-renderer.js';
import { CombatFX } from './combat-fx.js';
import { FxLightPool } from './fx-light-pool.js';
import { setActiveFxLightPool } from './zk-model-material.js';
import { DistortionRenderer } from './distortion-renderer.js';
import { MuzzleFlareRenderer } from './muzzle-flare-renderer.js';
import { DecalOverlay, buildTrackTypeNames } from './decal-overlay.js';
import { attachDecalOverlay } from './decal-overlay-plugin.js';
import { renderMapFeatures, DynamicFeatureRenderer } from './feature-renderer.js';
import { RTSCamera } from './rts-camera.js';
import { WorkerSelection } from './worker-selection.js';
import { resolveSoundRef, type ResolvedSoundEvent } from './sound-events.js';
import { CommandPathRenderer } from './command-path-renderer.js';
import { WaypointMarkerRenderer } from './waypoint-marker-renderer.js';
import { StandingOrderRenderer } from './standing-order-renderer.js';
import { LuaRuntime, type LuaValue, luaTable } from './lua-runtime.js';
import { LuaGLBridge } from './lua-gl-bridge.js';
import {
    buildSpringGlobals,
    createDefaultLiveState,
    type SpringAPIContext,
    type LiveState,
    type UnitEntry,
    type FeatureEntry,
    type ProjectileEntry,
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
        // PLAN-weapon-fx Z3 — authored GLSL shaders. ZK ships engine
        // shaders under `shaders/GLSL/` and widget-side helpers under
        // `LuaUI/Widgets/Shaders/` (reached via the LuaUI descent).
        // Also include `lups/` so the worker host can boot ZK's LUPS
        // (Phase Z1) — its 30 ParticleClasses include inline shader
        // source that's already covered by the .lua descent, but
        // `lups/shaders/` (if any) needs the explicit root.
        'shaders', 'shaders/GLSL', 'lups', 'lups/shaders',
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
                        lower.endsWith('.json') ||
                        // PLAN-weapon-fx Z3 — preload authored GLSL so
                        // ModelMaterials templates and LuaShaders widgets
                        // can `#include "path"` source through the
                        // bridge's shader include resolver. Extensions
                        // mirror ZK's content tree: `.glsl`, `.fs`/`.vs`
                        // (legacy short forms), plus the compound forms
                        // (`.frag.glsl`/`.vert.glsl`/`.geom.glsl`) which
                        // already end with `.glsl`.
                        lower.endsWith('.glsl') || lower.endsWith('.fs') ||
                        lower.endsWith('.vs')) {
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
}
interface MinimalWeaponDefWire {
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
        setCameraState: (state, smoothness) => {
            postToMain({ type: 'setCameraState', state, smoothness });
        },
        // `getCameraPose` is intentionally NOT forwarded: querying the
        // host synchronously across the worker boundary would block the
        // sim. The fallback path in lua-spring-api reads from `ls.camera`
        // (the snapshot main.ts pushes each tick), which is accurate to
        // within one frame and good enough for every existing widget.
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
    // this hook. We post them to the main thread, which feeds the forward
    // FxLightPool (the sanctioned GL4-deferred -> WebGL2-forward substitution,
    // now driven by the game's authored light_* data). String marshalling is
    // used deliberately: Lua tables cross to JS callbacks as lazy LuaTable
    // objects, fragile for a per-frame variable-length list; a flat numeric
    // string converts cleanly. Point stride 7: px,py,pz, r,g,b (colMult
    // pre-applied), radius. Beam stride 10: + dx,dy,dz (start->end delta).
    // Empty strings are skipped by the guard so a quiet frame costs nothing.
    runtime.setGlobal('_SpringWebEmitDeferredLights',
        (pointStr: LuaValue, beamStr: LuaValue) => {
            const p = String(pointStr ?? '');
            const b = String(beamStr ?? '');
            postToMain({ type: 'deferredLights', point: p, beam: b });
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
                -- PLAN-weapon-fx Z1.5 — fan-out to gadget unsynced halves
                -- that registered \`function gadget:GameFrame(n)\`. The
                -- handler is installed by GADGET_HANDLER_LUA before any
                -- gadget loads.
                if _SpringWebRunGadgetGameFrame then
                    pcall(_SpringWebRunGadgetGameFrame, f)
                end
            end
        end

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
function dispatchUnitCreated(
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
function dispatchUnitFromFactory(
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
function dispatchUnitTaken(
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
function dispatchUnitGiven(
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
function dispatchDefaultCommand(
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

/** widgetHandler:PlayerChanged(playerId) — Spring fires this when the
 *  local player's team/spec status changes, when the leader changes,
 *  or when another player on the team is reassigned. ZK's
 *  unit_cloakfirestate2 uses it to re-fetch the local player's start
 *  state; cmd_factory_plate_placer rebuilds its plate map. We dispatch
 *  with the local playerId only; widgets that care about *other*
 *  players' transitions filter the arg themselves. */
function dispatchPlayerChanged(playerId: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.PlayerChanged then
            pcall(widgetHandler.PlayerChanged, widgetHandler, ${playerId | 0})
        end
    `, 'dispatchPlayerChanged');
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

/** widgetHandler:UnitFinished(unitID, unitDefID, unitTeam) — fires when
 *  a unit completes construction. We derive it from a buildProgress
 *  < 1 → >= 1 transition in the entity-state stream rather than waiting
 *  for a dedicated server event; close enough for ZK widgets like
 *  unit_building_starter, unit_start_state, cmd_no_duplicate_orders. */
function dispatchUnitFinished(unitId: number, defId: number, team: number): void {
    if (!runtime) return;
    runtime.doString(`
        if widgetHandler and widgetHandler.UnitFinished then
            pcall(widgetHandler.UnitFinished, widgetHandler, ${unitId}, ${defId}, ${team})
        end
    `, 'dispatchUnitFinished');
}

/** widgetHandler:VisibleUnitAdded(unitID, unitDefID, unitTeam) — fires
 *  when a unit enters the camera viewing frustum. Distinct from
 *  UnitEnteredLos (vision-based) — VisibleUnitAdded is a render-side
 *  hook so per-frame overlay widgets (gui_attackrange_gl4) only iterate
 *  the units actually on screen. Sourced from main-thread frustum diff
 *  in LuaWidgetManager.updateVisibleUnits. */
function dispatchVisibleUnitAdded(
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
function dispatchVisibleUnitRemoved(unitId: number): void {
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
function paramsTableLiteral(params: ReadonlyArray<number>): string {
    if (params.length === 0) return '{}';
    return '{' + params.map(p => Number.isFinite(p) ? String(p) : '0').join(',') + '}';
}

/** widgetHandler:UnitCommand(unitID, unitDefID, unitTeam, cmdID,
 *  cmdParams, cmdOpts, cmdTag, playerID, fromSynced, fromLua) — fires
 *  after the engine has added a command to a unit's queue. ZK
 *  cawidgets accepts both the short (cmdTag only) and long form;
 *  the worker emits the long form so widgets that read the optional
 *  trailing args still get correct values. */
function dispatchUnitCommand(
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
function dispatchUnitCmdDone(
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

function computeCommandSignature(): string {
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

function dispatchCommandsChanged(force = false): void {
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

// ── Game-processor Babylon engine (PLAN-game-worker.md GW4) ─────────────
//
// GW4-c1: the worker owns the Babylon Engine on the transferred #game-canvas.
// At c1 it renders only an empty clear-color scene with a default camera —
// the connection, decoders, terrain, entities, FX and the LuaUI world pass
// fold in across c2–c6. The pre-existing 2D widget gl-bridge (overlay canvas,
// the `init` path) is dormant on the game-processor path until c6 repoints it
// at this same GL context.
let gpEngine: Engine | null = null;
let gpScene: Scene | null = null;
let gpCamera: FreeCamera | null = null;
/// GW4-c5b: interactive RTS cameras, keyed by viewId (multi-view, one Scene /
/// N camera→canvas views — PLAN-game-worker.md). Each owns one Babylon camera +
/// the pan/zoom/orbit state machine + scene.pick + viewport send, driven by the
/// `gp:*` input the main-thread CameraInput forwards. c5b ships a single view
/// (id 0); the map keeps adding views cheap. The DOM-input split moved the event
/// listeners to camera-input.ts on main; RTSCamera is now DOM-free.
const gpViewCameras = new Map<number, RTSCamera>();
/// GW4-c5b-2: worker-side selection / pick / order core (DOM-free port of the
/// `input-manager.ts` selection/order seam). Left-button gestures select; the
/// camera's `onRightClickCommit` routes a right-tap here as a move/attack/guard
/// order, sent over the worker's own connection. Built in gpInit after the
/// connection exists. Single instance for view 0 (multi-view: per-view picking
/// goes through `getCamera`; the selection set stays shared).
let gpSelection: WorkerSelection | null = null;
/// Current device-pixel-ratio (CSS px → backing px). Set in gpInit, updated in
/// gpResize; feeds the selection module's pick scaling.
let gpDpr = 1;
/// GW4-c5b-3: selection-driven order overlays (ports the three main-thread
/// overlay renderers into the worker). Command-path + waypoint markers are
/// shift-gated and redrawn on queue/selection change; standing orders are
/// always-on (server already scopes to own+allied). Built in gpInit, fed by the
/// in-worker connection's onUnitCommandQueues / onStandingOrders.
let gpCommandPathRenderer: CommandPathRenderer | null = null;
let gpWaypointMarkerRenderer: WaypointMarkerRenderer | null = null;
let gpStandingOrderRenderer: StandingOrderRenderer | null = null;
/// Latest command-queue snapshot (UnitCommandQueuesUpdate, ~1 Hz), cached so a
/// selection change can re-render the path/waypoint overlays immediately rather
/// than waiting for the next broadcast.
let gpLastCommandQueues: import('./connection.js').UnitCommandQueueInfo[] = [];
/// Shift-held state (drives the command-path / waypoint overlay gate). Tracked
/// from the forwarded key/pointer `mods` bitmask (bit 0 = shift); cleared on blur.
let gpShiftHeld = false;
/// GW4-c5c: latest sim status (from onGameInfo) for the sceneState feed → main's
/// HUD (entity count / frame / selection / speed-pause indicator). The HTML HUD
/// is the only main-thread world-fact consumer reconnected here; ZK's economy /
/// build-menu / order-panel are chili widgets (land with the c6 LuaUI world pass).
let gpGameFrame = 0;
let gpPaused = false;
let gpSimSpeed = 1;
/// Wall-clock of the last sceneState post (throttled to ~10 Hz).
let gpLastSceneStatePost = 0;
/// GW4-c5c-3: minimap feed throttle (~6 Hz — unit dots only need to be roughly
/// live) + LOS-dirty flag so the (relatively large) fog bitmap only ships when
/// a new envelope-0x07 snapshot actually arrives, not on every feed.
let gpLastMinimapPost = 0;
let gpMinimapLosDirty = false;
/// Most-recent per-allyteam LOS bitmap, for the minimap fog overlay. Mirrors
/// the pre-GW4 main.ts behaviour (most-recent-wins; spectators round-robin
/// ally teams and see one team's vision at a time).
let gpLastLosBitmap: LosBitmap | null = null;
/// Map dims + backdrop URL for the main-thread minimap, captured in gpLoadMap.
/// Sent on the first minimap feed after the terrain is built, then cleared
/// (`gpMinimapMapInfo = null` ⇒ already delivered).
let gpMinimapMapInfo: { width: number; height: number; baseUrl: string } | null = null;
/// GW4-c3: sun + ambient + HDR pipeline + CSM. Created in gpInit (deferred
/// from c1 — invisible on an empty scene), retuned by applyMapLighting once
/// the map's `mapinfo.lua → lighting` is fetched + parsed.
let gpSceneLighting: SceneLighting | null = null;
/// GW4-c2: the game-server WebTransport connection, owned by the worker.
/// Opened from `gp:init` creds; torn down on `gp:shutdown`. At c2 its
/// callbacks only log decoded counts + bridge a few signals to main; the
/// renderer/LuaUI dispatch wires up as those modules move in across c3–c6.
let gpConnection: Connection | null = null;
/// GW4-c4: world entity rendering, owned by the worker. The entity renderer
/// interpolates streamed snapshots at the presentation cursor P; the building-
/// plate renderer places static under-building ground decals; the def cache
/// accumulates the game's unit/weapon/CEG defs (fetched over HTTP, keyed by the
/// `defsCacheKey` the server hands back in AuthResponse). Mirrors main.ts's
/// pre-move construction (main.ts@d6301137f7^ L488–595).
let gpEntityRenderer: EntityRenderer | null = null;
let gpBuildingPlateRenderer: BuildingPlateRenderer | null = null;
let gpDefCache: DefCache | null = null;
/// PLAN-latency L0: interpolate entities at the presentation cursor (server-
/// frame keyed) instead of arrival wall-time. Reset + anchored to the
/// connection's ServerClock once `gpConnect` builds it.
let gpPresentationClock: PresentationClock | null = null;
/// GW4-c3 terrain state, populated once the map data HTTP fetch resolves.
/// Mirrors the pre-move main.ts `onMapData` terrain build.
let gpTerrainMesh: Mesh | null = null;
let gpTerrainFog: TerrainFog | null = null;
let gpDeformTerrain: DeformableTerrain | null = null;
let gpMapData: ParsedMapData | null = null;
/// GW4-c5: weapon-FX / projectile / decal / build render modules, owned by the
/// worker. Ported from main.ts's pre-move construction (main.ts@d6301137f7^
/// L391–595 + onMapData). Driven by the connection's combat/projectile/build/
/// decal callbacks and aged in the render loop at the sim-scaled `gpFxSimSpeed`.
let gpFxLightPool: FxLightPool | null = null;
let gpDistortion: DistortionRenderer | null = null;
let gpMuzzleFlare: MuzzleFlareRenderer | null = null;
let gpProjectileRenderer: ProjectileRenderer | null = null;
let gpCegRuntime: CegRuntime | null = null;
let gpBuildBeamRenderer: BuildBeamRenderer | null = null;
let gpCombatFX: CombatFX | null = null;
let gpDecalOverlay: DecalOverlay | null = null;
let gpDynamicFeatureRenderer: DynamicFeatureRenderer | null = null;
/// Sim-scaled delta multiplier for VISUAL FX aging — slows / freezes effect
/// lifetimes with the game speed (paused → 0). Driven by onGameInfo. The
/// camera + entity ticks keep raw wall dt; only FX lifetimes use it.
let gpFxSimSpeed = 1;
/// Wall-clock timestamp of the previous render frame, for the FX `dt`.
let gpLastFrameTime = 0;
/// Holds the per-allyteam LOS bitmaps (envelope 0x07) so a bitmap that
/// arrives before the fog mesh exists still paints on first build.
const gpLosBitmapStore = new LosBitmapStore();
/// Static full-map viewport resend timer. The camera→viewport path moves
/// into the worker in c3; until then a fixed full-map viewport is resent on
/// an interval so the server streams entity state (filtering is viewport-
/// gated) and the QUIC session sees periodic traffic. Cleared on shutdown.
let gpViewportTimer: ReturnType<typeof setInterval> | null = null;

/// GW4-c3: fetch map data over HTTP (not the connection — server_main.cpp
/// serves it on the asset plane) and build the terrain in the worker. This
/// ports the terrain/water/fog/lighting half of main.ts's pre-move
/// `onMapData` (the feature/widget/minimap halves stay on main / move in
/// later checkpoints). Runs once per game; idempotent via `gpMapData`.
///
/// DEVIATION (documented in the c3 handoff): the interactive RTS camera +
/// DOM input split (Bucket-3 `rts-camera` → CameraInput) is deferred to c5
/// per the plan's c5 bullet. c3 only needs a *static framed* camera so
/// terrain is visible ("first light"); the FreeCamera is positioned at map
/// centre here. No ground-clamp / pan / zoom yet.
async function gpLoadMap(msg: GpInitToWorker): Promise<void> {
    if (!gpScene || !gpEngine || !gpCamera || !gpSceneLighting) return;
    if (gpMapData) { postLog(2, '[gp] gpLoadMap: map already built — ignoring'); return; }
    const scene = gpScene;
    const sceneLighting = gpSceneLighting;

    let map: ParsedMapData;
    try {
        map = await fetchMapDataHttp(msg.mapId);
    } catch (err) {
        postLog(4, `[gp] map data fetch failed: ${err}`);
        return;
    }
    if (!gpScene) return;  // shutdown raced the fetch
    gpMapData = map;
    postLog(1, `[gp] MapData received: ${map.mapx}x${map.mapy}, ${map.features.length} features`);

    // `mapSourceUrl` is lobby-relative; lobbyUrl='' resolves it against the
    // worker (page) origin, same as fetchMapDataHttp's `/api/*` paths.
    const mapSourceAbs = map.mapSourceUrl.startsWith('http')
        ? map.mapSourceUrl
        : `${msg.lobbyUrl}${map.mapSourceUrl}`;
    const mapBaseUrl = `${msg.lobbyUrl}${map.mapDataUrl}`;

    // GW4-c5c-3: hand the main-thread minimap its dims + backdrop URL on the
    // next feed (the worker owns the map fetch). loadBackground appends
    // `/minimap.ktx2` to baseUrl, same as the pre-GW4 main path.
    gpMinimapMapInfo = { width: map.widthElmos, height: map.heightElmos, baseUrl: mapBaseUrl };

    const mapDims: MapDimensions = {
        mapx: map.mapx, mapy: map.mapy,
        minHeight: map.minHeight, maxHeight: map.maxHeight,
        tilesX: map.tilesX, tilesZ: map.tilesZ,
    };

    // PLAN-lighting L2: parse `mapinfo.lua → lighting` on the client (server
    // is headless) and apply sun/ambient. Fire-and-forget; failure falls back
    // to the createSceneLighting defaults so the scene is never dark.
    void loadMapLighting(mapSourceAbs).then((lighting: MapLighting) => {
        if (gpSceneLighting === sceneLighting) applyMapLighting(lighting, sceneLighting);
    });

    // Terrain mesh from the embedded heightmap.
    const terrainMesh = buildTerrainMesh(scene, mapDims, map.heightmap);
    terrainMesh.receiveShadows = true;
    gpTerrainMesh = terrainMesh;
    gpDeformTerrain = new DeformableTerrain(terrainMesh, mapDims);
    postLog(1, '[gp] terrain mesh built from MapData heightmap');

    // GW4-c4: hand the heightmap to the entity renderer so units clamp to the
    // ground + getGroundHeight / getMapSizeElmos resolve (the camera ground-
    // sampler hooks up with the interactive camera in c5).
    gpEntityRenderer?.setMapHeightmap(
        map.heightmap, map.mapx, map.mapy,
        map.minHeight, map.maxHeight, map.squareSize,
    );

    // GW4-c5b-3: the order overlays need the heightmap to terrain-follow their
    // lines/markers/rings.
    gpCommandPathRenderer?.setMapData(map);
    gpWaypointMarkerRenderer?.setMapData(map);
    gpStandingOrderRenderer?.setMapData(map);

    // GW4-c5b: frame the interactive camera over map centre and hand it the map
    // bounds (for fitMap / future edge clamping). recomputeAxes() re-seeds the
    // RTSCamera's look-at + pan/right axes from the new pose so the first pan
    // moves in the right direction. Keeps the same starting framing as c3–c5a;
    // now pan/zoom/orbit are live off the forwarded input.
    const cx = map.widthElmos / 2;
    const cz = map.heightElmos / 2;
    gpCamera.position.set(cx, 1200, cz - 1500);
    gpCamera.setTarget(new Vector3(cx, 0, cz));
    const rtsCam = gpViewCameras.get(0);
    rtsCam?.setMapBounds(map.widthElmos, map.heightElmos);
    rtsCam?.recomputeAxes();

    // Fog-of-war overlay (envelope 0x07). Sits just above terrain in
    // renderingGroupId=1; never a shadow caster (map-sized blob).
    const fog = new TerrainFog();
    fog.build(scene, mapDims, map.heightmap);
    gpTerrainFog = fog;
    const fogMesh = fog.getMesh();
    if (fogMesh) sceneLighting.csm.removeShadowCaster(fogMesh, false);
    gpLosBitmapStore.forEach(bitmap => fog.apply(bitmap));

    // DXT1/KTX2 tile textures over HTTP.
    if (map.tilesX > 0 && map.tilesZ > 0) {
        loadTerrainTextures(scene, terrainMesh, mapBaseUrl, mapDims).catch(e => {
            postLog(2, `[gp] terrain texture loading failed: ${e}`);
        });
    }

    // GW4-c5: ground decal overlay (PLAN-decals.md D7) — craters from scar
    // events + vehicle tracks, baked into a persistent clipmap sampled by the
    // terrain material. Track classification reads the unit defs' trackType;
    // the worker fetches defs independently of the map (no Promise.all gate),
    // so if defs lag the map build, tracks stay unclassified until they land
    // (scars are unaffected). DEVIATION from main's def-gated onMapData — noted.
    gpDecalOverlay?.dispose();
    const decalOverlay = new DecalOverlay(scene, map.widthElmos, map.heightElmos);
    decalOverlay.setTrackTypes(
        buildTrackTypeNames((gpDefCache?.getAllUnitDefs() ?? []).map(d => d.trackType)));
    gpDecalOverlay = decalOverlay;
    if (terrainMesh.material) {
        attachDecalOverlay(terrainMesh.material,
            decalOverlay.coarseTexture, decalOverlay.fineTexture, decalOverlay.fineState,
            decalOverlay.coarseTexel, decalOverlay.fineTexel,
            map.widthElmos, map.heightElmos);
    }

    // GW4-c5: static map-placed features (rocks, trees, wrecks) — thin-instanced
    // .glb, registered as shadow casters. Runtime feature spawns go through the
    // dynamic feature renderer (onFeatureLifecycle).
    renderMapFeatures(scene, map, gpSceneLighting!.csm).catch((err) =>
        postLog(2, `[gp] renderMapFeatures failed: ${err}`));

    // Fallback water plane (maps with voidWater=true ship their own fluid widget).
    if (!map.water.voidWater) {
        const water = MeshBuilder.CreateGround('water', {
            width: map.widthElmos, height: map.heightElmos,
        }, scene);
        water.position.set(map.widthElmos / 2, 0, map.heightElmos / 2);
        water.isPickable = false;
        water.renderingGroupId = 1;
        const wmat = new StandardMaterial('waterMat', scene);
        const [r, g, b] = map.water.baseColor;
        wmat.diffuseColor = new Color3(r, g, b);
        wmat.emissiveColor = new Color3(r * 0.3, g * 0.3, b * 0.3);
        wmat.specularColor = new Color3(0.2, 0.2, 0.2);
        wmat.alpha = Math.max(0.4, map.water.surfaceAlpha);
        wmat.backFaceCulling = false;
        water.material = wmat;
        water.receiveShadows = false;
        sceneLighting.csm.removeShadowCaster(water, false);
    }
}

/// GW4-c2 placeholder viewport. Map data is served over HTTP (not the
/// connection — server_main.cpp), so Connection.onMapData never fires here;
/// fetch the map metadata directly to size a full-map box, send it once the
/// connection is authenticated, then resend periodically. c3 replaces this
/// with real camera-frustum updates from the in-worker camera state machine.
async function gpRegisterViewport(lobbyUrl: string, mapId: string): Promise<void> {
    let centerX = 4096, centerZ = 4096;
    try {
        const resp = await fetch(`${lobbyUrl}/api/maps/data/${mapId}/metadata.json`);
        if (resp.ok) {
            const meta = await resp.json();
            const sq = meta.squareSize ?? 8;
            centerX = ((meta.mapx ?? 1024) * sq) / 2;
            centerZ = ((meta.mapy ?? 1024) * sq) / 2;
        }
    } catch (err) {
        postLog(2, `[gp] map metadata fetch failed (${err}); using default viewport center`);
    }
    // GW4-c5b: track the interactive camera — centre the viewport on the camera
    // look-at so the server filters around where the player is looking. The size
    // stays a generous 16384² ("cover any current map", viewport.ts) so entities
    // never pop on these test maps; a tighter frustum-derived box is a later
    // optimisation that matters for large MMORTS maps, not c5b. Rotation 0 / zoom
    // 1 are placeholders until the LOD path lands.
    const send = () => {
        const cam = gpViewCameras.get(0);
        const t = cam?.target;
        gpConnection?.sendViewportUpdate(
            0, t ? t.x : centerX, t ? t.z : centerZ, 16384, 16384, 0, 1);
    };
    send();
    if (gpViewportTimer) clearInterval(gpViewportTimer);
    gpViewportTimer = setInterval(send, 1000);
    postLog(1, `[gp] viewport registered (camera-tracked, default center ${centerX.toFixed(0)},${centerZ.toFixed(0)}) — entity stream should follow`);
}

/// GW4-c2: stand up the in-worker connection. Discovers `/api/wt/info` from
/// `gameHttpUrl`, opens the WebTransport session, and auths with the init
/// creds (token reconnect against the shared lobby SQLite). At c2 the
/// callbacks are deliberately thin — the exit gate is "worker logs
/// entityState count=N with no main-thread network code" (PLAN-game-worker.md
/// GW4-c2). The full callback object (porting main.ts@32cf513619 L1070–1326)
/// fills in as the renderers + LuaUI runtime come online in c3–c6.
function gpConnect(msg: GpInitToWorker): void {
    const conn = new Connection({
        onStateChange: (state) => postLog(1, `[gp] connection state: ${state}`),
        onAuthenticated: (playerId, _token, team, defsCacheKey) => {
            postLog(1, `[gp] authenticated playerId=${playerId} team=${team} defsKey=${defsCacheKey || '(none)'}`);
            postToMain({ type: 'gp:authenticated', playerId, team });
            // GW4-c5b-3: tell the standing-order overlay who "we" are so its
            // own/allied filtering works (server already scopes the broadcast;
            // this drives own-vs-allied styling + the show-allies toggle).
            gpStandingOrderRenderer?.setIdentity(team, team);
            // GW4-c4: fetch the game's defs (unit/weapon/CEG/feature) over HTTP
            // from the content-addressed bake the server hands back. The
            // DefCache.onUnitDefs listener pushes them to the entity + plate
            // renderers as they ingest. (Server has no incremental def stream;
            // this bulk fetch is the whole def supply — main did the same.)
            if (defsCacheKey && gpDefCache) {
                fetchAndIngestDefs(msg.gameId, defsCacheKey, gpDefCache)
                    .then(() => postLog(1, `[gp] defs ingested (${gpDefCache?.getAllUnitDefs().length ?? 0} unit defs)`))
                    .catch((e) => postLog(4, `[gp] defs fetch failed: ${e}`));
            }
            // Register a viewport so the server starts streaming entity state.
            void gpRegisterViewport(msg.lobbyUrl, msg.mapId);
        },
        onAuthFailed: (m) => postLog(4, `[gp] auth failed: ${m}`),
        onServerError: (code, m) => postLog(4, `[gp] server error ${code}: ${m}`),
        onEntityState: (snapshot, isDelta) => {
            gpEntityRenderer?.update(snapshot, isDelta);
            gpBuildingPlateRenderer?.update(snapshot);
        },
        // GW4-c4: streamed piece transforms (envelope 0x05) → per-piece thin
        // instance matrices on the unit's model.
        onPieceState: (snapshot) => gpEntityRenderer?.applyPieceState(snapshot),
        // GW4-c4/c5: a unit/feature left view or died → drop its meshes + plate
        // and (c5) fire a combatFX death burst at its last position. (LuaUI
        // forward to widgets wires up in c6.)
        onEntityDestroy: (entityId, x, y, z) => {
            gpEntityRenderer?.removeEntity(entityId);
            gpBuildingPlateRenderer?.remove(entityId);
            gpCombatFX?.onCombatEvents([{
                attackerId: 0, targetId: entityId, weaponDefId: 0,
                result: 3, damage: 500, x, y, z,
            }]);
        },
        // GW4-c5: runtime feature spawns (wrecks/debris/reclaim) → dynamic
        // feature renderer. Map-placed features load via renderMapFeatures.
        onFeatureLifecycle: (spawns, removed) => {
            gpDynamicFeatureRenderer?.applyLifecycleBatch(spawns, removed);
        },
        // GW4-c5: weapon-fire / impact / trajectory events (envelopes inside
        // GameEventBatch) drive the projectile renderer + combatFX. The legacy
        // 0x04 per-tick projectile-state envelope is gone — the renderer
        // integrates motion locally off these events.
        onProjectileFired: (events) => {
            if (!gpProjectileRenderer) return;
            for (const e of events) gpProjectileRenderer.onFired(e);
        },
        onProjectileImpacts: (events) => {
            for (const e of events) gpProjectileRenderer?.onImpact(e);
            gpCombatFX?.onProjectileImpacts(events);
        },
        onProjectileTrajectories: (events) => {
            if (!gpProjectileRenderer) return;
            for (const e of events) gpProjectileRenderer.onTrajectory(e);
        },
        // GW4-c5: combat hit/kill events → combatFX (impact CEGs + lights).
        onCombatEvents: (events) => gpCombatFX?.onCombatEvents(events),
        // GW4-c5b-3: per-unit command queues (~1 Hz) → command-path + waypoint
        // overlays for the current selection (shift-gated). Cached so a
        // selection change re-renders without waiting for the next broadcast.
        // (Widget forward + the build-pending-ghost reaper land in c5c/c6.)
        onUnitCommandQueues: (queues) => {
            gpLastCommandQueues = queues;
            const sel = gpSelection?.selection ?? [];
            gpCommandPathRenderer?.update(queues, sel);
            gpWaypointMarkerRenderer?.update(queues, sel);
        },
        // GW4-c5b-3: standing orders (always-on overlay; server scopes the
        // broadcast to own + allied teams).
        onStandingOrders: (orders) => gpStandingOrderRenderer?.update(orders),
        // GW4-c5c-2: audio bridge. The connection decodes SoundEvents here, but
        // playback needs the main-thread AudioContext. Resolve each event's
        // SoundRef against the in-worker def cache (the def-dependent step) and
        // post the resolved pairs to main, where SoundEventPlayer does the
        // SoundItem/URL resolution + AudioManager.play. Music events forward
        // straight to main's MusicDirector.
        onSoundEvents: (events) => {
            if (!gpDefCache) return;
            const resolved: ResolvedSoundEvent[] = [];
            for (const e of events) {
                const ref = resolveSoundRef(gpDefCache, e.sourceKind as 0 | 1 | 2 | 3,
                    e.sourceDefId, e.soundId);
                if (ref) resolved.push({ e, ref });
            }
            if (resolved.length) postToMain({ type: 'gp:audioSoundEvents', events: resolved });
        },
        onMusicEvent: (state, fadeMs) => postToMain({ type: 'gp:audioMusic', state, fadeMs }),
        // GW4-c5: build/repair/reclaim progress (envelope 0x06) → build beams.
        onBuildActivity: (snapshot) => gpBuildBeamRenderer?.onSnapshot(snapshot),
        // GW4-c5: scar/track decal events (envelope 0x08) → ground decal overlay.
        onDecals: (snapshot) => gpDecalOverlay?.onSnapshot(snapshot.scars, snapshot.tracks),
        // PLAN-latency L0: drive the presentation cursor at the true sim speed
        // (paused → 0 freezes P). GW4-c5: also drive the FX aging multiplier +
        // the projectile integrator's sim-speed so bolts / particles / lights
        // slow + freeze with the game. Frame/wind forwarding to LuaUI lands in c6.
        onGameInfo: (frame, speed, paused) => {
            const eff = paused ? 0 : speed;
            gpPresentationClock?.setSpeedFactor(eff);
            gpFxSimSpeed = eff;
            gpProjectileRenderer?.setSimSpeed(eff);
            // GW4-c5c: cache for the sceneState feed (HUD frame / speed / pause).
            gpGameFrame = frame;
            gpSimSpeed = speed;
            gpPaused = paused;
        },
        // GW4-c3: live terrain deformation (envelope 0x09) → DeformableTerrain.
        onHeightmapPatch: (patch) => gpDeformTerrain?.applyPatch(patch),
        // GW4-c3: per-allyteam LOS bitmap (envelope 0x07) → fog-of-war overlay.
        // Stored so a bitmap that arrives before gpLoadMap finishes still
        // paints once the fog mesh exists.
        onLosBitmap: (bitmap) => {
            gpLosBitmapStore.set(bitmap);
            gpTerrainFog?.apply(bitmap);
            // GW4-c5c-3: a fresh LOS snapshot → ship the fog bitmap on the next
            // minimap feed.
            gpLastLosBitmap = bitmap;
            gpMinimapLosDirty = true;
            // Ghost preservation: a building killed out of LOS leaves a stale
            // ghost; when its tile is re-LOSed and the server isn't re-
            // streaming it, drop the ghost (it died while unseen).
            const size = gpEntityRenderer?.getMapSizeElmos();
            if (size) gpEntityRenderer?.clearGhostsInLos(bitmap, size.width, size.height);
        },
        // NOTE: Connection.onMapData is unused here — map data is served over
        // HTTP, not the connection (server_main.cpp). gpLoadMap (called from
        // gpInit) fetches + builds the terrain; the viewport is registered from
        // onAuthenticated via gpRegisterViewport().
        onGameOver: (frame) => postToMain({ type: 'gp:gameOver', frame }),
        onServerRestart: () => postToMain({ type: 'gp:reload' }),
    });
    gpConnection = conn;
    conn.connect(msg.gameHttpUrl, msg.username, '', msg.token);
}

function gpInit(msg: GpInitToWorker): void {
    if (gpEngine) {
        postLog(2, '[gp] gp:init received but engine already up — ignoring');
        return;
    }
    const canvas = msg.canvas;
    gpDpr = msg.dpr > 0 ? msg.dpr : 1;

    // GW4-c5c-3: seed the worker's clientSettings cache with the main thread's
    // gfx.* snapshot BEFORE createSceneLighting / the FX gating below read it.
    // The worker has no localStorage (set() degrades to cache-only, try/caught),
    // so without this seed every gfx read returns the registry default rather
    // than the player's chosen quality. Live changes arrive via `gp:config`.
    for (const [key, value] of Object.entries(msg.gfx ?? {})) {
        clientSettings.set(key, value as never);
    }
    // Size the backing store to the device-pixel resolution; Babylon reads
    // width/height off the canvas. Main keeps CSS sizing on the DOM element.
    canvas.width = Math.max(1, Math.floor(msg.width * msg.dpr));
    canvas.height = Math.max(1, Math.floor(msg.height * msg.dpr));

    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    // RH scene so the glTF loader + the server's RH wire format line up
    // (PLAN-coordinate-system) — same setup main.ts used before the move.
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    // Preserve the depth buffer across rendering groups so meshes in a higher
    // group still depth-test against the terrain (group 0). Babylon's DEFAULT is
    // to clear depth/stencil before every rendering group, which would let the
    // group-1 water plane (and group-2 units / group-3 command overlays) draw
    // ON TOP of terrain that should occlude them. main.ts had these three calls
    // pre-GW4; the c3 terrain port dropped them — restored here. See the
    // renderingGroupId assignments in terrain.ts (fog), entity-renderer.ts
    // (units), and the water block in gpLoadMap.
    scene.setRenderingAutoClearDepthStencil(1, false, true, true);
    scene.setRenderingAutoClearDepthStencil(2, false, true, true);
    scene.setRenderingAutoClearDepthStencil(3, false, true, true);

    // Default camera at origin — repositioned when MapData arrives (GW4-c3).
    const camera = new FreeCamera('camera', new Vector3(0, 1200, -1500), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.minZ = 1;
    camera.maxZ = 50000;

    gpEngine = engine;
    gpScene = scene;
    gpCamera = camera;

    // GW4-c3: install sun + ambient + HDR pipeline + CSM (deferred from c1 —
    // it was invisible on an empty scene and drags in the HDR pipeline).
    // applyMapLighting retunes it once mapinfo.lua lighting is fetched.
    gpSceneLighting = createSceneLighting(scene, camera);

    // GW4-c5: dynamic FX light pool (PLAN-weapon-fx-gaps Phase L). Fixed ring
    // of point lights driven by weapon fire / explosions, sampled by the
    // forward-lit stock materials + bloomed by the HDR pipeline. Created BEFORE
    // the ZK unit material so setActiveFxLightPool lets units (not just terrain)
    // light up under fire (Phase U). Distortion + muzzle-flare share the same
    // explosion/fire paths and need the camera, so they're built here too.
    gpFxLightPool = new FxLightPool(scene);
    setActiveFxLightPool(gpFxLightPool);
    gpDistortion = new DistortionRenderer(scene, camera);
    gpMuzzleFlare = new MuzzleFlareRenderer(scene, camera);

    // GW4-c4: world entity rendering (ports main.ts@d6301137f7^ L480–595).
    // The per-game shader lighting style normally comes from modinfo.lua's
    // `lighting` field via the lobby games list; the worker has no lobby list,
    // so default to 'gameplay' (main's own fallback). ZK routes through the
    // ported defaultMaterialTemplate shader regardless (setUseZKMaterial),
    // which is what matters for the primary target.
    // DEVIATION (c4): lightingStyle is hardcoded 'gameplay' here — fold the
    // real modinfo value into gp:init in a later checkpoint if a non-ZK game
    // needs its authored built-in-material lighting style.
    setLightingStyle('gameplay');
    setUseZKMaterial(msg.gameId === 'zk');

    gpPresentationClock = new PresentationClock();

    const entityRenderer = new EntityRenderer(scene);
    entityRenderer.setPresentationClock(gpPresentationClock);
    // PLAN-lighting L3/L4: register with the sun shadow generator up-front
    // (before any def streams in) so the first ensureModel load isn't raced;
    // pass the sun so the team-color material can sample the live CSM.
    entityRenderer.setShadowGenerator(gpSceneLighting.csm, gpSceneLighting.sun);
    gpEntityRenderer = entityRenderer;

    // GW4-c5b: interactive RTS camera for view 0 (DOM-free; driven by the
    // forwarded `gp:*` input). Ground sampler = the entity renderer's heightmap
    // (resolves once gpLoadMap calls setMapHeightmap) so the camera never dives
    // through terrain. Map bounds + initial framing are applied in gpLoadMap.
    const rtsCam = new RTSCamera(camera, msg.width, msg.height, msg.dpr);
    rtsCam.setGroundSampler((x, z) => gpEntityRenderer?.getGroundHeight(x, z) ?? 0);
    gpViewCameras.set(0, rtsCam);

    // PLAN-decals.md D5: static under-building ground plates (AO/scorch).
    const buildingPlateRenderer = new BuildingPlateRenderer(scene);
    if (msg.gameId) buildingPlateRenderer.setGame(msg.gameId, msg.lobbyUrl);
    gpBuildingPlateRenderer = buildingPlateRenderer;

    // DefCache accumulates the game's defs (fetched over HTTP on auth).
    const defCache = new DefCache();
    gpDefCache = defCache;

    // GW4-c5: projectile renderer + CEG runtime + build-beam (ports
    // main.ts@d6301137f7^ L511–537). The CEG runtime drives muzzle flashes /
    // impact bursts / debris; the projectile renderer integrates motion locally
    // off Fired/Impact/Trajectory events and injects the CEG runtime + FX
    // light pool + distortion + muzzle flare for its hooks.
    const projectileRenderer = new ProjectileRenderer(scene);
    gpProjectileRenderer = projectileRenderer;
    const buildBeamRenderer = new BuildBeamRenderer(scene);
    buildBeamRenderer.setEntityRenderer(entityRenderer);
    if (msg.gameId) buildBeamRenderer.setGameAssetsBaseUrl(msg.gameId);
    gpBuildBeamRenderer = buildBeamRenderer;
    const cegRuntime = new CegRuntime(scene);
    gpCegRuntime = cegRuntime;
    projectileRenderer.setCegRuntime(cegRuntime);
    projectileRenderer.setLightPool(gpFxLightPool);
    projectileRenderer.setDistortion(gpDistortion);
    projectileRenderer.setMuzzleFlare(gpMuzzleFlare);

    // Resolve weapon-def texture names → KTX2 URLs (shared by projectiles, CEG,
    // muzzle flares). Async; the renderers consult it lazily when they first see
    // a weapon def with a texture name.
    if (msg.gameId) {
        const resolver = new ProjectileTextureResolver();
        projectileRenderer.setTextureResolver(resolver);
        cegRuntime.setTextureResolver(resolver);
        gpMuzzleFlare?.setTextureResolver(resolver);
        resolver.init(msg.gameId, msg.lobbyUrl).catch((e) =>
            postLog(2, `[gp] projectile texture resolver init failed: ${e}`));
    }

    // CombatFX — impact/death bursts + shockwaves. Needs cegRuntime + defCache
    // to look up the firing weapon's CEG (else falls back to procedural
    // spheres). audio is null here: visuals are self-contained; the
    // SoundEvent → AudioManager bridge stays on main (GW4-c5c).
    const combatFX = new CombatFX(scene, undefined, cegRuntime, defCache);
    combatFX.setLightPool(gpFxLightPool);
    combatFX.setDistortion(gpDistortion);
    gpCombatFX = combatFX;

    // Dynamic feature renderer — runtime-spawned features (wrecks, debris,
    // reclaim removals). Map-placed features load once via renderMapFeatures
    // in gpLoadMap.
    const dynamicFeatureRenderer = new DynamicFeatureRenderer(scene, defCache);
    dynamicFeatureRenderer.setShadowGenerator(gpSceneLighting.csm);
    gpDynamicFeatureRenderer = dynamicFeatureRenderer;

    // Phase G: gate the expensive FX through the graphics-quality presets
    // (ports main.ts@d6301137f7^ L434–451 — dropped in the c5a FX move, restored
    // here now that the gfx snapshot + live `gp:config` push exist). `fireNow`
    // applies the seeded value immediately; a later `gp:config` re-fires these
    // via clientSettings.set → notify. `gfx.msaaSamples/fxaa/bloom/
    // shadowFiltering` are owned by scene-lighting.ts's own subscriptions.
    {
        const fxLights = gpFxLightPool;
        if (fxLights) clientSettings.subscribe('gfx.fxLights',
            (v) => fxLights.setEnabled(Boolean(v)), /*fireNow*/ true);
        const distortion = gpDistortion;
        if (distortion) clientSettings.subscribe('gfx.distortion',
            (v) => distortion.setEnabled(Boolean(v)), /*fireNow*/ true);
        // tier → {maxPerSpawn, maxLifetimeS}. particleQuality is read once per
        // session at CEG ingest (`requiresRestart`), so a live push only takes
        // effect on the next ingestCegDefs — matching the main-thread semantics.
        const PARTICLE_TIERS: Array<[number, number]> = [
            [16, 4.0],   // 0 low
            [32, 8.0],   // 1 medium
            [64, 12.0],  // 2 high
        ];
        clientSettings.subscribe('gfx.particleQuality', (v) => {
            const tier = PARTICLE_TIERS[Math.max(0, Math.min(2, Number(v)))];
            setParticleBudget(tier[0], tier[1]);
        }, /*fireNow*/ true);
    }

    // New defs → the renderers that consume them. (LuaUI forward to widgets is
    // GW4-c6.)
    defCache.onUnitDefs((newDefs) => {
        gpEntityRenderer?.setUnitDefs(newDefs);
        gpBuildingPlateRenderer?.setUnitDefs(newDefs);
    });
    defCache.onWeaponDefs((newDefs) => {
        gpProjectileRenderer?.setWeaponDefs(newDefs);
    });
    // Streamed CEG defs override the BUILTIN_EFFECTS hand-ports for any tag the
    // game defines; missing tags still resolve via the built-in archetypes.
    defCache.onCegDefs((newDefs) => {
        gpCegRuntime?.ingestCegDefs(newDefs);
    });

    gpLastFrameTime = performance.now();
    engine.runRenderLoop(() => {
        const now = performance.now();
        const dt = (now - gpLastFrameTime) / 1000;
        gpLastFrameTime = now;
        // Sim-scaled delta for VISUAL FX aging — slows / freezes with the game
        // speed. Camera + entity ticks keep the raw wall dt; only FX lifetimes
        // use fxDt (PLAN-weapon-fx-capture-arch fxDt).
        const fxDt = dt * gpFxSimSpeed;

        // GW4-c5b: advance the interactive camera(s) first so this frame's
        // render + pick + viewport use the updated pose. Raw wall dt (the camera
        // is not sim-scaled). tick() handles its own per-call timing internally.
        for (const cam of gpViewCameras.values()) cam.tick();

        // entityRenderer.tick() advances the presentation clock (L0) and
        // interpolates every unit to the presentation cursor before render.
        gpEntityRenderer?.tick();
        gpBuildBeamRenderer?.tick();
        gpProjectileRenderer?.tick();
        gpCegRuntime?.tick(fxDt);
        gpCombatFX?.tick(fxDt);
        // Decal clipmap fine window tracks the camera focus + height.
        {
            const focus = camera.getTarget();
            gpDecalOverlay?.tick(dt, focus.x, focus.z,
                Math.max(1, camera.position.y - focus.y));
        }
        // Age the FX lights after the emitters ran this frame + before
        // scene.render() consumes the lighting; then push distortion/muzzle
        // uniforms.
        gpFxLightPool?.update(fxDt, camera.position);
        gpDistortion?.tick(fxDt);
        gpMuzzleFlare?.tick(fxDt);
        scene.render();
        // GW4-c5c: feed the HTML HUD (entity count / frame / selection / speed).
        gpPostSceneState(now);
        // GW4-c5c-3: feed the main-thread minimap (unit dots + fog overlay).
        gpPostMinimapFeed(now);
    });
    postLog(1, '[gp] Babylon Engine up on transferred #game-canvas (GW4-c5, weapon FX)');

    // GW4-c2: open the game-server connection from inside the worker.
    gpConnect(msg);

    // GW4-c5b-2: worker-side selection / pick / order. Needs the connection
    // (built in gpConnect) for order sends. Left-button gestures select; the
    // camera's right-tap routes through `onRightClickCommit` → an order. The
    // drag-box rectangle is posted to main (DOM overlay).
    // GW4-c5b-3: selection-driven order overlays. Command-path + waypoint share
    // the shift gate + queue/selection snapshot; standing orders are always-on.
    const commandPathRenderer = new CommandPathRenderer(scene, entityRenderer);
    gpCommandPathRenderer = commandPathRenderer;
    const waypointMarkerRenderer = new WaypointMarkerRenderer(scene, entityRenderer);
    gpWaypointMarkerRenderer = waypointMarkerRenderer;
    // Bucket-3: seed show-allies from the gp:init value (lifted from main's
    // localStorage) and route persistence back to main via gp:config — the
    // worker's localStorage isn't the page's.
    const standingOrderRenderer = new StandingOrderRenderer(scene, {
        showAllies: msg.standingOrderShowAllies,
        persistShowAllies: (show) =>
            postToMain({ type: 'gp:config', key: 'standing-orders-show-allies', value: show }),
    });
    gpStandingOrderRenderer = standingOrderRenderer;

    const selection = new WorkerSelection(scene, entityRenderer, gpConnection!, {
        getCamera: (viewId) => (viewId === 0 ? camera : null),
        dpr: gpDpr,
        onDragBox: (box) => postToMain({ type: 'gp:dragBox', box }),
        // Re-render the path/waypoint overlays from the cached queue snapshot so
        // they appear immediately on a selection change (don't wait for the next
        // ~1 Hz UnitCommandQueuesUpdate). (sceneState mirroring → main is c5c.)
        onSelectionChange: (ids) => {
            gpCommandPathRenderer?.update(gpLastCommandQueues, ids);
            gpWaypointMarkerRenderer?.update(gpLastCommandQueues, ids);
        },
    });
    gpSelection = selection;
    rtsCam.onRightClickCommit = (x, y, mods) =>
        selection.issueOrderAtScreen(x, y, mods.shift, 0);
    // PLAN-latency L0: anchor the presentation clock to this connection's
    // ServerClock (created per game connection by Connection).
    gpPresentationClock.reset();
    gpPresentationClock.setServerClock(gpConnection!.serverClock);
    // GW4-c3: fetch map data over HTTP + build the terrain (independent of the
    // connection auth handshake — map data is on the asset plane).
    void gpLoadMap(msg);
}

/// GW4-c5b-3: update the shift-held gate that shows/hides the command-path +
/// waypoint overlays (Spring's "hold Shift to see queued orders" gesture).
/// Driven from the forwarded key/pointer `mods` bitmask (bit 0 = shift).
function gpSetShift(held: boolean): void {
    if (held === gpShiftHeld) return;
    gpShiftHeld = held;
    gpCommandPathRenderer?.setShiftHeld(held);
    gpWaypointMarkerRenderer?.setShiftHeld(held);
}

/// GW4-c5c: post the consolidated scene-state feed to main (~10 Hz). This is the
/// only channel the DOM layer reads world facts from — keep it to the frozen
/// `GpSceneStateToMain` shape (game-worker-protocol.ts). Drives the HTML HUD
/// (entity count / frame / selection / speed-pause); the camera pose is carried
/// for the c5c-2 audio listener + c5c-3 minimap that build on this feed.
function gpPostSceneState(now: number): void {
    if (now - gpLastSceneStatePost < 100) return;  // ~10 Hz throttle
    gpLastSceneStatePost = now;
    const cam = gpCamera;
    if (!cam) return;
    const sel = gpSelection?.selection ?? [];
    const target = cam.getTarget();
    postToMain({
        type: 'gp:sceneState',
        selectedUnitIds: sel.slice(),
        // Rich per-unit facts (health etc.) fill in when a consumer needs them
        // (HUD today only reads ids + count); kept empty to stay cheap.
        selected: [],
        hovered: gpSelection && gpSelection.hovered > 0 ? { id: gpSelection.hovered } : null,
        camera: {
            x: cam.position.x, y: cam.position.y, z: cam.position.z,
            tx: target.x, ty: target.y, tz: target.z,
        },
        gameFrame: gpGameFrame,
        paused: gpPaused,
        simSpeed: gpSimSpeed,
        buildGhost: null,
        entityCount: gpEntityRenderer?.entityCount ?? 0,
    });
}

/// GW4-c5c-3: post the minimap feed to main (~6 Hz). The minimap is a DOM
/// element with its own Babylon Engine on the main thread (it can't read the
/// worker's entity renderer), so the worker projects the live entity set down
/// to compact per-blip arrays. Fog-of-war-hidden units (los===0) are dropped
/// here so the minimap never leaks their positions — mirrors the pre-GW4
/// `Minimap.updateEntityInstances` filter, just moved to the producer side.
/// The LOS fog bitmap only ships when a new envelope-0x07 snapshot arrived
/// (gpMinimapLosDirty); otherwise `los: null` ⇒ main keeps its current overlay.
function gpPostMinimapFeed(now: number): void {
    if (now - gpLastMinimapPost < 160) return;  // ~6 Hz
    gpLastMinimapPost = now;
    const er = gpEntityRenderer;
    if (!er) return;

    // First pass: count visible blips so the typed arrays are exactly sized.
    let n = 0;
    for (const [, meta] of er.getEntities()) {
        if (meta.losState !== 0) n++;
    }
    const ids = new Uint32Array(n);
    const teams = new Uint16Array(n);
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    const los = new Uint8Array(n);
    let i = 0;
    for (const [id, meta] of er.getEntities()) {
        if (meta.losState === 0) continue;       // fog of war — never leak
        const pos = er.getEntityPosition(id);
        if (!pos) continue;
        ids[i] = id;
        teams[i] = meta.team;
        xs[i] = pos.x;
        zs[i] = pos.z;
        los[i] = meta.losState;
        i++;
    }
    const blips: GpMinimapBlips = {
        // i may be < n if a position was missing; report the filled count.
        count: i, ids, teams, x: xs, z: zs, los,
    };

    let losPayload: GpMinimapLos | null = null;
    if (gpMinimapLosDirty && gpLastLosBitmap) {
        gpMinimapLosDirty = false;
        const b = gpLastLosBitmap;
        losPayload = {
            width: b.width, height: b.height,
            inLos: b.inLos, inRadar: b.inRadar, explored: b.explored,
        };
    }
    // Deliver map dims + backdrop URL once (cleared after the first send).
    const mapInfo = gpMinimapMapInfo ?? undefined;
    if (gpMinimapMapInfo) gpMinimapMapInfo = null;
    postToMain({ type: 'gp:minimapFeed', blips, los: losPayload, map: mapInfo });
}

function gpResize(width: number, height: number, dpr: number): void {
    if (!gpEngine) return;
    const c = gpEngine.getRenderingCanvas() as OffscreenCanvas | null;
    if (c) {
        c.width = Math.max(1, Math.floor(width * dpr));
        c.height = Math.max(1, Math.floor(height * dpr));
    }
    gpEngine.resize();
    // GW4-c5b: keep the camera's CSS-pixel viewport + dpr in sync so edge-scroll
    // bands and scene.pick (which scales by dpr) stay correct after a resize.
    for (const cam of gpViewCameras.values()) cam.setViewportSize(width, height, dpr);
    // GW4-c5b-2: selection pick scaling also needs the live dpr.
    if (dpr > 0) { gpDpr = dpr; gpSelection?.setDpr(dpr); }
}

function gpShutdown(): void {
    if (gpViewportTimer) { clearInterval(gpViewportTimer); gpViewportTimer = null; }
    for (const cam of gpViewCameras.values()) cam.dispose();
    gpViewCameras.clear();
    gpSelection?.dispose();
    gpSelection = null;
    gpCommandPathRenderer?.dispose();
    gpCommandPathRenderer = null;
    gpWaypointMarkerRenderer?.dispose();
    gpWaypointMarkerRenderer = null;
    gpStandingOrderRenderer?.dispose();
    gpStandingOrderRenderer = null;
    gpLastCommandQueues = [];
    gpShiftHeld = false;
    gpConnection?.disconnect();
    gpConnection = null;
    gpEntityRenderer?.dispose();
    gpEntityRenderer = null;
    gpBuildingPlateRenderer?.dispose();
    gpBuildingPlateRenderer = null;
    gpDefCache?.clear();
    gpDefCache = null;
    gpPresentationClock = null;
    // GW4-c5: weapon-FX / projectile / decal / build / feature modules.
    gpProjectileRenderer?.dispose();
    gpProjectileRenderer = null;
    gpCegRuntime?.dispose();
    gpCegRuntime = null;
    gpBuildBeamRenderer?.dispose();
    gpBuildBeamRenderer = null;
    gpCombatFX?.dispose();
    gpCombatFX = null;
    gpDistortion?.dispose();
    gpDistortion = null;
    gpMuzzleFlare?.dispose();
    gpMuzzleFlare = null;
    gpFxLightPool?.dispose();
    gpFxLightPool = null;
    setActiveFxLightPool(null);
    gpDecalOverlay?.dispose();
    gpDecalOverlay = null;
    gpDynamicFeatureRenderer?.dispose();
    gpDynamicFeatureRenderer = null;
    gpFxSimSpeed = 1;
    gpTerrainFog?.dispose();
    gpTerrainFog = null;
    gpTerrainMesh = null;
    gpDeformTerrain = null;
    gpMapData = null;
    gpSceneLighting = null;
    gpEngine?.stopRenderLoop();
    // scene.dispose() tears down the terrain mesh, fog, water, lights, CSM,
    // and the HDR render pipeline created above.
    gpScene?.dispose();
    gpEngine?.dispose();
    gpEngine = null;
    gpScene = null;
    gpCamera = null;
}

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    // Debug-level trace of inbound messages (skip high-frequency
    // channels to avoid drowning real log entries: pointer movement,
    // per-frame stateUpdate from the main thread's mouseState/camera
    // tracker, gameInfo (frame/speed/wind ticking every frame), the
    // entityState snapshot stream, and the periodic losBitmap push).
    if (msg.type !== 'mousemove'
        && msg.type !== 'stateUpdate'
        && msg.type !== 'gameInfo'
        && msg.type !== 'entityState'
        && msg.type !== 'losBitmap') {
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

        // PLAN-game-worker.md GW4: game-processor messages. At c1 only the
        // Engine bootstrap + resize/shutdown are wired; connection, decoders,
        // input and the scene-state feed land in c2–c5.
        case 'gp:init':
            try {
                gpInit(msg as GpInitToWorker);
            } catch (err) {
                postLog(4, `gp:init failed: ${err}`);
                postToMain({ type: 'error', msg: String(err) });
            }
            break;

        case 'gp:resize':
            gpResize(msg.width, msg.height, msg.dpr);
            break;

        // GW4-c5b: interactive camera input forwarded by the main-thread
        // CameraInput. Routed per-view (multi-view); absent viewId ⇒ view 0.
        // Coordinates are canvas-relative CSS px, origin top-left (Babylon's
        // native screen space — see game-worker-protocol.ts).
        case 'gp:pointermove':
            gpViewCameras.get(msg.viewId ?? 0)?.pointerMove(msg.x, msg.y, msg.buttons);
            // GW4-c5b-2: left-button drag-box growth + hover tracking.
            gpSelection?.pointerMove(msg.x, msg.y, msg.buttons, msg.mods, msg.viewId ?? 0);
            break;
        case 'gp:pointerdown':
            gpViewCameras.get(msg.viewId ?? 0)?.pointerDown(msg.x, msg.y, msg.button, msg.mods);
            // GW4-c5b-2: left-button selection (camera ignores button 0).
            gpSelection?.pointerDown(msg.x, msg.y, msg.button, msg.mods, msg.viewId ?? 0);
            break;
        case 'gp:pointerup':
            gpViewCameras.get(msg.viewId ?? 0)?.pointerUp(msg.x, msg.y, msg.button, msg.mods);
            gpSelection?.pointerUp(msg.x, msg.y, msg.button, msg.mods, msg.viewId ?? 0);
            break;
        case 'gp:wheel':
            gpViewCameras.get(msg.viewId ?? 0)?.wheel(msg.x, msg.y, msg.delta);
            break;
        case 'gp:keydown':
            // RTSCamera matches lowercased KeyboardEvent.code (e.g. 'arrowup').
            gpViewCameras.get(msg.viewId ?? 0)?.keyDown(String(msg.code).toLowerCase());
            // GW4-c5b-3: shift gates the command-path / waypoint overlays.
            gpSetShift((msg.mods & 1) !== 0);
            break;
        case 'gp:keyup':
            gpViewCameras.get(msg.viewId ?? 0)?.keyUp(String(msg.code).toLowerCase());
            gpSetShift((msg.mods & 1) !== 0);
            break;
        case 'gp:blur':
            gpViewCameras.get(msg.viewId ?? 0)?.blur();
            gpSelection?.blur();
            gpSetShift(false);
            break;

        // GW4-c5c-3: live clientSettings/gfx.* push from main. Routing through
        // clientSettings.set updates the worker's cache AND fires the subscribers
        // (scene-lighting's msaa/fxaa/bloom/shadow + the FX-gating block in
        // gpInit), so a quality toggle on main applies in the worker with no
        // per-key switch here. (localStorage write inside set() is try/caught —
        // the worker has none; main owns persistence.)
        case 'gp:config':
            try { clientSettings.set(msg.key, msg.value as never); }
            catch (err) { postLog(2, `[gp] gp:config ${msg.key} failed: ${err}`); }
            break;

        // GW4-c5c-3: minimap left-click → re-centre the world camera. The
        // minimap lives on main (own Engine) but the world camera is in the
        // worker, so the focus intent crosses the boundary.
        case 'gp:focusWorld':
            gpViewCameras.get(msg.viewId ?? 0)?.focusOn(msg.x, msg.z);
            break;

        case 'gp:shutdown':
            gpShutdown();
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

        case 'defaultCommandTarget': {
            // Main thread reports a hover-target change. Dispatch the
            // widget DefaultCommand callin chain so widgets like
            // unit_default_commands / cmd_mex_placement / gui_highlight_geos
            // can rewrite what right-click would do. Store the resolved
            // cmdId in liveState so Spring.GetDefaultCommand returns the
            // override, and post it back to main so InputManager can
            // honour the override on actual right-click. Throttled
            // main-side: the message only arrives on target change.
            const targetType = (msg.targetType === 'unit' || msg.targetType === 'feature')
                ? msg.targetType as 'unit' | 'feature'
                : null;
            const targetId = Number(msg.targetId | 0);
            const engineCmd = Number(msg.engineCmd | 0);
            const resolved = dispatchDefaultCommand(targetType, targetId, engineCmd);
            liveState.defaultCommand = {
                targetType,
                targetId,
                engineCmd,
                cmdId: resolved,
            };
            postToMain({
                type: 'defaultCommandResolved',
                targetType,
                targetId,
                engineCmd,
                cmdId: resolved,
            });
            break;
        }

        case 'commandNotify': {
            // Main thread asks the worker to run the CommandNotify gate
            // before issuing a mouse-built command. Mirrors the synchronous
            // path used by widget-issued GiveOrder*, but async because the
            // main thread can't call into the Worker. Any widget that
            // returns true from its CommandNotify handler consumes the
            // order — we relay that decision back so the main thread can
            // suppress the actual send. Failing open (consumed=false) on
            // a runtime not-yet-ready / missing-handler is correct: the
            // command should still go through.
            const requestId = Number(msg.requestId | 0);
            const cmdId = Number(msg.cmdId | 0);
            const params = Array.isArray(msg.params) ? (msg.params as number[]) : [];
            const options = Number(msg.options | 0);
            let consumed = false;
            try {
                consumed = dispatchCommandNotify(cmdId, params, options);
            } catch (err) {
                postLog(3, `[CommandNotify] dispatch error: ${err}`);
            }
            postToMain({ type: 'commandNotifyResult', requestId, consumed });
            break;
        }

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
            const prevIdentity = liveState.identity;
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
                // Selection genuinely changed — always rebuild so the
                // "newly selected factory" tab logic runs even if the new
                // selection happens to expose an identical command set.
                dispatchCommandsChanged(true);
            }
            // Identity delta → fire widget:PlayerChanged. Spring fires
            // this on team change, spec ↔ player toggle, leader change.
            // We don't track leadership here, but myTeam / myPlayerId
            // changes cover the cases ZK widgets (unit_cloakfirestate2,
            // cmd_factory_plate_placer) actually care about. Don't fire
            // on the initial auth (prevIdentity has the sentinel myPlayerId<=0),
            // which would otherwise spam every widget before any state
            // has loaded.
            if (msg.identity && prevIdentity.myPlayerId > 0
                && (prevIdentity.myTeam !== liveState.identity.myTeam
                    || prevIdentity.myAllyTeam !== liveState.identity.myAllyTeam
                    || prevIdentity.myPlayerId !== liveState.identity.myPlayerId)) {
                dispatchPlayerChanged(liveState.identity.myPlayerId);
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
            const buildProgress = msg.buildProgress as Uint8Array | null;

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
            // Track buildProgress < 1 → >= 1 transitions so we can fire
            // UnitFinished after the merge. The server doesn't emit a
            // dedicated build-complete event yet, so we derive it from
            // the entity-state stream — close enough for ZK widgets like
            // unit_building_starter and cmd_no_duplicate_orders.
            const finishedIds: Array<{ id: number; defId: number; team: number }> = [];
            const decodeProgress = (i: number) => buildProgress ? buildProgress[i] / 255 : 1;
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
                // Delta — merge changed units
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
            // Flush any allied-team appearances that were deferred on
            // the previous tick — if the server's UnitCreated event
            // arrived in the meantime, the id is in
            // serverFiredUnitCreated and we skip it; otherwise fire the
            // synthesised callin (no builderId).
            if (liveState.pendingSynthCreated.size > 0) {
                for (const [id, entry] of liveState.pendingSynthCreated) {
                    if (!liveState.serverFiredUnitCreated.has(id)) {
                        dispatchUnitCreated(id, entry.defId, entry.team, 0);
                        liveState.serverFiredUnitCreated.add(id);
                    }
                }
                liveState.pendingSynthCreated.clear();
            }
            // New ids picked up from this batch. Allied-team ids are
            // deferred one tick to let the server-side Created event
            // arrive first; enemy ids fire immediately because the
            // server intentionally doesn't broadcast Created for them.
            const myAllyTeam = liveState.identity.myAllyTeam;
            for (const c of createdIds) {
                if (liveState.serverFiredUnitCreated.has(c.id)) continue;
                const teamInfo = liveState.teams.get(c.team);
                const allied = teamInfo
                    ? teamInfo.allyTeam === myAllyTeam
                    : false;
                if (allied) {
                    liveState.pendingSynthCreated.set(
                        c.id, { defId: c.defId, team: c.team });
                } else {
                    dispatchUnitCreated(c.id, c.defId, c.team, 0);
                    liveState.serverFiredUnitCreated.add(c.id);
                }
            }
            for (const f of finishedIds) {
                dispatchUnitFinished(f.id, f.defId, f.team);
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
            liveState.serverFiredUnitCreated.delete(id);
            liveState.pendingSynthCreated.delete(id);
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

        case 'sendToUnsynced': {
            // PLAN-weapon-fx Phase Z1.5 — forwarded Spring.SendToUnsynced
            // call from a synced LuaRules gadget. Build a Lua call into
            // gadgetHandler:DispatchSyncAction(topic, ...). args[0] is
            // conventionally the topic string (matching upstream
            // CUnsyncedLuaHandle::RecvFromSynced); we pass it both as
            // the topic and as the first parameter so action handlers
            // that follow the `function FlameShot(_, unitID, ...)` shape
            // see their expected signature.
            if (!runtime) break;
            const args = msg.args as Array<
                | { kind: 'nil' }
                | { kind: 'bool'; value: boolean }
                | { kind: 'number'; value: number }
                | { kind: 'string'; value: string }
            > | undefined;
            if (!args || args.length === 0) break;
            // Render args as Lua literals into a single doString.
            // Strings go through escapeLuaString; numbers/bools serialise
            // directly. Nil maps to the Lua `nil` literal.
            const parts: string[] = [];
            for (const a of args) {
                switch (a.kind) {
                    case 'nil':
                        parts.push('nil');
                        break;
                    case 'bool':
                        parts.push(a.value ? 'true' : 'false');
                        break;
                    case 'number':
                        // Number.prototype.toString gives a finite Lua-valid
                        // literal for any finite double. Non-finite drops to
                        // nil (Lua's `0/0` would still parse but a nil keeps
                        // the action handler from doing arithmetic on NaN).
                        parts.push(Number.isFinite(a.value) ? String(a.value) : 'nil');
                        break;
                    case 'string':
                        parts.push(`"${escapeLuaString(a.value)}"`);
                        break;
                }
            }
            runtime.doString(
                `if gadgetHandler and gadgetHandler.DispatchSyncAction then ` +
                `gadgetHandler:DispatchSyncAction(${parts.join(', ')}) end`,
                'sendToUnsynced',
            );
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

        case 'unitTransports': {
            // Snapshot replacement. Rebuild both directions of the
            // transporter↔cargo index so widgets can look up either side
            // (Spring.GetUnitIsTransporting / GetUnitTransporter).
            const transports = msg.transports as Array<{
                transporterId: number; cargo: number[];
            }> | undefined;
            if (!transports) break;
            liveState.transportCargo.clear();
            liveState.transportCarrier.clear();
            for (const t of transports) {
                liveState.transportCargo.set(t.transporterId, [...t.cargo]);
                for (const cargoId of t.cargo) {
                    liveState.transportCarrier.set(cargoId, t.transporterId);
                }
            }
            break;
        }

        case 'unitSelfD': {
            const units = msg.units as Array<{
                unitId: number; secondsRemaining: number;
            }> | undefined;
            if (!units) break;
            liveState.selfDCountdown.clear();
            for (const u of units) {
                if (u.secondsRemaining > 0)
                    liveState.selfDCountdown.set(u.unitId, u.secondsRemaining);
            }
            break;
        }

        case 'unitStockpile': {
            const units = msg.units as Array<{
                unitId: number; ready: number; queued: number; buildPercent: number;
            }> | undefined;
            if (!units) break;
            liveState.stockpileState.clear();
            for (const u of units) {
                liveState.stockpileState.set(u.unitId, {
                    ready: u.ready, queued: u.queued, buildPercent: u.buildPercent,
                });
            }
            break;
        }

        case 'unitLifecycle': {
            const events = msg.events as Array<{
                kind: 'fromFactory' | 'taken' | 'given' | 'created';
                unitId: number; unitDefId: number; unitTeam: number;
                factoryId: number; factoryDefId: number; userOrders: boolean;
                oldTeam: number; newTeam: number;
                builderId: number;
            }> | undefined;
            if (!events || !runtime) break;
            for (const e of events) {
                if (e.kind === 'fromFactory') {
                    dispatchUnitFromFactory(
                        e.unitId, e.unitDefId, e.unitTeam,
                        e.factoryId, e.factoryDefId, e.userOrders);
                } else if (e.kind === 'taken') {
                    dispatchUnitTaken(e.unitId, e.unitDefId, e.oldTeam, e.newTeam);
                } else if (e.kind === 'given') {
                    dispatchUnitGiven(e.unitId, e.unitDefId, e.oldTeam, e.newTeam);
                } else if (e.kind === 'created') {
                    // Server-authoritative Created: own + allied teams
                    // only, with builderId populated. Mark the id so the
                    // entity-stream synthesis path skips it; drop any
                    // pending deferred synth that was waiting for this.
                    liveState.pendingSynthCreated.delete(e.unitId);
                    if (!liveState.serverFiredUnitCreated.has(e.unitId)) {
                        liveState.serverFiredUnitCreated.add(e.unitId);
                        dispatchUnitCreated(
                            e.unitId, e.unitDefId, e.unitTeam, e.builderId);
                    }
                }
            }
            break;
        }

        case 'visibleUnits': {
            const added = msg.added as Array<{
                id: number; defId: number; team: number;
            }> | undefined;
            const removed = msg.removed as number[] | undefined;
            if (!runtime) break;
            if (added) {
                for (const u of added) {
                    dispatchVisibleUnitAdded(u.id, u.defId, u.team);
                }
            }
            if (removed) {
                for (const id of removed) {
                    dispatchVisibleUnitRemoved(id);
                }
            }
            break;
        }

        case 'unitCommand': {
            const events = msg.events as Array<{
                kind: 'issued' | 'done';
                unitId: number; unitDefId: number; unitTeam: number;
                cmdId: number; params: number[]; options: number; tag: number;
                playerId: number; fromSynced: boolean; fromLua: boolean;
            }> | undefined;
            if (!events || !runtime) break;
            for (const e of events) {
                if (e.kind === 'issued') {
                    dispatchUnitCommand(
                        e.unitId, e.unitDefId, e.unitTeam,
                        e.cmdId, e.params, e.options, e.tag,
                        e.playerId, e.fromSynced, e.fromLua);
                } else {
                    dispatchUnitCmdDone(
                        e.unitId, e.unitDefId, e.unitTeam,
                        e.cmdId, e.params, e.options, e.tag);
                }
            }
            break;
        }

        case 'unitArmored': {
            const units = msg.units as Array<{
                unitId: number; armored: boolean; armoredMultiple: number;
            }> | undefined;
            if (!units) break;
            liveState.armoredState.clear();
            for (const u of units) {
                liveState.armoredState.set(u.unitId, {
                    armored: u.armored, armoredMultiple: u.armoredMultiple,
                });
            }
            break;
        }

        case 'pathResponse': {
            // Server reply to a `Spring.RequestPath` we sent earlier.
            // The path proxy returned at request time reads `pathResponses`
            // on every method call, so once we drop the result in here
            // any future call observes the real waypoints. We never
            // delete the entry on our own — the widget either calls
            // `Spring.DeletePath` (which clears it) or drops its
            // reference and we leak a small entry until shutdown.
            const requestId = Number(msg.requestId | 0);
            const waypoints = Array.isArray(msg.waypoints)
                ? (msg.waypoints as Array<[number, number, number]>)
                    .map(w => [Number(w[0]), Number(w[1]), Number(w[2])] as [number, number, number])
                : [];
            const length = Number(msg.length ?? 0);
            if (requestId > 0) {
                liveState.pathResponses.set(requestId, { waypoints, length });
            }
            break;
        }

        case 'standingOrders': {
            // Server-pushed snapshot of every standing order visible to
            // this client (own team + allied teams). Wholesale replace:
            // the server sends the full set on every state change so we
            // don't need to track diffs. Widgets read it via
            // `Spring.GetStandingOrders` which walks the map directly.
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

        case 'projectileState': {
            // A3: rebuild the live-projectile mirror from the main-thread
            // ProjectileRenderer snapshot. Full replace each frame — the set
            // is small and short-lived, so a fresh Map is cheaper than
            // diffing and avoids stale ids lingering after impact.
            const projs = msg.projectiles as ReadonlyArray<ProjectileEntry & { id: number }> | undefined;
            const next = new Map<number, ProjectileEntry>();
            if (projs) {
                for (const p of projs) {
                    next.set(p.id, {
                        defId: p.defId,
                        x: p.x, y: p.y, z: p.z,
                        vx: p.vx, vy: p.vy, vz: p.vz,
                        ttl: p.ttl, isBeam: p.isBeam,
                    });
                }
            }
            liveState.projectiles = next;
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
            // Coord-system mode lands here on the first GameInfo broadcast
            // for the game. Flipping it mid-game is not supported — the
            // server treats the flag as immutable per game session, and
            // widget code paths cache its effects in matrices.
            if (msg.legacyCoordSystem !== undefined) {
                liveState.legacyCoordSystem = msg.legacyCoordSystem as boolean;
                bridge?.setLegacyCoordSystem(msg.legacyCoordSystem as boolean);
            }
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
    local prefetched = _vfsLookup(path)
    if prefetched then return prefetched end
    -- PLAN-settings.md §3: fall back to persisted (io.open-written)
    -- config so settings survive a reload. Excludes widget-order files.
    if _vfsStorageLookup then return _vfsStorageLookup(path) end
    return nil
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
    mode = mode or VFS.DEF_MODE
    -- Mode-aware existence. RAW_ONLY / ZIP_ONLY must disambiguate which
    -- layer a file came from — the distinction ZK's fromZip security gate
    -- (cawidgets.lua: only archive-shipped widgets may access SpringRestricted)
    -- depends on. In the web model every HTTP-served engine/game file is
    -- archive-equivalent (ZIP); only io.open-written / localStorage-persisted
    -- config is raw (user-writable, outside any archive). A stub that
    -- returned true for BOTH _ONLY modes collapsed not FileExists(.., RAW_ONLY)
    -- to false, so gfx_projectile_lights.lua never received SpringRestricted and
    -- failed to load. PLAN-settings.md section 3: persisted config must still
    -- count as existing (raw) so cawidgets default-mode gated load restores it.
    local inArchive = _vfsExists(path)
    local inRaw = (VFS._writeCache[path] ~= nil)
        or (_vfsStorageLookup ~= nil and _vfsStorageLookup(path) ~= nil)
    if mode == VFS.RAW_ONLY then
        return inRaw
    elseif mode == VFS.ZIP_ONLY then
        return inArchive
    end
    return inArchive or inRaw
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

function escapeLuaString(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}
