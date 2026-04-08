/**
 * Spring RTS Web — Browser Client Entry Point
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, Color4 } from '@babylonjs/core';
import { Connection, type ConnectionState } from './core/connection.js';
import { EntityRenderer } from './core/entity-renderer.js';
import { CombatFX } from './core/combat-fx.js';
import { AudioManager } from './core/audio.js';
import { InputManager } from './core/input-manager.js';
import { loadTerrain } from './core/terrain.js';

let engine: Engine | null = null;
let connection: Connection | null = null;
let entityRenderer: EntityRenderer | null = null;
let combatFX: CombatFX | null = null;
let audioManager: AudioManager | null = null;
let inputManager: InputManager | null = null;

// --- HUD ---

function createHUD(): void {
    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.innerHTML = `
        <div id="hud-top-bar" class="hud-panel">
            <span id="hud-entities">Entities: 0</span>
            <span id="hud-frame">Frame: 0</span>
            <span id="hud-connection">Disconnected</span>
        </div>
        <div id="hud-selection" class="hud-panel">
            <span id="hud-selected">No selection</span>
        </div>
        <div id="hud-help" class="hud-panel">
            Left click: select &nbsp; Right click: move/attack &nbsp; S: stop &nbsp; Shift+click: queue
        </div>
    `;
    document.body.appendChild(hud);

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
        #game-hud {
            position: fixed; inset: 0;
            z-index: 10;
            pointer-events: none;
            font: 13px/1.4 system-ui, sans-serif;
            color: #e0e0e0;
        }
        .hud-panel {
            pointer-events: auto;
            background: rgba(0,0,0,0.7);
            padding: 6px 12px;
            border-radius: 4px;
        }
        #hud-top-bar {
            position: absolute; top: 8px; left: 8px; right: 8px;
            display: flex; gap: 24px;
        }
        #hud-selection {
            position: absolute; bottom: 48px; left: 8px;
            min-width: 200px;
        }
        #hud-help {
            position: absolute; bottom: 8px; left: 8px; right: 8px;
            text-align: center; font-size: 11px; color: #888;
        }
    `;
    document.head.appendChild(style);
}

function updateHUD(entityCount: number, frame: number, connState: string, selectedIds: readonly number[]): void {
    const elEntities = document.getElementById('hud-entities');
    const elFrame = document.getElementById('hud-frame');
    const elConn = document.getElementById('hud-connection');
    const elSelected = document.getElementById('hud-selected');

    if (elEntities) elEntities.textContent = `Entities: ${entityCount}`;
    if (elFrame) elFrame.textContent = `Frame: ${frame}`;
    if (elConn) elConn.textContent = connState;
    if (elSelected) {
        if (selectedIds.length === 0) {
            elSelected.textContent = 'No selection';
        } else if (selectedIds.length === 1) {
            elSelected.textContent = `Selected: unit ${selectedIds[0]}`;
        } else {
            elSelected.textContent = `Selected: ${selectedIds.length} units`;
        }
    }
}

// --- Status ---

function showStatus(message: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

// --- Viewport ---

function sendCameraViewport(camera: FreeCamera): void {
    if (!connection?.authenticated) return;

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

// --- Scene ---

let currentFrame = 0;
let connectionStatus = 'Disconnected';

async function initScene(): Promise<Scene> {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    const camera = new FreeCamera('camera', new Vector3(1600, 800, 2400), scene);
    camera.setTarget(new Vector3(1600, 0, 3200));
    camera.attachControl(canvas, true);
    camera.speed = 50;
    camera.minZ = 1;
    camera.maxZ = 50000;

    new HemisphericLight('light', new Vector3(0.3, 1, 0.2), scene);

    // Entity renderer
    entityRenderer = new EntityRenderer(scene);

    // Audio and combat effects
    audioManager = new AudioManager();
    combatFX = new CombatFX(scene, audioManager);

    // Resume audio on first click
    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // Load terrain
    const serverBase = `http://${window.location.hostname || 'localhost'}:9001`;
    loadTerrain(scene, serverBase).then((mesh) => {
        if (mesh) console.log('[client] terrain loaded');
    });

    // Render loop
    let lastViewportSend = 0;
    const VIEWPORT_INTERVAL = 100;
    let lastFrameTime = performance.now();
    let hudUpdateCounter = 0;

    engine.runRenderLoop(() => {
        const now = performance.now();
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        entityRenderer?.tick();
        combatFX?.tick(dt);
        scene.render();

        const vpNow = performance.now();
        if (vpNow - lastViewportSend > VIEWPORT_INTERVAL) {
            sendCameraViewport(camera);
            lastViewportSend = vpNow;
        }

        // Update HUD at ~10Hz
        hudUpdateCounter++;
        if (hudUpdateCounter >= 6) {
            hudUpdateCounter = 0;
            updateHUD(
                entityRenderer?.entityCount ?? 0,
                currentFrame,
                connectionStatus,
                inputManager?.selection ?? [],
            );
        }
    });

    window.addEventListener('resize', () => engine?.resize());

    return scene;
}

// --- Connection ---

function connectToServer(scene: Scene, camera: FreeCamera): void {
    const serverUrl = `ws://${window.location.hostname || 'localhost'}:9001`;
    const username = 'player1';
    const password = 'pass';

    connection = new Connection({
        onStateChange(state: ConnectionState) {
            connectionStatus = state;
            showStatus(state);
        },
        onAuthenticated(playerId: number, _token: string) {
            connectionStatus = `Player ${playerId}`;
            showStatus(`Connected - Player ${playerId}`);

            // Create input manager now that we have a connection
            if (!inputManager && entityRenderer && connection) {
                inputManager = new InputManager(
                    scene, camera, entityRenderer, connection,
                    (ids) => {
                        // Selection changed — could update HUD immediately
                        console.log(`[input] selected: ${ids.join(', ') || 'none'}`);
                    },
                );
            }
        },
        onAuthFailed(message: string) {
            connectionStatus = 'Auth failed';
            showStatus(`Auth failed: ${message}`);
        },
        onServerError(code: number, message: string) {
            console.warn(`[client] server error ${code}: ${message}`);
        },
        onEntityState(snapshot, isDelta) {
            entityRenderer?.update(snapshot, isDelta);
            // Track frame from entity count progression
            currentFrame++;
        },
        onCombatEvents(events) {
            combatFX?.onCombatEvents(events);
        },
        onEntityDestroy(entityId, x, y, z) {
            entityRenderer?.removeEntity(entityId);
            // Spawn explosion at death position
            combatFX?.onCombatEvents([{
                attackerId: 0, targetId: entityId, weaponDefId: 0,
                result: 3, damage: 500, x, y, z,
            }]);
        },
    });

    connection.connect(serverUrl, username, password);
}

// --- Boot ---

document.addEventListener('DOMContentLoaded', async () => {
    showStatus('Initialising...');
    createHUD();

    const scene = await initScene();
    const camera = scene.activeCamera as FreeCamera;
    connectToServer(scene, camera);
});
