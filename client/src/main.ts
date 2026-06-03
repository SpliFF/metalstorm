/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Flow: Login → Room Browser → Room Setup → Game
 */

import { Engine, Scene, FreeCamera, Mesh, MeshBuilder, StandardMaterial, Vector3, Color3, Color4 } from '@babylonjs/core';
// Side-effect import: registers Babylon's KTX2 loader + pins the
// transcoder asset URLs to a CDN copy. After the KTX2 migration every
// GPU texture (unit + feature + terrain + minimap) is `.ktx2`.
import './core/ktx2-config.js';
import { EntityRenderer, setLightingStyle, setUseZKMaterial } from './core/entity-renderer.js';
import { ProjectileRenderer } from './core/projectile-renderer.js';
import { ProjectileTextureResolver } from './core/projectile-texture-resolver.js';
import { CegRuntime } from './core/ceg-runtime.js';
import { BuildBeamRenderer } from './core/build-beam-renderer.js';
import { DefCache } from './core/def-cache.js';
import { CombatFX } from './core/combat-fx.js';
import { AudioManager } from './core/audio.js';
import { SoundEventPlayer } from './core/sound-events.js';
import { MusicDirector } from './core/music-director.js';
import { InputManager } from './core/input-manager.js';
import { AnimatedCursor } from './core/animated-cursor.js';
import { BuildMenu } from './core/build-menu.js';
import { OrderPanel } from './core/order-panel.js';
import { EconomyBar } from './core/economy-bar.js';
import { buildTerrainMesh, loadTerrainTextures, TerrainFog, DeformableTerrain, type MapDimensions } from './core/terrain.js';
import { BuildingPlateRenderer } from './core/building-plate-renderer.js';
import { DecalOverlay, buildTrackTypeNames } from './core/decal-overlay.js';
import { attachDecalOverlay } from './core/decal-overlay-plugin.js';
import { LobbyUI } from './lobby/lobby-ui.js';
import { Minimap } from './core/minimap.js';
import { LosBitmapStore } from './core/los-bitmap.js';
import { CommandPathRenderer } from './core/command-path-renderer.js';
import { WaypointMarkerRenderer } from './core/waypoint-marker-renderer.js';
import { StandingOrderRenderer } from './core/standing-order-renderer.js';
import { DebugTerrainGrid } from './core/debug-terrain-grid.js';
import { Connection } from './core/connection.js';
import { PresentationClock } from './core/presentation-clock.js';
import { TimingOverlay } from './core/timing-overlay.js';
import { fetchBuildStamp, CONFIG } from './config.js';
import GameWorker from './core/lua-widget-worker.ts?worker';
import type { GpInitToWorker } from './core/game-worker-protocol.js';
import { fetchMapDataHttp, type ParsedMapData } from './core/map-data.js';
import { loadMapLighting, type MapLighting } from './core/map-lighting.js';
import { applyMapLighting, createSceneLighting, type SceneLighting } from './core/scene-lighting.js';
import { PerfOverlay } from './core/perf-overlay.js';
import { resetNetStats } from './core/net-inspector.js';
import { FxLightPool } from './core/fx-light-pool.js';
import { DistortionRenderer } from './core/distortion-renderer.js';
import { MuzzleFlareRenderer } from './core/muzzle-flare-renderer.js';
import { setActiveFxLightPool } from './core/zk-model-material.js';
import { clientSettings } from './core/client-settings.js';
import { setParticleBudget } from './core/ceg-translator.js';
import { sendCameraViewport } from './core/viewport.js';
import { installCameraWindowApi, uninstallCameraWindowApi } from './core/camera-window-api.js';
import { fetchAndIngestDefs } from './core/defs-fetch.js';
import { renderMapFeatures, DynamicFeatureRenderer } from './core/feature-renderer.js';
import { CameraInput } from './core/camera-input.js';
import { LuaWidgetManager } from './core/lua-widget-manager.js';
import { TestHarness } from './core/test-harness.js';
import { ScenarioRunner } from './scenarios/runner.js';
import { createHUD, showHUD, updateHUD, updateSpeedHUD } from './ui/hud/hud.js';
import { showQuitConfirm } from './ui/quit-confirm/quit-confirm.js';
import { showGameOver } from './ui/game-over/game-over.js';
import { debugConsole } from './core/debug-console.js';
import { logIngest } from './core/log-ingest.js';
import {
    getDefaultLobbyTemplates,
    loadGameLobbyTemplates,
} from './ui/lobby/loader.js';
import {
    getDefaultGameTemplates,
    loadGameTemplates,
    type GameTemplates,
} from './ui/game/loader.js';

