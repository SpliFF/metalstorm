/**
 * OrbitRig — dev/test orbit camera for the model harness
 * (PLAN-model-harness §5). A target-anchored rig: drag = azimuth/pitch
 * orbit (pitch clamped 5°–85°), wheel = zoom (clamped to 1.2×–10× of the
 * target's bounding-sphere radius), auto-frame places the camera so the
 * sphere fills ~70% of the shorter viewport axis.
 *
 * While a rig is active the game-processor suppresses the RTS camera's
 * input + tick for that view (same discipline as the render-pause
 * toggle); the rig is the only writer of the Babylon camera. The saved
 * RTS view is restored on exit (game-processor owns that part).
 *
 * Follow mode re-reads the target's bounding sphere every tick so walk /
 * fly circuits keep the unit framed; toggling follow off holds the last
 * anchor (watch it walk away and come back).
 *
 * The pure math (bounding-sphere merge, framing distance, orbit pose) is
 * exported for vitest.
 */

import { Vector3 } from '@babylonjs/core';
import type { FreeCamera } from '@babylonjs/core';

export interface Sphere {
    x: number;
    y: number;
    z: number;
    radius: number;
}

/** Pitch clamp per the plan: never under the ground plane, never gimbal. */
export const ORBIT_PITCH_MIN_DEG = 5;
export const ORBIT_PITCH_MAX_DEG = 85;
/** Zoom clamp in multiples of the target sphere radius. */
export const ORBIT_ZOOM_MIN_RADII = 1.2;
export const ORBIT_ZOOM_MAX_RADII = 10;
/** Auto-frame: sphere fills this fraction of the shorter viewport axis. */
export const ORBIT_DEFAULT_FILL = 0.7;
/** Degenerate-model floor so a flat/empty model still frames sanely. */
const MIN_FRAME_RADIUS = 4;

/**
 * Bounding sphere of a sphere cloud (squad members, multi-part stages).
 * Incremental two-sphere merge — not minimal, but tight enough for
 * framing and exact for the single-sphere case.
 */
export function mergeSpheres(spheres: readonly Sphere[]): Sphere | null {
    if (spheres.length === 0) return null;
    let acc = { ...spheres[0] };
    for (let i = 1; i < spheres.length; i++) {
        const s = spheres[i];
        const dx = s.x - acc.x, dy = s.y - acc.y, dz = s.z - acc.z;
        const d = Math.hypot(dx, dy, dz);
        if (d + s.radius <= acc.radius) continue;        // s inside acc
        if (d + acc.radius <= s.radius) { acc = { ...s }; continue; } // acc inside s
        const newR = (d + acc.radius + s.radius) / 2;
        const t = (newR - acc.radius) / d;               // shift toward s
        acc = {
            x: acc.x + dx * t,
            y: acc.y + dy * t,
            z: acc.z + dz * t,
            radius: newR,
        };
    }
    return acc;
}

export function clampPitchDeg(pitchDeg: number): number {
    return Math.max(ORBIT_PITCH_MIN_DEG, Math.min(ORBIT_PITCH_MAX_DEG, pitchDeg));
}

export function clampOrbitDistance(distance: number, radius: number): number {
    const r = Math.max(MIN_FRAME_RADIUS, radius);
    return Math.max(ORBIT_ZOOM_MIN_RADII * r, Math.min(ORBIT_ZOOM_MAX_RADII * r, distance));
}

/**
 * Camera distance so a sphere of `radius` fills `fill` of the SHORTER
 * viewport axis. `fovYRad` is Babylon's vertical FOV
 * (FOVMODE_VERTICAL_FIXED default); landscape viewports are vertically
 * limited, portrait ones horizontally.
 */
export function frameDistance(
    radius: number, fovYRad: number, aspect: number, fill = ORBIT_DEFAULT_FILL,
): number {
    const r = Math.max(MIN_FRAME_RADIUS, radius);
    const halfY = fovYRad / 2;
    const halfShort = aspect >= 1 ? halfY : Math.atan(Math.tan(halfY) * aspect);
    const f = Math.max(0.05, Math.min(1, fill));
    return r / (f * Math.tan(halfShort));
}

/** Camera position on the orbit sphere. Yaw rotates around +Y from +X
 *  toward +Z (same convention as the sun azimuth); pitch is degrees
 *  above the horizontal, looking down at the anchor. */
export function orbitCameraPos(
    anchor: { x: number; y: number; z: number },
    yawDeg: number, pitchDeg: number, distance: number,
): { x: number; y: number; z: number } {
    const yaw = yawDeg * (Math.PI / 180);
    const pitch = pitchDeg * (Math.PI / 180);
    const horiz = Math.cos(pitch) * distance;
    return {
        x: anchor.x + horiz * Math.cos(yaw),
        y: anchor.y + Math.sin(pitch) * distance,
        z: anchor.z + horiz * Math.sin(yaw),
    };
}

