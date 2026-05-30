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
import { buildTerrainMesh, loadTerrainTextures, TerrainFog, type MapDimensions } from './core/terrain.js';
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
import { fetchBuildStamp } from './config.js';
import { fetchMapDataHttp, type ParsedMapData } from './core/map-data.js';
import { loadMapLighting, type MapLighting } from './core/map-lighting.js';
import { applyMapLighting, createSceneLighting, type SceneLighting } from './core/scene-lighting.js';
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
import { RTSCamera } from './core/rts-camera.js';
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
let entityRenderer: EntityRenderer | null = null;
let projectileRenderer: ProjectileRenderer | null = null;
let buildBeamRenderer: BuildBeamRenderer | null = null;
let dynamicFeatureRenderer: DynamicFeatureRenderer | null = null;
let cegRuntime: CegRuntime | null = null;
let combatFX: CombatFX | null = null;
let fxLightPool: FxLightPool | null = null;
let distortionRenderer: DistortionRenderer | null = null;
let muzzleFlareRenderer: MuzzleFlareRenderer | null = null;
let decalOverlay: DecalOverlay | null = null;
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
    uninstallCameraWindowApi();
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
    fxLightPool?.dispose();
    fxLightPool = null;
    distortionRenderer?.dispose();
    distortionRenderer = null;
    muzzleFlareRenderer?.dispose();
    muzzleFlareRenderer = null;
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
    // Base URL prefix for `/api/*` paths. Empty string = relative URL,
    // so the browser resolves against the page origin. In dev that's
    // Vite (:8012) which serves the four static-data routes itself and
    // proxies everything else to spring-lobby (:8011). In prod, nginx
    // (or equivalent) fronts both. Hardcoding the lobby host here breaks
    // static assets, which the lobby no longer serves (commit 78027e4004).
    const lobbyHttpUrl = '';

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    // PLAN-coordinate-system Phase 2d: flip the Babylon scene to RH
    // so the glTF loader passes data through unchanged (no __root__
    // hack) and yaw/pitch/roll quaternions stay sign-correct under
    // the server's RH wire format (Phase 2a).
    scene.useRightHandedSystem = true;
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

    // Lighting + HDR pipeline. PLAN-lighting L1 (HDR/ACES) + L2 (map sun)
    // both live in scene-lighting.ts; the per-map mapinfo.lua handler in
    // onMapData below rewrites the sun/ambient via applyMapLighting().
    const sceneLighting: SceneLighting = createSceneLighting(scene, camera);

    // Dynamic FX light pool (PLAN-weapon-fx-gaps Phase L). Fixed ring of
    // point lights that weapon fire / explosions drive, picked up by the
    // forward-lit stock materials (terrain/features) and bloomed by the
    // HDR pipeline. Injected into the projectile + combat renderers below.
    fxLightPool = new FxLightPool(scene);
    // Phase U: let the ZK unit material sample the pool directly so units
    // (not just terrain/features) light up under weapon fire.
    setActiveFxLightPool(fxLightPool);

    // Screen-space distortion composite (PLAN-weapon-fx-gaps Phase D).
    // Explosions warp the scene behind them via an expanding shockwave
    // ring. Fed from the same explosion paths as FxLightPool (combat +
    // projectile renderers, below). Gated on `gfx.distortion`.
    distortionRenderer = new DistortionRenderer(scene, camera);

    // Muzzle-flare flash (PLAN-weapon-fx-gaps Phase F item 2) — the visual
    // companion to the muzzle light, emitted on weapon fire below.
    muzzleFlareRenderer = new MuzzleFlareRenderer(scene, camera);

    // Phase G: gate the expensive FX through the graphics-quality presets.
    // `gfx.fxLights` toggles the pool live; `gfx.particleQuality` (tier
    // 0/1/2) sizes the CEG per-spawn budget — applied before CEG defs are
    // ingested (translation runs once per session, so this is a per-session
    // read; `requiresRestart` in the registry reflects that). `gfx.bloom`
    // is consumed directly by scene-lighting.ts; `gfx.distortion` toggles
    // the Phase D composite (full-screen pass detaches entirely when off).
    {
        const fxLights = fxLightPool;
        clientSettings.subscribe('gfx.fxLights',
            (v) => fxLights.setEnabled(Boolean(v)), /*fireNow*/ true);
        const distortion = distortionRenderer;
        clientSettings.subscribe('gfx.distortion',
            (v) => distortion.setEnabled(Boolean(v)), /*fireNow*/ true);
        // tier → {maxPerSpawn, maxLifetimeS}
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

    // Expose `window.camera` for JS console / chrome-devtools / TestHarness
    // / Lua widget bridge. Lazy entity-renderer getter so snapToUnit works
    // even though entityRenderer is constructed a few lines below.
    installCameraWindowApi(rtsCamera, () => entityRenderer);

    // Pick the per-game shader lighting style before the first team-color
    // material is built. modinfo.lua's `lighting` field flows through
    // GameDiscovery → LobbyGameInfo (FlatBuffer + /api/games JSON) →
    // lobbyUI.games. Look it up by the current gameId; fall back to the
    // default ('gameplay') when the lobby hasn't populated the list yet
    // or when launching a scenario that bypasses the games browser.
    const lightingStyle = gameId
        ? (lobbyUI?.games.find((g) => g.id === gameId)?.lighting ?? 'gameplay')
        : 'gameplay';
    setLightingStyle(lightingStyle);

    // PLAN-weapon-fx.md Phase Z2: route ZK content through the ported
    // defaultMaterialTemplate shader (zk-model-material.ts) instead of
    // the built-in team-color material. Opt-in by game id so non-ZK
    // games (incl. test scenarios) stay on the default pipeline.
    setUseZKMaterial(gameId === 'zk');

    entityRenderer = new EntityRenderer(scene);
    // PLAN-lighting L3: register the renderer with the sun shadow generator.
    // Adds every model/fallback mesh built later as a caster. Done up-front
    // (before any def streams in) so we don't race the first ensureModel
    // load. Pass the sun light too so PLAN-lighting L4 — the team-color
    // material's CSM sampling — can read the live sun direction + cascade
    // matrices each frame via its onBindObservable.
    entityRenderer.setShadowGenerator(sceneLighting.csm, sceneLighting.sun);
    projectileRenderer = new ProjectileRenderer(scene);
    buildBeamRenderer = new BuildBeamRenderer(scene);
    buildBeamRenderer.setEntityRenderer(entityRenderer);
    if (gameId) buildBeamRenderer.setGameAssetsBaseUrl(gameId);

    // CEG particle runtime — muzzle flashes, impact bursts, debris.
    // Lives parallel to the projectile renderer; spawn calls happen
    // from inside the renderer's onFired/onImpact hooks once injected.
    cegRuntime = new CegRuntime(scene);
    projectileRenderer.setCegRuntime(cegRuntime);
    projectileRenderer.setLightPool(fxLightPool);
    projectileRenderer.setDistortion(distortionRenderer);
    projectileRenderer.setMuzzleFlare(muzzleFlareRenderer);

    // Resolve weapon-def texture names → KTX2 URLs. Async load of
    // resources.json + the bitmaps manifests; the renderer can be
    // built before init() resolves and consults the resolver lazily
    // when it sees the first weapon def with a texture name.
    if (gameId) {
        const resolver = new ProjectileTextureResolver();
        projectileRenderer.setTextureResolver(resolver);
        cegRuntime.setTextureResolver(resolver);
        muzzleFlareRenderer.setTextureResolver(resolver);
        resolver.init(gameId, lobbyHttpUrl).catch((e) => {
            console.warn('[main] projectile texture resolver init failed:', e);
        });
    }

    // Ground decals (PLAN-decals.md D7) use a persistent baked overlay —
    // see the DecalOverlay created in onMapData once map dimensions are known.

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
    combatFX.setLightPool(fxLightPool);
    combatFX.setDistortion(distortionRenderer);
    (window as unknown as { __defCache: unknown }).__defCache = defCache;

    // Dynamic feature renderer — handles runtime-spawned features
    // (wrecks from unit death, gadget-spawned debris, reclaim removals).
    // Map-placed features still go through `renderMapFeatures` once on
    // MapData. Both can share the same model .glb on disk; the dynamic
    // renderer owns its own mesh pool so the static path's
    // thin-instance buffer stays read-only.
    dynamicFeatureRenderer = new DynamicFeatureRenderer(scene, defCache);
    dynamicFeatureRenderer.setShadowGenerator(sceneLighting.csm);
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

        // Map source URL for any per-map file fetches below (reverb IR,
        // mapinfo.lua lighting parse, ...). `mapSourceUrl` may already
        // be absolute when it comes through the WebRTC info path; fall
        // back to prepending the lobby HTTP origin otherwise.
        const mapSourceAbs = map.mapSourceUrl.startsWith('http')
            ? map.mapSourceUrl
            : `${lobbyHttpUrl}${map.mapSourceUrl}`;

        // Apply map-wide reverb (mapinfo.lua → sound.preset). The
        // AudioManager fetches sounds/efx/<preset>.webm from the map's
        // content root; missing IRs stay in passthrough so a map that
        // names a preset without shipping the IR works as if no preset
        // were set. "default" / empty is a no-op.
        if (audioManager && map.soundPreset) {
            void audioManager.setReverbPreset(map.soundPreset, mapSourceAbs);
        }

        // PLAN-lighting L2: parse `mapinfo.lua → lighting` on the client
        // (server is headless — lighting is pure renderer data) and apply
        // sun direction/colour, ambient sky/ground colours, and a sun
        // intensity derived from the authored diffuse brightness. Runs
        // fire-and-forget; if the fetch/parse fails the loader returns
        // safe defaults so we never end up with a dark scene.
        void loadMapLighting(mapSourceAbs).then((lighting: MapLighting) => {
            if (session !== activeSession) return;  // user quit during fetch
            applyMapLighting(lighting, sceneLighting);
        });
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
        // PLAN-lighting L3: terrain catches every unit + feature shadow.
        // Terrain itself doesn't cast — without normal mapping a single
        // hill self-shadows oddly, and the sun direction is high enough
        // that map-scale relief reads as ambient occlusion instead.
        terrainMesh.receiveShadows = true;
        console.log('[client] terrain mesh built from MapData heightmap');

        // Ground decals (PLAN-decals.md D7): a persistent baked overlay the
        // size of the map. Scars + track segments (envelope 0x08) are blitted
        // once into it; the terrain samples it every frame via a material
        // plugin (perturbs normal + darkens albedo, lit live by sun + CSM).
        // No per-decal height snap needed — the terrain samples the overlay at
        // each fragment's real height/normal, so marks follow undulations.
        decalOverlay?.dispose();
        decalOverlay = new DecalOverlay(scene, map.widthElmos, map.heightElmos);
        // Classify each wire trackTypeId → procedural pattern (tank tread vs
        // bot footprints vs spider claws). Defs are fully loaded by now
        // (onMapData runs after the def fetch resolves), so the client builds
        // the same sorted track-name table the server indexed by.
        decalOverlay.setTrackTypes(
            buildTrackTypeNames(defCache.getAllUnitDefs().map(d => d.trackType)));
        (window as unknown as { __decalOverlay: unknown }).__decalOverlay = decalOverlay;
        if (terrainMesh?.material) {
            attachDecalOverlay(terrainMesh.material,
                decalOverlay.coarseTexture, decalOverlay.fineTexture, decalOverlay.fineState,
                decalOverlay.coarseTexel, decalOverlay.fineTexel,
                map.widthElmos, map.heightElmos);
        }

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
        // PLAN-lighting L3: LOS overlay must never enter the shadow
        // pipeline — the mesh is huge, flat, and sits slightly above
        // terrain, so any caster role would project a map-sized blob
        // into the shadow atlas. `TerrainFog.build` sets
        // `receiveShadows = false` on its own; the explicit
        // removeShadowCaster here is defensive against any future
        // path that enrols scene-wide casters.
        const fogMesh = terrainFog.getMesh();
        if (fogMesh) sceneLighting.csm.removeShadowCaster(fogMesh, false);
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
            // PLAN-lighting L3: water is a pure visual overlay — never
            // a caster (would project a map-sized blob into the shadow
            // atlas) and never a receiver (a flat darken on water looks
            // like fake ice). `removeShadowCaster` is defensive — water
            // isn't added in the first place, but this guarantees it
            // even if a future path enrols every scene mesh.
            water.receiveShadows = false;
            sceneLighting.csm.removeShadowCaster(water, false);
            console.log(`[water] plane rendered: baseColor=(${r.toFixed(2)},${g.toFixed(2)},${b.toFixed(2)}) damage=${map.water.damage} alpha=${wmat.alpha.toFixed(2)}`);
        }

        // Render features. Loads each unique feature def's .glb model
        // asynchronously and thin-instances every placement of that type.
        // Types without a converted model fall back to placeholder boxes.
        renderMapFeatures(scene, map, sceneLighting.csm).catch((err) => {
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
            // The chili integral menu's command-button click resolves to
            // Spring.SetActiveCommand(idx, ...) for whatever command sits at
            // `idx` in the selected unit's cmd-descs. Route it into
            // InputManager so the click actually issues — without this, the
            // chili API round-trips happily inside the worker but no order
            // ever reaches the server.
            //   - Build commands (cmdId < 0) enter ground placement.
            //   - Positive cmdIds with a world target (Move/Attack/Patrol/
            //     Guard/Force-fire/…) arm a modal command resolved by the next
            //     world click; `cmdType` (Spring CMDTYPE_*) tells InputManager
            //     whether the target is ground / unit / either.
            // Instant + state-toggle commands are issued in the worker before
            // this fires, so they never arrive here.
            //
            // Right-click clears the active command, matching Spring's "RMB
            // cancels the active command" idiom.
            mgr.onSetActiveCommandRequest = (cmdId, mods, cmdType) => {
                if (!inputManager) return;
                if (cmdId < 0) {
                    if (mods.right) inputManager.cancelBuildPlacement();
                    else inputManager.startBuildPlacement(-cmdId, { shift: mods.shift, ctrl: mods.ctrl });
                    return;
                }
                if (mods.right) {
                    inputManager.cancelPendingCommand();
                    return;
                }
                inputManager.activateCommandFromMenu(cmdId, cmdType);
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
            const mapPromise = fetchMapDataHttp(mapId);
            const defsPromise = defsCacheKey
                ? fetchAndIngestDefs(gameId ?? '', defsCacheKey, defCache)
                : Promise.resolve();

            Promise.all([mapPromise, defsPromise])
                .then(([mapData]) => onMapData(mapData))
                .catch(err => {
                    console.error('[client] failed during game-start fetch:', err);
                });
        },
        onAuthFailed(msg: string) {
            console.error(`[game] auth failed: ${msg}`);
            // Only invalidate the stored token when the server says the
            // *token itself* is unusable — "Session user missing" means
            // the sessions table doesn't recognise it. Every other
            // InvalidCredentials path (Not in this room's roster, Wrong
            // password, Account banned, transient WebRTC errors) leaves
            // the token alone: it's still valid for the lobby, and
            // wiping it on every roster mismatch was breaking "Rejoin
            // Game" because the user landed back on the password screen
            // after one cross-room hiccup.
            if (msg.includes('Session user missing') ||
                msg.toLowerCase().includes('invalid token') ||
                msg.toLowerCase().includes('session expired')) {
                localStorage.removeItem('springrts-token');
            }
        },
        onMapData,
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
        onDecals(snapshot) {
            decalOverlay?.onSnapshot(snapshot.scars, snapshot.tracks);
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
        onSendToUnsynced(args) {
            currentWidgetManager?.forwardSendToUnsynced(args);
        },
        onResourceUpdate(info) {
            currentWidgetManager?.forwardResourceUpdate(info);
            economyBar?.update(info);
        },
        onGameInfo(frame, speed, paused, wind, legacyCoordSystem) {
            currentWidgetManager?.forwardGameInfo(frame, speed, paused, false, wind, legacyCoordSystem);
            // Tell InputManager about the latest speed/pause so its
            // `+`/`-`/`Pause` hotkeys know which rung to step to and
            // which verb to send on toggle. Also drives the HUD label.
            inputManager?.setSimStatus(speed, paused);
            updateSpeedHUD(speed, paused);
            // Projectile integrator needs the current sim-speed so its
            // wall-clock dt translates to sim-time motion / ttl decay.
            // Treat paused as 0× so bolts freeze with the sim.
            projectileRenderer?.setSimSpeed(paused ? 0 : speed);
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
            showGameOver(gameTemplates, frame, { onReturnToLobby: quitToLobby });
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
    // Tracking-camera target: InputManager calls rtsCamera.fitPoints
    // every tick when tracking is on. Pure client-side feature — no
    // server roundtrip needed since we already have selection + live
    // entity positions locally.
    inputManager.setRTSCamera(rtsCamera);
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
        // InputManager.tick currently only refits the tracking camera
        // on the live selection — cheap when tracking is off. Run it
        // BEFORE other ticks so the camera move lands this frame; the
        // entity/projectile renderers downstream see the new pose.
        inputManager?.tick();
        entityRenderer?.tick();
        buildBeamRenderer?.tick();
        projectileRenderer?.tick();
        cegRuntime?.tick(dt);
        combatFX?.tick(dt);
        // Feed the camera ground focus + height so the decal clipmap's fine
        // window tracks the view (PLAN-decal-vt.md V1: sharp near-camera decals,
        // VRAM bounded regardless of map size).
        {
            const camFocus = rtsCamera.target;
            const camPos = rtsCamera.position;
            decalOverlay?.tick(dt, camFocus.x, camFocus.z, Math.max(1, camPos.y - camFocus.y));
        }
        // Age the dynamic FX lights after the emitters have run this frame
        // and before scene.render() consumes the lighting.
        fxLightPool?.update(dt, camera.position);
        // Upload this frame's shockwave emissions before the offset RTT
        // renders (combat + projectile renderers emit during their ticks
        // above). The composite samples the result during scene.render().
        distortionRenderer?.tick(dt);
        muzzleFlareRenderer?.tick(dt);

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
