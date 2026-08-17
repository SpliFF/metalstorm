/**
 * P5 item 5: the camera's test-input lock and transition-settle hook.
 *
 * Built on a NullEngine scene (same pattern as squad-render-backend.test.ts) —
 * RTSCamera owns no DOM, so it constructs fine outside a browser.
 */
import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, FreeCamera, Vector3 } from '@babylonjs/core';
import { RTSCamera } from './rts-camera.js';

function makeCamera(): { cam: RTSCamera; free: FreeCamera; dispose: () => void } {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const free = new FreeCamera('cam', new Vector3(0, 1000, -800), scene);
    free.setTarget(Vector3.Zero());
    const cam = new RTSCamera(free, 1920, 1080, 1, { edgeScrollPixels: 8 });
    return { cam, free, dispose: () => { scene.dispose(); engine.dispose(); } };
}

describe('RTSCamera input lock', () => {
    it('starts unlocked and pans on a held arrow key', () => {
        const { cam, free, dispose } = makeCamera();
        expect(cam.isInputLocked).toBe(false);
        const before = free.position.clone();
        cam.keyDown('arrowup');
        cam.tick();
        // A tick's dt comes from the wall clock, so assert *some* motion after
        // giving the loop a measurable slice.
        const start = Date.now();
        while (Date.now() - start < 20) { /* let dt accumulate */ }
        cam.tick();
        expect(Vector3.Distance(free.position, before)).toBeGreaterThan(0);
        dispose();
    });

    it('drops held keys and stops panning when locked', () => {
        const { cam, free, dispose } = makeCamera();
        cam.keyDown('arrowup');
        cam.setInputLocked(true);
        expect(cam.isInputLocked).toBe(true);
        cam.tick();
        const parked = free.position.clone();
        const start = Date.now();
        while (Date.now() - start < 20) { /* let dt accumulate */ }
        cam.tick();
        expect(Vector3.Distance(free.position, parked)).toBe(0);
        dispose();
    });

    it('ignores fresh input intents while locked', () => {
        const { cam, free, dispose } = makeCamera();
        cam.setInputLocked(true);
        cam.keyDown('arrowleft');
        cam.wheel(0, 0, -300);
        cam.pointerMove(1, 1, 0);          // an edge-scroll corner
        cam.pointerDown(1, 1, 1, 0);       // middle-drag start
        const parked = free.position.clone();
        for (let i = 0; i < 5; i++) cam.tick();
        expect(Vector3.Distance(free.position, parked)).toBe(0);
        dispose();
    });

    it('accepts input again after unlocking', () => {
        const { cam, free, dispose } = makeCamera();
        cam.setInputLocked(true);
        cam.setInputLocked(false);
        cam.keyDown('arrowup');
        cam.tick();
        const start = Date.now();
        while (Date.now() - start < 20) { /* let dt accumulate */ }
        cam.tick();
        expect(Vector3.Distance(free.position, Vector3.Zero())).toBeGreaterThan(0);
        expect(cam.isInputLocked).toBe(false);
        dispose();
    });

    it('still allows programmatic moves while locked', () => {
        const { cam, free, dispose } = makeCamera();
        cam.setInputLocked(true);
        const before = free.position.clone();
        cam.focusOn(500, 500);             // instant (durationMs = 0)
        expect(Vector3.Distance(free.position, before)).toBeGreaterThan(0);
        dispose();
    });

    it('clears the lock on dispose so it cannot outlive the camera', () => {
        const { cam, dispose } = makeCamera();
        cam.setInputLocked(true);
        cam.dispose();
        expect(cam.isInputLocked).toBe(false);
        dispose();
    });
});

describe('RTSCamera waitForSettle', () => {
    it('resolves immediately when no transition is running', async () => {
        const { cam, dispose } = makeCamera();
        await expect(cam.waitForSettle()).resolves.toBeUndefined();
        dispose();
    });

    it('resolves when a transition completes', async () => {
        const { cam, dispose } = makeCamera();
        cam.focusOn(400, 400, 30);
        expect(cam.isAnimating).toBe(true);
        const settled = cam.waitForSettle();
        let done = false;
        void settled.then(() => { done = true; });
        // Drive the transition to completion.
        for (let i = 0; i < 40 && cam.isAnimating; i++) {
            await new Promise((r) => setTimeout(r, 5));
            cam.tick();
        }
        await settled;
        expect(done).toBe(true);
        expect(cam.isAnimating).toBe(false);
        dispose();
    });

    it('resolves on cancelTransition', async () => {
        const { cam, dispose } = makeCamera();
        cam.focusOn(400, 400, 5000);
        const settled = cam.waitForSettle();
        cam.cancelTransition();
        await expect(settled).resolves.toBeUndefined();
        dispose();
    });

    it('resolves on dispose — a waiter must never strand', async () => {
        const { cam, dispose } = makeCamera();
        cam.focusOn(400, 400, 5000);
        const settled = cam.waitForSettle();
        cam.dispose();
        await expect(settled).resolves.toBeUndefined();
        dispose();
    });

    it('resolves when user input cancels the transition mid-flight', async () => {
        const { cam, dispose } = makeCamera();
        cam.focusOn(400, 400, 5000);
        const settled = cam.waitForSettle();
        cam.keyDown('arrowup');            // input cancels an animation
        await new Promise((r) => setTimeout(r, 5));
        cam.tick();
        await expect(settled).resolves.toBeUndefined();
        dispose();
    });
});
