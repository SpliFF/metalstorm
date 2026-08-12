/**
 * CameraInput — thin main-thread DOM-input owner for one game view (GW4-c5b).
 *
 * The interactive RTS camera (state machine + scene.pick + viewport send) lives
 * INSIDE the game-processor worker (rts-camera.ts → WorkerCamera). But the worker
 * has no DOM, and `#game-canvas` — though transferred to the worker via
 * `transferControlToOffscreen()` — still receives pointer/wheel events on the main
 * thread (only its *rendering context* moved). So this class captures those raw
 * events, normalizes them to canvas-relative CSS pixels (origin top-left, y-down —
 * Babylon's native screen space) + a modifier bitmask, and forwards them to the
 * worker as `gp:*` input messages tagged with `viewId`.
 *
 * Per the multi-view decision (PLAN-game-worker.md, memory: project_multiview_decision)
 * input is per-view: each view is a camera + a canvas, and `viewId` routes the
 * input to the matching WorkerCamera in the worker's `Map<viewId, WorkerCamera>`.
 * c5b ships a single view (id 0); this stays correct as views are added.
 *
 * Pointer capture is held here (main) for the duration of a middle/right drag so
 * move/up keep arriving even when the cursor leaves the canvas — the worker camera
 * tracks drag state purely off the forwarded pointer stream.
 */

import type { GpInputToWorker } from './game-worker-protocol.js';

/** Pack the modifier keys of a DOM event into the wire bitmask
 *  (1=shift, 2=ctrl, 4=alt, 8=meta). */
function packMods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
    return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

/**
 * Key codes the worker camera actually pans on (`rts-camera.ts` tick(): arrow
 * keys only — Spring/ZK reserve WASD for unit orders). Kept as a set here rather
 * than "any keydown" so typing a command in the console, or pressing a hotkey,
 * doesn't count as taking the camera back.
 */
const CAMERA_KEY_CODES: ReadonlySet<string> = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class CameraInput {
    private readonly canvas: HTMLCanvasElement;
    private readonly worker: Worker;
    private readonly viewId: number;
    private disposed = false;
    /** PLAN-metalstorm-command-language.md §6.2 — "the player just moved the
     *  camera" observers (the NL follow loop's cancel signal). This class is
     *  where that is knowable: it owns the DOM listeners whose events ARE the
     *  worker camera's only interactive input. */
    private cameraInputListeners = new Set<() => void>();

    constructor(canvas: HTMLCanvasElement, worker: Worker, viewId = 0) {
        this.canvas = canvas;
        this.worker = worker;
        this.viewId = viewId;

        canvas.addEventListener('pointermove', this.onPointerMove);
        canvas.addEventListener('pointerdown', this.onPointerDown);
        canvas.addEventListener('pointerup', this.onPointerUp);
        // Cursor leaving the canvas (incl. leaving the window) must stop
        // edge-scroll — otherwise the last edge-parked pointermove keeps the
        // camera scrolling with no event to clear it.
        canvas.addEventListener('pointerleave', this.onPointerLeave);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
        // Right-drag must not pop the browser context menu; middle-click must not
        // trigger autoscroll / "open in new tab".
        canvas.addEventListener('contextmenu', this.preventDefault);
        canvas.addEventListener('auxclick', this.onAuxClick);
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
    }

    /**
     * Subscribe to "the player moved the camera". Fires for the inputs the
     * worker camera consumes as camera motion — wheel zoom, middle-pan and
     * right-orbit presses, arrow-key pans — and NOT for left-clicks (selection),
     * plain pointer motion, or other keys.
     *
     * Edge-scroll has no discrete event to hook (the worker pans from a pointer
     * position it already has, inside its own frame tick), so a consumer that
     * must be certain also needs a pose check — see `camera-port.ts`.
     */
    onCameraInput(listener: () => void): () => void {
        this.cameraInputListeners.add(listener);
        return () => { this.cameraInputListeners.delete(listener); };
    }

    private notifyCameraInput(): void {
        for (const listener of this.cameraInputListeners) {
            try { listener(); } catch (e) { console.error('[camera-input] listener failed:', e); }
        }
    }

    /** Post an input message to the worker, tagged with this view's id. */
    private send(msg: GpInputToWorker): void {
        // viewId is carried as an extra field; the worker routes on it. (The
        // GpInputToWorker union types the discriminated payload; viewId is the
        // per-view routing tag added for multi-view, default 0.)
        this.worker.postMessage({ ...msg, viewId: this.viewId });
    }

    /** Canvas-relative CSS-pixel coordinates of a pointer/mouse event. */
    private rel(e: { clientX: number; clientY: number }): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    private onPointerMove = (e: PointerEvent): void => {
        const { x, y } = this.rel(e);
        this.send({ type: 'gp:pointermove', x, y, buttons: e.buttons, mods: packMods(e) });
    };

    private onPointerDown = (e: PointerEvent): void => {
        // Middle / right press starts a camera drag: capture the pointer so we
        // keep getting move/up off-canvas, and swallow the default behaviour.
        if (e.button === 1 || e.button === 2) {
            e.preventDefault();
            try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
            this.notifyCameraInput();      // middle-pan / right-orbit
        }
        const { x, y } = this.rel(e);
        this.send({ type: 'gp:pointerdown', x, y, button: e.button, mods: packMods(e) });
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (e.button === 1 || e.button === 2) {
            try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        }
        const { x, y } = this.rel(e);
        this.send({ type: 'gp:pointerup', x, y, button: e.button, mods: packMods(e) });
    };

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const { x, y } = this.rel(e);
        this.send({ type: 'gp:wheel', x, y, delta: e.deltaY, mods: packMods(e) });
        this.notifyCameraInput();
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        // Ignore keystrokes aimed at a text field (lobby/login inputs).
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        this.send({ type: 'gp:keydown', code: e.code, mods: packMods(e) });
        if (CAMERA_KEY_CODES.has(e.code)) this.notifyCameraInput();
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        this.send({ type: 'gp:keyup', code: e.code, mods: packMods(e) });
    };

    private onPointerLeave = (): void => {
        this.send({ type: 'gp:pointerleave' });
    };

    private onBlur = (): void => {
        this.send({ type: 'gp:blur' });
    };

    private preventDefault = (e: Event): void => { e.preventDefault(); };

    private onAuxClick = (e: MouseEvent): void => {
        // Suppress the middle-click autoscroll marker once a pan drag ends.
        if (e.button === 1) e.preventDefault();
    };

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerdown', this.onPointerDown);
        this.canvas.removeEventListener('pointerup', this.onPointerUp);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.canvas.removeEventListener('wheel', this.onWheel);
        this.canvas.removeEventListener('contextmenu', this.preventDefault);
        this.canvas.removeEventListener('auxclick', this.onAuxClick);
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.cameraInputListeners.clear();
    }
}
