/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Connects to the game server, authenticates, and renders the game world.
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, MeshBuilder, Color4 } from '@babylonjs/core';
import { Connection, type ConnectionState } from './core/connection.js';

let engine: Engine | null = null;
let connection: Connection | null = null;

function showStatus(message: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

/**
 * Initialise Babylon.js with a placeholder scene.
 * Will be replaced with real terrain + entity rendering when state streaming works.
 */
function initScene(): void {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.05, 0.08, 0.12, 1);

    const camera = new FreeCamera('camera', new Vector3(0, 50, -80), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.attachControl(canvas, true);

    new HemisphericLight('light', new Vector3(0.3, 1, 0.2), scene);

    // Placeholder ground
    const ground = MeshBuilder.CreateGround('ground', { width: 200, height: 200 }, scene);
    ground.position.y = 0;

    engine.runRenderLoop(() => {
        scene.render();
    });

    window.addEventListener('resize', () => {
        engine?.resize();
    });
}

/**
 * Connect to the game server.
 */
function connectToServer(): void {
    // Default server URL — same host, port 9001
    const serverUrl = `ws://${window.location.hostname || 'localhost'}:9001`;
    const username = 'player1'; // TODO: lobby UI for login
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
    });

    connection.connect(serverUrl, username, password);
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    showStatus('Initialising...');
    initScene();
    connectToServer();
});
