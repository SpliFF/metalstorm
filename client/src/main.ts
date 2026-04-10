/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Flow: Login → Room Browser → Room Setup → Game
 */

import { Engine, Scene, FreeCamera, Mesh, MeshBuilder, StandardMaterial, Vector3, HemisphericLight, DirectionalLight, Color3, Color4 } from '@babylonjs/core';
import { EntityRenderer } from './core/entity-renderer.js';
import { CombatFX } from './core/combat-fx.js';
import { AudioManager } from './core/audio.js';
import { InputManager } from './core/input-manager.js';
import { buildTerrainMesh, loadTerrainTextures, type MapDimensions } from './core/terrain.js';
import { LobbyUI } from './lobby/lobby-ui.js';
import { Minimap } from './core/minimap.js';
import { Connection } from './core/connection.js';
import { CONFIG } from './config.js';
import type { ParsedMapData } from './core/map-data.js';
import { renderMapFeatures } from './core/feature-renderer.js';
import { RTSCamera } from './core/rts-camera.js';
import { LuaWidgetHost } from './core/lua-widget-host.js';

let engine: Engine | null = null;
let entityRenderer: EntityRenderer | null = null;
let combatFX: CombatFX | null = null;
let audioManager: AudioManager | null = null;
let inputManager: InputManager | null = null;
let lobbyUI: LobbyUI | null = null;
let minimap: Minimap | null = null;
/// Game server WebSocket. Non-null while a game is active. Hoisted out
/// of startGame() so the quit-to-lobby handler can close it cleanly.
let gameConn: Connection | null = null;

// --- HUD ---

function createHUD(): void {
    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.display = 'none'; // hidden until game starts
    hud.innerHTML = `
        <div id="hud-top-bar" class="hud-panel">
            <span id="hud-entities">Entities: 0</span>
            <span id="hud-frame">Frame: 0</span>
            <button id="hud-quit-btn" title="Quit to lobby (ESC)">Quit</button>
        </div>
        <div id="hud-selection" class="hud-panel">
            <span id="hud-selected">No selection</span>
        </div>
        <div id="hud-minimap" class="hud-panel">
            <div id="minimap-container"></div>
            <button id="detach-minimap-btn" style="margin-top:4px;font-size:11px;padding:4px 8px;">Detach ↗</button>
        </div>
        <div id="hud-help" class="hud-panel">
            Left click: select &nbsp; Right click: move/attack &nbsp; S: stop &nbsp; Shift: queue &nbsp; ESC: quit
        </div>
    `;
    document.body.appendChild(hud);

    document.getElementById('hud-quit-btn')?.addEventListener('click', () => {
        showQuitConfirm();
    });

    const style = document.createElement('style');
    style.textContent = `
        #game-hud {
            position: fixed; inset: 0; z-index: 10;
            pointer-events: none;
            font: 13px/1.4 system-ui, sans-serif; color: #e0e0e0;
        }
        .hud-panel {
            pointer-events: auto;
            background: rgba(0,0,0,0.7);
            padding: 6px 12px; border-radius: 4px;
        }
        #hud-top-bar {
            position: absolute; top: 8px; left: 8px;
            display: flex; gap: 24px; align-items: center;
        }
        #hud-quit-btn {
            pointer-events: auto;
            padding: 4px 12px; margin-left: auto;
            background: #552222; color: #f0c0c0;
            border: 1px solid #882222; border-radius: 4px;
            font: inherit; cursor: pointer;
        }
        #hud-quit-btn:hover { background: #772222; color: #fff; }
        #hud-selection {
            position: absolute; bottom: 48px; left: 8px; min-width: 200px;
        }
        #hud-minimap {
            position: absolute; bottom: 48px; right: 8px;
        }
        #hud-help {
            position: absolute; bottom: 8px; left: 8px; right: 8px;
            text-align: center; font-size: 11px; color: #888;
        }
    `;
    document.head.appendChild(style);
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

    const height = Math.max(camera.position.y, 1);
    const fov = camera.fov;
    const aspect = engine ? engine.getAspectRatio(camera) : 16 / 9;
    const visibleHeight = 2 * height * Math.tan(fov / 2);
    const visibleWidth = visibleHeight * aspect;

    const dir = camera.getTarget().subtract(camera.position).normalize();
    const t = dir.y !== 0 ? -camera.position.y / dir.y : 0;
    const groundX = camera.position.x + dir.x * Math.max(t, 0);
    const groundZ = camera.position.z + dir.z * Math.max(t, 0);
    const rotation = Math.atan2(dir.x, dir.z);
    const zoomLevel = Math.max(1, height / 100);

    connection.sendViewportUpdate(0, groundX, groundZ, visibleWidth, visibleHeight, rotation, zoomLevel);
}

