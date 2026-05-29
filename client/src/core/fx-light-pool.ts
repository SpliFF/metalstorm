/**
 * FxLightPool — bespoke forward dynamic-light pool for weapon/explosion FX.
 *
 * PLAN-weapon-fx-gaps.md Phase L. ZK's authored look lights terrain and
 * units in the weapon's colour when something fires or explodes
 * (`UnitPieceLight` + the GL4 deferred light pipeline). A faithful
 * deferred port is a large GL4→WebGL2 job; this is the ~70%-of-the-win
 * forward substitute: a fixed ring of N point lights that the existing
 * stock-material forward lighting picks up automatically, amplified by
 * the HDR/ACES + bloom pipeline (PLAN-lighting L1).
 *
 * Design notes:
 *  - The N lights are created ONCE and stay in `scene.lights` for the
 *    pool's whole life. Babylon recompiles a material's shader when the
 *    *count* of lights affecting it changes — so we never add/remove,
 *    we only modulate `intensity` (0 = contributes nothing). Idle slots
 *    sit at intensity 0.
 *  - Each stock material still only samples up to its own
 *    `maxSimultaneousLights` (default 4); Babylon sorts per mesh and
 *    keeps the most relevant. So a high N gives spatial coverage, not a
 *    per-mesh light budget. Terrain / features / water (Standard/PBR)
 *    light up for free; the unit team-colour ShaderMaterial does not
 *    sample point lights yet — that's a documented follow-up.
 *  - Acquisition reuses the lowest-priority slot when full, where
 *    priority = current intensity / max(1, distance² to camera). On-screen
 *    bright lights win; far/dim ones get recycled first.
 */

import { Color3, PointLight, Scene, Vector3 } from '@babylonjs/core';

/** Per-slot dynamic-light state. */
interface LightSlot {
    light: PointLight;
    /** True while counting down a live emission. */
    active: boolean;
    /** Seconds since this emission started. */
    age: number;
    /** Total lifetime in seconds. */
    ttl: number;
    /** Peak intensity at the start of the emission. */
    peak: number;
    /** Cached priority for eviction comparison (recomputed in update). */
    priority: number;
}

export interface FxLightPoolOptions {
    /** Number of pooled point lights. Plan calls for 16. */
    count?: number;
    /** Global multiplier on every emission's peak intensity. */
    intensityScale?: number;
    /** Skip emissions whose peak intensity is below this floor. */
    intensityFloor?: number;
    /** Cull emissions farther than this from the camera (elmos). */
    maxCameraDistance?: number;
}

const DEFAULTS = {
    count: 16,
    intensityScale: 1.0,
    intensityFloor: 0.05,
    maxCameraDistance: 7000,
};

export class FxLightPool {
    private scene: Scene;
    private slots: LightSlot[] = [];
    private cameraPos = new Vector3(0, 0, 0);
    private opts: Required<FxLightPoolOptions>;
    private enabled = true;

    constructor(scene: Scene, options: FxLightPoolOptions = {}) {
        this.scene = scene;
        this.opts = { ...DEFAULTS, ...options };

        for (let i = 0; i < this.opts.count; i++) {
            // Position is irrelevant while intensity is 0; start at origin.
            const light = new PointLight(`fxLight${i}`, new Vector3(0, 0, 0), scene);
            light.intensity = 0;
            light.range = 1;
            light.diffuse = new Color3(0, 0, 0);
            light.specular = new Color3(0, 0, 0);
            // FX lights never cast shadows — the CSM is the sun's alone and
            // adding point-light shadow maps would be ruinous.
            light.shadowEnabled = false;
            this.slots.push({
                light, active: false, age: 0, ttl: 0, peak: 0, priority: 0,
            });
        }

        (window as unknown as { __fxLightPool: unknown }).__fxLightPool = this;
    }

    /** Master on/off (e.g. a `gfx.fxLights` setting). Idles all slots. */
    setEnabled(on: boolean): void {
        this.enabled = on;
        if (!on) {
            for (const s of this.slots) {
                s.active = false;
                s.light.intensity = 0;
            }
        }
    }

    /**
     * Muzzle flash — short, bright, small radius. Colour should match the
     * weapon's bolt/tracer colour so the flash reads as the same source.
     */
    emitMuzzle(x: number, y: number, z: number, color: readonly [number, number, number], scale = 1): void {
        this.emit(x, y, z, color, 6 * scale, 90 * scale, 0.12);
    }

