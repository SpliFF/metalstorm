/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Flow: Login → Room Browser → Room Setup → Game
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, DirectionalLight, Color3, Color4 } from '@babylonjs/core';
import { EntityRenderer } from './core/entity-renderer.js';
import { CombatFX } from './core/combat-fx.js';
import { AudioManager } from './core/audio.js';
import { InputManager } from './core/input-manager.js';
import { loadTerrain } from './core/terrain.js';
import { LobbyUI } from './lobby/lobby-ui.js';
import { Minimap } from './core/minimap.js';
import { Connection } from './core/connection.js';

let engine: Engine | null = null;
let entityRenderer: EntityRenderer | null = null;
let combatFX: CombatFX | null = null;
let audioManager: AudioManager | null = null;
let inputManager: InputManager | null = null;
let lobbyUI: LobbyUI | null = null;
let minimap: Minimap | null = null;

// --- HUD ---

function createHUD(): void {
    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.display = 'none'; // hidden until game starts
    hud.innerHTML = `
        <div id="hud-top-bar" class="hud-panel">
            <span id="hud-entities">Entities: 0</span>
            <span id="hud-frame">Frame: 0</span>
        </div>
        <div id="hud-selection" class="hud-panel">
            <span id="hud-selected">No selection</span>
        </div>
        <div id="hud-minimap" class="hud-panel">
            <div id="minimap-container"></div>
            <button id="detach-minimap-btn" style="margin-top:4px;font-size:11px;padding:4px 8px;">Detach ↗</button>
        </div>
        <div id="hud-help" class="hud-panel">
            Left click: select &nbsp; Right click: move/attack &nbsp; S: stop &nbsp; Shift: queue
        </div>
    `;
    document.body.appendChild(hud);

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
            display: flex; gap: 24px;
        }
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
        overlay.remove();
        // Hide game, show lobby
        const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
        canvas.style.display = 'none';
        const hud = document.getElementById('game-hud');
        if (hud) hud.style.display = 'none';
        engine?.stopRenderLoop();
        engine?.dispose();
        engine = null;
        lobbyUI?.showBrowser();
        lobbyUI?.show();
    };
}

async function startGame(gameServerPort: number): Promise<void> {
    showHUD();

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'block';

    // Build game server URL
    const host = window.location.hostname || 'localhost';
    const gameWsUrl = `ws://${host}:${gameServerPort}`;
    const gameHttpUrl = `http://${host}:${gameServerPort}`;

    // Connect to the game server (separate from lobby connection)
    const gameConn = new Connection({
        onAuthenticated() {
            console.log(`[game] connected to game server on port ${gameServerPort}`);
        },
        onAuthFailed(msg: string) {
            console.error(`[game] auth failed: ${msg}`);
        },
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

    // Use same credentials — game server auto-registers too
    // TODO: pass session token from lobby for proper auth
    gameConn.connect(gameWsUrl, 'player1', 'pass');

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    // Fetch map info from game server to position camera
    let mapW = 8192, mapH = 8192;
    // Wait a moment for the game server to start, then fetch
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            const infoResp = await fetch(`${gameHttpUrl}/api/map/info`);
            if (infoResp.ok) {
                const info = await infoResp.json();
                mapW = info.widthElmos ?? 8192;
                mapH = info.heightElmos ?? 8192;
                break;
            }
        } catch { /* server not ready yet */ }
        await new Promise(r => setTimeout(r, 500));
    }

    const mapCenterX = mapW / 2;
    const mapCenterZ = mapH / 2;

    const camera = new FreeCamera('camera',
        new Vector3(mapCenterX, 1200, mapCenterZ - 1500), scene);
    camera.setTarget(new Vector3(mapCenterX, 0, mapCenterZ));
    camera.attachControl(canvas, true);
    camera.speed = 80;
    camera.minZ = 1;
    camera.maxZ = 50000;

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

    // Load terrain from game server
    loadTerrain(scene, gameHttpUrl).then((mesh) => {
        if (mesh) console.log('[client] terrain loaded');
    });

    // Input
    inputManager = new InputManager(scene, camera, entityRenderer, gameConn,
        (ids) => minimap?.setSelection(ids));

    // Minimap
    {
        const container = document.getElementById('minimap-container');
        if (container && entityRenderer) {
            minimap = new Minimap(
                { mapWidth: mapW, mapHeight: mapH, parentElement: container, size: 200 },
                entityRenderer, gameConn);
            minimap.onCameraMove = (x, z) => {
                camera.position.x = x;
                camera.position.z = z - 800;
                camera.setTarget(new Vector3(x, 0, z));
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

        entityRenderer?.tick();
        combatFX?.tick(dt);
        scene.render();

        if (now - lastViewportSend > 100) {
            sendCameraViewport(camera, gameConn);
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

    // Show lobby
    lobbyUI = new LobbyUI((gameServerPort: number) => {
        startGame(gameServerPort);
    });
});
