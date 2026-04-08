/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Connects to the game server, authenticates, and renders the game world.
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, MeshBuilder, Color4, Color3, StandardMaterial } from '@babylonjs/core';
import { Connection, type ConnectionState } from './core/connection.js';
import { EntityRenderer } from './core/entity-renderer.js';

let engine: Engine | null = null;
let connection: Connection | null = null;
let entityRenderer: EntityRenderer | null = null;

function showStatus(message: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

/**
 * Compute the camera's ground-plane viewport and send it to the server.
 * Approximates the visible area by projecting the camera frustum onto y=0.
 */
function sendCameraViewport(camera: FreeCamera): void {
    if (!connection?.authenticated) return;

    // Use camera position and target to estimate visible ground area.
    // For a perspective camera looking down, the visible width at ground
    // level is roughly: 2 * height * tan(fov/2) * aspect
    const height = Math.max(camera.position.y, 1);
    const fov = camera.fov; // vertical FOV in radians
    const aspect = engine ? engine.getAspectRatio(camera) : 16 / 9;

    const visibleHeight = 2 * height * Math.tan(fov / 2);
    const visibleWidth = visibleHeight * aspect;

    // Camera target on ground plane (approximate center of viewport)
    const dir = camera.getTarget().subtract(camera.position).normalize();
    // Project camera position down to ground: find t where pos.y + t*dir.y = 0
    const t = dir.y !== 0 ? -camera.position.y / dir.y : 0;
    const groundX = camera.position.x + dir.x * Math.max(t, 0);
    const groundZ = camera.position.z + dir.z * Math.max(t, 0);

    // Camera Y rotation
    const rotation = Math.atan2(dir.x, dir.z);

    // Zoom level: higher camera = more zoomed out
    const zoomLevel = Math.max(1, height / 100);

    connection.sendViewportUpdate(0, groundX, groundZ, visibleWidth, visibleHeight, rotation, zoomLevel);
}

/**
 * Initialise Babylon.js scene.
 */
function initScene(): Scene {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    // Camera positioned to overlook a typical Spring map area
    const camera = new FreeCamera('camera', new Vector3(1600, 800, 2400), scene);
    camera.setTarget(new Vector3(1600, 0, 3200));
    camera.attachControl(canvas, true);
    camera.speed = 50;
    camera.minZ = 1;
    camera.maxZ = 50000;

    new HemisphericLight('light', new Vector3(0.3, 1, 0.2), scene);

    // Ground plane at y=0
    const ground = MeshBuilder.CreateGround('ground', { width: 8192, height: 8192 }, scene);
    ground.position.x = 4096;
    ground.position.z = 4096;
    const groundMat = new StandardMaterial('groundMat', scene);
    groundMat.diffuseColor = new Color3(0.15, 0.2, 0.1);
    groundMat.specularColor = new Color3(0, 0, 0);
    ground.material = groundMat;

    // Entity renderer
    entityRenderer = new EntityRenderer(scene);

    // Send viewport updates at ~10Hz (throttled)
    let lastViewportSend = 0;
    const VIEWPORT_INTERVAL = 100; // ms

    engine.runRenderLoop(() => {
        scene.render();

        const now = performance.now();
        if (now - lastViewportSend > VIEWPORT_INTERVAL) {
            sendCameraViewport(camera);
            lastViewportSend = now;
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
    });

    connection.connect(serverUrl, username, password);
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    showStatus('Initialising...');
    initScene();
    connectToServer();
});
