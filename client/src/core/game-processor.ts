/**
 * game-processor.ts — the game-processor (GP) half of the game-processor worker.
 *
 * Owns:
 *   - All gp* module-level state (engine, scene, camera, renderers, etc.)
 *   - gpInit() — bootstraps the Babylon engine, renderers, and connection
 *   - gpConnect() — opens the WebTransport game connection
 *   - gpLoadMap() — fetches map data and builds the terrain
 *   - gpShutdown() — tears down everything GP-owned
 *   - All other gp* functions (input dispatch, scene-state feed, etc.)
 *
 * One-way import: game-processor imports from lua-ui-host and gp-context,
 * but is NEVER imported by lua-ui-host or gp-context (no cycle).
 *
 * Extracted from lua-widget-worker.ts as part of PLAN-refactor-p3.md WP2c.
 */

import { Engine, Scene, FreeCamera, Vector3, Color3, Color4, Mesh, MeshBuilder, StandardMaterial } from '@babylonjs/core';
import type { GpInitToWorker, GpMinimapBlips, GpMinimapLos, GpMinimapMetalSpots, BuildMenuTile, FactoryQueueTile } from './game-worker-protocol.js';
// GW4-c2: the WebTransport game connection now lives in the worker. Connection
// is host-agnostic (runs on WebTransportAdapter, no DOM refs after the
// onServerRestart callback was extracted) so it imports + runs here unchanged.
import { Connection } from './connection.js';
import type { CombatEventInfo, FeatureSpawnInfo,
    SoundEventInfo, SoundRefInfo, ResourceUpdateInfo, UnitCmdDescsInfo } from './connection.js';
import { AudioChannel } from './audio.js';
import type { EntityStateSnapshot } from './entity-state.js';
// GW4-c3: terrain + lighting + map parse move into the worker so terrain
// renders from here (first light). All of these are worker-safe (Babylon
// DynamicTexture allocates an OffscreenCanvas in a worker; the dev-hook
// `window.__*` injections in scene-lighting/client-settings were switched to
// `globalThis` for this move — PLAN-game-worker.md GW4 Bucket-2).
import {
    buildTerrainMesh, loadTerrainTextures, TerrainFog, DeformableTerrain,
    setTerrainDecalPluginEnabled, attachTerrainWaterAbsorption,
    type MapDimensions,
} from './terrain.js';
import { fetchMapDataHttp, type ParsedMapData } from './map-data.js';
import {
    loadMapLighting, defaultMapLighting, loadMapWaterAbsorption,
    type MapLighting,
} from './map-lighting.js';
import { createSceneLighting, applyMapLighting, type SceneLighting } from './scene-lighting.js';
import { LosBitmapStore, type LosBitmap } from './los-bitmap.js';
// GW4-c4: world entity rendering moves into the worker. Side-effect import
// registers Babylon's KTX2 loader + pins the transcoder URLs (previously only
// done in main.ts) so unit `.ktx2` textures transcode here.
import './ktx2-config.js';
import { EntityRenderer, setLightingStyle, setModelMaterialPort } from './entity-renderer.js';

/**
 * The model-material port id that `zk-model-material.ts` reproduces
 * (PLAN-bar.md A4). This client ships a hand-port of Zero-K's 939-line
 * GL3 `modelmaterials/Templates/defaultMaterialTemplate.lua`. A game opts
 * into that material by declaring `modelMaterialPort = 'zk-939'` in its
 * modinfo; any other (or absent) value falls to the engine-default material.
 * Bump the `-NNN` suffix if the hand-port is ever re-synced to a newer
 * template revision so stale game configs surface as a loud mismatch.
 */
// Client model-material ports the worker can satisfy. A game names one via
// modinfo `modelMaterialPort`; anything outside this set falls to the
// engine-default material (with a loud warn). Data-driven — no gameId
// branches. See setModelMaterialPort in entity-renderer.ts.
//   'zk-939'  — hand-port of Zero-K's 939-line GL3 CUS template.
//   'cus-pbr' — Recoil cus_gl4 metallic look (env-reflection approx +
//               boosted spec) on the engine-default material; BAR and any
//               cus_gl4-based mod declare this.
const CLIENT_MATERIAL_PORTS = new Set(['zk-939', 'cus-pbr']);
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
import { CONFIG } from '../config.js';
import { resetNetStats, snapshotNetStats } from './net-inspector.js';
import { FrameProfiler } from './frame-profiler.js';
import { EntityFxFence } from './entity-fx-fence.js';
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
import { OrbitRig, type OrbitTarget } from './orbit-rig.js';
import { SunRig } from './sun-rig.js';
import { ClipPlayer } from './clip-player.js';
import { WorkerSelection } from './worker-selection.js';
import { WorkerBuildPlacement, UNITDEF_FLAG_IS_FACTORY } from './worker-build-placement.js';
import { WorkerCommandModes } from './worker-command-modes.js';
import { CMD, OPT } from './command-buffer.js';
import { groupFactoryQueueRuns } from './factory-queue.js';
import { findMetalSpots, type MetalSpot } from './metal-spots.js';
import { resolveSoundRef, pickUnitDefSound,
    type ResolvedSoundEvent } from './sound-events.js';
import { CommandPathRenderer } from './command-path-renderer.js';
import { WaypointMarkerRenderer } from './waypoint-marker-renderer.js';
import { StandingOrderRenderer } from './standing-order-renderer.js';
import { getEngineGl } from './engine-gl.js';
import {
    applyPlayerTeamRosterEffect,
    seedPlayersFromRoster,
    reconcilePlayerAllyTeams,
    PlayerTeamEventKind,
    type ProjectileEntry,
} from './lua-spring-api.js';
// WP2b: shared mutable seam refs (connection, selection, renderers, lighting).
import { gpCtx } from './gp-context.js';
// PLAN-rml.md: worker-side RmlUi bridge — flush the frame's DOM ops to main
// (frame-loop tail) and reset on teardown. Event/resize routing lives in the
// worker dispatcher (lua-widget-worker.ts), calling the bridge directly.
import { rmlFlush, rmlReset } from '../ui/rml/rml-bridge.js';
// WP2b: LuaUI half exports — getRuntime() host + all widget callins + liveState + defs.
import {
    liveState, unitDefMap, weaponDefMap,
    postToMain, postLog, republishDefGlobals,
    init, runFrame, getRuntime, getBridge, setLuaUiActiveFalse,
    applyEntityStateToLiveState, removeUnitFromLiveState,
    dispatchSelectionChanged, dispatchCommandsChanged,
    dispatchUnitCreated, dispatchUnitFromFactory, dispatchUnitTaken, dispatchUnitGiven,
    dispatchDefaultCommand, dispatchCommandNotify,
    dispatchPlayerChanged, dispatchPlayerAdded, dispatchPlayerRemoved, dispatchTeamDied,
    dispatchRecvLuaUIMsg, dispatchUnitDestroyed, dispatchUnitFinished,
    dispatchUnitDamaged, dispatchFeatureLifecycle,
    dispatchVisibleUnitAdded, dispatchVisibleUnitRemoved,
    dispatchUnitCommand, dispatchUnitCmdDone,
    getWidgetList, toggleWidget, enableWidget, disableWidget, shutdown,
    setMusicStreamTime, seedStorageCache, setWorkerSetActiveCommandHandler,
    sameIdSet, escapeLuaStr, escapeLuaString, loadFromStorage, saveToStorage,
    luaBytesLiteral, paramsTableLiteral,
    describeMessage, describeInboundMessage,
    pauseFramesHost, resumeFramesHost,
    type MapDataTransfer, type MinimalUnitDefWire, type MinimalWeaponDefWire,
} from './lua-ui-host.js';
import {
    widgetProfileStart, widgetProfileStop, widgetProfileDump,
    buildUiProfileReport, type UiTaxAccumulator,
} from './widget-profiler.js';

// ── GP module-level state ───────────────────────────────────────────────────

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
/// PLAN-playable.md G3a: worker-side build placement (ghost + snap + order).
/// Built in gpInit alongside WorkerSelection; armed by the native BuildMenu via
/// gp:startBuildPlacement. Pointer handlers route left-clicks here before
/// selection when it is active.
let gpBuildPlacement: WorkerBuildPlacement | null = null;
/// PLAN-playable.md G3b: worker-side modal commands (arm-then-click), area-attack
/// radius drag, waypoint reposition/revoke drag, and order hotkeys. Armed via the
/// order menu (Spring.SetActiveCommand) or a hotkey; drives the main-thread cursor
/// via gp:cursorMode. Pointer handlers route left-clicks here after build
/// placement, before selection.
let gpCommandModes: WorkerCommandModes | null = null;
/// G3a: per-unit command descriptions (UnitCmdDescsUpdate, ~1 Hz, selection-
/// scoped). Cached so the buildable-tile set can be recomputed on selection
/// change without waiting for the next broadcast. Also mirrored into
/// liveState.unitCmdDescs (the LuaUI consumer this connection event fed pre-GW4).
const gpUnitCmdDescs = new Map<number, UnitCmdDescsInfo>();
/// G3a: metal-spot centroids (in world elmos), computed once from the parsed
/// map data in gpLoadMap and consumed by the mex build-ghost snap.
let gpMetalSpots: MetalSpot[] = [];
/// World elmos per metalmap cell (scales the mex snap search radius). Spring's
/// metalmap is half the heightmap resolution → 2 × squareSize.
let gpMetalCellSize = 16;
/// G3a: resolved build-menu tiles for the current selection, posted to main's
/// native BuildMenu via gp:sceneState.buildOptions. Dirty-gated so the tile
/// array only ships when the buildable set actually changed.
let gpBuildTiles: BuildMenuTile[] = [];
let gpBuildTilesDirty = false;
/// G4: resolved production-queue rows for the selected factory, posted to
/// main's native FactoryQueuePanel via gp:sceneState.factoryQueue. Dirty-gated
/// like gpBuildTiles.
let gpFactoryQueueTiles: FactoryQueueTile[] = [];
let gpFactoryQueueDirty = false;
/// G4: latest ResourceUpdate for the local team, posted to main's native
/// EconomyBar via gp:sceneState.economy. Dirty-gated like gpBuildTiles so a
/// snapshot only ships when a fresh ResourceUpdate for our own team arrived.
let gpLastEconomy: ResourceUpdateInfo | null = null;
let gpEconomyDirty = false;
/// Latest command-queue snapshot (UnitCommandQueuesUpdate, ~1 Hz), cached so a
/// selection change can re-render the path/waypoint overlays immediately rather
/// than waiting for the next broadcast.
let gpLastCommandQueues: import('./connection.js').UnitCommandQueueInfo[] = [];
/// Shift-held state (drives the command-path / waypoint overlay gate). Tracked
/// from the forwarded key/pointer `mods` bitmask (bit 0 = shift); cleared on blur.
let gpShiftHeld = false;
/// GW4-c5c: latest sim status (from onGameInfo) for the sceneState feed → main's
/// HUD (entity count / frame / selection / speed-pause indicator). Stale note
/// removed 2026-07-09 (G4): the native build-menu (G3a) and EconomyBar (G4) are
/// both reconnected main-thread consumers now, not chili widgets — only the
/// order-panel remains unbuilt (see PLAN-playable.md G4 factory-queue note).
let gpGameFrame = 0;
let gpPaused = false;
let gpSimSpeed = 1;
/// GW8 (test harness): client-side render-loop freeze, distinct from `gpPaused`
/// (which mirrors the *server* sim-pause from onGameInfo). `window.test.pause()`
/// sets this so a screenshot captures a deterministic frame while the sim may
/// still tick server-side. preserveDrawingBuffer keeps the last frame visible.
let gpRenderPaused = false;
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
/// PLAN-playable.md G4: metal-spot markers for the minimap overlay, captured
/// in gpLoadMap from the same gpMetalSpots the mex build-ghost snap uses.
/// Static per-map data — one-shot delivery like gpMinimapMapInfo, not resent
/// every feed (`gpMinimapMetalSpotsInfo = null` ⇒ already delivered).
let gpMinimapMetalSpotsInfo: GpMinimapMetalSpots | null = null;
let gpBuildingPlateRenderer: BuildingPlateRenderer | null = null;
let gpDefCache: DefCache | null = null;
/// GW4-c6-1b: resolves once the game's defs are ingested into the def cache (or
/// immediately if the game ships none). gpBootLuaUI awaits this before running
/// init(), so the Lua UnitDefs/UnitDefNames tables are already populated when
/// ZK's config files (unitDefReplacements, dynamic_comm_defs, …) index
/// UnitDefNames.<x> at include-time — otherwise they hit nil and the dependent
/// widgets/gadgets boot degraded.
let gpDefsReadyResolve: (() => void) | null = null;
const gpDefsReady: Promise<void> = new Promise((resolve) => { gpDefsReadyResolve = resolve; });
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
let gpDistortion: DistortionRenderer | null = null;
let gpMuzzleFlare: MuzzleFlareRenderer | null = null;
/// PLAN.md Stage B1: latches true on the first frame ZK's authored deferred
/// lights produce anything, so the projectile renderer's invented muzzle/follow
/// stand-ins suppress (see _SpringWebEmitDeferredLights).
let gpAuthoredLightsActive = false;