// --- Game Scene ---

let currentFrame = 0;

/// Tear down the active game session and show the lobby browser. Safe to
/// call from any in-game context: "Quit" button, ESC-confirm, Game Over
/// overlay, or an error handler. No-op if no game is active.
function quitToLobby(): void {
    // Close the game WebSocket cleanly before disposing the renderer —
    // that way any "player left" hint reaches the game server before
    // our send queue gets torn down.
    gameConn?.disconnect();
    gameConn = null;

    // Clear saved game state so a page refresh lands on the lobby.
    localStorage.removeItem('springrts-game-room');
    localStorage.removeItem('springrts-game-port');

    // Tear down Babylon + the per-session helpers. Most of these hold
    // references to the engine/scene, so letting GC collect them is
    // enough — we just drop our handles.
    engine?.stopRenderLoop();
    engine?.dispose();
    engine = null;
    entityRenderer = null;
    combatFX = null;
    audioManager = null;
    inputManager = null;
    minimap = null;

    // Hide the game canvas and HUD. Any in-flight overlays (quit confirm,
    // game over) are removed here too so the lobby is the only thing left.
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (canvas) canvas.style.display = 'none';
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'none';
    document.getElementById('quit-confirm-overlay')?.remove();
    document.getElementById('game-over-overlay')?.remove();

    // Show the lobby browser. The lobby WebSocket stayed connected the
    // whole time — the player is simply back in the room list.
    lobbyUI?.showBrowser();
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

    const overlay = document.createElement('div');
    overlay.id = 'quit-confirm-overlay';
    overlay.innerHTML = `
        <div class="quit-card">
            <h2>Quit to Lobby?</h2>
            <p>Your game is still running. You can rejoin from the lobby.</p>
            <div class="quit-buttons">
                <button id="quit-cancel-btn">Cancel</button>
                <button id="quit-confirm-btn">Quit to Lobby</button>
            </div>
        </div>
    `;
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 150;
        background: rgba(0,0,0,0.7);
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, sans-serif; color: #e0e0e0;
    `;

    // One-shot style injection — guarded by an id so repeated quit
    // prompts don't spam the head with duplicate <style> tags.
    if (!document.getElementById('quit-confirm-style')) {
        const style = document.createElement('style');
        style.id = 'quit-confirm-style';
        style.textContent = `
            .quit-card {
                background: #16213e; border-radius: 10px; padding: 28px 36px;
                text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                min-width: 320px;
            }
            .quit-card h2 { color: #e0e0e0; margin: 0 0 10px; font-size: 20px; }
            .quit-card p { color: #888; margin: 0 0 20px; font-size: 13px; }
            .quit-buttons { display: flex; gap: 10px; justify-content: center; }
            .quit-buttons button {
                padding: 10px 20px; border: none; border-radius: 5px;
                font: inherit; font-weight: 600; cursor: pointer;
            }
            #quit-cancel-btn { background: #2a3a5a; color: #c0c0c0; }
            #quit-cancel-btn:hover { background: #3a4a6a; color: #fff; }
            #quit-confirm-btn { background: #aa3333; color: #fff; }
            #quit-confirm-btn:hover { background: #cc3333; }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    document.getElementById('quit-cancel-btn')?.addEventListener('click', () => {
        overlay.remove();
    });
    document.getElementById('quit-confirm-btn')?.addEventListener('click', () => {
        quitToLobby();
    });
}