/** Where the rig gets its bounding sphere. Returning null (unit died,
 *  renderer doesn't know it yet) keeps the last latched anchor. */
export interface OrbitTarget {
    getSphere(): Sphere | null;
}

export interface OrbitOpts {
    yawDeg?: number;
    pitchDeg?: number;
    distance?: number;
    follow?: boolean;
}

/** Drag sensitivity, degrees of orbit per CSS pixel (≈ a full sweep over
 *  ~900 px — matches the RTS camera's rotate feel). */
const DRAG_DEG_PER_PX = 0.4;
/** Wheel zoom step per notch (multiplicative). */
const WHEEL_ZOOM_STEP = 1.15;

export class OrbitRig {
    yawDeg = 30;
    pitchDeg = 25;
    distance = 200;
    follow = true;

    private camera: FreeCamera;
    private target: OrbitTarget;
    /** Last known target sphere — held when the target vanishes or
     *  follow is off. */
    private anchor: Sphere = { x: 0, y: 0, z: 0, radius: 40 };

    private dragging = false;
    private lastX = 0;
    private lastY = 0;
    /** Scratch look-at vector — avoids a per-frame allocation. */
    private lookAtScratch = new Vector3();

    constructor(camera: FreeCamera, target: OrbitTarget, opts: OrbitOpts = {}) {
        this.camera = camera;
        this.target = target;
        this.set(opts);
        const s = target.getSphere();
        if (s) this.anchor = s;
    }

    /** Swap the tracked target (def switch / wreck focus). */
    retarget(target: OrbitTarget): void {
        this.target = target;
        const s = target.getSphere();
        if (s) this.anchor = s;
        this.distance = clampOrbitDistance(this.distance, this.anchor.radius);
    }

    set(opts: OrbitOpts): void {
        if (opts.yawDeg !== undefined) this.yawDeg = opts.yawDeg;
        if (opts.pitchDeg !== undefined) this.pitchDeg = clampPitchDeg(opts.pitchDeg);
        if (opts.distance !== undefined) {
            this.distance = clampOrbitDistance(opts.distance, this.anchor.radius);
        }
        if (opts.follow !== undefined) this.follow = opts.follow;
    }

    /** Auto-frame: set distance so the target sphere fills `fill` of the
     *  shorter viewport axis. Re-reads the target even when follow is off. */
    frame(fovYRad: number, aspect: number, fill = ORBIT_DEFAULT_FILL): void {
        const s = this.target.getSphere();
        if (s) this.anchor = s;
        this.distance = clampOrbitDistance(
            frameDistance(this.anchor.radius, fovYRad, aspect, fill),
            this.anchor.radius);
    }

    // ── Input (forwarded by the game-processor while the rig is active) ──

    /** Returns true when the rig consumed the press (drag started). */
    pointerDown(x: number, y: number, button: number): boolean {
        if (button !== 0 && button !== 2) return false;
        this.dragging = true;
        this.lastX = x;
        this.lastY = y;
        return true;
    }

    pointerMove(x: number, y: number): void {
        if (!this.dragging) return;
        const dx = x - this.lastX;
        const dy = y - this.lastY;
        this.lastX = x;
        this.lastY = y;
        this.yawDeg += dx * DRAG_DEG_PER_PX;
        this.pitchDeg = clampPitchDeg(this.pitchDeg + dy * DRAG_DEG_PER_PX);
    }

    pointerUp(): void {
        this.dragging = false;
    }

    wheel(delta: number): void {
        const factor = delta > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
        this.distance = clampOrbitDistance(this.distance * factor, this.anchor.radius);
    }

    // ── Per-frame ────────────────────────────────────────────────────────

    tick(): void {
        if (this.follow) {
            const s = this.target.getSphere();
            if (s) this.anchor = s;
        }
        const pos = orbitCameraPos(this.anchor, this.yawDeg, this.pitchDeg, this.distance);
        this.camera.position.set(pos.x, pos.y, pos.z);
        this.lookAtScratch.set(this.anchor.x, this.anchor.y, this.anchor.z);
        this.camera.setTarget(this.lookAtScratch);
    }

    state(): {
        yawDeg: number; pitchDeg: number; distance: number; follow: boolean;
        anchor: Sphere;
    } {
        return {
            yawDeg: this.yawDeg,
            pitchDeg: this.pitchDeg,
            distance: this.distance,
            follow: this.follow,
            anchor: { ...this.anchor },
        };
    }
}