    /**
     * Explosion — bigger, longer, scaled by the blast radius. `radius`
     * is the explosion's area-of-effect in elmos.
     */
    emitExplosion(x: number, y: number, z: number, color: readonly [number, number, number], radius: number): void {
        const r = Math.max(40, radius);
        // Intensity grows sub-linearly with radius so a nuke doesn't wash
        // the whole map to white; range tracks the blast more directly.
        const peak = 8 + Math.min(24, r * 0.05);
        const ttl = 0.25 + Math.min(0.45, r * 0.0015);
        this.emit(x, y, z, color, peak, r * 2.2, ttl);
    }

    /**
     * Generic emission. Acquires a slot (evicting the lowest-priority one
     * if the pool is full) and starts a fade-out from `peak` over `ttl`.
     */
    emit(
        x: number, y: number, z: number,
        color: readonly [number, number, number],
        peak: number, range: number, ttlSec: number,
    ): void {
        if (!this.enabled) return;
        const scaledPeak = peak * this.opts.intensityScale;
        if (scaledPeak < this.opts.intensityFloor) return;

        // Distance cull — off-screen-far emissions aren't worth a slot.
        const dx = x - this.cameraPos.x, dy = y - this.cameraPos.y, dz = z - this.cameraPos.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        const maxD = this.opts.maxCameraDistance;
        if (dist2 > maxD * maxD) return;

        const slot = this.acquire(scaledPeak, dist2);
        if (!slot) return;

        slot.active = true;
        slot.age = 0;
        slot.ttl = Math.max(0.01, ttlSec);
        slot.peak = scaledPeak;
        slot.priority = scaledPeak / Math.max(1, dist2);

        const lt = slot.light;
        lt.position.set(x, y, z);
        // Babylon clamps point-light contribution by `range`; the colour
        // carries the hue, `intensity` the HDR brightness (>1 ok — bloom
        // and ACES handle it).
        lt.diffuse.set(color[0], color[1], color[2]);
        lt.range = range;
        lt.intensity = scaledPeak;
    }

    /**
     * Find a free slot, or the lowest-priority active slot to evict. A
     * fresh emission must out-prioritise the slot it steals, else it's
     * dropped (so a flurry of dim distant muzzle flashes can't knock out
     * a close bright explosion light).
     */
    private acquire(newPeak: number, newDist2: number): LightSlot | null {
        let worst: LightSlot | null = null;
        for (const s of this.slots) {
            if (!s.active) return s;
            if (!worst || s.priority < worst.priority) worst = s;
        }
        if (!worst) return null;
        const newPriority = newPeak / Math.max(1, newDist2);
        return newPriority >= worst.priority ? worst : null;
    }

    /**
     * Per-frame update. Ages every active slot, applies the intensity
     * falloff, deactivates expired ones, and refreshes the priority used
     * for eviction (camera may have moved).
     * @param dtSec delta time in seconds
     * @param cameraPos current camera world position
     */
    update(dtSec: number, cameraPos: Vector3): void {
        this.cameraPos.copyFrom(cameraPos);
        for (const s of this.slots) {
            if (!s.active) continue;
            s.age += dtSec;
            if (s.age >= s.ttl) {
                s.active = false;
                s.light.intensity = 0;
                s.priority = 0;
                continue;
            }
            // Ease-out fade: pow(1 - u, 1.5) holds a touch of brightness
            // early then drops off — reads like a flash decay rather than
            // a linear ramp.
            const u = s.age / s.ttl;
            const f = Math.pow(1 - u, 1.5);
            const intensity = s.peak * f;
            s.light.intensity = intensity;
            const p = s.light.position;
            const dx = p.x - this.cameraPos.x, dy = p.y - this.cameraPos.y, dz = p.z - this.cameraPos.z;
            s.priority = intensity / Math.max(1, dx * dx + dy * dy + dz * dz);
        }
    }

    /** Number of currently-lit slots (debug / tuning). */
    get activeCount(): number {
        let n = 0;
        for (const s of this.slots) if (s.active) n++;
        return n;
    }

    dispose(): void {
        for (const s of this.slots) s.light.dispose();
        this.slots = [];
    }
}
