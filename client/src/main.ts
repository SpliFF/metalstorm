/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Connects to the game server, authenticates, and renders the game world.
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, Color4 } from '@babylonjs/core';
import { Connection, type ConnectionState } from './core/connection.js';
import { EntityRenderer } from './core/entity-renderer.js';
import { CombatFX } from './core/combat-fx.js';
import { AudioManager } from './core/audio.js';
import { loadTerrain } from './core/terrain.js';

let engine: Engine | null = null;
let connection: Connection | null = null;
let entityRenderer: EntityRenderer | null = null;
let combatFX: CombatFX | null = null;
let audioManager: AudioManager | null = null;

function showStatus(message: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

/**
 * Compute the camera's ground-plane viewport and send it to the server.
 */
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

/**
 * Initialise Babylon.js scene and load terrain.
 */
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

    // Resume audio on first click (browser autoplay policy)
    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // Load terrain heightmap from server (async, non-blocking)
    const serverBase = `http://${window.location.hostname || 'localhost'}:9001`;
    loadTerrain(scene, serverBase).then((terrainMesh) => {
        if (terrainMesh) {
            console.log('[client] terrain loaded');
        } else {
            console.log('[client] no terrain available, using flat ground');
        }
    });

    // Viewport updates at ~10Hz
    let lastViewportSend = 0;
    const VIEWPORT_INTERVAL = 100;

    let lastFrameTime = performance.now();

    engine.runRenderLoop(() => {
        const now = performance.now();
        const dt = (now - lastFrameTime) / 1000;
        lastFrameTime = now;

        // Interpolate entity positions before rendering
        entityRenderer?.tick();
        combatFX?.tick(dt);
        scene.render();

        const vpNow = performance.now();
        if (vpNow - lastViewportSend > VIEWPORT_INTERVAL) {
            sendCameraViewport(camera);
            lastViewportSend = vpNow;
        }
    });

    window.addEventListener('resize', () => {
        engine?.resize();
    });

    return scene;
}

/**
 * Connect to the game server.
 */
function connectToServer(): void {
    const serverUrl = `ws://${window.location.hostname || 'localhost'}:9001`;
    const username = 'player1';
    const password = 'pass';

    connection = new Connection({
        onStateChange(state: ConnectionState) {
            switch (state) {
                case 'connecting':
                    showStatus('Connecting to server...');
                    break;
                case 'handshake':
                    showStatus('Handshaking...');
                    break;
                case 'authenticating':
                    showStatus('Authenticating...');
                    break;
                case 'connected':
                    showStatus('Connected to server');
                    break;
                case 'disconnected':
                    showStatus('Disconnected from server');
                    break;
            }
        },
        onAuthenticated(playerId: number, _token: string) {
            showStatus(`Connected - Player ${playerId}`);
            console.log(`[client] authenticated as player ${playerId}`);
        },
        onAuthFailed(message: string) {
            showStatus(`Auth failed: ${message}`);
            console.error(`[client] auth failed: ${message}`);
        },
        onServerError(code: number, message: string) {
            console.warn(`[client] server error ${code}: ${message}`);
        },
        onEntityState(snapshot, isDelta) {
            entityRenderer?.update(snapshot, isDelta);
        },
        onCombatEvents(events) {
            combatFX?.onCombatEvents(events);
        },
    });

    connection.connect(serverUrl, username, password);
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    showStatus('Initialising...');
    initScene();
    connectToServer();
});