function showGameOver(frame: number): void {
    const overlay = document.createElement('div');
    overlay.id = 'game-over-overlay';
    overlay.innerHTML = `
        <div class="game-over-card">
            <h1>Game Over</h1>
            <p>Battle ended at frame ${frame}</p>
            <button id="return-lobby-btn">Return to Lobby</button>
        </div>
    `;
    overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 200;
        background: rgba(0,0,0,0.75);
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, sans-serif; color: #e0e0e0;
    `;
    const cardStyle = document.createElement('style');
    cardStyle.textContent = `
        .game-over-card {
            background: #16213e; border-radius: 12px; padding: 40px;
            text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        .game-over-card h1 { color: #f07; margin: 0 0 12px; }
        .game-over-card p { color: #888; margin: 0 0 24px; }
        .game-over-card button {
            padding: 12px 28px; border: none; border-radius: 6px;
            background: #4cc9f0; color: #0f1626; font-weight: 600;
            cursor: pointer; font-size: 15px;
        }
    `;
    document.head.appendChild(cardStyle);
    document.body.appendChild(overlay);

    document.getElementById('return-lobby-btn')!.onclick = () => {
        quitToLobby();
    };
}

async function startGame(gameServerPort: number): Promise<void> {
    showHUD();

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'block';

    // Build game server URL
    const host = window.location.hostname || 'localhost';
    const gameWsUrl = `ws://${host}:${gameServerPort}`;
    const lobbyHttpUrl = CONFIG.httpUrl; // static asset host

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    // Default camera pointing at origin — repositioned when MapData arrives
    const camera = new FreeCamera('camera', new Vector3(0, 1200, -1500), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.minZ = 1;
    camera.maxZ = 50000;

    // RTS controls — WASD pan, wheel zoom, edge scrolling. Replaces the
    // default FreeCamera mouse-look input.
    const rtsCamera = new RTSCamera(camera, canvas, {
        minHeight: 150,
        maxHeight: 6000,
        panSpeed: 1000,
        // Small per-notch step; tick() eases the actual distance toward
        // the target over several frames for a smooth feel.
        zoomStep: 0.08,
    });

    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.7;
    ambient.diffuse = new Color3(0.8, 0.85, 1.0);
    ambient.groundColor = new Color3(0.3, 0.25, 0.2);

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.3).normalize(), scene);
    sun.intensity = 1.5;
    sun.diffuse = new Color3(1.0, 0.95, 0.85);

    entityRenderer = new EntityRenderer(scene);
    audioManager = new AudioManager();
    combatFX = new CombatFX(scene, audioManager);

    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // Terrain state — populated when MapData arrives
    let terrainMesh: Mesh | null = null;
    let currentMapData: ParsedMapData | null = null;
    let currentWidgetHost: LuaWidgetHost | null = null;

    const onMapData = (map: ParsedMapData): void => {
        if (currentMapData) {
            console.log('[client] ignoring duplicate MapData');
            return;
        }
        currentMapData = map;
        console.log(`[client] MapData received: ${map.mapx}x${map.mapy}, ` +
            `${map.features.length} features, ${map.startPositions.length} start positions`);

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
            const wmat = new StandardMaterial('waterMat', scene);
            const [r, g, b] = map.water.baseColor;
            wmat.diffuseColor = new Color3(r, g, b);
            wmat.emissiveColor = new Color3(r * 0.3, g * 0.3, b * 0.3);
            wmat.specularColor = new Color3(0.2, 0.2, 0.2);
            wmat.alpha = Math.max(0.4, map.water.surfaceAlpha);
            wmat.backFaceCulling = false;
            water.material = wmat;
            console.log(`[water] plane rendered: baseColor=(${r.toFixed(2)},${g.toFixed(2)},${b.toFixed(2)}) damage=${map.water.damage}`);
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

        // Load any LuaUI widgets the map ships (mapinfo.lua water shaders,
        // lava layer rendering, etc.). Widgets are fetched from
        // /api/maps/source/{mapId}/... and executed via fengari.
        if (map.widgets.length > 0) {
            const host = new LuaWidgetHost(scene, camera, {
                ...map,
                // Make the source URL absolute so widget fetches resolve
                // against the lobby HTTP server, not the Vite dev server.
                mapSourceUrl: lobbyHttpUrl + map.mapSourceUrl,
            }, {
                // Pre-fetch Paper Tanks' LuaUI base and run it in every
                // widget's Lua state before the widget's own source, so
                // widgetHandler / WG / LUAUI_DIRNAME are in scope.
                // TODO: derive gameId from the room's selected game.
                gameId: 'papertanks',
            });
            void host.loadWidgets(map.widgets).then(() => {
                console.log(`[client] ${map.widgets.length} widget(s) loaded`);
            }).catch(e => {
                console.warn('[client] widget loading failed:', e);
            });
            currentWidgetHost = host;
        }
    };

    // Connect to the game server (separate from lobby connection).
    // Assigned to the module-level `gameConn` so the quit handler can
    // close it cleanly from outside this function. We also keep a
    // non-null local alias `conn` for use inside this function —
    // TypeScript can't narrow the module-level binding across the
    // async callbacks below, so we hand them `conn` instead.
    const conn: Connection = new Connection({
        onAuthenticated() {
            console.log(`[game] connected to game server on port ${gameServerPort}`);
        },
        onAuthFailed(msg: string) {
            console.error(`[game] auth failed: ${msg}`);
        },
        onMapData,
        onEntityState(snapshot, isDelta) {
            entityRenderer?.update(snapshot, isDelta);
            currentFrame++;
        },
        onCombatEvents(events) {
            combatFX?.onCombatEvents(events);
        },
        onEntityDestroy(entityId, x, y, z) {
            entityRenderer?.removeEntity(entityId);
            combatFX?.onCombatEvents([{
                attackerId: 0, targetId: entityId, weaponDefId: 0,
                result: 3, damage: 500, x, y, z,
            }]);
        },
        onGameOver(frame) {
            showGameOver(frame);
        },
    });
    gameConn = conn;

    // Use same credentials — game server auto-registers too
    // TODO: pass session token from lobby for proper auth
    conn.connect(gameWsUrl, 'player1', 'pass');

    // Input
    inputManager = new InputManager(scene, camera, entityRenderer, conn,
        (ids) => minimap?.setSelection(ids));

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

        rtsCamera.tick();
        entityRenderer?.tick();
        combatFX?.tick(dt);
        scene.render();

        if (now - lastViewportSend > 100) {
            sendCameraViewport(camera, conn);
            lastViewportSend = now;
        }

        hudCounter++;
        if (hudCounter >= 6) {
            hudCounter = 0;
            updateHUD(
                entityRenderer?.entityCount ?? 0,
                currentFrame,
                inputManager?.selection ?? [],
            );
            minimap?.render();
        }
    });

    window.addEventListener('resize', () => engine?.resize());
}

// --- Boot ---

document.addEventListener('DOMContentLoaded', () => {
    createHUD();

    // Hide canvas until game starts
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'none';

    // Global ESC handler: toggle the quit-to-lobby confirmation. Only
    // active while a game is running (detected by a non-null `engine`),
    // so ESC stays free for lobby UI dialogs.
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!engine) return;
        e.preventDefault();
        showQuitConfirm();
    });

    // Show lobby
    lobbyUI = new LobbyUI((gameServerPort: number) => {
        startGame(gameServerPort);
    });
});