/// Parse one of the flattened deferred-light strings emitted by the Lua
/// collector. Records are ';'-separated, fields ','-separated; a record is
/// kept only if it has at least `stride` finite numbers. Point stride 7
/// (px,py,pz,r,g,b,radius); beam stride 10 (+dx,dy,dz).
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
let gpCegRuntime: CegRuntime | null = null;
let gpBuildBeamRenderer: BuildBeamRenderer | null = null;
let gpCombatFX: CombatFX | null = null;
let gpDecalOverlay: DecalOverlay | null = null;
let gpDynamicFeatureRenderer: DynamicFeatureRenderer | null = null;
/// Sim-scaled delta multiplier for VISUAL FX aging — slows / freezes effect
/// lifetimes with the game speed (paused → 0). Driven by onGameInfo. The
/// camera + entity ticks keep raw wall dt; only FX lifetimes use it.
let gpFxSimSpeed = 1;
/// PLAN-model-harness: dev/test orbit camera rig (window.test.orbit). While
/// non-null it owns the view-0 Babylon camera — the RTSCamera's tick + input
/// are suppressed for that view and its pre-orbit pose is restored on exit.
let gpOrbitRig: OrbitRig | null = null;
let gpOrbitSavedView: { pos: Vector3; lookAt: Vector3 } | null = null;
/// PLAN-model-harness: dev/test sun override (window.test.sun / sunCycle).
/// Ticked from the render loop; re-applies each frame while active so game
/// Lua lighting re-applies can't clobber the test state.
let gpSunRig: SunRig | null = null;
/// PLAN-model-harness task 6: dev/test clip player (window.test.playClip).
/// Samples one authored .glb clip per frame into EntityRenderer's per-piece
/// clip-pose override; auto-stops when the target unit disappears.
let gpClipPlayer: ClipPlayer | null = null;
/// Long-frame profiler: the render loop stamps per-phase timings every frame
/// into a permanent accumulator (`gpFrameProfiler`), which both (a) computes
/// mean/p50/p95/p99 per phase over a rolling 30 s window on demand
/// (`window.test.perfDump()` / `window.__gp('__frameProfiler.dump()')`, the
/// PLAN-perf P0 attribution matrix) and (b) logs a breakdown for any frame
/// exceeding GP_LONG_FRAME_MS so worker stalls (model/atlas loads, GC, a
/// runaway subsystem tick) are attributable instead of guessed. Cheap enough
/// to leave on: the hot path is a few typed-array writes with no allocation.
const gpFrameProfile = true;
const GP_LONG_FRAME_MS = 150;
/// Permanent per-phase frame-time accumulator (PLAN-perf P0). 30 s default
/// window. Exposed on globalThis (see gpInit) as `__frameProfiler`.
const gpFrameProfiler = new FrameProfiler(30000);
/// Allocation-free phase mark (module-level so the render loop doesn't build a
/// closure per frame). `idx` follows FRAME_PHASES: 0 camera, 1 entity, 2 fx,
/// 3 decals+lights, 4 render, 5 ui.
function gpMark(idx: number): void {
    if (gpFrameProfile) gpFrameProfiler.mark(idx, performance.now());
}
/// PLAN-fx-offload X5 — the Fengari fence for legacy per-frame entity FX
/// scripts (entity-fx-fence.ts). One instance, ticked every frame like
/// gpFrameProfiler above; nothing calls `.run()` yet (no game currently
/// ships per-frame entity `onUpdate` content through a dispatch this
/// engine drives — see PLAN-fx-offload field notes), so `dump()` reports
/// zero defs today. This is the wiring point for whichever module ends up
/// running legacy per-def callbacks (task 3, the JS animation system, is
/// next in line) — exposed via getEntityFxFence() and the
/// entityFxFenceDump/-Reset test-dispatch verbs below.
const gpEntityFxFence = new EntityFxFence();
export function getEntityFxFence(): EntityFxFence {
    return gpEntityFxFence;
}
/// PLAN-perf P0 isolation toggle (hazard #5): when false the LuaUI screen pass
/// is skipped, isolating its render-thread tax (12 gl.getParameter round-trips
/// + Fengari runFrame + wipeCaches). Live proxy for a widget-less boot.
let gpUiPassEnabled = true;
/// PLAN-perf N1: always-on fixed-tax split of gpRunUiPass — total ms per
/// slice (GL-state save / Fengari runFrame / restore / wipeCaches / rmlFlush)
/// since the last reset. Costs 6 performance.now() calls per frame. Dump via
/// window.test.uiProfileDump() (merged with the Lua-side per-widget profile
/// when window.test.uiProfileStart() has installed it — widget-profiler.ts).
const gpUiTax: UiTaxAccumulator = { frames: 0, save: 0, lua: 0, restore: 0, wipe: 0, rml: 0 };
function gpUiTaxReset(): void {
    gpUiTax.frames = 0; gpUiTax.save = 0; gpUiTax.lua = 0;
    gpUiTax.restore = 0; gpUiTax.wipe = 0; gpUiTax.rml = 0;
}
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

let gpLastMouseSpringX = 0;
let gpLastMouseSpringY = 0;

// ── GP functions ────────────────────────────────────────────────────────────

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
    if (!gpScene || !gpEngine || !gpCamera || !gpCtx.sceneLighting) return;
    if (gpMapData) { postLog(2, '[gp] gpLoadMap: map already built — ignoring'); return; }
    const scene = gpScene;
    const sceneLighting = gpCtx.sceneLighting;

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

    // PLAN-playable.md G3a: pre-compute metal-spot centroids for the build-ghost
    // mex snap. Spring's metalmap is half the heightmap resolution: each cell
    // covers 2 heightmap squares = 2 × squareSize elmos. Ports input-manager
    // setMapData() verbatim.
    gpMetalCellSize = (map.squareSize ?? 8) * 2;
    gpMetalSpots = findMetalSpots(
        map.metalmap, (map.mapx / 2) | 0, (map.mapy / 2) | 0, gpMetalCellSize);
    postLog(1, `[gp] ${gpMetalSpots.length} metal spots discovered`);

    // PLAN-playable.md G4: same centroids, packed struct-of-arrays for the
    // minimap's one-shot metal-spot feed (see gpPostMinimapFeed).
    {
        const n = gpMetalSpots.length;
        const x = new Float32Array(n);
        const z = new Float32Array(n);
        const metal = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            x[i] = gpMetalSpots[i].x;
            z[i] = gpMetalSpots[i].z;
            metal[i] = gpMetalSpots[i].totalMetal;
        }
        gpMinimapMetalSpotsInfo = { count: n, x, z, metal };
    }

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
        if (gpCtx.sceneLighting === sceneLighting) {
            applyMapLighting(lighting, sceneLighting);
            gpCtx.mapLighting = lighting;
        }
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
    gpCtx.entityRenderer?.setMapHeightmap(
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
    renderMapFeatures(scene, map, gpCtx.sceneLighting!.csm).catch((err) =>
        postLog(2, `[gp] renderMapFeatures failed: ${err}`));

    // Water plane at Y=0 (maps with voidWater=true ship their own fluid widget).
    // FIDELITY-STANDIN: a flat alpha-blended plane instead of Recoil's BumpWater
    // (reflection/refraction/waves). The tint follows BumpWater's SurfaceColor
    // define exactly — surfaceColor * 0.4 at surfaceAlpha (BumpWater.cpp:429).
    // water.baseColor is NOT the surface colour: it (with absorb/minColor) is
    // the underwater TERRAIN shade, applied by WaterAbsorptionPlugin below.
    // Using it here painted pools_of_ilys's pink absorb base across the whole
    // surface at an invented 0.4 alpha floor — the G1a solid-magenta pools.
    if (!map.water.voidWater) {
        const water = MeshBuilder.CreateGround('water', {
            width: map.widthElmos, height: map.heightElmos,
        }, scene);
        water.position.set(map.widthElmos / 2, 0, map.heightElmos / 2);
        water.isPickable = false;
        water.renderingGroupId = 1;
        const wmat = new StandardMaterial('waterMat', scene);
        const [r, g, b] = map.water.surfaceColor;
        wmat.diffuseColor = new Color3(r * 0.4, g * 0.4, b * 0.4);
        wmat.emissiveColor = new Color3(r * 0.12, g * 0.12, b * 0.12);
        wmat.specularColor = new Color3(0.2, 0.2, 0.2);
        wmat.alpha = map.water.surfaceAlpha;
        wmat.backFaceCulling = false;
        water.material = wmat;
        water.receiveShadows = false;
        sceneLighting.csm.removeShadowCaster(water, false);
        postLog(1, '[gp] water plane: flat surfaceColor stand-in (no BumpWater reflection/refraction)');
    }

    // Underwater terrain absorption (Recoil SMF_WATER_ABSORPTION): depth-graded
    // pool-floor tint from mapinfo water.absorb/baseColor/minColor. Gated on
    // Recoil's HasVisibleWater() condition; colours parsed client-side from
    // mapinfo.lua (absorb is not in metadata.json — render-only data stays off
    // the server per feedback_lighting_client_only). Fire-and-forget like the
    // lighting parse; attach survives the later atlas material swaps via
    // terrain.ts's reattach path.
    if (map.minHeight < 0 && !map.water.voidWater) {
        void loadMapWaterAbsorption(mapSourceAbs).then((colors) => {
            if (gpTerrainMesh === terrainMesh && gpScene) {
                attachTerrainWaterAbsorption(terrainMesh, colors);
            }
        });
    }

    // GW4-c6: boot the LuaUI getRuntime() now that the map (source URL + heightmap)
    // is available. It runs on this same Babylon GL context; the gp render loop
    // drives its screen-space pass after scene.render(). Fire-and-forget — the
    // bootstrap (VFS prefetch + camain.lua + gadget halves) is async and the
    // world keeps rendering while it loads.
    void gpBootLuaUI(map, mapSourceAbs, msg);
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
        gpCtx.connection?.sendViewportUpdate(
            0, t ? t.x : centerX, t ? t.z : centerZ, 16384, 16384, 0, 1);
    };
    send();
    if (gpViewportTimer) clearInterval(gpViewportTimer);
    gpViewportTimer = setInterval(send, 1000);
    postLog(1, `[gp] viewport registered (camera-tracked, default center ${centerX.toFixed(0)},${centerZ.toFixed(0)}) — entity stream should follow`);
}

// GW4-c6-1b: input → LuaUI widget callins. The gp input messages carry
// canvas-relative CSS px (top-left origin) + DOM button numbering + a packed
// mods bitfield (1=shift,2=ctrl,4=alt,8=meta) + KeyboardEvent.code. Spring's
// widget callins expect device px with a bottom-left origin, Spring button
// numbering (left=1/middle=2/right=3) and SDL keysyms — translate here.

/** DOM mouse button (0/1/2) → Spring button (1/2/3). */
function domButtonToSpring(b: number): number {
    return b === 0 ? 1 : b === 1 ? 2 : b === 2 ? 3 : b + 1;
}

/** KeyboardEvent.code → Spring/SDL keysym. Named keys are mapped; letters,
 *  digits and numpad digits fall back to the ASCII code of the character they
 *  produce (matching the lua-widget-manager springKeyCode table on main, which
 *  worked off `.key` — here we derive the same numbers from `.code`). */
function codeToSpringKeysym(code: string): number {
    const m: Record<string, number> = {
        Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, Escape: 27, Space: 32,
        Delete: 127, ArrowLeft: 276, ArrowRight: 275, ArrowUp: 273, ArrowDown: 274,
        Home: 278, End: 279, PageUp: 280, PageDown: 281, Insert: 277,
        F1: 282, F2: 283, F3: 284, F4: 285, F5: 286, F6: 287,
        F7: 288, F8: 289, F9: 290, F10: 291, F11: 292, F12: 293,
        ShiftLeft: 304, ShiftRight: 303, ControlLeft: 306, ControlRight: 305,
        AltLeft: 308, AltRight: 307, MetaLeft: 310, MetaRight: 309,
    };
    if (code in m) return m[code];
    if (code.length === 4 && code.startsWith('Key')) return code.charCodeAt(3) + 32; // 'KeyA'→'a'
    if (code.length === 6 && code.startsWith('Digit')) return code.charCodeAt(5);     // 'Digit5'→'5'
    if (code.length === 7 && code.startsWith('Numpad')) return code.charCodeAt(6);    // 'Numpad5'→'5'
    return 0;
}

/** CSS px (top-left) → Spring device px (bottom-left). The OffscreenCanvas
 *  backing store is CSS × dpr, and liveState.viewport is in device px. */
function gpToSpringCoords(x: number, y: number): { x: number; y: number } {
    const dx = x * gpDpr;
    const dy = y * gpDpr;
    return { x: Math.round(dx), y: Math.round(liveState.viewport.height - dy) };
}

/** widgetHandler:MousePress — returns true if a widget consumed the press (→
 *  the world selection/order is suppressed, Spring's mouse-capture semantics). */
function gpDispatchMousePress(sx: number, sy: number, btn: number): boolean {
    if (!getRuntime()) return false;
    const consumed = getRuntime()!.evalString(`
        if widgetHandler and widgetHandler.MousePress then
            local ok, ret = pcall(widgetHandler.MousePress, widgetHandler, ${sx}, ${sy}, ${btn})
            return ok and ret and "1" or "0"
        end
        return "0"`);
    return consumed === '1';
}
function gpDispatchMouseRelease(sx: number, sy: number, btn: number): void {
    if (!getRuntime()) return;
    getRuntime()!.doString(`
        if widgetHandler and widgetHandler.MouseRelease then
            pcall(widgetHandler.MouseRelease, widgetHandler, ${sx}, ${sy}, ${btn})
        end`, 'callin:MouseRelease');
}
function gpDispatchMouseMove(sx: number, sy: number, dx: number, dy: number, btn: number): void {
    if (!getRuntime()) return;
    getRuntime()!.doString(`
        if widgetHandler and widgetHandler.MouseMove then
            pcall(widgetHandler.MouseMove, widgetHandler, ${sx}, ${sy}, ${dx}, ${dy}, ${btn})
        end`, 'callin:MouseMove');
}
function gpDispatchMouseWheel(up: boolean, value: number): void {
    if (!getRuntime()) return;
    getRuntime()!.doString(`
        if widgetHandler and widgetHandler.MouseWheel then
            pcall(widgetHandler.MouseWheel, widgetHandler, ${up ? 'true' : 'false'}, ${value})
        end`, 'callin:MouseWheel');
}
function gpDispatchKeyPress(keysym: number, mods: number): void {
    if (!getRuntime() || keysym === 0) return;
    const alt = (mods & 4) !== 0, ctrl = (mods & 2) !== 0;
    const meta = (mods & 8) !== 0, shift = (mods & 1) !== 0;
    getRuntime()!.doString(`
        if widgetHandler and widgetHandler.KeyPress then
            pcall(widgetHandler.KeyPress, widgetHandler, ${keysym}, { alt=${alt}, ctrl=${ctrl}, meta=${meta}, shift=${shift} }, false)
        end`, 'callin:KeyPress');
}
function gpDispatchKeyRelease(keysym: number, mods: number): void {
    if (!getRuntime() || keysym === 0) return;
    const alt = (mods & 4) !== 0, ctrl = (mods & 2) !== 0;
    const meta = (mods & 8) !== 0, shift = (mods & 1) !== 0;
    getRuntime()!.doString(`
        if widgetHandler and widgetHandler.KeyRelease then
            pcall(widgetHandler.KeyRelease, widgetHandler, ${keysym}, { alt=${alt}, ctrl=${ctrl}, meta=${meta}, shift=${shift} })
        end`, 'callin:KeyRelease');
}

