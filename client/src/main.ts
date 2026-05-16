/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Flow: Login → Room Browser → Room Setup → Game
 */

import { Engine, Scene, FreeCamera, Mesh, MeshBuilder, StandardMaterial, Vector3, HemisphericLight, DirectionalLight, Color3, Color4 } from '@babylonjs/core';
// Register the KTX2 / Basis Universal texture loader. After the
// migration to KTX2 every GPU texture (unit + feature + terrain +
// minimap) is `.ktx2`; the loader transcodes UASTC/ETC1S to whichever
// compressed format the GPU prefers (BC7/ASTC/ETC2/BC3).
import '@babylonjs/core/Materials/Textures/Loaders/ktxTextureLoader.js';
import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js';

// Pin the KTX2 transcoder asset URLs. The decoder lazily downloads its
// JS module + WASM transcoders + Zstd decoder on first KTX2 load; the
// stock defaults leave `wasmZSTDDecoder` null and rely on each
// transcoder's hard-coded fallback path, which has historically been
// flaky (one missing module sinks every KTX2 load with the misleading
// "BasisLzEtc1sImageTranscoder.decodePalettes — Cannot convert
// undefined to unsigned int" error). Setting every URL explicitly
// makes the dependency chain auditable in DevTools' Network tab.
const KTX2_CDN = 'https://cdn.babylonjs.com';
KhronosTextureContainer2.URLConfig = {
    jsDecoderModule:        `${KTX2_CDN}/babylon.ktx2Decoder.js`,
    wasmUASTCToASTC:        `${KTX2_CDN}/ktx2Transcoders/1/uastc_astc.wasm`,
    wasmUASTCToBC7:         `${KTX2_CDN}/ktx2Transcoders/1/uastc_bc7.wasm`,
    wasmUASTCToRGBA_UNORM:  `${KTX2_CDN}/ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm`,
    wasmUASTCToRGBA_SRGB:   `${KTX2_CDN}/ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm`,
    wasmUASTCToR8_UNORM:    `${KTX2_CDN}/ktx2Transcoders/1/uastc_r8_unorm.wasm`,
    wasmUASTCToRG8_UNORM:   `${KTX2_CDN}/ktx2Transcoders/1/uastc_rg8_unorm.wasm`,
    jsMSCTranscoder:        `${KTX2_CDN}/ktx2Transcoders/1/msc_basis_transcoder.js`,
    wasmMSCTranscoder:      `${KTX2_CDN}/ktx2Transcoders/1/msc_basis_transcoder.wasm`,
    wasmZSTDDecoder:        `${KTX2_CDN}/zstddec.wasm`,
};
import { EntityRenderer } from './core/entity-renderer.js';
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
import { buildTerrainMesh, loadTerrainTextures, TerrainFog, type MapDimensions } from './core/terrain.js';
import { LobbyUI } from './lobby/lobby-ui.js';
import { Minimap } from './core/minimap.js';
import { LosBitmapStore } from './core/los-bitmap.js';
import { CommandPathRenderer } from './core/command-path-renderer.js';
import { WaypointMarkerRenderer } from './core/waypoint-marker-renderer.js';
import { StandingOrderRenderer } from './core/standing-order-renderer.js';
import { DebugTerrainGrid } from './core/debug-terrain-grid.js';
import { Connection } from './core/connection.js';
import { CONFIG, fetchBuildStamp, stampUrl } from './config.js';
import { fetchMapDataHttp, type ParsedMapData } from './core/map-data.js';
import { fetchAndIngestDefs } from './core/defs-fetch.js';
import { renderMapFeatures, DynamicFeatureRenderer } from './core/feature-renderer.js';
import { RTSCamera } from './core/rts-camera.js';
import { LuaWidgetManager } from './core/lua-widget-manager.js';
import { TestHarness } from './core/test-harness.js';
import { injectStyle, renderTemplate } from './ui/ui.js';
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
let entityRenderer: EntityRenderer | null = null;
let projectileRenderer: ProjectileRenderer | null = null;
let buildBeamRenderer: BuildBeamRenderer | null = null;
let dynamicFeatureRenderer: DynamicFeatureRenderer | null = null;
let cegRuntime: CegRuntime | null = null;
let combatFX: CombatFX | null = null;
let audioManager: AudioManager | null = null;
let inputManager: InputManager | null = null;
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

// --- HUD ---

function createHUD(): void {
    // Remove a previous HUD if present (e.g. after a template hot-swap).
    document.getElementById('game-hud')?.remove();
    document.getElementById('hud-style')?.remove();

    injectStyle('hud-style', gameTemplates.hudCss);

    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.display = 'none'; // hidden until game starts
    hud.innerHTML = gameTemplates.hudHtml;
    document.body.appendChild(hud);

    // Quit is reachable via ESC (toggle quit-confirm) and the in-game
    // chili menu (F10 → widget list / game menu). The HUD's static Quit
    // button was removed because it sat under the chili HUD bar; if a
    // future template re-adds #hud-quit-btn this guard simply skips.
    document.getElementById('hud-quit-btn')?.addEventListener('click', () => {
        showQuitConfirm();
    });
}

function showHUD(): void {
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'block';
}

function updateHUD(entityCount: number, frame: number, selectedIds: readonly number[]): void {
    const elEntities = document.getElementById('hud-entities');
    const elFrame = document.getElementById('hud-frame');
    const elSelected = document.getElementById('hud-selected');

    if (elEntities) elEntities.textContent = `Entities: ${entityCount}`;
    if (elFrame) elFrame.textContent = `Frame: ${frame}`;
    if (elSelected) {
        if (selectedIds.length === 0) elSelected.textContent = 'No selection';
        else if (selectedIds.length === 1) elSelected.textContent = `Selected: unit ${selectedIds[0]}`;
        else elSelected.textContent = `Selected: ${selectedIds.length} units`;
    }
}

// --- Viewport ---

function sendCameraViewport(camera: FreeCamera, connection: Connection): void {
    if (!connection.authenticated) return;

    // The server filters entity-state snapshots to only those inside
    // the viewport rectangle. When we sized the rectangle off
    // `camera.position.y * tan(fov/2)`, zooming in dropped the
    // viewport to ~100 elmos wide — any unit outside that tiny box
    // was filtered out, the client received an empty full-snapshot,
    // and `EntityRenderer.update()` wiped its `entityMeta` map.
    // Entity counter on the HUD dropped to 0 and every unit vanished
    // until the camera zoomed back out enough for them to re-enter
    // the box.
    //
    // Pragmatic fix: always send a viewport that comfortably covers
    // an entire typical map. 16k elmos is bigger than wanderlust /
    // scorched_crossing / pools_of_ilys, so the server effectively
    // passes everything through. Proper frustum-on-ground math for
    // the tilted camera is a future optimisation — when we start
    // running maps or unit counts big enough that viewport filtering
    // buys us real bandwidth, we can revisit.
    const fov = camera.fov;
    const height = Math.max(camera.position.y, 1);
    const visibleHeight = 16384;
    const visibleWidth = 16384;

    const dir = camera.getTarget().subtract(camera.position).normalize();
    const t = dir.y !== 0 ? -camera.position.y / dir.y : 0;
    const groundX = camera.position.x + dir.x * Math.max(t, 0);
    const groundZ = camera.position.z + dir.z * Math.max(t, 0);
    const rotation = Math.atan2(dir.x, dir.z);
    // zoomLevel is metadata for LOD selection on the server; keep the
    // same height-based heuristic we used before.
    const zoomLevel = Math.max(1, height / 100);
    void fov;

    connection.sendViewportUpdate(0, groundX, groundZ, visibleWidth, visibleHeight, rotation, zoomLevel);
}

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
    animatedCursor?.dispose();
    animatedCursor = null;
    engine?.stopRenderLoop();
    engine?.dispose();
    engine = null;
    delete (window as any).camera;
    delete (window as any).test;
    testHarness = null;
    testRenderPaused = false;
    entityRenderer = null;
    projectileRenderer = null;
    buildBeamRenderer?.dispose();
    buildBeamRenderer = null;
    cegRuntime?.dispose();
    cegRuntime = null;
    combatFX = null;
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