// Active in-game templates. Starts with engine defaults; overwritten when
// a game id is resolved (URL param, localStorage, or room selection).
// createHUD / showQuitConfirm / showGameOver read from this at call time.
let gameTemplates: GameTemplates = getDefaultGameTemplates();

let engine: Engine | null = null;
/// Game-processor worker (PLAN-game-worker.md GW4). Owns the Babylon Engine on
/// the transferred #game-canvas. From GW4-c1 the world render lives here, not
/// on `engine` above (which stays declared but unused on main until the render
/// modules + their disposal move into the worker across c2–c6).
let gameWorker: Worker | null = null;
/// GW8 tooling bridge. The test harness (window.test) + widget eval
/// (window.widgets.eval) live on main but their state lives in the worker;
/// `workerCall()` issues a `gp:test`/`evalLua` request and resolves the
/// matching reply by id. `lastSceneState` caches the worker's ~10 Hz feed so
/// the harness's read-only getters (selection, cameraPose) stay synchronous.
let gpReqId = 0;
const gpPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let evalReqResolve: ((v: string) => void) | null = null;
let lastSceneState: {
    selectedUnitIds: number[];
    camera: { x: number; y: number; z: number; tx: number; ty: number; tz: number };
} | null = null;
/// Issue a client-bound request to the game-processor worker (GW8). Resolves
/// with the worker's reply value or rejects with its error string.
function workerCall(method: string, args: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const w = gameWorker;
        if (!w) { reject(new Error('[test] game worker not running')); return; }
        const id = ++gpReqId;
        gpPending.set(id, { resolve, reject });
        w.postMessage({ type: 'gp:test', id, method, args });
    });
}
let perfOverlay: PerfOverlay | null = null;
let entityRenderer: EntityRenderer | null = null;
/// Presentation clock — the L0 timing spine (PLAN-latency.md). Converts the
/// frame-stamped snapshot stream into a smooth presentation cursor P that the
/// entity renderer interpolates to. Created once; the per-game ServerClock is
/// attached when the game connection opens. Exposed on window.__presClock for
/// the perf overlay + the latency-injection test tool.
const presentationClock = new PresentationClock();
(window as unknown as { __presClock: PresentationClock }).__presClock = presentationClock;
/// Timing telemetry panel for the presentation clock (F10). Separate from the
/// perf overlay (F11). Created lazily in the bootstrap once the DOM exists.
let timingOverlay: TimingOverlay | null = null;
let buildingPlateRenderer: BuildingPlateRenderer | null = null;
let projectileRenderer: ProjectileRenderer | null = null;
let buildBeamRenderer: BuildBeamRenderer | null = null;
let dynamicFeatureRenderer: DynamicFeatureRenderer | null = null;
let cegRuntime: CegRuntime | null = null;
let combatFX: CombatFX | null = null;
let fxLightPool: FxLightPool | null = null;
// PLAN.md Stage B1: flips true once ZK's authored projectile lights start
// arriving via the WG.DeferredLighting registry, so the projectile renderer
// silences its invented muzzle/follow light stand-ins (drift #1).
let authoredProjectileLightsActive = false;
let distortionRenderer: DistortionRenderer | null = null;
let muzzleFlareRenderer: MuzzleFlareRenderer | null = null;
let decalOverlay: DecalOverlay | null = null;
let audioManager: AudioManager | null = null;
/// GW4-c5c-2: audio playback stays on the main thread (AudioContext is main-only).
/// The worker decodes SoundEvents + resolves their SoundRef against its def cache,
/// then posts resolved pairs (`gp:audioSoundEvents`) / music transitions
/// (`gp:audioMusic`) here for SoundEventPlayer / MusicDirector to play.
let soundEventPlayer: SoundEventPlayer | null = null;
let musicDirector: MusicDirector | null = null;
/// MusicDirector.arm() gates music start on the scene being live; we open it on
/// the first scene-state tick from the worker (terrain is up by then).
let musicArmed = false;
let inputManager: InputManager | null = null;
/// GW4-c5b: thin main-thread DOM-input owner for the game view. Captures
/// pointer/wheel/key events on #game-canvas and forwards them to the
/// game-processor worker, where the interactive camera + scene.pick live.
let cameraInput: CameraInput | null = null;
/// GW4-c5c-3: unsubscribe handle for the gfx.* → worker `gp:config` push.
/// Set in startGame, cleared on teardown so we don't leak a subscriber (or
/// post to a terminated worker) across game sessions.
let gfxConfigUnsub: (() => void) | null = null;
/// GW4-c5b-2: the drag-select rectangle overlay. The worker computes the box
/// (CSS px, canvas-relative) and posts `gp:dragBox`; we draw the div here.
let dragOverlay: HTMLDivElement | null = null;
function updateDragOverlay(box: { x0: number; y0: number; x1: number; y1: number } | null): void {
    if (!box) { if (dragOverlay) dragOverlay.style.display = 'none'; return; }
    if (!dragOverlay) {
        const div = document.createElement('div');
        div.id = 'drag-select-overlay';
        div.style.position = 'fixed';
        div.style.border = '1px solid rgba(255, 220, 60, 0.9)';
        div.style.background = 'rgba(255, 220, 60, 0.12)';
        div.style.pointerEvents = 'none';
        div.style.zIndex = '50';
        document.body.appendChild(div);
        dragOverlay = div;
    }
    // Box coords are canvas-relative CSS px; offset by the canvas position so
    // the fixed-position div lines up even if the canvas isn't at (0,0).
    const rect = document.getElementById('game-canvas')?.getBoundingClientRect();
    const ox = rect?.left ?? 0;
    const oy = rect?.top ?? 0;
    dragOverlay.style.display = 'block';
    dragOverlay.style.left = `${ox + box.x0}px`;
    dragOverlay.style.top = `${oy + box.y0}px`;
    dragOverlay.style.width = `${box.x1 - box.x0}px`;
    dragOverlay.style.height = `${box.y1 - box.y0}px`;
}
let animatedCursor: AnimatedCursor | null = null;
let buildMenu: BuildMenu | null = null;
let orderPanel: OrderPanel | null = null;
let economyBar: EconomyBar | null = null;
let lobbyUI: LobbyUI | null = null;
let minimap: Minimap | null = null;
let commandPathRenderer: CommandPathRenderer | null = null;
let waypointMarkerRenderer: WaypointMarkerRenderer | null = null;
let standingOrderRenderer: StandingOrderRenderer | null = null;
let debugTerrainGrid: DebugTerrainGrid | null = null;
/// TestHarness on `window.test` — exposed in startGame(), torn down on
/// quitToLobby(). GW8: server-bound verbs run on main over HTTP; client-bound
/// (camera/selection/netSim/pause/screenshot) forward to the worker, where the
/// render loop now lives (the client render-pause is `gpRenderPaused` there).
let testHarness: TestHarness | null = null;
/// Current sim-speed multiplier for VISUAL FX aging (0 when paused). The
/// render loop scales its wall-clock dt by this before ticking the FX
/// systems (CEG particles, dynamic lights, muzzle flares, distortion,
/// combat FX) so every weapon effect plays out in sim time — slowing or
/// freezing with the game speed. That makes transient FX capturable
/// (drop the speed or pause and they linger) and is more faithful (the
/// engine ages these by sim frame). Set from onGameInfo. Camera/UI ticks
/// keep using the raw wall dt.
let fxSimSpeed = 1;
/// Capture aid: when armed (window.__captureOnFire), the next projectile
/// fire freezes the client FX clock after a short delay so the beam +
/// muzzle flash + impact all hang on screen for a screenshot — no race
/// with the wall clock. Server keeps running; only the visual FX freeze.
/// `window.__captureResume()` (or any speed change) thaws it.
let fxFrozen = false;
let captureOnFireDelayMs: number | null = null;
/// Last server-reported sim speed (for thaw + the fxFrozen override).
let lastServerSpeed = 1;
let lastServerPaused = false;

