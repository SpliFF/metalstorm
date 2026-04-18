/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * This is the top-level orchestrator. It manages the lifecycle transitions
 * between lobby UI and game rendering, maintaining the WebSocket connection
 * across both.
 */

import { Engine, Scene, FreeCamera, Vector3, HemisphericLight, MeshBuilder } from '@babylonjs/core';

// Application state
type AppPhase = 'lobby' | 'loading' | 'game' | 'postgame';

let currentPhase: AppPhase = 'lobby';
let engine: Engine | null = null;

function showStatus(message: string): void {
    const el = document.getElementById('status');
    if (el) el.textContent = message;
}

/**
 * Initialise Babylon.js with a test scene to verify WebGL works.
 * This will be replaced with the real game renderer in Phase 2.
 */
function initTestScene(): void {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    if (!canvas) return;

    engine = new Engine(canvas, true);
    const scene = new Scene(engine);

    const camera = new FreeCamera('camera', new Vector3(0, 5, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.attachControl(canvas, true);

    new HemisphericLight('light', new Vector3(0, 1, 0), scene);

    // Test geometry — a ground plane and a box
    const ground = MeshBuilder.CreateGround('ground', { width: 10, height: 10 }, scene);
    const box = MeshBuilder.CreateBox('box', { size: 1 }, scene);
    box.position.y = 0.5;

    engine.runRenderLoop(() => {
        scene.render();
    });

    window.addEventListener('resize', () => {
        engine?.resize();
    });

    showStatus('Babylon.js WebGL 2 — rendering test scene');
    currentPhase = 'game';
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    showStatus('Spring RTS Web — client loaded');

    // For now, go straight to the test scene
    // In Phase 5 this will show the Svelte lobby first
    initTestScene();
});