/// Show an "are you sure?" overlay with Quit / Cancel buttons. Toggle-safe:
/// calling this while the overlay is already visible closes it instead
/// (so ESC works as an open/close toggle).
function showQuitConfirm(): void {
    const existing = document.getElementById('quit-confirm-overlay');
    if (existing) {
        existing.remove();
        return;
    }

    injectStyle('quit-confirm-style', gameTemplates.quitConfirmCss);

    const overlay = document.createElement('div');
    overlay.id = 'quit-confirm-overlay';
    overlay.innerHTML = gameTemplates.quitConfirmHtml;
    document.body.appendChild(overlay);

    document.getElementById('quit-cancel-btn')?.addEventListener('click', () => {
        overlay.remove();
    });
    document.getElementById('quit-confirm-btn')?.addEventListener('click', () => {
        quitToLobby();
    });
}

function showGameOver(frame: number): void {
    injectStyle('game-over-style', gameTemplates.gameOverCss);

    const overlay = document.createElement('div');
    overlay.id = 'game-over-overlay';
    overlay.innerHTML = renderTemplate(gameTemplates.gameOverHtml, { frame });
    document.body.appendChild(overlay);

    document.getElementById('return-lobby-btn')?.addEventListener('click', () => {
        quitToLobby();
    });
}