/// Freeze for capture. The SERVER is the single authority for pause/speed
/// (server_main.cpp gates SimFrame on gs->paused), so freezing pauses the
/// server — units, projectiles, sounds, combat events ALL stop coherently
/// at the source, no client-side event gating needed. We also zero the
/// client FX clock immediately so the frame freezes crisply before the
/// pause round-trips. Thawed by window.__captureResume().
function freezeFx(): void {
    fxFrozen = true;
    fxSimSpeed = 0;
    projectileRenderer?.setSimSpeed(0);
    void testHarness?.simPause();
    console.log('[capture] frozen (server paused) — screenshot now; window.__captureResume() to thaw');
}
/// Cached most-recent command-queue snapshot. Lets a selection change
/// repaint the path overlay without waiting for the next server tick.
let lastCommandQueues: ReadonlyArray<{
    unitId: number;
    orders: ReadonlyArray<{ cmdId: number; params: number[]; tag?: number }>;
}> = [];
/// Game server connection. Non-null while a game is active. Hoisted out
/// of startGame() so the quit-to-lobby handler can close it cleanly.
let gameConn: Connection | null = null;

/// Monotonic session counter. Each startGame() captures the current
/// value; quitToLobby() and subsequent startGame() bumps it. Async
/// callbacks (mapPromise, defsPromise, onMapData) compare against
/// the snapshot before doing work — anything from a stale session
/// bails out, preventing the "quit during loading" leak where a
/// late-resolving fetch builds a LuaWidgetManager (and its overlay
/// canvas) for a game that no longer exists.
let activeSession = 0;