/// GW4-c2: stand up the in-worker connection. Discovers `/api/wt/info` from
/// `gameHttpUrl`, opens the WebTransport session, and auths with the init
/// creds (token reconnect against the shared lobby SQLite). At c2 the
/// callbacks are deliberately thin — the exit gate is "worker logs
/// entityState count=N with no main-thread network code" (PLAN-game-worker.md
/// GW4-c2). The full callback object (porting main.ts@32cf513619 L1070–1326)
/// fills in as the renderers + LuaUI getRuntime() come online in c3–c6.
function gpConnect(msg: GpInitToWorker): void {
    // GW8: reset the per-envelope bandwidth tally for the new game session. The
    // tally lives in THIS (worker) bundle's net-inspector instance, fed by the
    // worker connection's routeIncoming/sendOnControl; surfaced to main via the
    // gp:test 'netStats' pull (PLAN-performance PC-2).
    resetNetStats();
    const conn = new Connection({
        onStateChange: (state) => postLog(1, `[gp] connection state: ${state}`),
        onAuthenticated: (playerId, _token, team, defsCacheKey) => {
            postLog(1, `[gp] authenticated playerId=${playerId} team=${team} defsKey=${defsCacheKey || '(none)'}`);
            postToMain({ type: 'gp:authenticated', playerId, team });
            // GW4-c6-1b: seed LuaUI identity so Spring.GetMyTeamID /
            // GetLocalPlayerID / GetMyAllyTeamID resolve. AuthResponse carries
            // no allyTeam, so default myAllyTeam to the team until the team
            // table is wired (correct for single-team / AI cases; proper ally
            // resolution from the team table is a later seam).
            liveState.identity = { myTeam: team, myAllyTeam: team, myPlayerId: playerId };
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
                    .catch((e) => postLog(4, `[gp] defs fetch failed: ${e}`))
                    // GW4-c6-1b: unblock the LuaUI boot once defs are in (or on
                    // failure — boot anyway rather than hang the UI forever).
                    .finally(() => gpDefsReadyResolve?.());
            } else {
                // No defs to fetch — don't make the LuaUI boot wait.
                gpDefsReadyResolve?.();
            }
            // Register a viewport so the server starts streaming entity state.
            void gpRegisterViewport(msg.lobbyUrl, msg.mapId);
        },
        onAuthFailed: (m) => postLog(4, `[gp] auth failed: ${m}`),
        onServerError: (code, m) => postLog(4, `[gp] server error ${code}: ${m}`),
        onEntityState: (snapshot, isDelta) => {
            gpCtx.entityRenderer?.update(snapshot, isDelta);
            gpBuildingPlateRenderer?.update(snapshot);
            // GW4-c6-1b: also merge into liveState.units + synth the
            // UnitCreated/UnitFinished callins so LuaUI widgets see the world.
            applyEntityStateToLiveState(snapshot, isDelta);
        },
        // GW4-c4: streamed piece transforms (envelope 0x05) → per-piece thin
        // instance matrices on the unit's model.
        onPieceState: (snapshot) => gpCtx.entityRenderer?.applyPieceState(snapshot),
        // GW4-c4/c5: a unit/feature left view or died → drop its meshes + plate
        // and (c5) fire a combatFX death burst at its last position. (LuaUI
        // forward to widgets wires up in c6.)
        onEntityDestroy: (entityId, x, y, z) => {
            gpCtx.entityRenderer?.removeEntity(entityId);
            gpBuildingPlateRenderer?.remove(entityId);
            gpCombatFX?.onCombatEvents([{
                attackerId: 0, targetId: entityId, weaponDefId: 0,
                result: 3, damage: 500, x, y, z,
            }]);
            // GW4-c6-1b: LuaUI UnitDestroyed + liveState cleanup.
            removeUnitFromLiveState(entityId);
        },
        // GW4-c5: getRuntime() feature spawns (wrecks/debris/reclaim) → dynamic
        // feature renderer. Map-placed features load via renderMapFeatures.
        onFeatureLifecycle: (spawns, removed) => {
            gpDynamicFeatureRenderer?.applyLifecycleBatch(spawns, removed);
            // Fan out widget:FeatureCreated/FeatureDestroyed (BAR reclaim/blast
            // widgets react to wrecks + debris). No-op for ZK (no handler).
            dispatchFeatureLifecycle(spawns, removed);
        },
        // GW4-c5: weapon-fire / impact / trajectory events (envelopes inside
        // GameEventBatch) drive the projectile renderer + combatFX. The legacy
        // 0x04 per-tick projectile-state envelope is gone — the renderer
        // integrates motion locally off these events.
        onProjectileFired: (events) => {
            if (!gpCtx.projectileRenderer) return;
            for (const e of events) gpCtx.projectileRenderer.onFired(e);
        },
        onProjectileImpacts: (events) => {
            for (const e of events) gpCtx.projectileRenderer?.onImpact(e);
            gpCombatFX?.onProjectileImpacts(events);
        },
        onProjectileTrajectories: (events) => {
            if (!gpCtx.projectileRenderer) return;
            for (const e of events) gpCtx.projectileRenderer.onTrajectory(e);
        },
        // GW4-c5: combat hit/kill events → combatFX (impact CEGs + lights).
        // Also fan out widget:UnitDamaged so intel/health/FX widgets in ZK
        // and BAR react to damage (faithful weapon-combat subset; see
        // dispatchUnitDamaged for the documented wire gaps).
        onCombatEvents: (events) => {
            gpCombatFX?.onCombatEvents(events);
            dispatchUnitDamaged(events);
        },
        // GW4-c5b-3: per-unit command queues (~1 Hz) → command-path + waypoint
        // overlays for the current selection (shift-gated). Cached so a
        // selection change re-renders without waiting for the next broadcast.
        // (Widget forward + the build-pending-ghost reaper land in c5c/c6.)
        onUnitCommandQueues: (queues) => {
            gpLastCommandQueues = queues;
            const sel = gpCtx.selection?.selection ?? [];
            gpCommandPathRenderer?.update(queues, sel);
            gpWaypointMarkerRenderer?.update(queues, sel);
            // PLAN-playable.md G4: the selected factory's queue may have
            // changed (unit completed, order added/removed) — re-resolve.
            gpRecomputeFactoryQueue();
            // PLAN-playable.md G3b: reap pending build-ghosts whose order has
            // left the queue (construction started / cancelled).
            gpBuildPlacement?.onCommandQueuesUpdated(queues);
        },
        // PLAN-playable.md G3a: selection-scoped command descriptions (~1 Hz).
        // GW4-regression fix (U3/onResourceUpdate-class): pre-GW4 the main-thread
        // lua-widget-manager fed liveState.unitCmdDescs + the native build menu
        // via a worker `unitCmdDescs` message; post-GW4 the connection moved INTO
        // this worker and LuaWidgetManager isn't instantiated, so this connection
        // event had NO consumer — the native build menu never populated and
        // LuaUI's Spring.Get*CmdDesc* read empty. Restore both consumers: (1)
        // cache for the native BuildMenu tile recompute; (2) mirror into
        // liveState.unitCmdDescs (+ dispatchCommandsChanged) for LuaUI, exactly
        // as the dead legacy `unitCmdDescs` handler in lua-widget-worker.ts did.
        onUnitCmdDescs: (units) => {
            gpUnitCmdDescs.clear();
            liveState.unitCmdDescs.clear();
            for (const u of units) {
                gpUnitCmdDescs.set(u.unitId, u);
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
            dispatchCommandsChanged();
            gpRecomputeBuildTiles();
        },
        // GW4-c5b-3: standing orders (always-on overlay; server scopes the
        // broadcast to own + allied teams).
        onStandingOrders: (orders) => gpStandingOrderRenderer?.update(orders),
        // GW4-c5c-2: audio getBridge(). The connection decodes SoundEvents here, but
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
        // Team economy (envelope 0x01 ResourceUpdate, server sends every 10
        // ticks to each session with team >= 0). Populates liveState.resources
        // so Spring.GetTeamResources returns live metal/energy/income/etc.
        // GW4-regression fix (U1-class): pre-GW4 the main-thread
        // lua-widget-manager.forwardResourceUpdate fed liveState.resources via a
        // worker message; post-GW4 the connection moved INTO this worker and
        // LuaWidgetManager isn't instantiated, so onResourceUpdate had no
        // consumer and GetTeamResources returned 0 on every client (top-bar
        // resource bars, economy panels, income-gated widgets all read empty).
        // ResourceUpdateInfo carries the same 18 numeric fields as ResourceEntry
        // (+ team) — a straight copy, mirroring the old lua-widget-worker path.
        onResourceUpdate: (info: ResourceUpdateInfo) => {
            liveState.resources.set(info.team, {
                metal: info.metal, maxMetal: info.maxMetal,
                energy: info.energy, maxEnergy: info.maxEnergy,
                metalIncome: info.metalIncome, energyIncome: info.energyIncome,
                metalPull: info.metalPull, energyPull: info.energyPull,
                metalExpense: info.metalExpense, energyExpense: info.energyExpense,
                metalShare: info.metalShare, energyShare: info.energyShare,
                metalSent: info.metalSent, energySent: info.energySent,
                metalReceived: info.metalReceived, energyReceived: info.energyReceived,
                metalExcess: info.metalExcess, energyExcess: info.energyExcess,
            });
            // G4: same GW4-regression class as above, but for the *native*
            // EconomyBar on main (a DOM panel, not a LuaUI widget) — nothing
            // ever forwarded ResourceUpdate across the worker→main boundary,
            // so the fully-built EconomyBar component was never fed. Only
            // the local team's updates are worth the postMessage; other
            // teams' economies aren't shown (see economy-bar.ts).
            if (info.team === gpCtx.connection?.myTeam) {
                gpLastEconomy = info;
                gpEconomyDirty = true;
            }
        },
        // PLAN-latency L0: drive the presentation cursor at the true sim speed
        // (paused → 0 freezes P). GW4-c5: also drive the FX aging multiplier +
        // the projectile integrator's sim-speed so bolts / particles / lights
        // slow + freeze with the game. Frame/wind forwarding to LuaUI lands in c6.
        onGameInfo: (frame, speed, paused, _wind, _legacyCoordSystem, maxUnits) => {
            const eff = paused ? 0 : speed;
            gpPresentationClock?.setSpeedFactor(eff);
            gpFxSimSpeed = eff;
            gpCtx.projectileRenderer?.setSimSpeed(eff);
            // GW4-c5c: cache for the sceneState feed (HUD frame / speed / pause).
            gpGameFrame = frame;
            gpSimSpeed = speed;
            gpPaused = paused;
            // GW4-c6-1b: advance the LuaUI clock so Spring.GetGameFrame()
            // ticks → widgetHandler:GameFrame + gadget GameFrame fan-out
            // (gpRunUiPass → runFrame reads Spring.GetGameFrame()).
            liveState.gameFrame = frame;
            liveState.gameSpeed = speed;
            liveState.gamePaused = paused;
            // The engine's unit/feature ID-space boundary (unitHandler.MaxUnits()),
            // immutable for the game. Sent reliably on auth so it's present
            // before the Game table is built. Guard > 0 so a stray not-yet-known
            // 0 can't clobber a good value. Feeds Game.maxUnits. See PLAN-bar.md.
            if (maxUnits && maxUnits > 0) liveState.maxUnits = maxUnits;
        },
        // PLAN-bar.md §3b: team start positions + ally start boxes → liveState,
        // read by Spring.GetTeamStartPosition / GetAllyTeamStartBox. Replaced
        // wholesale on each arrival (auth + post-GameStart re-broadcast).
        onTeamStartInfo: (data) => {
            liveState.teamStartPositions.clear();
            for (const t of data.teams) {
                liveState.teamStartPositions.set(t.team, {
                    x: t.x, y: t.y, z: t.z, valid: t.valid, allyTeam: t.allyTeam,
                });
                // PLAN-bar.md UI-2 (gui_ecostats nil-aID crash + every other
                // team-aware HUD widget): the worker had NO team roster.
                // liveState.teams was only ever filled by the never-called
                // setRoster()/rosterUpdate path, so Spring.GetAllyTeamList()
                // returned {} and GetTeamInfo() returned nil. In gui_ecostats
                // that made setAllyData() build an allyData entry with a nil
                // .aID (empty GetTeamList → early-return before .aID is set),
                // which removeGuiShaderRects' pairs() then fed to isTeamReal(nil)
                // → "table index is nil" at :250. TeamStartInfo is the one stream
                // carrying every team's ally-team mapping, so seed liveState.teams
                // from it — faithful to Recoil, whose LuaUI always knows the full
                // team→allyTeam map. Upsert (don't clobber): leader/isDead/
                // isAiTeam/side may already be set by a PlayerTeamEvent.
                // KNOWN GAP (documented, not silent): leader / isAiTeam / side are
                // NOT on TeamStartPos, so they keep defaults until a richer roster
                // restream lands (PLAN-bar.md P1 — also covers team colours).
                const prevTeam = liveState.teams.get(t.team);
                liveState.teams.set(t.team, {
                    teamId: t.team,
                    leader: prevTeam?.leader ?? -1,
                    isDead: prevTeam?.isDead ?? false,
                    isAiTeam: prevTeam?.isAiTeam ?? false,
                    side: prevTeam?.side ?? '',
                    allyTeam: t.allyTeam,
                    // Recoil CTeam default; not on the TeamStartPos wire (same
                    // documented gap as leader/side above) — see PLAN-bar.md P1.
                    incomeMultiplier: prevTeam?.incomeMultiplier ?? 1,
                    customKeys: prevTeam?.customKeys ?? {},
                });
            }
            // PLAN-bar.md UI-2: now that the team→allyTeam map is known, correct
            // each seeded player's allyTeam (seedPlayersFromRoster could only
            // best-effort it at gp:init, before TeamStartInfo arrived).
            reconcilePlayerAllyTeams(liveState.players, liveState.teams);
            liveState.allyStartBoxes.clear();
            for (const b of data.boxes) {
                liveState.allyStartBoxes.set(b.allyTeam, {
                    xmin: b.xmin, zmin: b.zmin, xmax: b.xmax, zmax: b.zmax,
                });
            }
        },
        // PLAN-bar.md §5 (5c): the game's modoptions → liveState.modOptions, read
        // by the unsynced LuaUI Spring.GetModOptions(). Sent once on auth (they're
        // immutable per game server). Values stay strings — faithful to Recoil's
        // PushAllOptions (lua_pushsstring); widgets tonumber() numeric options.
        onGameModOptions: (options) => {
            liveState.modOptions = { ...options };
        },
        // PLAN-bar.md §6: player/team status changes (PlayerTeamEventBatch) →
        // the matching Recoil LuaUI callins. The server fires these into its
        // own synced Lua via eventHandler; this carries them to the unsynced
        // widgets. We update the roster state we can derive with certainty so a
        // widget re-reading Spring.GetPlayerInfo/GetTeamInfo after the callin
        // sees the change, then fan out.
        //
        // KNOWN GAP (documented, not silent): PlayerChanged carries only the
        // playerID (faithful to Recoil's callin signature), but the player's
        // *new* spectator/team values aren't streamed — liveState.players is
        // seeded once from the lobby roster. So after a spec/team change a
        // re-query still shows the old spec/team. Closing it needs a roster
        // re-stream (or per-field deltas) on the wire; tracked in PLAN-bar.md.
        // TeamDied (isDead) and PlayerRemoved (active=false) ARE applied.
        onPlayerTeamEvents: (events) => {
            for (const e of events) {
                // Update the roster fields we can derive with certainty
                // (active / isDead) so a post-callin re-query is consistent.
                applyPlayerTeamRosterEffect(liveState.players, liveState.teams, e);
                switch (e.kind) {
                    case PlayerTeamEventKind.PlayerChanged: dispatchPlayerChanged(e.id); break;
                    case PlayerTeamEventKind.PlayerAdded:   dispatchPlayerAdded(e.id); break;
                    case PlayerTeamEventKind.PlayerRemoved: dispatchPlayerRemoved(e.id, e.reason); break;
                    case PlayerTeamEventKind.TeamDied:      dispatchTeamDied(e.id); break;
                    default: postLog(2, `[player-team] unknown event kind ${e.kind}`);
                }
            }
        },
        // PLAN-bar Spring.GetTeamStatsHistory: per-second incremental team
        // stats-history deltas. Splice each team's entries into its history
        // array starting at baseIndex (the previously-live tail is re-sent once
        // finalised, then the new live tail appended), so the worker mirrors
        // the server's CTeam::statHistory.
        onTeamStatsHistory: (teams) => {
            for (const t of teams) {
                let hist = liveState.teamStatsHistory.get(t.teamId);
                if (!hist) { hist = []; liveState.teamStatsHistory.set(t.teamId, hist); }
                for (let i = 0; i < t.entries.length; i++) {
                    hist[t.baseIndex + i] = t.entries[i];
                }
                // Trim any stale tail beyond what the server now reports.
                hist.length = t.baseIndex + t.entries.length;
            }
        },
        // PLAN-bar.md §6: relayed Spring.SendLuaUIMsg (LuaUIMsgRelay). The
        // server already applied the audience filter, so dispatch
        // unconditionally to widget:RecvLuaMsg(msg, playerID). 107 BAR + 52 ZK
        // widgets register RecvLuaMsg.
        onLuaUIMsg: (data, playerId) => {
            // PLAN-gm-tools: a GM broadcast arrives as a LuaUIMsgRelay whose
            // payload begins with the sentinel bytes [0x01,'G','M',0x01]
            // (kGmBroadcastSentinel) and playerId -1. Intercept it BEFORE widget
            // dispatch — it never reaches a widget (can't crash one) and instead
            // surfaces a system toast on the main thread.
            if (data.length >= 4 && data[0] === 0x01 && data[1] === 0x47 &&
                data[2] === 0x4d && data[3] === 0x01) {
                const message = new TextDecoder().decode(data.subarray(4));
                postToMain({ type: 'gp:gmBroadcast', message });
                return;
            }
            dispatchRecvLuaUIMsg(data, playerId);
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
            const size = gpCtx.entityRenderer?.getMapSizeElmos();
            if (size) gpCtx.entityRenderer?.clearGhostsInLos(bitmap, size.width, size.height);
        },
        // NOTE: Connection.onMapData is unused here — map data is served over
        // HTTP, not the connection (server_main.cpp). gpLoadMap (called from
        // gpInit) fetches + builds the terrain; the viewport is registered from
        // onAuthenticated via gpRegisterViewport().
        onGameOver: (frame, winningAllyTeams) => {
            // G2: winners now arrive on the wire (GameInfo.winning_ally_teams).
            // Decide victory/defeat here where both the winners and the local
            // ally team (liveState.identity) are known; a spectator (myTeam < 0)
            // gets a neutral result rather than a false "Defeat".
            const myTeam = liveState.identity.myTeam;
            const myAllyTeam = liveState.identity.myAllyTeam;
            const won = winningAllyTeams.length === 0 || myTeam < 0
                ? null
                : winningAllyTeams.includes(myAllyTeam);
            postToMain({ type: 'gp:gameOver', frame, winningAllyTeams, won });
            // Drive widget:GameOver + gadget-half GameOver with the real winners
            // table — Recoil's signature is GameOver(winningAllyTeams). The IDs
            // are server-validated allyteam ints, safe to inline as a Lua list.
            { const rt = getRuntime(); if (rt) {
                const w = `{${winningAllyTeams.join(',')}}`;
                rt.doString(
                    `do local w = ${w} ` +
                    `if widgetHandler and widgetHandler.GameOver then ` +
                    `pcall(widgetHandler.GameOver, widgetHandler, w) end ` +
                    `if _SpringWebRunGadgetCallin then ` +
                    `pcall(_SpringWebRunGadgetCallin, 'GameOver', w) end end`,
                    'gameOver',
                );
            } }
        },
        onServerRestart: () => postToMain({ type: 'gp:reload' }),
    });
    gpCtx.connection = conn;
    conn.connect(msg.gameHttpUrl, msg.username, '', msg.token);
}