async function startGame(gameServerPort: number, mapId: string, gameId: string = ''): Promise<void> {
    // Capture this call's session id. Late-arriving promise callbacks
    // (mapPromise, defsPromise, onMapData) compare against this and
    // bail when activeSession has moved on — covers the case where a
    // user quits mid-load and the queued mapData fetch resolves into
    // an orphaned LuaWidgetManager / overlay canvas after teardown.
    activeSession++;
    const session = activeSession;

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
    cegRuntime?.dispose();
    cegRuntime = null;
    combatFX = null;
    audioManager = null;
    inputManager = null;
    buildMenu?.dispose();
    buildMenu = null;
    orderPanel?.dispose();
    orderPanel = null;
    economyBar?.dispose();
    economyBar = null;

    showHUD();

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'block';

    // Build game server URL
    const host = window.location.hostname || 'localhost';
    const gameHttpUrl = `http://${host}:${gameServerPort}`;
    const lobbyHttpUrl = CONFIG.httpUrl; // static asset host

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    // Preserve the depth buffer across rendering groups so water
    // (group 1) depth-tests against the terrain already drawn in
    // group 0, and units (group 2) depth-test against both. Babylon
    // defaults to auto-clearing depth + stencil at the start of
    // every rendering group, which would let an opaque water plane
    // render on top of a mountain just because it's in a higher
    // group. See entity-renderer.ts + the water block below for
    // the corresponding renderingGroupId assignments.
    scene.setRenderingAutoClearDepthStencil(1, false, true, true);
    scene.setRenderingAutoClearDepthStencil(2, false, true, true);
    scene.setRenderingAutoClearDepthStencil(3, false, true, true);

    // Default camera pointing at origin — repositioned when MapData arrives
    const camera = new FreeCamera('camera', new Vector3(0, 1200, -1500), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.minZ = 1;
    camera.maxZ = 50000;

    // RTS controls — WASD pan, wheel zoom, edge scrolling, and
    // middle-mouse drag to yaw/tilt. Replaces the default FreeCamera
    // mouse-look input.
    const rtsCamera = new RTSCamera(camera, canvas, {
        minHeight: 150,
        maxHeight: 6000,
        panSpeed: 1000,
        // Small per-notch step; tick() eases the actual distance toward
        // the target over several frames for a smooth feel.
        zoomStep: 0.08,
    });

    // Expose camera API globally for JS console, LuaUI bridge, and automation.
    // All methods accept an optional durationMs parameter: 0 = instant jump,
    // >0 = animate over that many milliseconds with smooth ease-in-out.
    //
    // The surface deliberately covers four caller categories so each gets a
    // single discoverable entry point:
    //   - JS console / dev tools          (this object directly)
    //   - chrome-devtools MCP             (via evaluate_script on this object)
    //   - TestHarness / spring-test MCP   (forwards through these primitives)
    //   - Lua widgets                     (Spring.SetCameraState / SetCameraTarget
    //                                       /GetCameraState — wired in lua-spring-api)
    (window as any).camera = {
        // ── Pose primitives ─────────────────────────────────────────
        /** Read the current pose. */
        getPose: () => rtsCamera.getPose(),
        /** Set both camera position and look-at point. */
        setPose: (pose: any, durationMs?: number) => rtsCamera.setPose(pose, durationMs),

        // ── Snap / point ───────────────────────────────────────────
        /** Snap to a ground point. opts: {height?, pitchDeg?, durationMs?} */
        snapToGround: (x: number, z: number, opts: any = {}) => rtsCamera.snapToGround(x, z, opts),
        /** Snap to a unit by ID. opts: {height?, pitchDeg?, durationMs?} */
        snapToUnit: (unitId: number, opts: any = {}) => {
            const p = entityRenderer?.getEntityPosition(unitId);
            if (!p) throw new Error(`[camera] no client-side position for unit ${unitId}`);
            rtsCamera.snapToGround(p.x, p.z, opts);
        },
        /** Look at an arbitrary 3D point ({x,y,z}). */
        pointAt: (p: any, durationMs?: number) => rtsCamera.pointAt(p, durationMs),

        // ── Movement ───────────────────────────────────────────────
        /** Absolute camera position; preserves look direction. */
        moveTo: (p: any, durationMs?: number) => rtsCamera.moveTo(p, durationMs),
        /** Relative camera translation (also translates look-at). */
        moveBy: (delta: any, durationMs?: number) => rtsCamera.moveBy(delta, durationMs),

        // ── Orbit ──────────────────────────────────────────────────
        /** Orbit around current look-at. opts: {yawDeg?, pitchDeg?, distance?, durationMs?} */
        orbit: (opts: any = {}) => rtsCamera.orbit(opts),
        /** Set heading (degrees CW from +Z). */
        setHeading: (yawDeg: number, durationMs?: number) => rtsCamera.setHeading(yawDeg, durationMs),
        /** Set downward pitch (degrees). */
        setPitch: (pitchDeg: number, durationMs?: number) => rtsCamera.setPitch(pitchDeg, durationMs),
        /** Set camera-to-target distance. */
        setDistance: (d: number, durationMs?: number) => rtsCamera.setDistance(d, durationMs),

        // ── Fit + saved slots ──────────────────────────────────────
        /** Top-down view sized to the entire map. */
        fitMap: (opts: any = {}) => rtsCamera.fitMap(opts),
        /** Save current pose to a numbered slot (Spring F2..F6 convention). */
        saveSlot: (slot: number) => rtsCamera.saveSlot(slot),
        /** Recall a numbered slot. Returns false if empty. */
        loadSlot: (slot: number, durationMs?: number) => rtsCamera.loadSlot(slot, durationMs),
        /** True if a saved slot has a stored pose. */
        hasSlot: (slot: number) => rtsCamera.hasSlot(slot),

        // ── Legacy aliases (kept for backwards compat) ─────────────
        /** Move camera to look at world XZ position. */
        focusOn: (x: number, z: number, durationMs?: number) => rtsCamera.focusOn(x, z, durationMs),
        /** Move camera to look at a 3D world position, keeping current distance. */
        lookAt: (x: number, y: number, z: number, durationMs?: number) => rtsCamera.lookAtPosition(x, y, z, durationMs),
        /** Save current camera view for later restoration. */
        saveView: () => rtsCamera.saveView(),
        /** Restore a previously saved view. */
        restoreView: (view: any, durationMs?: number) => rtsCamera.restoreView(view, durationMs),
        /** Rotate camera around current target by degrees. Positive yaw = clockwise from above. */
        rotateAroundTarget: (yawDeg: number, pitchDeg?: number, durationMs?: number) =>
            rtsCamera.rotateAroundTarget(yawDeg, pitchDeg, durationMs),
        /** Cancel any running camera animation. */
        cancel: () => rtsCamera.cancelTransition(),
        /** Whether an animation is currently running. */
        get animating() { return rtsCamera.isAnimating; },
        /** Current look-at position {x, y, z}. */
        get target() { const t = rtsCamera.target; return { x: t.x, y: t.y, z: t.z }; },
        /** Current camera position {x, y, z}. */
        get position() { const p = rtsCamera.position; return { x: p.x, y: p.y, z: p.z }; },
    };

    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.7;
    ambient.diffuse = new Color3(0.8, 0.85, 1.0);
    ambient.groundColor = new Color3(0.3, 0.25, 0.2);

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.3).normalize(), scene);
    sun.intensity = 1.5;
    sun.diffuse = new Color3(1.0, 0.95, 0.85);

    entityRenderer = new EntityRenderer(scene);
    projectileRenderer = new ProjectileRenderer(scene);
    buildBeamRenderer = new BuildBeamRenderer(scene);
    buildBeamRenderer.setEntityRenderer(entityRenderer);
    if (gameId) buildBeamRenderer.setGameAssetsBaseUrl(gameId);

    // CEG particle runtime — muzzle flashes, impact bursts, debris.
    // Lives parallel to the projectile renderer; spawn calls happen
    // from inside the renderer's onFired/onImpact hooks once injected.
    cegRuntime = new CegRuntime(scene);
    projectileRenderer.setCegRuntime(cegRuntime);

    // Resolve weapon-def texture names → KTX2 URLs. Async load of
    // resources.json + the bitmaps manifests; the renderer can be
    // built before init() resolves and consults the resolver lazily
    // when it sees the first weapon def with a texture name.
    if (gameId) {
        const resolver = new ProjectileTextureResolver();
        projectileRenderer.setTextureResolver(resolver);
        cegRuntime.setTextureResolver(resolver);
        resolver.init(gameId, lobbyHttpUrl).catch((e) => {
            console.warn('[main] projectile texture resolver init failed:', e);
        });
    }
    audioManager = new AudioManager();

    // SoundEventPlayer routes server SoundEvents → AudioManager. Built
    // here so it shares the same DefCache the renderers consume; the
    // content base URL points at the game's `data/games/<id>/` root.
    const soundContentBaseUrl = gameId
        ? `${lobbyHttpUrl}/api/games/data/${gameId}/`
        : `${lobbyHttpUrl}/`;

    // Debug hooks — exposed for chrome-devtools introspection.
    (window as unknown as { __scene: unknown }).__scene = scene;
    (window as unknown as { __entityRenderer: unknown }).__entityRenderer = entityRenderer;
    (window as unknown as { __buildBeamRenderer: unknown }).__buildBeamRenderer = buildBeamRenderer;
    (window as unknown as { __projectileRenderer: unknown }).__projectileRenderer = projectileRenderer;

    // DefCache accumulates defs as the server streams them incrementally.
    // Listeners forward new defs to the renderers that need them.
    const defCache = new DefCache();
    // CombatFX needs both cegRuntime (created above) and the def cache
    // to look up the firing weapon's CEG name; construct after both
    // are in hand so it doesn't fall back to procedural spheres for
    // every impact.
    combatFX = new CombatFX(scene, audioManager, cegRuntime, defCache);
    (window as unknown as { __defCache: unknown }).__defCache = defCache;

    // Dynamic feature renderer — handles runtime-spawned features
    // (wrecks from unit death, gadget-spawned debris, reclaim removals).
    // Map-placed features still go through `renderMapFeatures` once on
    // MapData. Both can share the same model .glb on disk; the dynamic
    // renderer owns its own mesh pool so the static path's
    // thin-instance buffer stays read-only.
    dynamicFeatureRenderer = new DynamicFeatureRenderer(scene, defCache);
    (window as unknown as { __dynamicFeatureRenderer: unknown }).__dynamicFeatureRenderer =
        dynamicFeatureRenderer;
    defCache.onUnitDefs((newDefs) => {
        entityRenderer?.setUnitDefs(newDefs);
        currentWidgetManager?.forwardUnitDefs(newDefs);
    });
    defCache.onWeaponDefs((newDefs) => {
        projectileRenderer?.setWeaponDefs(newDefs);
        currentWidgetManager?.forwardWeaponDefs(newDefs);
    });
    // Streamed CEG defs land in the runtime as authored EffectDefs,
    // overriding the BUILTIN_EFFECTS hand-ports for any tag the game
    // actually defines. Tags missing from the stream still resolve
    // through the built-in archetype dispatch (see projectile-renderer).
    defCache.onCegDefs((newDefs) => {
        cegRuntime?.ingestCegDefs(newDefs);
    });

    const soundEventPlayer = new SoundEventPlayer(audioManager, defCache, soundContentBaseUrl);

    // MusicDirector subscribes to server MusicEvents and crossfades
    // a random track from the per-state playlist (built from
    // gamedata/sounds.lua `music_<state>_<n>` SoundItems). The
    // worker hands the playlist over via lua-widget-manager after
    // the SoundItem load completes.
    const musicDirector = new MusicDirector(audioManager, soundContentBaseUrl);

    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // Terrain state — populated when MapData arrives
    let terrainMesh: Mesh | null = null;
    let terrainFog: TerrainFog | null = null;
    let currentMapData: ParsedMapData | null = null;
    let currentWidgetManager: LuaWidgetManager | null = null;
    const losBitmapStore = new LosBitmapStore();

    const onMapData = (map: ParsedMapData): void => {
        // Stale callback from a session the user has already quit. Bail
        // before constructing renderers / widget managers — the parent
        // scope's engine has been disposed by quitToLobby and creating
        // a LuaWidgetManager here leaks an orphan overlay canvas.
        if (session !== activeSession) {
            console.log('[client] ignoring stale MapData (session moved on)');
            return;
        }
        if (currentMapData) {
            console.log('[client] ignoring duplicate MapData');
            return;
        }
        currentMapData = map;
        console.log(`[client] MapData received: ${map.mapx}x${map.mapy}, ` +
            `${map.features.length} features, ${map.startPositions.length} start positions`);

        // Hand the map to the input manager so metal extractor placement
        // can snap to spots derived from the metalmap.
        inputManager?.setMapData(map);
        commandPathRenderer?.setMapData(map);
        waypointMarkerRenderer?.setMapData(map);
        standingOrderRenderer?.setMapData(map);
        debugTerrainGrid?.setMapData(map);

        // Apply map-wide reverb (mapinfo.lua → sound.preset). The
        // AudioManager fetches sounds/efx/<preset>.webm from the map's
        // content root; missing IRs stay in passthrough so a map that
        // names a preset without shipping the IR works as if no preset
        // were set. "default" / empty is a no-op.
        if (audioManager && map.soundPreset) {
            const mapBaseUrl = map.mapSourceUrl.startsWith('http')
                ? map.mapSourceUrl
                : `${lobbyHttpUrl}${map.mapSourceUrl}`;
            void audioManager.setReverbPreset(map.soundPreset, mapBaseUrl);
        }
        entityRenderer?.setMapHeightmap(
            map.heightmap, map.mapx, map.mapy,
            map.minHeight, map.maxHeight, map.squareSize,
        );

        // Wire the camera's terrain clamp + fitMap framing now that the
        // heightmap and map dimensions are known. Both pulls come from
        // EntityRenderer so the camera never holds its own copy.
        if (entityRenderer) {
            rtsCamera.setGroundSampler((x, z) => entityRenderer!.getGroundHeight(x, z));
        }
        rtsCamera.setMapBounds(map.widthElmos, map.heightElmos);

        // Absolute URL for HTTP resources (lobby-served)
        const mapBaseUrl = lobbyHttpUrl + map.mapDataUrl;

        // Position camera at map centre
        const cx = map.widthElmos / 2;
        const cz = map.heightElmos / 2;
        camera.position.set(cx, 1200, cz - 1500);
        camera.setTarget(new Vector3(cx, 0, cz));
        rtsCamera.recomputeAxes();
        rtsCamera.focusOn(cx, cz);

        // Build terrain mesh from embedded heightmap
        const mapDims: MapDimensions = {
            mapx: map.mapx, mapy: map.mapy,
            minHeight: map.minHeight, maxHeight: map.maxHeight,
            tilesX: map.tilesX, tilesZ: map.tilesZ,
        };
        terrainMesh = buildTerrainMesh(scene, mapDims, map.heightmap);
        console.log('[client] terrain mesh built from MapData heightmap');

        // Open the music gate. Per PLAN-audio.md the gate covers
        // terrain + first entity batch + preload SoundItems; we use
        // terrain build as the proxy since it's the latest of the
        // three for any non-trivial game. Any MusicEvent that fired
        // before this point applies its latest state here.
        musicDirector.arm();

        // Fog-of-war overlay — heightmap-following translucent black
        // mesh that the per-allyteam LOS bitmap (envelope 0x07) paints
        // each second. Sits a few elmos above terrain in
        // renderingGroupId=1 so opaque water + terrain composite first
        // and units (group 2) draw on top.
        terrainFog = new TerrainFog();
        terrainFog.build(scene, mapDims, map.heightmap);
        // Re-apply any bitmap that arrived before the mesh existed so
        // the fog paints on first frame rather than waiting for the
        // next per-second tick.
        losBitmapStore.forEach(bitmap => terrainFog?.apply(bitmap));

        // Debug helper: window.__toggleTerrain() flips terrain visibility.
        // Useful for spotting overlay geometry (command paths, ghosts) that
        // might be hidden under the surface.
        (window as unknown as { __toggleTerrain: () => void }).__toggleTerrain = () => {
            if (terrainMesh) {
                terrainMesh.isVisible = !terrainMesh.isVisible;
                console.log(`[debug] terrain visible=${terrainMesh.isVisible}`);
            }
        };
        // Debug helper: window.__toggleFog() flips the fog overlay.
        let fogVisible = true;
        (window as unknown as { __toggleFog: () => void }).__toggleFog = () => {
            if (!terrainFog) return;
            fogVisible = !fogVisible;
            terrainFog.setVisible(fogVisible);
            console.log(`[debug] terrain fog visible=${fogVisible}`);
        };

        // Load DXT1 tile textures via HTTP
        if (map.tilesX > 0 && map.tilesZ > 0) {
            loadTerrainTextures(scene, terrainMesh, mapBaseUrl, mapDims).catch(e => {
                console.warn('[client] terrain texture loading failed:', e);
            });
        }

        // Render the fallback water plane. Maps with voidWater=true have
        // disabled Spring's built-in water renderer, typically because
        // they ship a Lua widget to draw custom fluid (lava, acid, etc.)
        // — the widget host below will run that widget.
        if (!map.water.voidWater) {
            const water = MeshBuilder.CreateGround('water', {
                width: map.widthElmos,
                height: map.heightElmos,
            }, scene);
            water.position.x = map.widthElmos / 2;
            water.position.z = map.heightElmos / 2;
            water.position.y = 0;
            water.isPickable = false;
            // Put water in its own rendering group *after* terrain
            // (which stays in the default group 0). Scene-level
            // `setRenderingAutoClearDepthStencil(1, false)` below
            // preserves the depth buffer from group 0 into group 1,
            // so the water depth-tests against every terrain fragment
            // already in the buffer and cannot render on top of a
            // mountain by winning the opaque front-to-back sort.
            // Before this, fully-opaque water on maps with
            // `surfaceAlpha = 1.0` (Scorched Crossing's lava) could
            // appear to float on top of terrain at oblique camera
            // angles because Babylon's bounding-sphere sort flipped
            // the water plane ahead of terrain in the opaque queue,
            // and the combination with backFaceCulling=false made
            // the z-resolution unreliable right at the y=0 plane.
            water.renderingGroupId = 1;
            const wmat = new StandardMaterial('waterMat', scene);
            const [r, g, b] = map.water.baseColor;
            wmat.diffuseColor = new Color3(r, g, b);
            wmat.emissiveColor = new Color3(r * 0.3, g * 0.3, b * 0.3);
            wmat.specularColor = new Color3(0.2, 0.2, 0.2);
            wmat.alpha = Math.max(0.4, map.water.surfaceAlpha);
            wmat.backFaceCulling = false;
            water.material = wmat;
            console.log(`[water] plane rendered: baseColor=(${r.toFixed(2)},${g.toFixed(2)},${b.toFixed(2)}) damage=${map.water.damage} alpha=${wmat.alpha.toFixed(2)}`);
        }

        // Render features. Loads each unique feature def's .glb model
        // asynchronously and thin-instances every placement of that type.
        // Types without a converted model fall back to placeholder boxes.
        renderMapFeatures(scene, map).catch((err) => {
            console.error('[features] renderMapFeatures failed', err);
        });

        // Wire the minimap: update dimensions and load the same DXT1 atlas
        // as the main terrain via its own Babylon engine.
        if (minimap) {
            minimap.setMapDimensions(map.widthElmos, map.heightElmos);
            minimap.loadBackground(mapBaseUrl, mapDims);
        }

        // Load LuaUI widgets via the widget manager. Discovers all
        // available widgets for the game, fetches sources, and loads
        // them in a single shared Lua state.
        // URL param `?nowidgets` disables widget loading entirely —
        // useful for isolating widget-induced browser crashes.
        // URL param `?widgetTest` (or `=name`) loads only the named
        // widget (default: dbg_render_test) — for isolating gl bridge
        // and Chili rendering issues without 100+ widgets in the way.
        const urlParams = new URLSearchParams(location.search);
        const widgetsDisabled = urlParams.has('nowidgets');
        const widgetTestParam = urlParams.get('widgetTest');
        const soloWidget = widgetTestParam === '' || widgetTestParam === '1' || widgetTestParam === 'true'
            ? 'dbg_render_test'
            : widgetTestParam;
        if (gameId && !widgetsDisabled) {
            const mgr = new LuaWidgetManager(scene, camera, {
                ...map,
                mapSourceUrl: lobbyHttpUrl + map.mapSourceUrl,
            }, {
                gameId,
                lobbyUrl: lobbyHttpUrl,
                soloWidget: soloWidget ?? undefined,
            });
            mgr.setLiveDataSources(rtsCamera, conn, audioManager ?? undefined);
            mgr.setMusicDirector(musicDirector);
            if (animatedCursor) mgr.setAnimatedCursor(animatedCursor);
            mgr.forwardMapFeatures(map.features);
            // Seed the worker with any defs that arrived before the
            // manager existed (def stream can race MapData arrival).
            mgr.forwardUnitDefs(defCache.getAllUnitDefs());
            mgr.forwardWeaponDefs(defCache.getAllWeaponDefs());
            // Push the lobby's room roster (humans + AI slots) into the
            // worker so Spring.GetPlayerList/GetTeamList/etc. return real
            // data. Without this widgets see only the local player. The
            // lobby is the only source for these in single-host mode —
            // the game server's auth response carries just myTeam.
            const room = lobbyUI?.room;
            if (room) {
                const players = room.players.map((p) => ({
                    id: p.playerId,
                    name: p.username,
                    spectator: p.isSpectator,
                    team: p.team,
                    allyTeam: p.team,
                }));
                const aiPlayers = room.aiSlots.map((ai, i) => ({
                    id: 1000 + i,
                    name: ai.displayName,
                    spectator: false,
                    team: ai.team,
                    allyTeam: ai.team,
                }));
                const allTeams = new Set<number>();
                for (const p of room.players) allTeams.add(p.team);
                for (const a of room.aiSlots) allTeams.add(a.team);
                allTeams.add(1); // gaia
                const teams = [...allTeams].map((tid) => ({
                    id: tid,
                    allyTeam: tid,
                    isAi: room.aiSlots.some((a) => a.team === tid),
                    leader: room.players.find((p) => p.team === tid)?.playerId ?? -1,
                }));
                mgr.setRoster({ players: [...players, ...aiPlayers], teams });
            }
            // Route widget-driven selection (Spring.SelectUnit and friends)
            // through the InputManager so the highlight, minimap, and build
            // menu update the same as a click-driven selection.
            mgr.onSelectionRequest = (ids) => inputManager?.setSelectionFromWidget(ids);
            // Route widget-driven camera moves (Spring.SetCameraTarget) to
            // the RTS camera. Spring's smoothness is seconds-ish; cap at 2s
            // and treat 0 as a teleport. Y is ignored — the RTS camera owns
            // its own height.
            mgr.onCameraTargetRequest = (x, z, smoothness) => {
                const durationMs = smoothness > 0 ? Math.min(2000, smoothness * 1000) : 0;
                rtsCamera.focusOn(x, z, durationMs);
            };
            // Full Spring.SetCameraState — translate the Recoil-shape
            // table into our pose primitives. We honour every field the
            // RTS camera understands; mode/name are silently ignored
            // (this fork ships only one camera mode). Widgets typically
            // pass either {tx,ty,tz} (target) or {px,py,pz} (position)
            // or both; we accept any subset and fall back to the
            // current value for missing components.
            mgr.onCameraStateRequest = (state, smoothness) => {
                const durationMs = smoothness > 0 ? Math.min(2000, smoothness * 1000) : 0;
                const cur = rtsCamera.getPose();
                const numF = (v: unknown, def: number) =>
                    typeof v === 'number' && Number.isFinite(v) ? v : def;
                const px = numF(state.px, cur.pos.x);
                const py = numF(state.py, cur.pos.y);
                const pz = numF(state.pz, cur.pos.z);
                const tx = numF(state.tx, cur.lookAt.x);
                const ty = numF(state.ty, cur.lookAt.y);
                const tz = numF(state.tz, cur.lookAt.z);
                rtsCamera.setPose({
                    pos: { x: px, y: py, z: pz },
                    lookAt: { x: tx, y: ty, z: tz },
                }, durationMs);
                // `dist` after a pose set lets widgets that only sent a
                // target (no position) still adjust orbit distance.
                if (typeof state.dist === 'number' && Number.isFinite(state.dist)) {
                    rtsCamera.setDistance(state.dist, 0);
                }
            };
            // The chili integral menu's build-button click resolves to
            // Spring.SetActiveCommand(idx, ...) for whatever build sits
            // at `idx` in the selected unit's cmd-descs. Route negative
            // cmdIds (build commands) into InputManager so the click
            // actually starts a build — without this, the chili API
            // round-trips happily inside the worker but no order ever
            // reaches the server. Non-build cmdIds are a no-op for now;
            // widgets that want move/stop/attack/etc. call
            // Spring.GiveOrderToUnit directly.
            //
            // Right-click on a build icon cancels the active placement,
            // matching Spring's "RMB clears the active command" idiom.
            mgr.onSetActiveCommandRequest = (cmdId, mods) => {
                if (cmdId < 0 && inputManager) {
                    if (mods.right) {
                        inputManager.cancelBuildPlacement();
                    } else {
                        inputManager.startBuildPlacement(-cmdId, { shift: mods.shift, ctrl: mods.ctrl });
                    }
                }
            };
            void mgr.initialize().then(() => {
                console.log(`[client] widget manager ready`);
            }).catch(e => {
                console.warn('[client] widget manager failed:', e);
            });
            currentWidgetManager = mgr;
            // Hand the minimap (if it's been constructed by now — the
            // minimap-init block in this same function may run before
            // or after MapData lands depending on connection ordering)
            // to the manager so chili widgets' gl.ConfigMiniMap /
            // gl.DrawMiniMapEvents calls reach the native renderer.
            // PLAN-intel.md Phase 6.
            if (minimap) mgr.setMinimap(minimap);
            // Route every mouse-issued command through the worker's
            // CommandNotify dispatch so widgets that veto / rewrite
            // orders (cmd_no_duplicate_orders, cmd_raw_move_issue,
            // cmd_keep_target, …) see them before they hit the server.
            // Widget-issued GiveOrder* already runs the same gate inside
            // the worker (see lua-widget-worker.ts `giveOrder` cb).
            inputManager?.setCommandNotifier(
                (cmdId, params, options) => mgr.notifyCommand(cmdId, params, options));
            // Route hover-target changes so widget:DefaultCommand fires
            // and the resolved cmdId reaches Spring.GetDefaultCommand
            // (cmd_mex_placement, unit_default_commands, the cursortip
            // widget, …). InputManager filters to actual target changes;
            // the manager also dedupes identical reports for safety.
            // The worker's reply feeds back into InputManager so the
            // next right-click honours the widget's override.
            inputManager?.setHoverTargetCallback(
                (info) => mgr.forwardDefaultCommandTarget(info));
            mgr.onDefaultCommandResolved = (info) =>
                inputManager?.setDefaultCommandOverride(info);
            (window as any).__widgetManagerDispose = () => {
                inputManager?.setCommandNotifier(null);
                inputManager?.setHoverTargetCallback(null);
                mgr.dispose();
            };
        }
    };

    // Connect to the game server (separate from lobby connection).
    // Assigned to the module-level `gameConn` so the quit handler can
    // close it cleanly from outside this function. We also keep a
    // non-null local alias `conn` for use inside this function —
    // TypeScript can't narrow the module-level binding across the
    // async callbacks below, so we hand them `conn` instead.
    const conn: Connection = new Connection({
        onAuthenticated(_playerId, token, team, defsCacheKey) {
            console.log(`[game] connected to game server on port ${gameServerPort} (team=${team}, defsKey=${defsCacheKey || '(none)'})`);
            if (token) localStorage.setItem('springrts-token', token);
            // Wire debug console to game server for command execution
            const channel = conn.getControlChannel();
            if (channel) {
                debugConsole.setGameChannel(channel);
            }

            inputManager?.setMyTeam(team);
            // Push viewer identity into the standing-order renderer so it
            // can colour own-team orders differently and honour the
            // `setShowAllies(false)` toggle when set. Server-side
            // visibility filtering still controls *which* orders we see;
            // this only affects how we draw what we receive.
            standingOrderRenderer?.setIdentity(team, team);

            // Native HUD panels — BuildMenu, OrderPanel, EconomyBar — are
            // disabled while ZK's chili widgets (gui_integral_menu.lua,
            // gui_chili_command_buttons.lua, gui_chili_economy_panel2.lua)
            // are the primary UI. The JS panels were placeholders that
            // doubled up with chili once it started rendering. Re-enable
            // any of them as a fallback if the matching chili widget is
            // confirmed to be failing (e.g. a soloWidget mode without
            // WG.Chili). The downstream null-checks on `buildMenu?.` /
            // `orderPanel?.` / `economyBar?.` keep this safe.
            //
            // if (entityRenderer && inputManager) {
            //     buildMenu = new BuildMenu(defCache, entityRenderer, team,
            //         { lobbyHttpUrl, gameId: gameId ?? '' },
            //         { onPick: (defId, mods) =>
            //             inputManager?.startBuildPlacement(defId, mods) });
            //     orderPanel = new OrderPanel(entityRenderer, inputManager, team);
            // }
            // economyBar = new EconomyBar({ myTeam: team });

            // Fetch map data + def cache in parallel. Both must complete
            // before widget manager bootstrap so cawidgets sees populated
            // UnitDefs/WeaponDefs tables. Defs come from a content-addressed
            // path the server baked at startup; URL is browser-cacheable
            // forever for this (gameId, version, modOptions) combination.
            const mapPromise = fetchMapDataHttp(lobbyHttpUrl, mapId);
            const defsPromise = defsCacheKey
                ? fetchAndIngestDefs(lobbyHttpUrl, gameId ?? '', defsCacheKey, conn)
                : Promise.resolve();

            Promise.all([mapPromise, defsPromise])
                .then(([mapData]) => onMapData(mapData))
                .catch(err => {
                    console.error('[client] failed during game-start fetch:', err);
                });
        },
        onAuthFailed(msg: string) {
            console.error(`[game] auth failed: ${msg}`);
            // Stale token is the most common failure path here — e.g.
            // the lobby DB was wiped between sessions but localStorage
            // still holds the old token. Drop it so the next login
            // screen falls through to password auth instead of looping
            // on an invalid token forever.
            localStorage.removeItem('springrts-token');
        },
        onMapData,
        onUnitDefs(defs) {
            defCache.addUnitDefs(defs);
        },
        onWeaponDefs(defs) {
            defCache.addWeaponDefs(defs);
        },
        onCegDefs(defs) {
            defCache.addCegDefs(defs);
        },
        onFeatureDefs(defs) {
            defCache.addFeatureDefs(defs);
        },
        onFeatureLifecycle(spawns, removed) {
            // Dynamic feature spawns (wrecks, debris) — forwarded to
            // the feature renderer. Map-placed features come through
            // onMapData and are owned by `renderMapFeatures` separately.
            dynamicFeatureRenderer?.applyLifecycleBatch(spawns, removed);
        },
        onEntityState(snapshot, isDelta) {
            entityRenderer?.update(snapshot, isDelta);
            currentWidgetManager?.forwardEntityState(snapshot, isDelta);
            currentFrame++;
        },
        // The legacy 0x04 per-tick projectile state envelope is no longer
        // emitted by the server; ProjectileRenderer now drives off Fired /
        // Impact / Trajectory events and integrates motion locally.
        onProjectileFired(events) {
            if (!projectileRenderer) return;
            for (const e of events) projectileRenderer.onFired(e);
        },
        onProjectileImpacts(events) {
            for (const e of events) projectileRenderer?.onImpact(e);
            combatFX?.onProjectileImpacts(events);
        },
        onProjectileTrajectories(events) {
            if (!projectileRenderer) return;
            for (const e of events) projectileRenderer.onTrajectory(e);
        },
        onPieceState(snapshot) {
            entityRenderer?.applyPieceState(snapshot);
        },
        onBuildActivity(snapshot) {
            buildBeamRenderer?.onSnapshot(snapshot);
        },
        onCombatEvents(events) {
            combatFX?.onCombatEvents(events);
        },
        onSoundEvents(events) {
            soundEventPlayer.handleBatch(events);
        },
        onMusicEvent(state, fadeMs) {
            musicDirector.handleMusicEvent(state, fadeMs);
        },
        onSeismicPings(events) {
            currentWidgetManager?.forwardSeismicPings(events);
            // Native minimap events layer reads pings directly off this
            // callback in parallel with the widget worker — keeps the
            // renderer independent of the worker pace and means a game
            // without LuaUI still gets blip rendering. See PLAN-intel.md
            // Phase 6.
            if (minimap && events.length > 0) {
                currentWidgetManager?.pushMinimapSeismicPings(events);
                if (!currentWidgetManager) {
                    for (const e of events) minimap.pushSeismicPing(e);
                }
            }
        },
        onLosBitmap(bitmap) {
            losBitmapStore.set(bitmap);
            currentWidgetManager?.forwardLosBitmap(bitmap);
            minimap?.applyLosBitmap(bitmap);
            terrainFog?.apply(bitmap);
            // Ghost preservation: a building killed out of LOS leaves a
            // stale ghost on the client (server filters the destroy
            // broadcast by per-allyteam LOS-at-death). When the player
            // later re-LOSes the spot, drop ghosts whose tile is now
            // in-LOS — if the building were alive, the server would be
            // re-streaming it; absence means it died while we couldn't
            // see it.
            const size = entityRenderer?.getMapSizeElmos();
            if (size) {
                entityRenderer?.clearGhostsInLos(bitmap, size.width, size.height);
            }
        },
        onEntityDestroy(entityId, x, y, z) {
            entityRenderer?.removeEntity(entityId);
            currentWidgetManager?.forwardEntityDestroy(entityId);
            combatFX?.onCombatEvents([{
                attackerId: 0, targetId: entityId, weaponDefId: 0,
                result: 3, damage: 500, x, y, z,
            }]);
        },
        onEntitySensorUpdate(entityId, sensorType, radius) {
            currentWidgetManager?.forwardEntitySensorUpdate(entityId, sensorType, radius);
        },
        onResourceUpdate(info) {
            currentWidgetManager?.forwardResourceUpdate(info);
            economyBar?.update(info);
        },
        onGameInfo(frame, speed, paused, wind) {
            currentWidgetManager?.forwardGameInfo(frame, speed, paused, false, wind);
        },
        onUnitCommandQueues(queues) {
            lastCommandQueues = queues;
            currentWidgetManager?.forwardUnitCommandQueues(queues);
            inputManager?.onCommandQueuesUpdated(queues);
            commandPathRenderer?.update(queues, inputManager?.selection ?? []);
            waypointMarkerRenderer?.update(queues, inputManager?.selection ?? []);
        },
        onUnitCmdDescs(units) {
            // Forward to chili widgets via Spring.GetUnitCmdDescs(uid).
            // Without this the integral menu's build palette stays empty
            // even though the server is streaming the build options at
            // ~1 Hz, because the JS BuildMenu (now disabled) was the only
            // listener.
            currentWidgetManager?.forwardUnitCmdDescs(units);
            buildMenu?.setCmdDescs(units);
            orderPanel?.setCmdDescs(units);
        },
        onUnitTransports(transports) {
            currentWidgetManager?.forwardUnitTransports(transports);
        },
        onUnitSelfD(units) {
            currentWidgetManager?.forwardUnitSelfD(units);
        },
        onUnitStockpile(units) {
            currentWidgetManager?.forwardUnitStockpile(units);
        },
        onUnitArmored(units) {
            currentWidgetManager?.forwardUnitArmored(units);
        },
        onUnitLifecycle(events) {
            currentWidgetManager?.forwardUnitLifecycle(events);
        },
        onUnitCommand(events) {
            currentWidgetManager?.forwardUnitCommand(events);
        },
        onPathResponse(info) {
            currentWidgetManager?.forwardPathResponse(
                info.requestId, info.waypoints, info.length);
        },
        onStandingOrders(orders) {
            currentWidgetManager?.forwardStandingOrders(orders);
            standingOrderRenderer?.update(orders);
        },
        onGameOver(frame) {
            showGameOver(frame);
            currentWidgetManager?.forwardGameInfo(frame, 0, true, true);
        },
    });
    gameConn = conn;

    // Auth against the game server using the same username + token
    // the user picked up from the lobby login. The game server shares
    // the lobby's SQLite DB and has a token-reconnect code path that
    // validates the token, looks up the username, and cross-checks
    // it against the --player roster the lobby handed off at spawn
    // time. Without this, the game server sees the anonymous
    // "player1" dev shim and rejects it with "Not in this room's
    // roster" whenever the lobby is actually enforcing auth.
    const savedUser = localStorage.getItem('springrts-username') ?? '';
    const savedToken = localStorage.getItem('springrts-token') ?? '';
    conn.connect(gameHttpUrl, savedUser, '', savedToken);

    // Command path overlay — drawn while the player holds shift, for
    // the current selection. Refreshes whenever an
    // UnitCommandQueuesUpdate arrives or the selection changes; the
    // shift gate matches Spring/Recoil's "show queued orders" gesture.
    commandPathRenderer = new CommandPathRenderer(scene, entityRenderer);
    (window as unknown as { __cmdPath: unknown }).__cmdPath = commandPathRenderer;

    // Waypoint markers — billboarded icons at each queued order's
    // destination, paired with the connecting line. Shares the shift
    // gesture and queue/selection snapshot with CommandPathRenderer.
    // Hit-tests against marker meshes (`waypoint-marker-*`) drive the
    // per-waypoint revocation + drag-to-reorder interactions.
    waypointMarkerRenderer = new WaypointMarkerRenderer(scene, entityRenderer);
    if (currentMapData) waypointMarkerRenderer.setMapData(currentMapData);
    (window as unknown as { __waypointMarkers: unknown }).__waypointMarkers = waypointMarkerRenderer;

    // Standing-order map overlays — always visible (server already
    // filters the broadcast to the viewer's team + allies). Unlike the
    // shift-gated command-path overlay, strategic intent should always
    // be readable. Allied display can be toggled off via
    // `__standingOrders.setShowAllies(false)` (persists in
    // localStorage). See PLAN-orders.md "Standing Order Visualisation
    // (Client)" for per-type visual semantics.
    standingOrderRenderer = new StandingOrderRenderer(scene);
    if (currentMapData) standingOrderRenderer.setMapData(currentMapData);
    (window as unknown as { __standingOrders: unknown }).__standingOrders = standingOrderRenderer;

    // Debug overlay: terrain-following grid using the same tube +
    // X-ray material setup as CommandPathRenderer. Toggle from devtools:
    //   window.__terrainGrid.show()      // 256-elmo cells
    //   window.__terrainGrid.show(512)   // wider cells
    //   window.__terrainGrid.hide()
    debugTerrainGrid = new DebugTerrainGrid(scene);
    if (currentMapData) debugTerrainGrid.setMapData(currentMapData);
    (window as unknown as { __terrainGrid: unknown }).__terrainGrid = debugTerrainGrid;
    const cmdPathShiftDown = (e: KeyboardEvent) => {
        if (e.key === 'Shift') {
            commandPathRenderer?.setShiftHeld(true);
            waypointMarkerRenderer?.setShiftHeld(true);
        }
    };
    const cmdPathShiftUp = (e: KeyboardEvent) => {
        if (e.key === 'Shift') {
            commandPathRenderer?.setShiftHeld(false);
            waypointMarkerRenderer?.setShiftHeld(false);
        }
    };
    // Window-level so we catch the gesture regardless of which DOM
    // element has focus. The blur handler clears state if the window
    // loses focus mid-press, otherwise the overlay stays stuck on.
    window.addEventListener('keydown', cmdPathShiftDown);
    window.addEventListener('keyup', cmdPathShiftUp);
    window.addEventListener('blur', () => {
        commandPathRenderer?.setShiftHeld(false);
        waypointMarkerRenderer?.setShiftHeld(false);
    });

    // Input
    let selectionStateTimer: number | null = null;
    let pendingSelection: readonly number[] | null = null;
    const SELECTION_DEBOUNCE_MS = 50;
    inputManager = new InputManager(scene, camera, entityRenderer, conn,
        (ids) => {
            minimap?.setSelection(ids);
            buildMenu?.setSelection(ids);
            orderPanel?.setSelection(ids);
            // Re-render paths from the cached queue snapshot so the lines
            // appear immediately on a selection change instead of waiting
            // for the next 1-second UnitCommandQueuesUpdate broadcast.
            commandPathRenderer?.update(lastCommandQueues, ids);
            waypointMarkerRenderer?.update(lastCommandQueues, ids);
            // Mirror selection to the server (debounced). Server scopes
            // its UnitCmdDescsUpdate broadcast to these ids so the
            // command panel data only flows for what's selected.
            pendingSelection = ids.slice();
            if (selectionStateTimer === null) {
                selectionStateTimer = window.setTimeout(() => {
                    selectionStateTimer = null;
                    if (pendingSelection) {
                        conn.sendSelectionState(pendingSelection);
                        pendingSelection = null;
                    }
                }, SELECTION_DEBOUNCE_MS);
            }
        });
    inputManager.setDefCache(defCache);
    // Animated cursor — loads ZK's `Anims/cursor*.txt` packs and renders
    // them on a transparent overlay. Only constructable once we know the
    // game data root; safe to skip when no game is loaded yet.
    if (gameId) {
        const canvasHost = scene.getEngine().getRenderingCanvas()?.parentElement
            ?? document.body;
        animatedCursor = new AnimatedCursor(canvasHost, lobbyHttpUrl, gameId);
        inputManager.setAnimatedCursor(animatedCursor);
        (window as unknown as { __animatedCursor: unknown }).__animatedCursor = animatedCursor;
    }
    // Debug hook: expose inputManager + connection so chrome-devtools
    // automation can drive orders without touching the canvas.
    (window as unknown as { __inputManager: unknown }).__inputManager = inputManager;
    (window as unknown as { __connection: unknown }).__connection = conn;

    // window.test — high-level testing API. Reuses the existing
    // /api/exec route on the lobby (which proxies to the game server)
    // for spawn/kill/damage/order/log verbs, and drives the camera +
    // engine directly for client-side focus / pause / screenshot. See
    // docs/javascript.md and .claude/skills/spring-test/SKILL.md.
    if (lobbyUI) {
        testHarness = new TestHarness({
            engine,
            scene,
            camera: rtsCamera,
            entityRenderer,
            connection: conn,
            inputManager,
            lobby: lobbyUI,
            setPaused: (p) => { testRenderPaused = p; },
            isPaused: () => testRenderPaused,
        });
        (window as unknown as { test: TestHarness }).test = testHarness;
    }
    // Route ground-click suppression through the widget manager. The
    // widget manager is created later (when MapData arrives) so we read
    // it lazily — by the time the user clicks anything, the manager has
    // long since reported its first uiHover.
    inputManager.setUIHitTest(() => currentWidgetManager?.isCursorOverUI() ?? false);
    rtsCamera.setUIHitTest(() => currentWidgetManager?.isCursorOverUI() ?? false);
    // Right-click → ground-pivoted orbit lives in RTSCamera. A click
    // without drag falls through here so we issue an order at the
    // recorded mousedown screen point.
    rtsCamera.onRightClickCommit = (x, y, mods) => {
        inputManager?.issueOrderAtScreen(x, y, mods.shift);
    };

    // Minimap (initial size — rebound on MapData arrival)
    {
        const container = document.getElementById('minimap-container');
        if (container && entityRenderer) {
            minimap = new Minimap(
                { mapWidth: 8192, mapHeight: 8192, parentElement: container, size: 200 },
                entityRenderer, conn);

            minimap.onCameraMove = (x, z) => {
                rtsCamera.focusOn(x, z);
            };
            document.getElementById('detach-minimap-btn')?.addEventListener('click', () => {
                minimap?.detach();
            });
            // If the widget manager already exists, hand it the minimap
            // now. Otherwise the onMapData callback that constructs the
            // manager registers the link itself.
            const existingManager = currentWidgetManager as LuaWidgetManager | null;
            existingManager?.setMinimap(minimap);
        }
    }

    // Render loop
    let lastViewportSend = 0;
    let lastFrameTime = performance.now();
    let hudCounter = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        // window.test.pause() freezes rendering. Sim continues server-side
        // (use test.simPause() to also stop ticks) and entity-state
        // updates keep arriving so the harness can still query state.
        if (testRenderPaused) return;

        rtsCamera.tick();
        entityRenderer?.tick();
        buildBeamRenderer?.tick();
        projectileRenderer?.tick();
        cegRuntime?.tick(dt);
        combatFX?.tick(dt);

        // Listener follows the camera every frame so HRTF stays in
        // sync with smooth camera motion. Previously this only fired
        // on camera-change events and lagged behind pans/zooms.
        // The zoom factor uses camera Y (RtsCamera keeps the camera in
        // [minHeight,maxHeight]) so further-out cameras quiet the SFX
        // bus and raise the priority floor (PLAN-audio.md).
        if (audioManager) {
            const cp = camera.position;
            const fwd = camera.getTarget().subtract(cp).normalize();
            audioManager.setListenerPosition(cp.x, cp.y, cp.z, fwd.x, fwd.y, fwd.z);
            audioManager.setZoomFactor(cp.y);
        }

        scene.render();

        // VisibleUnitAdded / VisibleUnitRemoved widget callins. Built
        // from the in-frustum diff against the previous tick. The
        // manager throttles internally to 10 Hz so calling here every
        // render frame is cheap. Runs after scene.render() so
        // scene.frustumPlanes reflects this frame's camera.
        if (currentWidgetManager && entityRenderer) {
            const er = entityRenderer;
            currentWidgetManager.updateVisibleUnits((function* () {
                for (const [id, meta] of er.getEntities()) {
                    const pos = er.getEntityPosition(id);
                    if (!pos) continue;
                    const def = defCache.getUnitDef(meta.defId);
                    // Fall back to a generous radius when the def hasn't
                    // streamed yet — keeps the unit in-set rather than
                    // dropping it from the frustum during the boot race.
                    const radius = def?.radius ?? 32;
                    yield {
                        id, defId: meta.defId, team: meta.team,
                        x: pos.x, y: pos.y, z: pos.z, radius,
                    };
                }
            })());
        }

        if (now - lastViewportSend > 100) {
            sendCameraViewport(camera, conn);
            lastViewportSend = now;
        }

        hudCounter++;
        if (hudCounter >= 6) {
            hudCounter = 0;
            const sel = inputManager?.selection ?? [];
            updateHUD(
                entityRenderer?.entityCount ?? 0,
                currentFrame,
                sel,
            );
            currentWidgetManager?.setSelection(sel);
            minimap?.render();
        }
    });

    window.addEventListener('resize', () => engine?.resize());
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
    createHUD();
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
        showQuitConfirm();
    });

    // Show lobby with the engine-default templates immediately so the
    // login screen renders without waiting on a network round-trip.
    lobbyUI = new LobbyUI((gameServerPort: number, mapId: string, gameId: string) => {
        startGame(gameServerPort, mapId, gameId);
    }, getDefaultLobbyTemplates());
    (window as any).lobby = lobbyUI;

    // If a game id is known up front, fire-and-forget the override
    // bundle fetch and hot-swap the templates as soon as it lands.
    // Each per-file override falls back to the bundled default, so a
    // missing or partial override gracefully degrades.
    const initialGameId = resolveInitialGameId();
    if (initialGameId) {
        loadGameLobbyTemplates(initialGameId, CONFIG.httpUrl)
            .then((templates) => lobbyUI?.setTemplates(templates))
            .catch((err) => console.warn('[lobby] game UI override failed:', err));

        loadGameTemplates(initialGameId, CONFIG.httpUrl)
            .then((templates) => {
                gameTemplates = templates;
                // Re-create HUD with the game's overridden templates. The
                // HUD was already built above with engine defaults — swap
                // it now that the override has landed. Re-attaches the
                // quit button listener.
                createHUD();
            })
            .catch((err) => console.warn('[game] game UI override failed:', err));
    }
});