// --- Game Scene ---

let currentFrame = 0;

/// Tear down the active game session and show the lobby browser. Safe to
/// call from any in-game context: "Quit" button, ESC-confirm, Game Over
/// overlay, or an error handler. No-op if no game is active.
function quitToLobby(): void {
    // Bump session: any in-flight async work from this session (map
    // fetch, defs fetch, queued onMapData) will see a stale token and
    // bail before creating widget managers / canvases.
    activeSession++;

    // Close the game connection cleanly before disposing the renderer —
    // that way any "player left" hint reaches the game server before
    // our send queue gets torn down.
    gameConn?.disconnect();
    gameConn = null;

    // Clear saved game state so a page refresh lands on the lobby.
    localStorage.removeItem('springrts-game-room');
    localStorage.removeItem('springrts-game-port');

    // Tear down Babylon + the per-session helpers. Most of these hold
    // references to the engine/scene, so letting GC collect them is
    // enough — we just drop our handles. The minimap is an exception:
    // it owns its own engine/canvas parented to #minimap-container,
    // and that container persists across game sessions. Without an
    // explicit dispose the next startGame() would append a second
    // canvas to the container.
    // Widget manager — inside the startGame scope, but we stash a
    // dispose callback on window so quitToLobby can reach it.
    (window as any).__widgetManagerDispose?.();
    delete (window as any).__widgetManagerDispose;

    minimap?.dispose();
    minimap = null;
    buildMenu?.dispose();
    buildMenu = null;
    orderPanel?.dispose();
    orderPanel = null;
    economyBar?.dispose();
    economyBar = null;
    commandPathRenderer?.dispose();
    commandPathRenderer = null;
    waypointMarkerRenderer?.dispose();
    waypointMarkerRenderer = null;
    standingOrderRenderer?.dispose();
    standingOrderRenderer = null;
    debugTerrainGrid?.dispose();
    debugTerrainGrid = null;
    lastCommandQueues = [];
    inputManager?.dispose();
    inputManager = null;
    cameraInput?.dispose();
    cameraInput = null;
    gfxConfigUnsub?.();
    gfxConfigUnsub = null;
    animatedCursor?.dispose();
    animatedCursor = null;
    // Game-processor worker owns the Engine + transferred canvas (GW4).
    // Terminating it tears down the Babylon Engine inside the worker; the
    // canvas itself is replaced with a fresh clone on the next startGame().
    gameWorker?.terminate();
    gameWorker = null;
    engine?.stopRenderLoop();
    engine?.dispose();
    engine = null;
    uninstallCameraWindowApi();
    delete (window as any).test;
    delete (window as any).widgets;
    testHarness = null;
    // GW8: drop any in-flight worker-bridge requests + cached feed.
    for (const p of gpPending.values()) p.reject(new Error('[test] game ended'));
    gpPending.clear();
    evalReqResolve = null;
    lastSceneState = null;
    entityRenderer = null;
    buildingPlateRenderer = null;
    projectileRenderer = null;
    buildBeamRenderer?.dispose();
    buildBeamRenderer = null;
    cegRuntime?.dispose();
    cegRuntime = null;
    combatFX = null;
    fxLightPool?.dispose();
    fxLightPool = null;
    distortionRenderer?.dispose();
    distortionRenderer = null;
    muzzleFlareRenderer?.dispose();
    muzzleFlareRenderer = null;
    musicDirector = null;
    soundEventPlayer = null;
    musicArmed = false;
    audioManager?.dispose();
    audioManager = null;

    // Hide the game canvas and HUD. Any in-flight overlays (quit confirm,
    // game over) are removed here too so the lobby is the only thing left.
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (canvas) canvas.style.display = 'none';
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'none';
    document.getElementById('quit-confirm-overlay')?.remove();
    document.getElementById('game-over-overlay')?.remove();

    // Show the lobby. The lobby connection stayed open the whole
    // time. If the player is still a member of their room (the normal
    // case after a mid-game quit) land on the room view; otherwise
    // fall through to the room browser.
    lobbyUI?.showAfterGame();
    lobbyUI?.show();
}

