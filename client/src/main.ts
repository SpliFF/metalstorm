/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Flow: Login → Room Browser → Room Setup → Game
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, Color4 } from '@babylonjs/core';
import { EntityRenderer } from './core/entity-renderer.js';
import { CombatFX } from './core/combat-fx.js';
import { AudioManager } from './core/audio.js';
import { InputManager } from './core/input-manager.js';
import { loadTerrain } from './core/terrain.js';
import { LobbyUI } from './lobby/lobby-ui.js';
import type { Connection } from './core/connection.js';

let engine: Engine | null = null;
let entityRenderer: EntityRenderer | null = null;
let combatFX: CombatFX | null = null;
let audioManager: AudioManager | null = null;
let inputManager: InputManager | null = null;
let lobbyUI: LobbyUI | null = null;

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

function startGame(connection: Connection): void {
    showHUD();

    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'block';

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

    entityRenderer = new EntityRenderer(scene);
    audioManager = new AudioManager();
    combatFX = new CombatFX(scene, audioManager);

    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // Load terrain
    const serverBase = `http://${window.location.hostname || 'localhost'}:9001`;
    loadTerrain(scene, serverBase).then((mesh) => {
        if (mesh) console.log('[client] terrain loaded');
    });

    // Input
    inputManager = new InputManager(scene, camera, entityRenderer, connection);

    // Wire connection callbacks for game state
    connection.setEvents({
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
    });

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
            sendCameraViewport(camera, connection);
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
    lobbyUI = new LobbyUI(() => {
        // Game start callback — lobby hides, game scene starts
        const conn = lobbyUI?.getConnection();
        if (conn) {
            startGame(conn);
        }
    });
});
