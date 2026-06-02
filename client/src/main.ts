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
let inputManager: InputManager | null = null;
/// GW4-c5b: thin main-thread DOM-input owner for the game view. Captures
/// pointer/wheel/key events on #game-canvas and forwards them to the
/// game-processor worker, where the interactive camera + scene.pick live.
let cameraInput: CameraInput | null = null;
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
/// quitToLobby(). The render loop checks `testRenderPaused` so a paused
/// session continues to receive entity-state updates (the connection is
/// independent of the render loop) while skipping `scene.render()`.
let testHarness: TestHarness | null = null;
let testRenderPaused = false;
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
    testHarness = null;
    testRenderPaused = false;
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
    audioManager = null;
    inputManager = null;
    cameraInput?.dispose();
    cameraInput = null;
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
            case 'gp:gameOver':
                showGameOver(gameTemplates, m.frame, { onReturnToLobby: quitToLobby });
                break;
            case 'gp:reload':
                console.log('[gameWorker] server restarting — reloading page');
                window.location.reload();
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
        standingOrderShowAllies:
            localStorage.getItem('luaui:standing-order-show-allies') === 'true',
    };
    gameWorker.postMessage(init, [offscreen]);

    // GW4-c5b: the interactive camera + scene.pick live in the worker, but the
    // canvas still receives DOM pointer/wheel events on the main thread (only its
    // render context was transferred). CameraInput captures them and forwards
    // canvas-relative input to the worker camera (view 0).
    cameraInput = new CameraInput(canvas, gameWorker, 0);

    // The worker owns the Engine + canvas now, so resize is forwarded to it.
    window.addEventListener('resize', () => {
        gameWorker?.postMessage({
            type: 'gp:resize',
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio || 1,
        });
    });
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