async function startGame(gameServerPort: number, mapId: string, gameId: string = ''): Promise<void> {
    // Capture this call's session id. Late-arriving promise callbacks
    // (mapPromise, defsPromise, onMapData) compare against this and
    // bail when activeSession has moved on — covers the case where a
    // user quits mid-load and the queued mapData fetch resolves into
    // an orphaned LuaWidgetManager / overlay canvas after teardown.
    activeSession++;
    // NOTE (GW4-c1): the per-call `session` snapshot + its stale-session
    // guards lived in the gutted body; they return in c2 when the connection
    // callbacks (which compare against activeSession) move into the worker.

    // Defensive teardown of any leftover session state. `quitToLobby`
    // normally runs this on explicit quit, but a player can re-enter
    // a game through paths that don't go via quitToLobby — for
    // example a room state change transitions straight into a new
    // startGame(). Without this, the old minimap canvas would
    // stay parented to #minimap-container and the new Minimap would
    // append a second canvas on top of it.
    //
    // Also dispose any leftover widget manager from a previous session.
    // Without this, startGame leaks a widget worker each call, and
    // orphaned workers keep running their 30Hz frame loops in the
    // background — a likely contributor to the widget shutdown loop.
    (window as any).__widgetManagerDispose?.();
    delete (window as any).__widgetManagerDispose;

    if (minimap) {
        minimap.dispose();
        minimap = null;
    }
    if (gameWorker) {
        gameWorker.terminate();
        gameWorker = null;
    }
    if (engine) {
        engine.stopRenderLoop();
        engine.dispose();
        engine = null;
    }
    if (gameConn) {
        gameConn.disconnect();
        gameConn = null;
    }
    entityRenderer = null;
    buildingPlateRenderer = null;
    cegRuntime?.dispose();
    cegRuntime = null;
    combatFX = null;
    fxLightPool?.dispose();
    fxLightPool = null;
    distortionRenderer?.dispose();
    distortionRenderer = null;
    muzzleFlareRenderer?.dispose();
    muzzleFlareRenderer = null;
    musicDirector = null;
    soundEventPlayer = null;
    musicArmed = false;
    audioManager?.dispose();
    audioManager = null;
    inputManager = null;
    cameraInput?.dispose();
    cameraInput = null;
    gfxConfigUnsub?.();
    gfxConfigUnsub = null;
    buildMenu?.dispose();
    buildMenu = null;
    orderPanel?.dispose();
    orderPanel = null;
    economyBar?.dispose();
    economyBar = null;

    showHUD();

    // PLAN-game-worker.md GW4-c1: the world render moves into the
    // game-processor worker. Main relinquishes #game-canvas via
    // transferControlToOffscreen(), so it can no longer create a Babylon
    // Engine on it — the entire main-thread render construction, render
    // loop, and Connection wiring that lived here is gone. The worker
    // rebuilds it across c2–c6 (connection+decoders → terrain → entities
    // → FX → LuaUI world pass). Until c4 the branch's game is intentionally
    // non-running (empty clear-color scene); see PLAN-game-worker.md.

    // #game-canvas is a static element in index.html and can only be
    // transferred to an OffscreenCanvas once. Replace it with a fresh clone
    // on every startGame() so re-entry (quit → relaunch) can transfer again.
    const staleCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const canvas = staleCanvas.cloneNode(false) as HTMLCanvasElement;
    staleCanvas.replaceWith(canvas);
    canvas.style.display = 'block';

    // Build game server URL
    const host = window.location.hostname || 'localhost';
    const gameHttpUrl = `http://${host}:${gameServerPort}`;
    // Empty base = page-origin /api (Vite dev proxy in dev, nginx in prod).
    const lobbyHttpUrl = '';

    // Snapshot the gfx.* settings for the worker — it can't read
    // clientSettings' localStorage-backed store directly. Live changes will
    // arrive over a 'gp:config' message once that bridge lands (GW5).
    const gfx: Record<string, unknown> = {};
    for (const def of clientSettings.defs()) {
        if (def.key.startsWith('gfx.')) gfx[def.key] = clientSettings.get(def.key);
    }

    const dpr = window.devicePixelRatio || 1;
    const offscreen = canvas.transferControlToOffscreen();
    gameWorker = new GameWorker();
    gameWorker.onerror = (e) => {
        console.error('[gameWorker] error:',
            e.message || '(no detail)',
            e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
            e.error?.stack ?? '');
    };
    // Worker → main bridge (PLAN-game-worker.md GW4). The full sceneState /
    // audio / minimap feeds land in GW5; at c2 only the connection-lifecycle
    // signals the worker raises (auth, game-over, server-restart) are handled.
    gameWorker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        switch (m?.type) {
            case 'gp:authenticated':
                console.log(`[gameWorker] authenticated playerId=${m.playerId} team=${m.team}`);
                break;
            // GW4-c5c: consolidated scene-state feed → the HTML HUD (the only
            // main-thread world-fact consumer reconnected here; ZK economy /
            // build-menu / order-panel are chili widgets in the worker, c6).
            case 'gp:sceneState':
                // GW8: cache for the test harness's synchronous getters
                // (window.test.selection / .cameraPose()).
                lastSceneState = { selectedUnitIds: m.selectedUnitIds, camera: m.camera };
                updateHUD(m.entityCount, m.gameFrame, m.selectedUnitIds);
                updateSpeedHUD(m.simSpeed, m.paused);
                // GW4-c5c-3: keep the minimap selection rings in sync with the
                // worker's selection set (the minimap matches ids against blips).
                minimap?.setSelection(m.selectedUnitIds);
                // GW4-c5c-2: keep the audio listener glued to the camera so 3D
                // panning matches the view. Forward = (target - position).
                if (audioManager) {
                    const c = m.camera;
                    audioManager.setListenerPosition(
                        c.x, c.y, c.z, c.tx - c.x, c.ty - c.y, c.tz - c.z);
                }
                break;
            // GW4-c5c-3: worker minimap feed → main-thread minimap (own Engine).
            // `map` arrives once (dims + backdrop); `los` only when a new fog
            // snapshot shipped; blips every feed. Render is driven here (~6 Hz)
            // since main has no game render loop post-GW4.
            case 'gp:minimapFeed':
                if (minimap) {
                    if (m.map) {
                        minimap.setMapDimensions(m.map.width, m.map.height);
                        void minimap.loadBackground(m.map.baseUrl);
                    }
                    if (m.los) {
                        minimap.applyLosBitmap({ allyTeam: 0, frame: 0, ...m.los });
                    }
                    minimap.applyFeed(m.blips);
                    minimap.render();
                }
                break;
            // GW4-c5c-2: resolved sound events / music transitions from the worker.
            case 'gp:audioSoundEvents':
                soundEventPlayer?.handleResolvedBatch(m.events);
                break;
            case 'gp:audioMusic':
                // Open the music gate on the first transition (scene is live).
                if (musicDirector && !musicArmed) { musicDirector.arm(); musicArmed = true; }
                musicDirector?.handleMusicEvent(m.state, m.fadeMs);
                break;
            case 'gp:gameOver':
                showGameOver(gameTemplates, m.frame, { onReturnToLobby: quitToLobby });
                break;
            // GW8: reply to a window.test client-bound request.
            case 'gp:testResult': {
                const p = gpPending.get(m.id);
                if (p) {
                    gpPending.delete(m.id);
                    if (m.ok) p.resolve(m.value);
                    else p.reject(new Error(String(m.error ?? 'worker test error')));
                }
                break;
            }
            // GW8: reply to a window.widgets.eval() Lua eval (worker evalLua).
            case 'evalResult':
                evalReqResolve?.(String(m.result ?? 'nil'));
                evalReqResolve = null;
                break;
            case 'gp:reload':
                console.log('[gameWorker] server restarting — reloading page');
                window.location.reload();
                break;
            // GW4-c5b-2: the worker owns selection/pick but the drag-box overlay
            // is a DOM concern — draw it here in CSS-pixel space.
            case 'gp:dragBox':
                updateDragOverlay(m.box);
                break;
            // GW4-c5b-3 (Bucket-3): the worker has no access to the page's
            // localStorage — persist worker-owned UI prefs here (e.g. the
            // standing-order show-allies toggle). Booleans store as 'true'/'false'.
            case 'gp:config':
                try {
                    const v = typeof m.value === 'boolean' ? String(m.value)
                        : typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
                    localStorage.setItem(m.key, v);
                } catch { /* ignore quota / private-mode */ }
                break;
            // Worker postLog() output. Until the LuaWidgetManager's log bridge
            // is folded back in (GW5/GW8), surface it on the page console (and
            // thus the log server via logIngest) so the worker isn't a black box.
            case 'log': {
                const lvl = m.level ?? 1;
                const text = `[worker] ${m.msg}`;
                if (lvl >= 4) console.error(text);
                else if (lvl >= 3) console.warn(text);
                else console.log(text);
                break;
            }
            case 'error':
                console.error(`[worker] ${m.msg}`);
                break;
            default:
                break;
        }
    };
    const init: GpInitToWorker = {
        type: 'gp:init',
        canvas: offscreen,
        gameHttpUrl,
        lobbyUrl: lobbyHttpUrl,
        username: localStorage.getItem('springrts-username') ?? '',
        token: localStorage.getItem('springrts-token') ?? '',
        gameId,
        mapId,
        defsCacheKey: '',
        buildStamp: CONFIG.buildStamp,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr,
        gfx,
        // Canonical key matches StandingOrderRenderer's SHOW_ALLIES_KEY; default
        // true (only an explicit 'false' hides allies). The worker persists
        // changes back here via a `gp:config` message (Bucket-3).
        standingOrderShowAllies:
            localStorage.getItem('standing-orders-show-allies') !== 'false',
    };
    gameWorker.postMessage(init, [offscreen]);

    // GW4-c5b: the interactive camera + scene.pick live in the worker, but the
    // canvas still receives DOM pointer/wheel events on the main thread (only its
    // render context was transferred). CameraInput captures them and forwards
    // canvas-relative input to the worker camera (view 0).
    cameraInput = new CameraInput(canvas, gameWorker, 0);

    // GW4-c5c-3: live gfx.* settings → worker. The worker's clientSettings was
    // seeded with the snapshot in `gp:init`; this forwards every later change so
    // a quality toggle in the settings panel re-tunes the worker's render
    // pipeline / FX gating without a restart (the worker routes it through its
    // own clientSettings.set → subscribers). Only gfx.* keys cross — audio etc.
    // are owned on main.
    gfxConfigUnsub = clientSettings.subscribeAll((value, key) => {
        if (key.startsWith('gfx.')) gameWorker?.postMessage({ type: 'gp:config', key, value });
    });

    // GW4-c5c-3: minimap on the main thread (own Babylon Engine + DOM canvas
    // parented to #minimap-container). The entity renderer + connection live in
    // the worker now, so the minimap takes neither — it renders from the
    // worker's `gp:minimapFeed` (blips + fog + map dims) via applyFeed. Initial
    // dims are placeholders; the first feed carries the real map size + backdrop.
    const minimapContainer = document.getElementById('minimap-container');
    if (minimapContainer) {
        minimap = new Minimap(
            { mapWidth: 8192, mapHeight: 8192, parentElement: minimapContainer, size: 200 },
            null);
        // Left-click → re-centre the worker's world camera (the camera is in the
        // worker; the focus intent crosses the boundary as `gp:focusWorld`).
        minimap.onCameraMove = (x, z) => {
            gameWorker?.postMessage({ type: 'gp:focusWorld', x, z });
        };
        document.getElementById('detach-minimap-btn')
            ?.addEventListener('click', () => minimap?.detach());
    }

    // GW4-c5c-2: audio playback chain on the main thread (AudioContext is
    // main-only). The worker resolves SoundEvent → SoundRef against its def
    // cache and posts the resolved pairs (`gp:audioSoundEvents`); music
    // transitions arrive as `gp:audioMusic`. The content base points at the
    // game's preprocessed `data/games/<id>/` root (where the .webm SFX live).
    const soundContentBaseUrl = gameId
        ? `${lobbyHttpUrl}/api/games/data/${gameId}/`
        : `${lobbyHttpUrl}/`;
    audioManager = new AudioManager();
    soundEventPlayer = new SoundEventPlayer(audioManager, soundContentBaseUrl);
    musicDirector = new MusicDirector(audioManager, soundContentBaseUrl);
    musicArmed = false;
    // AudioContext can't start until a user gesture — resume on first click.
    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // The worker owns the Engine + canvas now, so resize is forwarded to it.
    window.addEventListener('resize', () => {
        gameWorker?.postMessage({
            type: 'gp:resize',
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio || 1,
        });
    });

    // GW8: re-plumb the dev/test tooling for the worker split.
    //   window.test     — server-bound verbs run on main over HTTP; camera /
    //                      selection / netSim / pause / screenshot forward to
    //                      the worker via workerCall(); selection + cameraPose
    //                      read the cached gp:sceneState feed synchronously.
    //   window.widgets  — Lua eval bridge to the in-worker LuaUI runtime
    //                      (the spring-debug `evaluate_widget_lua` path).
    testHarness = new TestHarness({
        gameHttpUrl,
        token: localStorage.getItem('springrts-token') ?? '',
        workerCall,
        getSelection: () => lastSceneState?.selectedUnitIds ?? [],
        getCameraPose: () => {
            const c = lastSceneState?.camera;
            if (!c) return null;
            return { pos: { x: c.x, y: c.y, z: c.z }, lookAt: { x: c.tx, y: c.ty, z: c.tz } };
        },
    });
    (window as any).test = testHarness;

    (window as any).widgets = {
        /** Evaluate a Lua snippet in the in-worker LuaUI runtime; resolves with
         *  the result's string form (or 'timeout'). Serialised — one in flight. */
        eval(code: string): Promise<string> {
            return new Promise((resolve) => {
                if (!gameWorker) { resolve('no worker'); return; }
                if (evalReqResolve) { resolve('busy'); return; }
                let done = false;
                evalReqResolve = (v) => { done = true; resolve(v); };
                gameWorker.postMessage({ type: 'evalLua', code });
                window.setTimeout(() => {
                    if (!done) { evalReqResolve = null; resolve('timeout'); }
                }, 5000);
            });
        },
    };
}