export function gpInit(msg: GpInitToWorker): void {
    if (gpEngine) {
        postLog(2, '[gp] gp:init received but engine already up — ignoring');
        return;
    }
    const canvas = msg.canvas;
    gpDpr = msg.dpr > 0 ? msg.dpr : 1;

    // GW6: adopt the main thread's resolved build stamp. CONFIG is a module-level
    // singleton; the render/def modules in this worker call stampUrl() (which
    // reads CONFIG.buildStamp) for every .glb/.ktx2/.lua asset fetch. Main runs
    // fetchBuildStamp() at startup, but the worker never did — so without this
    // its CONFIG.buildStamp stayed 'dev' and stampUrl() was a no-op, dropping the
    // ?v=<stamp> cache-bust the main thread applies. Seed it from gp:init so the
    // worker's asset URLs match main's (no stale-cache skew on a new deploy, and
    // a shared same-origin HTTP cache hit instead of two distinct URLs).
    if (msg.buildStamp) CONFIG.buildStamp = msg.buildStamp;

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
    // GW4-c6: LuaUI lays out against Spring.GetViewSizes() = liveState.viewport,
    // and the screen-space gl.Ortho maps [0,vsx]×[0,vsy] onto the device-pixel
    // framebuffer — so view size must be the device-pixel backing store size.
    liveState.viewport = { width: canvas.width, height: canvas.height };

    // PLAN-bar.md UI-2 (gui_chat:2647 + every other player-aware HUD widget):
    // seed the human-player roster from the lobby room state NOW, before LuaUI
    // boots, so Spring.GetPlayerList()/GetPlayerInfo(id) resolve every player
    // when a widget's Initialize / first PlayerChanged runs (Recoil's
    // playerHandler invariant). The worker's own setRoster/rosterUpdate path is
    // dead (zero callers — same gap the team-roster fix found), so without this
    // the roster is empty and gui_chat's PlayerChanged → GetPlayerInfo(id) → nil
    // name → "table index is nil". allyTeam is corrected once TeamStartInfo
    // lands (reconcilePlayerAllyTeams in onTeamStartInfo).
    if (msg.players && msg.players.length) {
        seedPlayersFromRoster(liveState.players, msg.players);
    }

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
    gpCtx.sceneLighting = createSceneLighting(scene, camera);

    // GW4-c5: dynamic FX light pool (PLAN-weapon-fx-gaps Phase L). Fixed ring
    // of point lights driven by weapon fire / explosions, sampled by the
    // forward-lit stock materials + bloomed by the HDR pipeline. Created BEFORE
    // the ZK unit material so setActiveFxLightPool lets units (not just terrain)
    // light up under fire (Phase U). Distortion + muzzle-flare share the same
    // explosion/fire paths and need the camera, so they're built here too.
    gpCtx.fxLightPool = new FxLightPool(scene);
    setActiveFxLightPool(gpCtx.fxLightPool);
    gpDistortion = new DistortionRenderer(scene, camera);
    gpMuzzleFlare = new MuzzleFlareRenderer(scene, camera);

    // GW4-c4: world entity rendering (ports main.ts@d6301137f7^ L480–595).
    // The per-game shader lighting style comes from modinfo.lua's `lighting`
    // field, surfaced via the lobby's /api/games and plumbed through gp:init
    // (PLAN-bar.md A4). Defaults to 'gameplay' when absent (main's fallback).
    setLightingStyle(msg.lighting || 'gameplay');
    // PLAN-bar.md A4 (decided 2026-06-11): apply the ZK team-color material
    // (zk-model-material.ts) by a data-driven *port id*, not the `gameId`
    // literal. zk-model-material.ts is a hand-port of Zero-K's specific
    // 939-line `defaultMaterialTemplate.lua` (GL3 CUS); it is only faithful
    // for a game that ships that exact template. The game declares which port
    // its template matches via modinfo `modelMaterialPort` (→ /api/games →
    // gp:init). BAR ships a different (GL4) template we can't render on WebGL2
    // (§4) and omits the flag, so it correctly falls to the engine-default
    // material. ACCEPTED LIMITATION: a plain flag (not a content hash) can't
    // detect the live template drifting from this hand-port — ZK_MATERIAL_PORT_ID
    // names the exact template version this port reproduces; bump it if the
    // port is re-synced to a newer template.
    const port = msg.modelMaterialPort || '';
    if (port && !CLIENT_MATERIAL_PORTS.has(port)) {
        // A game asked for a material port the client doesn't implement →
        // engine-default (no silent mis-render: surface the unmet request).
        console.warn(`[gp] modelMaterialPort='${port}' has no client port ` +
            `(have ${[...CLIENT_MATERIAL_PORTS].join(', ')}) — using engine-default material`);
    }
    setModelMaterialPort(port);

    gpPresentationClock = new PresentationClock();

    const entityRenderer = new EntityRenderer(scene);
    entityRenderer.setPresentationClock(gpPresentationClock);
    // PLAN-lighting L3/L4: register with the sun shadow generator up-front
    // (before any def streams in) so the first ensureModel load isn't raced;
    // pass the sun so the team-color material can sample the live CSM.
    entityRenderer.setShadowGenerator(gpCtx.sceneLighting.csm, gpCtx.sceneLighting.sun);
    gpCtx.entityRenderer = entityRenderer;
    // GW8: expose the scene-debug hooks on the worker globalThis so the main
    // devtools console can reach them via window.__gp('__entityRenderer…')
    // (the render-core move stranded these here). Mirrors the __fxLightPool /
    // __renderPipeline / __csm hooks the render modules already set.
    (globalThis as Record<string, unknown>).__entityRenderer = entityRenderer;
    // PLAN-perf P0: reach the frame-phase accumulator from the main devtools
    // console — `window.__gp('__frameProfiler.dump()')` (or window.test.perfDump).
    (globalThis as Record<string, unknown>).__frameProfiler = gpFrameProfiler;
    // PLAN-perf P0 isolation matrix: one handle for every runtime toggle the
    // attribution run flips (terrain decal plugin, decal fade re-bake, light-
    // pool count, render scale, LuaUI pass). Reach via
    // `window.__gp('__perfToggles.terrainPlugin(false)')` etc. Each returns the
    // applied value so the matrix run can confirm the toggle took.
    (globalThis as Record<string, unknown>).__perfToggles = {
        /** Hazard #1: the ~10-tap terrain decal-overlay fragment block. */
        terrainPlugin: (on: boolean): boolean =>
            setTerrainDecalPluginEnabled(gpTerrainMesh, on),
        /** Hazard #2: the periodic + pan-driven full RTT re-stamp. */
        decalFade: (on: boolean): boolean => {
            if (!gpDecalOverlay) return false;
            gpDecalOverlay.fadeEnabled = on;
            return on;
        },
        /** Hazard #3: pooled point-light count (16→4→0 removes them from the
         *  scene light list, not just idles them). Returns the new count. */
        lightPool: (n: number): number =>
            gpCtx.fxLightPool?.setPoolCount(n) ?? -1,
        /** Fill-rate probe: engine hardware scaling ⇒ backing-store resolution.
         *  scale 1.5 ≈ retina-capped baseline; 0.75 halves fill. */
        renderScale: (scale: number): number => {
            gpEngine?.setHardwareScalingLevel(1 / Math.max(0.1, scale));
            return scale;
        },
        /** Hazard #5: skip the LuaUI render-thread pass. */
        luaUi: (on: boolean): boolean => { gpUiPassEnabled = on; return on; },
    };

    // GW4-c5b: interactive RTS camera for view 0 (DOM-free; driven by the
    // forwarded `gp:*` input). Ground sampler = the entity renderer's heightmap
    // (resolves once gpLoadMap calls setMapHeightmap) so the camera never dives
    // through terrain. Map bounds + initial framing are applied in gpLoadMap.
    const rtsCam = new RTSCamera(camera, msg.width, msg.height, msg.dpr);
    rtsCam.setGroundSampler((x, z) => gpCtx.entityRenderer?.getGroundHeight(x, z) ?? 0);
    gpViewCameras.set(0, rtsCam);

    // PLAN-decals.md D5: static under-building ground plates (AO/scorch).
    const buildingPlateRenderer = new BuildingPlateRenderer(scene);
    if (msg.gameId) buildingPlateRenderer.setGame(msg.gameId, msg.lobbyUrl);
    gpBuildingPlateRenderer = buildingPlateRenderer;

    // DefCache accumulates the game's defs (fetched over HTTP on auth).
    const defCache = new DefCache();
    gpDefCache = defCache;
    // PLAN-playable.md G3a: a build tile's name/cost/pic come from its unit def,
    // which may stream in after the cmd-descs that reference it. Re-resolve the
    // tiles whenever new defs land so the native menu fills in labels/costs
    // (mirrors input-manager's BuildMenu defCache.onUnitDefs re-render hook).
    defCache.onUnitDefs(() => {
        if ((gpCtx.selection?.selection.length ?? 0) > 0) {
            gpRecomputeBuildTiles();
            gpRecomputeFactoryQueue();
        }
    });

    // GW4-c5: projectile renderer + CEG getRuntime() + build-beam (ports
    // main.ts@d6301137f7^ L511–537). The CEG getRuntime() drives muzzle flashes /
    // impact bursts / debris; the projectile renderer integrates motion locally
    // off Fired/Impact/Trajectory events and injects the CEG getRuntime() + FX
    // light pool + distortion + muzzle flare for its hooks.
    const projectileRenderer = new ProjectileRenderer(scene);
    gpCtx.projectileRenderer = projectileRenderer;
    (globalThis as Record<string, unknown>).__projectileRenderer = projectileRenderer;  // GW8 debug hook
    const buildBeamRenderer = new BuildBeamRenderer(scene);
    buildBeamRenderer.setEntityRenderer(entityRenderer);
    if (msg.gameId) buildBeamRenderer.setGameAssetsBaseUrl(msg.gameId);
    gpBuildBeamRenderer = buildBeamRenderer;
    const cegRuntime = new CegRuntime(scene);
    gpCegRuntime = cegRuntime;
    projectileRenderer.setCegRuntime(cegRuntime);
    projectileRenderer.setLightPool(gpCtx.fxLightPool);
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
    // SoundEvent → AudioManager getBridge() stays on main (GW4-c5c).
    const combatFX = new CombatFX(scene, undefined, cegRuntime, defCache);
    // No light pool on CombatFX — ZK authors no explosion deferred light
    // (fx-light-pool.ts); explosion glow is authored CEG/groundflash + bloom.
    combatFX.setDistortion(gpDistortion);
    gpCombatFX = combatFX;

    // Dynamic feature renderer — getRuntime()-spawned features (wrecks, debris,
    // reclaim removals). Map-placed features load once via renderMapFeatures
    // in gpLoadMap.
    const dynamicFeatureRenderer = new DynamicFeatureRenderer(scene, defCache);
    dynamicFeatureRenderer.setShadowGenerator(gpCtx.sceneLighting.csm);
    gpDynamicFeatureRenderer = dynamicFeatureRenderer;

    // Phase G: gate the expensive FX through the graphics-quality presets
    // (ports main.ts@d6301137f7^ L434–451 — dropped in the c5a FX move, restored
    // here now that the gfx snapshot + live `gp:config` push exist). `fireNow`
    // applies the seeded value immediately; a later `gp:config` re-fires these
    // via clientSettings.set → notify. `gfx.msaaSamples/fxaa/bloom/
    // shadowFiltering` are owned by scene-lighting.ts's own subscriptions.
    {
        const fxLights = gpCtx.fxLightPool;
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

    // New defs → the renderers that consume them, and (GW4-c6-1b) the LuaUI
    // def map behind UnitDefNames / WeaponDefNames / buildPic. UnitDefInfo and
    // WeaponDefInfo are supersets of the Minimal*Wire shapes (same field
    // names), so they slot straight into the def maps; republishDefGlobals
    // rebuilds the Lua UnitDefs/UnitDefNames tables. Before this seam, every ZK
    // config file logged `UnitDefNames.<x>` nil-index errors and panels read 0.
    defCache.onUnitDefs((newDefs) => {
        gpCtx.entityRenderer?.setUnitDefs(newDefs);
        gpBuildingPlateRenderer?.setUnitDefs(newDefs);
        for (const d of newDefs) unitDefMap.set(d.defId, d);
        const rt0 = getRuntime(); if (rt0) republishDefGlobals(rt0);
    });
    defCache.onWeaponDefs((newDefs) => {
        gpCtx.projectileRenderer?.setWeaponDefs(newDefs);
        for (const d of newDefs) weaponDefMap.set(d.defId, d);
        const rt1 = getRuntime(); if (rt1) republishDefGlobals(rt1);
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
        // GW8: window.test.pause() freezes the client render loop for a
        // deterministic screenshot. Keep gpLastFrameTime fresh (above) so resume
        // doesn't see a huge dt; the preserved drawing buffer holds the frame.
        if (gpRenderPaused) return;
        // Sim-scaled delta for VISUAL FX aging — slows / freezes with the game
        // speed. Camera + entity ticks keep the raw wall dt; only FX lifetimes
        // use fxDt (PLAN-weapon-fx-capture-arch fxDt).
        const fxDt = dt * gpFxSimSpeed;

        // Per-phase frame profiling (PLAN-perf P0). beginFrame/gpMark/endFrame
        // write into the permanent accumulator (gpFrameProfiler) with no
        // per-frame allocation; percentiles are computed only at dump time.
        if (gpFrameProfile) gpFrameProfiler.beginFrame(now);
        gpEntityFxFence.beginFrame();

        // GW4-c5b: advance the interactive camera(s) first so this frame's
        // render + pick + viewport use the updated pose. Raw wall dt (the camera
        // is not sim-scaled). tick() handles its own per-call timing internally.
        // While the model-harness orbit rig is active it is the only writer of
        // the view-0 camera — the RTSCamera tick would fight it (ground clamp,
        // map-bounds rubber band), so it's skipped for that view.
        for (const [viewId, cam] of gpViewCameras) {
            if (viewId === 0 && gpOrbitRig) continue;
            cam.tick();
        }
        gpOrbitRig?.tick();
        gpSunRig?.tick(dt);
        gpClipPlayer?.tick();
        gpMark(0);  // camera

        // entityRenderer.tick() advances the presentation clock (L0) and
        // interpolates every unit to the presentation cursor before render.
        gpCtx.entityRenderer?.tick();
        gpMark(1);  // entity
        gpBuildBeamRenderer?.tick();
        gpCtx.projectileRenderer?.tick();
        gpCegRuntime?.tick(fxDt);
        gpCombatFX?.tick(fxDt);
        gpMark(2);  // fx
        // Decal clipmap fine window tracks the camera focus + height.
        {
            const focus = camera.getTarget();
            gpDecalOverlay?.tick(dt, focus.x, focus.z,
                Math.max(1, camera.position.y - focus.y));
        }
        // Age the FX lights after the emitters ran this frame + before
        // scene.render() consumes the lighting; then push distortion/muzzle
        // uniforms.
        gpCtx.fxLightPool?.update(fxDt, camera.position);
        gpDistortion?.tick(fxDt);
        gpMuzzleFlare?.tick(fxDt);
        gpMark(3);  // decals+lights
        scene.render();
        gpMark(4);  // render
        // U1 (PLAN-bar §7): mirror the live render camera into the Spring-API
        // liveState every frame, AFTER scene.render() (Babylon only refreshes
        // getViewMatrix/getProjectionMatrix during render). Kept OUTSIDE the
        // UI-pass toggle below so Spring.TraceScreenRay / GetCameraPosition /
        // GetPixelDir / ScreenToWorldCoords read the real camera even when the
        // LuaUI pass is isolated off (P0). Feeds the gl-bridge too (gpRunUiPass).
        gpSyncCameraToLiveState();
        // GW4-c6: LuaUI screen-space pass on the SAME context, after the world
        // is drawn (state save/restore + wipeCaches inside). World-space
        // DrawWorld/DrawWorldPreUnit overlays land in c6-2. Gated by the P0
        // isolation toggle (gpUiPassEnabled).
        if (gpUiPassEnabled) gpRunUiPass();
        gpMark(5);  // ui
        // GW4-c5c: feed the HTML HUD (entity count / frame / selection / speed).
        gpPostSceneState(now);
        // GW4-c5c-3: feed the main-thread minimap (unit dots + fog overlay).
        gpPostMinimapFeed(now);

        if (gpFrameProfile) {
            const total = gpFrameProfiler.endFrame(performance.now());
            if (total > GP_LONG_FRAME_MS) {
                postLog(2, `[gp] long frame ${total | 0}ms: ${gpFrameProfiler.formatLastFrame()}`);
            }
        }
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
    // localStorage) and route persistence back via storage:set — the worker's
    // localStorage isn't the page's. WP3b: uses saveToStorage so all worker
    // persistence flows through the single storage:set channel.
    const standingOrderRenderer = new StandingOrderRenderer(scene, {
        showAllies: msg.standingOrderShowAllies,
        persistShowAllies: (show) =>
            saveToStorage('standing-orders-show-allies', String(show)),
    });
    gpStandingOrderRenderer = standingOrderRenderer;

    const selection = new WorkerSelection(scene, entityRenderer, gpCtx.connection!, {
        getCamera: (viewId) => (viewId === 0 ? camera : null),
        dpr: gpDpr,
        onDragBox: (box) => postToMain({ type: 'gp:dragBox', box }),
        // Re-render the path/waypoint overlays from the cached queue snapshot so
        // they appear immediately on a selection change (don't wait for the next
        // ~1 Hz UnitCommandQueuesUpdate). (sceneState mirroring → main is c5c.)
        onSelectionChange: (ids) => {
            gpCommandPathRenderer?.update(gpLastCommandQueues, ids);
            gpWaypointMarkerRenderer?.update(gpLastCommandQueues, ids);
            // GW4-c6-1b: feed LuaUI selection (Spring.GetSelectedUnits +
            // widgetHandler:SelectionChanged) so build-menu / order panels
            // react to what the player picked.
            liveState.selectedUnitIds = ids.slice();
            dispatchSelectionChanged(ids);
            // PLAN-playable.md G3a: mirror the selection to the server so it
            // scopes UnitCmdDescsUpdate to these units (Recoil-faithful; also
            // the PLAN-orders bandwidth control). GW4-regression: post-move the
            // connection lives in this worker and nothing called
            // sendSelectionState, so the server never learned the selection and
            // fell back to streaming EVERY own-team unit's cmd descs. Same dead-
            // stream class as onUnitCmdDescs/onResourceUpdate. Selection changes
            // are discrete gestures, so no extra debounce is needed here.
            gpCtx.connection?.sendSelectionState(ids);
            // A new selection invalidates any in-progress build placement (the
            // armed def may not be buildable by the new selection —
            // input-manager.setSelection did the same) and changes the
            // buildable-tile set for the native menu.
            gpBuildPlacement?.cancelBuildPlacement();
            gpRecomputeBuildTiles();
            // PLAN-playable.md G4: the factory-queue panel tracks the
            // selection too — re-resolve from the cached queue snapshot so
            // it appears immediately, same reasoning as the path/waypoint
            // overlays above.
            gpRecomputeFactoryQueue();
        },
        // GW4: unit-UI sounds (select / order-ack / multi-select). These are
        // unsynced in Recoil — the server emits no SoundEvent for them — so the
        // worker synthesises a resolved sound here from the def cache (or a
        // named SoundItem) and reuses the main-thread playback path.
        onUiSound: (req) => {
            let ev: ResolvedSoundEvent | null = null;
            if (req.kind === 'unit') {
                const def = gpDefCache?.getUnitDef(req.defId);
                const ref = pickUnitDefSound(def?.sounds, req.category);
                if (!ref) return;
                const e: SoundEventInfo = {
                    soundId: ref.id, sourceDefId: req.defId, sourceKind: 0,
                    x: req.x, y: req.y, z: req.z, volume: 1, pitch: 1,
                    priority: 128, team: 255, channel: AudioChannel.UnitReply,
                };
                ev = { e, ref };
            } else {
                // Named SoundItem (e.g. "MultiSelect") — a 2D UI sound resolved
                // by name against gamedata/sounds.lua on the main thread.
                const ref: SoundRefInfo = {
                    id: -1, path: '', category: -1, volume: 1, pitch: 1,
                    name: req.name,
                };
                const e: SoundEventInfo = {
                    soundId: -1, sourceDefId: 0, sourceKind: 3,
                    x: 0, y: 0, z: 0, volume: 1, pitch: 1,
                    priority: 128, team: 255, channel: AudioChannel.UserInterface,
                };
                ev = { e, ref };
            }
            postToMain({ type: 'gp:audioSoundEvents', events: [ev] });
        },
    });
    gpCtx.selection = selection;

    // PLAN-playable.md G3a: worker-side build placement (ghost + snap + order).
    // Shares the selection set (owned by WorkerSelection), the def cache, and
    // the pre-computed metal spots. The native BuildMenu on main arms it via
    // gp:startBuildPlacement; the pointer dispatcher routes left-clicks here
    // before selection while it is active.
    gpBuildPlacement = new WorkerBuildPlacement(scene, entityRenderer, gpCtx.connection!, {
        getCamera: (viewId) => (viewId === 0 ? camera : null),
        getDpr: () => gpDpr,
        getDefCache: () => gpDefCache,
        getSelection: () => gpCtx.selection?.selection ?? [],
        getMetalSpots: () => gpMetalSpots,
        getMetalCellSize: () => gpMetalCellSize,
        getBuildSpacing: () => liveState.buildSpacing,
    });

    // PLAN-playable.md G3b: worker-side modal commands + area/waypoint drags +
    // order hotkeys. Shares the selection set + the ~1 Hz command-queue snapshot
    // (for waypoint reposition). Emits cursor-mode changes to main.
    gpCommandModes = new WorkerCommandModes(scene, entityRenderer, gpCtx.connection!, {
        getCamera: (viewId) => (viewId === 0 ? camera : null),
        getDpr: () => gpDpr,
        getSelection: () => gpCtx.selection?.selection ?? [],
        getLastCommandQueues: () => gpLastCommandQueues,
        onCursorMode: (req) => postToMain({ type: 'gp:cursorMode', name: req.name, css: req.css }),
    });

    // G3b: route Spring.SetActiveCommand (order menu → widget worker shim) into
    // the worker. Build commands (cmdId<0) arm ground placement (same as the
    // native BuildMenu); world-target commands (cmdId>0) arm a modal. Instant /
    // mode-cycle commands never arrive here (the shim issues those directly).
    setWorkerSetActiveCommandHandler((cmdId, mods, cmdType) => {
        if (cmdId < 0) {
            gpBuildPlacement?.startBuildPlacement(-cmdId, { shift: mods.shift, ctrl: mods.ctrl });
        } else if (cmdId > 0) {
            gpCommandModes?.activateCommandFromMenu(cmdId, cmdType);
        }
    });

    rtsCam.onRightClickCommit = (x, y, mods) => {
        // Spring convention: a right-click while placing cancels the placement
        // (input-manager.issueOrderAtScreen). RMB also cancels an armed modal
        // command / in-flight area-attack drag (Recoil CGuiHandler: RMB clears
        // the active command). Only when nothing is armed does RMB issue the
        // default context order (move / attack / guard).
        if (gpBuildPlacement?.isActive) { gpBuildPlacement.cancelBuildPlacement(); return; }
        if (gpCommandModes?.tryHandleRightClick()) return;
        selection.issueOrderAtScreen(x, y, mods.shift, 0);
    };
    // PLAN-latency L0: anchor the presentation clock to this connection's
    // ServerClock (created per game connection by Connection).
    gpPresentationClock.reset();
    gpPresentationClock.setServerClock(gpCtx.connection!.serverClock);
    // GW4-c3: fetch map data over HTTP + build the terrain (independent of the
    // connection auth handshake — map data is on the asset plane).
    void gpLoadMap(msg);
}

/// PLAN-playable.md G3a: recompute the buildable-tile set for the current
/// selection (union of build cmds across own-team selected units) and resolve
/// each defId into a render-ready tile via the def cache. Marks the tiles dirty
/// so the next sceneState post ships them to the native BuildMenu on main.
/// Called on selection change, cmd-desc arrival, and late def arrival.
/// Mirrors the buildable-set computation in the pre-GW4 BuildMenu.render().
function gpRecomputeBuildTiles(): void {
    const sel = gpCtx.selection?.selection ?? [];
    const er = gpCtx.entityRenderer;
    const dc = gpDefCache;
    const myTeam = gpCtx.connection?.myTeam ?? -1;

    const buildable = new Set<number>();
    if (er && dc) {
        for (const unitId of sel) {
            const meta = er.getEntityMeta(unitId);
            if (!meta || meta.team !== myTeam) continue;
            const descs = gpUnitCmdDescs.get(unitId);
            if (!descs) continue;
            for (const c of descs.cmds) {
                if (c.disabled) continue;
                if (c.cmdId >= 0) continue;   // negative cmdId = build command
                buildable.add(-c.cmdId);
            }
        }
    }

    // Sort by metal cost (light → heavy) for a usable browsing order; fall back
    // to defId when costs haven't loaded yet. Matches the pre-GW4 BuildMenu.
    const sorted = [...buildable].sort((a, b) => {
        const ca = dc?.getUnitDef(a)?.metalCost ?? Number.MAX_SAFE_INTEGER;
        const cb = dc?.getUnitDef(b)?.metalCost ?? Number.MAX_SAFE_INTEGER;
        if (ca !== cb) return ca - cb;
        return a - b;
    });

    const tiles: BuildMenuTile[] = [];
    for (const defId of sorted) {
        const def = dc?.getUnitDef(defId);
        tiles.push({
            defId,
            name:       def?.name ?? '',
            humanName:  def?.humanName ?? '',
            buildPic:   def?.buildPic ?? '',
            metalCost:  def?.metalCost ?? 0,
            energyCost: def?.energyCost ?? 0,
            buildTime:  def?.buildTime ?? 0,
            tooltip:    def?.tooltip ?? '',
        });
    }
    gpBuildTiles = tiles;
    gpBuildTilesDirty = true;
}

/// PLAN-playable.md G4: recompute the production-queue rows for the native
/// FactoryQueuePanel. Picks the first own-team factory (UnitDef bit 11) in
/// the current selection — multi-factory queue merging isn't implemented,
/// matching the "selected factory" (singular) framing of the ZK Phase D
/// item this closes. Groups gpLastCommandQueues' build entries (cmdId<0,
/// same convention gpRecomputeBuildTiles decodes) into consecutive
/// same-defId runs, mirroring how Spring's FactoryCAI stacks repeated
/// identical build commands one slot each. Non-build orders (e.g. a WAIT
/// a player inserted between batches) are skipped rather than splitting a
/// run — an acceptable simplification for this native (non-Lua-port) panel.
/// Called on selection change and on every UnitCommandQueuesUpdate.
function gpRecomputeFactoryQueue(): void {
    const sel = gpCtx.selection?.selection ?? [];
    const er = gpCtx.entityRenderer;
    const dc = gpDefCache;
    const myTeam = gpCtx.connection?.myTeam ?? -1;

    let factoryId = -1;
    if (er && dc) {
        for (const unitId of sel) {
            const meta = er.getEntityMeta(unitId);
            if (!meta || meta.team !== myTeam) continue;
            const def = dc.getUnitDef(meta.defId);
            if (!def || !(def.flags & UNITDEF_FLAG_IS_FACTORY)) continue;
            factoryId = unitId;
            break;
        }
    }

    let tiles: FactoryQueueTile[] = [];
    if (factoryId >= 0) {
        const orders = gpLastCommandQueues.find(q => q.unitId === factoryId)?.orders ?? [];
        const runs = groupFactoryQueueRuns(orders);
        tiles = runs.map(r => {
            const def = dc?.getUnitDef(r.defId);
            return {
                unitId: factoryId,
                defId: r.defId,
                name: def?.name ?? '',
                humanName: def?.humanName ?? '',
                buildPic: def?.buildPic ?? '',
                count: r.tags.length,
                tags: r.tags.slice(),
            };
        });
    }
    gpFactoryQueueTiles = tiles;
    gpFactoryQueueDirty = true;
}

/// Cancel queued factory order(s) from the native FactoryQueuePanel
/// (gp:removeFactoryOrder). CMD.REMOVE by tag (no OPT.ALT) against a factory
/// needs OPT.CONTROL set — Recoil's CCommandAI::ExecuteRemove redirects a
/// factory's plain (non-Ctrl) REMOVE to CFactoryCAI::newUnitCommands (orders
/// queued for the *next produced unit*, not the build queue itself); only
/// the Ctrl-held variant targets `commandQue`, the actual build queue this
/// panel reads via UnitCommandQueuesUpdate. Mirrors ZK/BA's own Ctrl+
/// right-click-to-cancel-a-build convention. Live-verified: omitting
/// OPT.CONTROL silently no-ops (removal lands on the empty produced-unit
/// queue) — confirmed via Spring.GetFactoryCommands before/after.
export function gpHandleRemoveFactoryOrder(unitId: number, tags: number[]): void {
    if (tags.length === 0) return;
    gpCtx.connection?.sendPlayerCommand(CMD.REMOVE, [unitId], tags, OPT.CONTROL, 0);
}

/// GW4-c5b-3: update the shift-held gate that shows/hides the command-path +
/// waypoint overlays (Spring's "hold Shift to see queued orders" gesture).
/// Driven from the forwarded key/pointer `mods` bitmask (bit 0 = shift).
export function gpSetShift(held: boolean): void {
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
    const sel = gpCtx.selection?.selection ?? [];
    const target = cam.getTarget();
    // PLAN-playable.md G3a: ship the resolved build tiles only when the buildable
    // set changed (dirty-gated), and the live build-ghost state (armed placement)
    // every post so main's HUD/ESC readout tracks it.
    const buildOptions = gpBuildTilesDirty ? gpBuildTiles.slice() : undefined;
    gpBuildTilesDirty = false;
    // G4: ship the local team's latest ResourceUpdate only when a fresh one
    // arrived (dirty-gated, same pattern as buildOptions).
    const economy = gpEconomyDirty && gpLastEconomy ? gpLastEconomy : undefined;
    gpEconomyDirty = false;
    // G4: ship the resolved factory-queue rows only when they changed.
    const factoryQueue = gpFactoryQueueDirty ? gpFactoryQueueTiles.slice() : undefined;
    gpFactoryQueueDirty = false;
    postToMain({
        type: 'gp:sceneState',
        selectedUnitIds: sel.slice(),
        // Rich per-unit facts (health etc.) fill in when a consumer needs them
        // (HUD today only reads ids + count); kept empty to stay cheap.
        selected: [],
        hovered: gpCtx.selection && gpCtx.selection.hovered > 0 ? { id: gpCtx.selection.hovered } : null,
        camera: {
            x: cam.position.x, y: cam.position.y, z: cam.position.z,
            tx: target.x, ty: target.y, tz: target.z,
        },
        gameFrame: gpGameFrame,
        paused: gpPaused,
        simSpeed: gpSimSpeed,
        buildGhost: gpBuildPlacement?.getGhostState() ?? null,
        // G3b: a modal command / area-attack armed → main swallows ESC to cancel
        // it (before the build-ghost check + the quit dialog).
        commandModeArmed: gpCommandModes?.isArmed() ?? false,
        entityCount: gpCtx.entityRenderer?.entityCount ?? 0,
        ...(buildOptions ? { buildOptions } : {}),
        ...(economy ? { economy } : {}),
        ...(factoryQueue ? { factoryQueue } : {}),
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
    const er = gpCtx.entityRenderer;
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
    // Deliver metal-spot markers once — same one-shot pattern as mapInfo.
    const metalSpots = gpMinimapMetalSpotsInfo ?? undefined;
    if (gpMinimapMetalSpotsInfo) gpMinimapMetalSpotsInfo = null;
    postToMain({ type: 'gp:minimapFeed', blips, los: losPayload, map: mapInfo, metalSpots });
}

/// U1 (PLAN-bar §7): mirror the live worker render camera into the Spring-API
/// liveState. Post-GW4 the render camera moved INTO this worker, but the only
/// producer that fed `liveState.viewMatrix/projMatrix/camera` was the
/// main-thread `stateUpdate` message (lua-widget-manager.pushStateToWorker),
/// which is dead post-GW4 — so every screen-ray / camera read
/// (Spring.TraceScreenRay, GetCameraPosition, GetPixelDir, ScreenToWorldCoords,
/// GetCameraState) silently degraded to the zeroed liveState defaults. This
/// re-establishes the producer at the real source: the worker's own Babylon
/// scene + camera, refreshed each frame after scene.render(). The matrices are
/// copied out because Babylon mutates its internal .m arrays in place each
/// frame. Coordinate frame: scene coords == server world coords == the
/// Lua-facing frame (flipPosZ is identity, game-processor world draws project
/// server coords directly), so the unprojected results are already what widgets
/// expect on BOTH legacy games (BAR + ZK) — no extra flip.
function gpSyncCameraToLiveState(): void {
    if (!gpScene || !gpCamera) return;
    liveState.viewMatrix = new Float32Array(gpScene.getViewMatrix().m);
    liveState.projMatrix = new Float32Array(gpScene.getProjectionMatrix().m);
    const cam = gpCamera;
    const tgt = cam.getTarget();
    const c = liveState.camera;
    c.px = cam.position.x; c.py = cam.position.y; c.pz = cam.position.z;
    c.tx = tgt.x; c.ty = tgt.y; c.tz = tgt.z;
    // fov stored in radians (GetCameraState converts to degrees on read).
    c.fov = cam.fov;
    c.near = cam.minZ;
    c.far = cam.maxZ;
}

/// GW4-c6: run the LuaUI screen-space pass on the shared Babylon context after
/// scene.render(). Babylon caches GL state and assumes nothing else touches the
/// context, so the pass ends with `wipeCaches(true)` (bruteForce) to force
/// Babylon to re-verify + re-issue every cached GL call on its next real state
/// change (mirrors lua-widget-host.ts's postDraw). Without this the world
/// render corrupts within a frame or two (wrong program/VAO/blend bound).
///
/// PLAN-perf P5 (2026-07-05): this used to also snapshot 9 more GL values via
/// `gl.getParameter` (program/VAO/blend/depthTest/depthMask/cull/viewport/
/// polygonOffset/activeTexture) and restore them by hand before the
/// `wipeCaches(true)` call. That was provably redundant: `wipeCaches(true)`
/// (read Babylon's ThinEngine source — `_alphaState.reset()`,
/// `_depthCullingState.reset()`, `resetTextureCache()`, `_currentProgram =
/// null`, `_unbindVertexArrayObject()`, `_viewportCached` zeroed) marks every
/// one of those caches dirty/sentinel, so Babylon reissues the real GL call
/// the moment it next sets any of them — regardless of what raw state we
/// leave behind. (CORRECTION, U8 2026-07-11: dropping the VAO restore was NOT
/// harmless — see the `gl.bindVertexArray(null)` below and its comment. The
/// old restore incidentally left the DEFAULT VAO bound before wipeCaches, which
/// is why wipeCaches's `unbindAllAttributes()` never touched the bridge VAO.
/// That behaviour is now restored explicitly, not by a save/restore round
/// trip.) The ONE getParameter value wipeCaches does NOT track is the framebuffer
/// binding (`_currentFramebuffer`) — that still needs a real save/restore,
/// now read from Babylon's own cache instead of a `gl.getParameter` round
/// trip. Kept `wipeCaches(true)` (not `false`): the weaker form skips exactly
/// the resets this reasoning depends on, so downgrading would silently
/// reintroduce the need for the removed restores. This narrows the 12
/// `gl.getParameter` round-trips (N1-measured 0.55 ms/frame) to zero;
/// `wipeCaches(true)`'s own downstream re-upload cost is untouched by design
/// (already bounded by P0's ≤2 ms render-phase deltas, not this milestone).
function gpRunUiPass(): void {
    if (!gpCtx.luaUiActive || !getRuntime() || !gpCtx.uiGl || !gpEngine) return;
    const gl = gpCtx.uiGl;

    const tSave = performance.now();
    // Babylon's own cached binding — see the function doc comment for why
    // this is the one save that still needs to happen (not reset by wipeCaches).
    const savedFBO = (gpEngine as unknown as { _currentFramebuffer: WebGLFramebuffer | null })._currentFramebuffer;
    // Babylon may leave a post-process render-target FBO bound; the UI must
    // draw to the default framebuffer (the canvas the player sees).
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    // GW4-c6-2: feed the live camera view + projection to the GL getBridge() so the
    // world-space DrawWorld pass (and UniformMatrix("view"/"projection")) draw
    // in world space. scene coords == server world coords (no flip), so a
    // widget's gl.Vertex(serverX,serverY,serverZ) projects correctly. Reuse the
    // exact matrix instances gpSyncCameraToLiveState() already copied out this
    // frame (it runs just before us in the render loop) so the world-draw bridge
    // and the Spring-API screen-ray reads share one source of truth.
    if (getBridge() && liveState.viewMatrix && liveState.projMatrix) {
        getBridge()!.setCameraMatrices(liveState.viewMatrix, liveState.projMatrix);
    }

    const tLua = performance.now();
    try {
        runFrame(getRuntime()!, gl, /*clearColor*/ false, /*worldPass*/ true);
    } catch (err) {
        postLog(4, `[gp] LuaUI pass error: ${err}`);
        gpCtx.luaUiActive = false;  // stop after a hard failure rather than spam
    }

    // Restore Babylon's expected state. Only the framebuffer binding needs a
    // manual restore here — see the function doc comment for why the other 9
    // values that used to be saved/restored are made redundant by the
    // `wipeCaches(true)` call below.
    const tRestore = performance.now();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, savedFBO);
    // U8 (PLAN-bar §7, 2026-07-11): unbind the LuaUI immediate-mode VAO BEFORE
    // wipeCaches(). Babylon's `wipeCaches(true)` calls `unbindAllAttributes()`,
    // which runs `disableVertexAttribArray()` on the CURRENTLY-BOUND VAO and
    // only rebinds the default VAO afterwards. The last immediate flush leaves
    // the gl-bridge's private VAO bound, so wipeCaches was disabling ITS three
    // attributes every frame; the next frame's draws then read generic-constant
    // vertices (all collapsed to the origin → degenerate, zero-area) and the
    // ENTIRE LuaUI HUD renders nothing — healthy program, no GL error, correct
    // buffers, just an all-disabled VAO. P5 removed the old explicit VAO
    // save/restore believing wipeCaches's own `_unbindVertexArrayObject()` made
    // it redundant; it does not, because `unbindAllAttributes()` runs first, on
    // whatever VAO we left bound. Binding the default VAO here sends that
    // disable at the throwaway default VAO instead, leaving the bridge VAO's
    // attribute enables intact for the next pass.
    gl.bindVertexArray(null);
    const tWipe = performance.now();
    (gpEngine as unknown as { wipeCaches: (b?: boolean) => void }).wipeCaches(true);

    // PLAN-rml.md §4.5: ship the frame's recorded RML DOM ops to the main-thread
    // overlay in ONE message. Ordering: world pass → chili DrawScreen (runFrame
    // above) → rmlFlush. RML widget callins ran inside runFrame and recorded
    // their ops; this is the single batched flush.
    const tRml = performance.now();
    rmlFlush();

    const tEnd = performance.now();
    gpUiTax.frames++;
    gpUiTax.save += tLua - tSave;
    gpUiTax.lua += tRestore - tLua;
    gpUiTax.restore += tWipe - tRestore;
    gpUiTax.wipe += tRml - tWipe;
    gpUiTax.rml += tEnd - tRml;
}

/// GW4-c6: boot the Fengari LuaUI getRuntime() against the shared Babylon context.
/// Called once from gpLoadMap after the terrain is built (init needs the map's
/// source URL + heightmap). Reuses the full legacy `init()` bootstrap (VFS
/// prefetch, getRuntime(), gl-getBridge(), widgetHandler, camain.lua, gadget halves) but
/// in shared-context mode (no private canvas, no setInterval — the gp render
/// loop drives the pass via gpRunUiPass).
async function gpBootLuaUI(map: ParsedMapData, mapSourceAbs: string, msg: GpInitToWorker): Promise<void> {
    if (getRuntime() || !gpEngine) return;  // already booted (idempotent)
    let gl: WebGL2RenderingContext;
    try { gl = getEngineGl(gpEngine); } catch { postLog(4, '[gp] LuaUI boot: no _gl on Babylon engine'); return; }
    const mapDataTransfer: MapDataTransfer = {
        mapx: map.mapx, mapy: map.mapy, squareSize: map.squareSize,
        minHeight: map.minHeight, maxHeight: map.maxHeight,
        widthElmos: map.widthElmos, heightElmos: map.heightElmos,
        heightmap: map.heightmap, mapSourceUrl: mapSourceAbs,
    };
    // GW4-c6-1b: wait for defs to be ingested before booting. init() includes
    // ZK's config files (unitDefReplacements, dynamic_comm_defs, integral_menu,
    // …) which index UnitDefNames.<x> at load-time; republishDefGlobals must
    // have published a populated def map first or those files hit nil and the
    // dependent widgets/gadgets boot degraded. The def fetch is usually faster
    // than the terrain build + VFS prefetch, so this rarely actually blocks.
    // Cap the wait as a last resort so a truly dead connection (never auths →
    // gpDefsReady never resolves) can't strand the UI forever. The defs fetch
    // only starts AFTER auth, and a cold ZK game server can take 30–60 s to warm
    // up before it answers AuthRequest, so the cap must be generous — an 8 s cap
    // fired mid-cold-start and booted with empty UnitDefNames (the config-include
    // nil-index spam c6-1b eliminated). On a healthy server defs resolve in well
    // under this; on a dead one a degraded boot at the cap beats an infinite hang.
    await Promise.race([
        gpDefsReady,
        new Promise<void>((resolve) => setTimeout(() => {
            postLog(3, '[gp] LuaUI boot: defs not ready after 90s — booting anyway (server never authed?)');
            resolve();
        }, 90000)),
    ]);
    if (getRuntime() || !gpEngine) return;  // a concurrent boot won the race while awaiting
    try {
        await init(null, msg.gameId, msg.lobbyUrl, mapDataTransfer, undefined, gl);
        // The getBridge()'s one-time GL setup (shaders, font textures, VAOs) ran
        // outside the per-frame save/restore — force Babylon to re-upload its
        // cached state next frame so boot doesn't corrupt the world render.
        (gpEngine as unknown as { wipeCaches: (b?: boolean) => void }).wipeCaches(true);
        postLog(1, '[gp] LuaUI booted on shared context (GW4-c6)');
    } catch (err) {
        postLog(4, `[gp] LuaUI boot failed: ${err}`);
    }
}

export function gpResize(width: number, height: number, dpr: number): void {
    if (!gpEngine) return;
    const c = gpEngine.getRenderingCanvas() as OffscreenCanvas | null;
    if (c) {
        c.width = Math.max(1, Math.floor(width * dpr));
        c.height = Math.max(1, Math.floor(height * dpr));
    }
    gpEngine.resize();
    // GW4-c6: keep the LuaUI view size in sync (device px — see gpInit).
    if (c) liveState.viewport = { width: c.width, height: c.height };
    // GW4-c5b: keep the camera's CSS-pixel viewport + dpr in sync so edge-scroll
    // bands and scene.pick (which scales by dpr) stay correct after a resize.
    for (const cam of gpViewCameras.values()) cam.setViewportSize(width, height, dpr);
    // GW4-c5b-2: selection pick scaling also needs the live dpr.
    if (dpr > 0) { gpDpr = dpr; gpCtx.selection?.setDpr(dpr); }
}

export function gpShutdown(): void {
    if (gpViewportTimer) { clearInterval(gpViewportTimer); gpViewportTimer = null; }
    rmlReset();  // PLAN-rml.md: drop the bridge op queue + runtime ref.
    for (const cam of gpViewCameras.values()) cam.dispose();
    gpViewCameras.clear();
    gpCtx.selection?.dispose();
    gpCtx.selection = null;
    // PLAN-playable.md G3a: dispose the build-placement controller + reset caches.
    gpBuildPlacement?.dispose();
    gpBuildPlacement = null;
    // PLAN-playable.md G3b: dispose the command-modes controller + unregister the
    // worker-side SetActiveCommand handler (the closure captured the now-dead
    // controllers/connection).
    gpCommandModes?.dispose();
    gpCommandModes = null;
    setWorkerSetActiveCommandHandler(null);
    gpUnitCmdDescs.clear();
    gpMetalSpots = [];
    gpMinimapMetalSpotsInfo = null;
    gpBuildTiles = [];
    gpBuildTilesDirty = false;
    gpFactoryQueueTiles = [];
    gpFactoryQueueDirty = false;
    gpLastEconomy = null;
    gpEconomyDirty = false;
    gpCommandPathRenderer?.dispose();
    gpCommandPathRenderer = null;
    gpWaypointMarkerRenderer?.dispose();
    gpWaypointMarkerRenderer = null;
    gpStandingOrderRenderer?.dispose();
    gpStandingOrderRenderer = null;
    gpLastCommandQueues = [];
    gpShiftHeld = false;
    gpCtx.connection?.disconnect();
    gpCtx.connection = null;
    gpCtx.entityRenderer?.dispose();
    gpCtx.entityRenderer = null;
    gpBuildingPlateRenderer?.dispose();
    gpBuildingPlateRenderer = null;
    gpDefCache?.clear();
    gpDefCache = null;
    gpPresentationClock = null;
    // GW4-c5: weapon-FX / projectile / decal / build / feature modules.
    gpCtx.projectileRenderer?.dispose();
    gpCtx.projectileRenderer = null;
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
    gpCtx.fxLightPool?.dispose();
    gpCtx.fxLightPool = null;
    setActiveFxLightPool(null);
    gpDecalOverlay?.dispose();
    gpDecalOverlay = null;
    gpDynamicFeatureRenderer?.dispose();
    gpDynamicFeatureRenderer = null;
    gpFxSimSpeed = 1;
    // Model-harness rigs (PLAN-model-harness): the scene they drive is being
    // disposed below, so just drop them — no restore needed.
    gpOrbitRig = null;
    gpOrbitSavedView = null;
    gpSunRig = null;
    gpClipPlayer = null;
    gpTerrainFog?.dispose();
    gpTerrainFog = null;
    gpTerrainMesh = null;
    gpDeformTerrain = null;
    gpMapData = null;
    gpCtx.sceneLighting = null;
    gpEngine?.stopRenderLoop();
    // scene.dispose() tears down the terrain mesh, fog, water, lights, CSM,
    // and the HDR render pipeline created above.
    gpScene?.dispose();
    gpEngine?.dispose();
    gpEngine = null;
    gpScene = null;
    gpCamera = null;
}

// ── GW8: window.test client-bound getBridge() ───────────────────────────────
//
// The server-bound half of the test harness (spawn/kill/order/damage/log/…)
// runs entirely on the MAIN thread over HTTP — it needs only the game-server
// URL + auth token. The CLIENT-bound half (camera, selection, render-pause,
// screenshot) needs the renderer + camera + connection, which now live here in
// the worker. main posts `gp:test {id, method, args}`; this resolves it against
// the worker-resident objects and posts `gp:testResult {id, ok, value/error}`.
// Camera *animations* return immediately after starting — main awaits the
// duration itself, exactly as the old in-process harness did. Composite ops
// that resolve a unit's interpolated position (focusUnit etc.) run worker-side
// in one shot to avoid an extra round-trip.
export async function gpTestDispatch(method: string, args: unknown[]): Promise<unknown> {
    const cam = gpViewCameras.get(0);
    const num = (i: number, d = 0): number => (typeof args[i] === 'number' ? args[i] as number : d);
    const obj = <T>(i: number, d: T): T => (args[i] == null ? d : args[i] as T);
    switch (method) {
        // — network sim (PLAN-latency L0 validation) —
        case 'setNetSim':
            gpCtx.connection?.setNetSim(obj(0, {} as Parameters<Connection['setNetSim']>[0]));
            return null;
        // — render-loop freeze for deterministic screenshots —
        case 'pause':    gpRenderPaused = true;  return null;
        case 'resume':   gpRenderPaused = false; return null;
        case 'isPaused': return gpRenderPaused;
        // — selection —
        case 'select':
            gpCtx.selection?.setSelectionExternal(obj<number[]>(0, []));
            return null;
        case 'selection':
            return gpCtx.selection ? [...gpCtx.selection.selection] : [];
        // — entity position (interpolated, client-side) —
        case 'getEntityPosition':
            return gpCtx.entityRenderer?.getEntityPosition(num(0)) ?? null;
        // — per-envelope bandwidth tally (GW8 / PLAN-performance PC-2) —
        case 'netStats':
            return snapshotNetStats();
        // — per-phase frame-time distribution (PLAN-perf P0 attribution) —
        //   arg 0 = window ms (default 30 s); returns structured stats + a
        //   pre-formatted table.
        case 'perfDump':
            return gpFrameProfiler.dump(num(0, gpFrameProfiler.windowMs));
        case 'perfReset':
            gpFrameProfiler.reset();
            return null;
        // — per-def legacy entity-FX script cost (PLAN-fx-offload X5). Ranked
        //   most-expensive-first, same shape/convention as uiProfileDump. —
        case 'entityFxFenceDump':
            return gpEntityFxFence.dump();
        case 'entityFxFenceReset':
            gpEntityFxFence.reset();
            return null;
        // — per-widget LuaUI cost profile (PLAN-perf N1). start installs the
        //   Lua-side timing wrappers (widget-profiler.ts) and zeroes the JS
        //   fixed-tax accumulator; dump merges both into the P5-vs-Fengari
        //   report; stop restores the original widget callins. —
        case 'uiProfileStart': {
            const rt = getRuntime();
            if (!rt) return { error: 'LuaUI runtime not booted' };
            gpUiTaxReset();
            const err = widgetProfileStart(rt);
            return err ? { error: err } : { ok: true };
        }
        case 'uiProfileStop': {
            const rt = getRuntime();
            if (!rt) return { error: 'LuaUI runtime not booted' };
            const err = widgetProfileStop(rt);
            return err ? { error: err } : { ok: true };
        }
        case 'uiProfileDump': {
            const rt = getRuntime();
            const dump = rt ? widgetProfileDump(rt) : null;
            return buildUiProfileReport(gpUiTax, dump, num(0, 40));
        }
        // — generic JS eval against the worker global scope (GW8). Lets the
        //   main devtools console reach the worker-resident debug hooks
        //   (globalThis.__entityRenderer / __fxLightPool / __renderPipeline /
        //   __csm / __distortion / __muzzleFlare …) that the render-core move
        //   stranded in the worker. Dev-only; the result is made clone-safe. —
        case 'evalJs': {
            // Indirect eval runs in global scope, where the __* hooks live.
            const v = (0, eval)(String(args[0] ?? ''));  // eslint-disable-line no-eval
            const resolved = v && typeof (v as { then?: unknown }).then === 'function'
                ? await (v as Promise<unknown>) : v;
            return gpCloneSafe(resolved);
        }
        // — camera (animations return once started; main awaits the duration) —
        case 'focusOn':
            cam?.focusOn(num(0), num(1), num(2));
            return null;
        case 'lookAtPosition':
            cam?.lookAtPosition(num(0), num(1), num(2), num(3));
            return null;
        case 'setCameraHeight':
            gpSetCameraHeight(cam, num(0));
            return null;
        case 'cameraPose':    return cam?.getPose() ?? null;
        case 'setCameraPose': cam?.setPose(obj(0, { pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } }), num(1)); return null;
        case 'cameraOrbit':   cam?.orbit(obj(0, {})); return null;
        case 'cameraSnapToGround': cam?.snapToGround(num(0), num(1), obj(2, {})); return null;
        case 'cameraFitMap':  cam?.fitMap(obj(0, {})); return null;
        case 'cameraSaveSlot': cam?.saveSlot(num(0)); return null;
        case 'cameraLoadSlot': return cam?.loadSlot(num(0), num(1)) ?? false;
        case 'setTrackingCamera':
            // DEFERRED (GW8): the tracking-camera state machine lived on the
            // main-thread InputManager; not yet ported to the worker camera.
            postLog(2, '[gp:test] setTrackingCamera not yet wired in the worker — ignoring');
            return null;
        // — composite: resolve unit position(s) worker-side, then frame —
        case 'focusUnit': {
            const p = gpCtx.entityRenderer?.getEntityPosition(num(0));
            if (!p || !cam) return false;
            gpSetCameraHeight(cam, num(2, 800));
            cam.lookAtPosition(p.x, p.y, p.z, num(1, 600));
            return true;
        }
        case 'cameraSnapToUnit': {
            const p = gpCtx.entityRenderer?.getEntityPosition(num(0));
            if (!p || !cam) return false;
            cam.snapToGround(p.x, p.z, obj(1, {}));
            return true;
        }
        case 'cameraFitUnits': {
            if (!cam) return false;
            const pts: { x: number; y: number; z: number }[] = [];
            for (const id of obj<number[]>(0, [])) {
                const p = gpCtx.entityRenderer?.getEntityPosition(id);
                if (p) pts.push(p);
            }
            if (!pts.length) return false;
            cam.fitPoints(pts, obj(1, {}));
            return true;
        }
        // — PLAN-model-harness: orbit camera rig (window.test.orbit) —
        //   arg 0 = unitId | {x, z, radius?}; arg 1 = OrbitOpts. Starting the
        //   rig saves the RTS view; orbitStop restores it. Re-invoking while
        //   active retargets in place (def switch / wreck focus).
        case 'orbitStart': {
            if (!cam || !gpCamera) return false;
            const target = gpMakeOrbitTarget(args[0]);
            if (!target) return false;
            if (!gpOrbitRig) {
                gpOrbitSavedView = cam.saveView();
                gpOrbitRig = new OrbitRig(gpCamera, target, obj(1, {}));
            } else {
                gpOrbitRig.retarget(target);
                gpOrbitRig.set(obj(1, {}));
            }
            gpOrbitRig.frame(gpCamera.fov, gpAspect());
            return gpOrbitRig.state();
        }
        case 'orbitStop': {
            if (gpOrbitRig) {
                gpOrbitRig = null;
                if (gpOrbitSavedView && cam) cam.restoreView(gpOrbitSavedView, 0);
                gpOrbitSavedView = null;
            }
            return null;
        }
        case 'orbitSet':
            gpOrbitRig?.set(obj(0, {}));
            return gpOrbitRig?.state() ?? null;
        case 'orbitFrame':
            if (gpOrbitRig && gpCamera) {
                gpOrbitRig.frame(gpCamera.fov, gpAspect(), num(0, 0.7));
            }
            return gpOrbitRig?.state() ?? null;
        case 'orbitState':
            return gpOrbitRig?.state() ?? null;
        // — PLAN-model-harness: sun override + day–night cycle (test.sun) —
        case 'setSun': {
            const rig = gpEnsureSunRig();
            if (!rig) return null;
            if (args[0] == null) rig.restore();
            else rig.setSun(obj(0, {}));
            return rig.state();
        }
        case 'sunCycle': {
            const rig = gpEnsureSunRig();
            if (!rig) return null;
            const secondsPerDay = num(0, 0);
            if (secondsPerDay > 0) rig.startCycle(secondsPerDay, num(1, 60));
            else rig.stopCycle();
            return rig.state();
        }
        case 'getSun':
            return gpSunRig?.state()
                ?? { active: false, azimuthDeg: null, elevationDeg: null,
                     cycleSecondsPerDay: 0, cyclePhase: 0 };
        // — PLAN-model-harness: def-cache reads for the F8 panel's picker +
        //   capability probe (the DefCache lives worker-side post-GW8) —
        case 'listUnitDefs':
            return (gpDefCache?.getAllUnitDefs() ?? []).map((d) => ({
                defId: d.defId, name: d.name, humanName: d.humanName,
                flags: d.flags, mass: d.mass, xsize: d.xsize,
                metalCost: d.metalCost,
            }));
        case 'unitDefByName': {
            const name = String(args[0] ?? '');
            const d = (gpDefCache?.getAllUnitDefs() ?? []).find((x) => x.name === name);
            return d ? gpCloneSafe(d) : null;
        }
        // — PLAN-model-harness: world bounding sphere + E1 fallback probe —
        case 'entityBounds':
            return gpCtx.entityRenderer?.getEntityBounds(num(0)) ?? null;
        // — PLAN-model-harness: render-group toggles for the F8 panel —
        case 'setWireframe':
            if (gpScene) gpScene.forceWireframe = Boolean(args[0]);
            return null;
        // — PLAN-model-harness task 6: generic clip player. Clips are
        //   authored .glb AnimationGroups captured at model load; playback
        //   samples channels each render frame into the per-piece clip-pose
        //   override (see clip-player.ts for the fx-offload migration note). —
        case 'listClips':
            return gpCtx.entityRenderer?.getClipNames(num(0)) ?? null;
        case 'playClip': {
            const r = gpCtx.entityRenderer;
            if (!r) return { error: 'entity renderer not ready' };
            const unitId = num(0);
            const clipName = String(args[1] ?? '');
            const resolved = r.getClip(unitId, clipName);
            if (!resolved) {
                const known = r.getClipNames(unitId);
                return {
                    error: `no clip "${clipName}" on unit ${unitId} — `
                        + (known === null ? 'model still loading / unknown unit'
                            : known.length ? `has: ${known.join(', ')}` : 'model has no clips'),
                };
            }
            if (!gpClipPlayer) gpClipPlayer = new ClipPlayer(r);
            return gpClipPlayer.play(unitId, resolved.clip, resolved.restLocals, obj(2, {}));
        }
        case 'stopClip':
            gpClipPlayer?.stop();
            return null;
        case 'clipState':
            return gpClipPlayer?.state() ?? null;
        // — screenshot: OffscreenCanvas → PNG data URL (no FileReader in workers) —
        case 'screenshot': {
            const canvas = gpEngine?.getRenderingCanvas() as OffscreenCanvas | null;
            if (!canvas) throw new Error('no rendering canvas');
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return `data:image/png;base64,${btoa(binary)}`;
        }
        default:
            throw new Error(`unknown test method '${method}'`);
    }
}

/// Make a worker-side value safe to postMessage (structured-clone) back to main.
/// Babylon objects, functions, and circular graphs can't be cloned — JSON
/// round-trip strips them; on failure fall back to a string description so the
/// devtools console at least sees the type. (GW8 evalJs.)
function gpCloneSafe(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'number' || t === 'string' || t === 'boolean') return v;
    if (t === 'function') return `[function ${(v as { name?: string }).name || 'anonymous'}]`;
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return `[unserializable ${t}: ${String(v).slice(0, 120)}]`; }
}

/// Render aspect ratio for orbit auto-framing.
function gpAspect(): number {
    if (!gpEngine) return 16 / 9;
    return gpEngine.getRenderWidth() / Math.max(1, gpEngine.getRenderHeight());
}

/// Lazily build the sun rig once scene lighting exists (PLAN-model-harness §6).
function gpEnsureSunRig(): SunRig | null {
    if (!gpSunRig && gpCtx.sceneLighting) gpSunRig = new SunRig(gpCtx.sceneLighting);
    return gpSunRig;
}

/// Resolve a test-harness orbit target: a unit id tracks that entity's live
/// bounding sphere; an {x, z, radius?} point is a static ground anchor
/// (wreck inspection etc.).
function gpMakeOrbitTarget(spec: unknown): OrbitTarget | null {
    if (typeof spec === 'number') {
        const unitId = spec;
        return { getSphere: () => gpCtx.entityRenderer?.getEntityBounds(unitId) ?? null };
    }
    if (spec && typeof spec === 'object') {
        const p = spec as { x?: number; y?: number; z?: number; radius?: number };
        if (typeof p.x === 'number' && typeof p.z === 'number') {
            const sphere = {
                x: p.x,
                y: p.y ?? (gpCtx.entityRenderer?.getGroundHeight(p.x, p.z) ?? 0),
                z: p.z,
                radius: p.radius ?? 40,
            };
            return { getSphere: () => sphere };
        }
    }
    return null;
}

/// Force the worker camera to a fixed height above its look-at target (ports the
/// old TestHarness.setCameraHeight; RTSCamera has no direct height setter).
function gpSetCameraHeight(cam: RTSCamera | undefined, height: number): void {
    if (!cam) return;
    const dy = height - (cam.position.y - cam.target.y);
    const view = cam.saveView();
    view.pos.y += dy;
    cam.restoreView(view, 0);
}

// ── Input dispatch (exported for the dispatcher in lua-widget-worker.ts) ────

/// True when the model-harness orbit rig owns this view's pointer/key input —
/// the RTS camera AND drag-selection are suppressed while orbiting (drag is
/// the orbit gesture); LuaUI mouse dispatch still runs.
function gpOrbitOwnsView(viewId: number): boolean {
    return viewId === 0 && gpOrbitRig !== null;
}

export function gpHandlePointerMove(x: number, y: number, buttons: number, mods: number, viewId: number): void {
    if (gpOrbitOwnsView(viewId)) {
        gpOrbitRig!.pointerMove(x, y);
    } else {
        gpViewCameras.get(viewId)?.pointerMove(x, y, buttons);
        // PLAN-playable.md G3a/G3b: an armed build placement drives its ghost; an
        // in-flight area-attack / waypoint drag drives its overlay; otherwise the
        // pointer feeds selection hover / drag-box.
        if (gpBuildPlacement?.isActive) gpBuildPlacement.pointerMove(x, y, buttons, mods, viewId);
        else if (gpCommandModes?.isDragging) gpCommandModes.pointerMove(x, y, buttons, mods, viewId);
        else gpCtx.selection?.pointerMove(x, y, buttons, mods, viewId);
    }
    const sp = gpToSpringCoords(x, y);
    const dragBtn = (buttons & 1) ? 1 : (buttons & 4) ? 2 : (buttons & 2) ? 3 : 0;
    gpDispatchMouseMove(sp.x, sp.y, sp.x - gpLastMouseSpringX, sp.y - gpLastMouseSpringY, dragBtn);
    gpLastMouseSpringX = sp.x; gpLastMouseSpringY = sp.y;
}

export function gpHandlePointerDown(x: number, y: number, button: number, mods: number, viewId: number): void {
    const sp = gpToSpringCoords(x, y);
    const consumed = gpDispatchMousePress(sp.x, sp.y, domButtonToSpring(button));
    if (gpOrbitOwnsView(viewId)) {
        if (!consumed) gpOrbitRig!.pointerDown(x, y, button);
        return;
    }
    gpViewCameras.get(viewId)?.pointerDown(x, y, button, mods);
    if (consumed) return;
    // PLAN-playable.md G3a: a left-click during build placement captures the
    // click for placement (Spring's "active build command → LMB to place"),
    // before it can reach unit selection / drag-box (input-manager.onLeftDown).
    if (gpBuildPlacement?.pointerDown(x, y, button, mods, viewId)) return;
    // G3b: waypoint revoke/drag + area-attack drag start consume the press; a
    // plain armed modal does NOT (selection may still drag-box), resolving on up.
    if (gpCommandModes?.pointerDown(x, y, button, mods, viewId)) return;
    gpCtx.selection?.pointerDown(x, y, button, mods, viewId);
}

export function gpHandlePointerUp(x: number, y: number, button: number, mods: number, viewId: number): void {
    const sp = gpToSpringCoords(x, y);
    gpDispatchMouseRelease(sp.x, sp.y, domButtonToSpring(button));
    if (gpOrbitOwnsView(viewId)) {
        gpOrbitRig!.pointerUp();
        return;
    }
    gpViewCameras.get(viewId)?.pointerUp(x, y, button, mods);
    // G3a: commit the build placement if one is armed (consumes the release).
    if (gpBuildPlacement?.pointerUp(x, y, button, mods, viewId)) return;
    // G3b: commit an area-attack / waypoint drag, or resolve an armed modal on a
    // click. When it consumes, cancel any drag-box the selection started on the
    // same press (a plain-modal press let selection.pointerDown run).
    if (gpCommandModes?.pointerUp(x, y, button, mods, viewId)) { gpCtx.selection?.blur(); return; }
    gpCtx.selection?.pointerUp(x, y, button, mods, viewId);
}

export function gpHandleWheel(x: number, y: number, delta: number, viewId: number): void {
    if (gpOrbitOwnsView(viewId)) {
        gpOrbitRig!.wheel(delta);
    } else {
        gpViewCameras.get(viewId)?.wheel(x, y, delta);
    }
    gpDispatchMouseWheel(delta < 0, -delta);
}

export function gpHandleKeyDown(code: string, mods: number, viewId: number): void {
    if (!gpOrbitOwnsView(viewId)) gpViewCameras.get(viewId)?.keyDown(String(code).toLowerCase());
    gpSetShift((mods & 1) !== 0);
    // PLAN-playable.md G3b: order hotkeys (modal arms m/a/f/p/g/r/e/c/x/d/l/u +
    // instant s/w/h/q/i). A convenience layer over the faithful SetActiveCommand
    // path (see worker-command-modes header); fires alongside the LuaUI KeyPress
    // dispatch. No WASD binding, so no conflict with the camera's arrow movement.
    gpCommandModes?.handleOrderKey(String(code), mods);
    gpDispatchKeyPress(codeToSpringKeysym(String(code)), mods);
}

export function gpHandleKeyUp(code: string, mods: number, viewId: number): void {
    gpViewCameras.get(viewId)?.keyUp(String(code).toLowerCase());
    gpSetShift((mods & 1) !== 0);
    gpDispatchKeyRelease(codeToSpringKeysym(String(code)), mods);
}

export function gpHandlePointerLeave(viewId: number): void {
    if (viewId === 0) gpOrbitRig?.pointerUp();
    gpViewCameras.get(viewId)?.pointerLeave();
}

export function gpHandleBlur(viewId: number): void {
    if (viewId === 0) gpOrbitRig?.pointerUp();
    gpViewCameras.get(viewId)?.blur();
    gpCtx.selection?.blur();
    gpSetShift(false);
}

export function gpHandleFocusWorld(x: number, z: number, viewId: number): void {
    gpViewCameras.get(viewId)?.focusOn(x, z);
}

// ── Build placement (PLAN-playable.md G3a) ──────────────────────────────────

/// Arm build placement from the native BuildMenu (gp:startBuildPlacement).
/// Factories queue immediately; builders enter ghost-placement mode.
export function gpHandleStartBuildPlacement(defId: number, mods: { shift?: boolean; ctrl?: boolean }): void {
    gpBuildPlacement?.startBuildPlacement(defId, mods);
}

/// Cancel an armed build placement (gp:cancelBuildPlacement — ESC on main).
export function gpHandleCancelBuildPlacement(): void {
    gpBuildPlacement?.cancelBuildPlacement();
}

/// PLAN-playable.md G3b: cancel an armed modal command / in-flight area-attack
/// or waypoint drag (gp:cancelCommandMode — ESC on main, checked before the
/// build-ghost cancel + the quit dialog).
export function gpHandleCancelCommandMode(): void {
    gpCommandModes?.cancelAll();
}
