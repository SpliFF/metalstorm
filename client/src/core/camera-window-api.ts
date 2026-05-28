/**
 * `window.camera` — discoverable camera-control surface for four caller
 * categories:
 *
 *   - JS console / dev tools          (this object directly)
 *   - chrome-devtools MCP             (via evaluate_script on this object)
 *   - TestHarness / spring-test MCP   (forwards through these primitives)
 *   - Lua widgets                     (Spring.SetCameraState / SetCameraTarget
 *                                       /GetCameraState — wired in lua-spring-api)
 *
 * All methods that move the camera accept an optional `durationMs`
 * parameter: 0 = instant jump, >0 = animate over that many milliseconds
 * with smooth ease-in-out.
 *
 * The entity-position lookup needed by `snapToUnit` lives on the active
 * EntityRenderer, which is only constructed inside `startGame()`. We
 * accept a getter (lazy) so the installer can run before the renderer
 * exists.
 */

import type { RTSCamera } from './rts-camera.js';
import type { EntityRenderer } from './entity-renderer.js';

interface CameraApi {
    getPose: () => any;
    setPose: (pose: any, durationMs?: number) => void;
    snapToGround: (x: number, z: number, opts?: any) => void;
    snapToUnit: (unitId: number, opts?: any) => void;
    pointAt: (p: any, durationMs?: number) => void;
    moveTo: (p: any, durationMs?: number) => void;
    moveBy: (delta: any, durationMs?: number) => void;
    orbit: (opts?: any) => void;
    setHeading: (yawDeg: number, durationMs?: number) => void;
    setPitch: (pitchDeg: number, durationMs?: number) => void;
    setDistance: (d: number, durationMs?: number) => void;
    fitMap: (opts?: any) => void;
    saveSlot: (slot: number) => void;
    loadSlot: (slot: number, durationMs?: number) => boolean;
    hasSlot: (slot: number) => boolean;
    focusOn: (x: number, z: number, durationMs?: number) => void;
    lookAt: (x: number, y: number, z: number, durationMs?: number) => void;
    saveView: () => any;
    restoreView: (view: any, durationMs?: number) => void;
    rotateAroundTarget: (yawDeg: number, pitchDeg?: number, durationMs?: number) => void;
    cancel: () => void;
    readonly animating: boolean;
    readonly target: { x: number; y: number; z: number };
    readonly position: { x: number; y: number; z: number };
}

export function installCameraWindowApi(
    rtsCamera: RTSCamera,
    getEntityRenderer: () => EntityRenderer | null,
): void {
    const api: CameraApi = {
        // ── Pose primitives ─────────────────────────────────────────
        /** Read the current pose. */
        getPose: () => rtsCamera.getPose(),
        /** Set both camera position and look-at point. */
        setPose: (pose, durationMs) => rtsCamera.setPose(pose, durationMs),

        // ── Snap / point ───────────────────────────────────────────
        /** Snap to a ground point. opts: {height?, pitchDeg?, durationMs?} */
        snapToGround: (x, z, opts = {}) => rtsCamera.snapToGround(x, z, opts),
        /** Snap to a unit by ID. opts: {height?, pitchDeg?, durationMs?} */
        snapToUnit: (unitId, opts = {}) => {
            const er = getEntityRenderer();
            const p = er?.getEntityPosition(unitId);
            if (!p) throw new Error(`[camera] no client-side position for unit ${unitId}`);
            rtsCamera.snapToGround(p.x, p.z, opts);
        },
        /** Look at an arbitrary 3D point ({x,y,z}). */
        pointAt: (p, durationMs) => rtsCamera.pointAt(p, durationMs),

        // ── Movement ───────────────────────────────────────────────
        /** Absolute camera position; preserves look direction. */
        moveTo: (p, durationMs) => rtsCamera.moveTo(p, durationMs),
        /** Relative camera translation (also translates look-at). */
        moveBy: (delta, durationMs) => rtsCamera.moveBy(delta, durationMs),

        // ── Orbit ──────────────────────────────────────────────────
        /** Orbit around current look-at. opts: {yawDeg?, pitchDeg?, distance?, durationMs?} */
        orbit: (opts = {}) => rtsCamera.orbit(opts),
        /** Set heading (degrees CW from +Z). */
        setHeading: (yawDeg, durationMs) => rtsCamera.setHeading(yawDeg, durationMs),
        /** Set downward pitch (degrees). */
        setPitch: (pitchDeg, durationMs) => rtsCamera.setPitch(pitchDeg, durationMs),
        /** Set camera-to-target distance. */
        setDistance: (d, durationMs) => rtsCamera.setDistance(d, durationMs),

        // ── Fit + saved slots ──────────────────────────────────────
        /** Top-down view sized to the entire map. */
        fitMap: (opts = {}) => rtsCamera.fitMap(opts),
        /** Save current pose to a numbered slot (Spring F2..F6 convention). */
        saveSlot: (slot) => rtsCamera.saveSlot(slot),
        /** Recall a numbered slot. Returns false if empty. */
        loadSlot: (slot, durationMs) => rtsCamera.loadSlot(slot, durationMs),
        /** True if a saved slot has a stored pose. */
        hasSlot: (slot) => rtsCamera.hasSlot(slot),

        // ── Legacy aliases (kept for backwards compat) ─────────────
        /** Move camera to look at world XZ position. */
        focusOn: (x, z, durationMs) => rtsCamera.focusOn(x, z, durationMs),
        /** Move camera to look at a 3D world position, keeping current distance. */
        lookAt: (x, y, z, durationMs) => rtsCamera.lookAtPosition(x, y, z, durationMs),
        /** Save current camera view for later restoration. */
        saveView: () => rtsCamera.saveView(),
        /** Restore a previously saved view. */
        restoreView: (view, durationMs) => rtsCamera.restoreView(view, durationMs),
        /** Rotate camera around current target by degrees. Positive yaw = clockwise from above. */
        rotateAroundTarget: (yawDeg, pitchDeg, durationMs) =>
            rtsCamera.rotateAroundTarget(yawDeg, pitchDeg, durationMs),
        /** Cancel any running camera animation. */
        cancel: () => rtsCamera.cancelTransition(),
        /** Whether an animation is currently running. */
        get animating() { return rtsCamera.isAnimating; },
        /** Current look-at position {x, y, z}. */
        get target() { const t = rtsCamera.target; return { x: t.x, y: t.y, z: t.z }; },
        /** Current camera position {x, y, z}. */
        get position() { const p = rtsCamera.position; return { x: p.x, y: p.y, z: p.z }; },
    };

    (window as any).camera = api;
}

export function uninstallCameraWindowApi(): void {
    delete (window as any).camera;
}