// --- Boot ---

/// Resolve which game (if any) the lobby UI should style itself for at
/// boot time. Order of precedence:
///   1. `?game=<id>` URL query parameter (browser link, dev override)
///   2. `springrts-game-id` localStorage key (sticky across reloads)
///   3. none (engine default UI)
///
/// CLI startup of the client (e.g. `npm run dev -- --game papertanks`)
/// is forwarded into the URL by the host launcher, so the same path
/// covers both browser and packaged-app entry points.
function resolveInitialGameId(): string | null {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('game');
    if (fromUrl) {
        // Persist URL choices so a refresh keeps the same skin without
        // having to re-pass the query string.
        localStorage.setItem('springrts-game-id', fromUrl);
        return fromUrl;
    }
    return localStorage.getItem('springrts-game-id');
}

document.addEventListener('DOMContentLoaded', async () => {
    await fetchBuildStamp();
    createHUD(gameTemplates, { onQuit: () => showQuitConfirm(gameTemplates, { onConfirm: quitToLobby }) });
    debugConsole.init();
    // Capture window.onerror, unhandledrejection, console.error/warn and
    // batch-POST them to the log server so every browser-side error is
    // discoverable via spring-debug + the in-game console SSE stream.
    logIngest.install();

    // Hide canvas until game starts
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'none';

    // Global ESC handler: toggle the quit-to-lobby confirmation. Only
    // active while a game is running (detected by a non-null `engine`),
    // so ESC stays free for lobby UI dialogs.
    //
    // InputManager has its own ESC handler that cancels build placement
    // and pending modal commands. Both listeners are on `window`, and
    // stopPropagation doesn't suppress sibling listeners on the same
    // node, so we have to check InputManager's state up front and bail —
    // otherwise pressing ESC mid-placement clears the ghost AND opens
    // the quit dialog at the same time.
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!engine) return;
        if (inputManager?.isPlacingBuild || inputManager?.hasPendingCommand()) return;
        e.preventDefault();
        showQuitConfirm(gameTemplates, { onConfirm: quitToLobby });
    });

    // Scenario mode (`?scenario=<name>`) hijacks the boot flow: clear
    // any stale saved session so the lobby's auto-login doesn't race
    // with the runner's fresh login, then let the runner orchestrate
    // login → room → start.
    const scenario = ScenarioRunner.fromUrl();
    if (scenario) {
        localStorage.removeItem('springrts-token');
        localStorage.removeItem('springrts-username');
        localStorage.removeItem('springrts-game-room');
        localStorage.removeItem('springrts-game-port');
    }

    // Show lobby with the engine-default templates immediately so the
    // login screen renders without waiting on a network round-trip.
    lobbyUI = new LobbyUI((gameServerPort: number, mapId: string, gameId: string) => {
        startGame(gameServerPort, mapId, gameId);
    }, getDefaultLobbyTemplates());
    (window as any).lobby = lobbyUI;

    if (scenario) {
        // Fire and forget — the runner publishes progress and results
        // on `window.scenarioResults` for external pickup.
        const runner = new ScenarioRunner(scenario, lobbyUI, () => testHarness);
        runner.start();
    }

    // If a game id is known up front, fire-and-forget the override
    // bundle fetch and hot-swap the templates as soon as it lands.
    // Each per-file override falls back to the bundled default, so a
    // missing or partial override gracefully degrades.
    const initialGameId = resolveInitialGameId();
    if (initialGameId) {
        // Empty base = relative URL; see scope-local `lobbyHttpUrl`
        // comment above for rationale (commit 78027e4004 moved static
        // assets off the lobby; relative paths route through Vite +
        // proxy in dev and nginx in prod).
        loadGameLobbyTemplates(initialGameId, '')
            .then((templates) => lobbyUI?.setTemplates(templates))
            .catch((err) => console.warn('[lobby] game UI override failed:', err));

        loadGameTemplates(initialGameId, '')
            .then((templates) => {
                gameTemplates = templates;
                // Re-create HUD with the game's overridden templates. The
                // HUD was already built above with engine defaults — swap
                // it now that the override has landed. Re-attaches the
                // quit button listener.
                createHUD(gameTemplates, { onQuit: () => showQuitConfirm(gameTemplates, { onConfirm: quitToLobby }) });
            })
            .catch((err) => console.warn('[game] game UI override failed:', err));
    }
});
