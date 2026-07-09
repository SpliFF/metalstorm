/**
 * SunRig — dev/test sun control for the model harness (PLAN-model-harness §6).
 *
 * Drives the existing lighting pipeline (docs/lighting.md): sets the
 * directional sun vector from azimuth/elevation and optionally animates a
 * full day–night cycle. Purely client-side render state — the sim has no
 * time-of-day and this deliberately does NOT add one (LOS implications;
 * see the plan). The CSM shadow generator follows `sun.direction`
 * automatically (autoCalcDepthBounds refits cascades every frame).
 *
 * While an override is active, `tick()` re-applies it every frame so game
 * Lua that re-applies authored lighting (ZK's gfx_sun_and_atmosphere
 * read-modify-write cycle, PLAN-playable G1c) cannot clobber the test
 * state between frames. `restore()` puts the saved scene values back.
 *
 * Angle convention (documented for `window.test.sun`):
 *   - azimuthDeg: rotation around +Y, 0° = sun toward +X (map east),
 *     90° = +Z (map south). Only affects shadow direction, not intensity.
 *   - elevationDeg: angle above the horizon; 90° = straight overhead,
 *     negative = below the horizon (night).
 */

import type { SceneLighting } from './scene-lighting.js';

export interface SunAngles {
    azimuthDeg: number;
    elevationDeg: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Babylon `DirectionalLight.direction` (points FROM the sun TOWARD the
 *  scene) for the given sun sky-position angles. Unit length. */
export function sunDirectionFromAngles(a: SunAngles): { x: number; y: number; z: number } {
    const az = a.azimuthDeg * DEG2RAD;
    const el = a.elevationDeg * DEG2RAD;
    const cosEl = Math.cos(el);
    // Sun position on the unit sky dome; light shines the opposite way.
    return {
        x: -cosEl * Math.cos(az),
        y: -Math.sin(el),
        z: -cosEl * Math.sin(az),
    };
}

/** Inverse of `sunDirectionFromAngles` — recover angles from a (not
 *  necessarily normalised) light direction. */
export function anglesFromLightDirection(d: { x: number; y: number; z: number }): SunAngles {
    const len = Math.hypot(d.x, d.y, d.z) || 1;
    const sx = -d.x / len, sy = -d.y / len, sz = -d.z / len;
    return {
        azimuthDeg: Math.atan2(sz, sx) * RAD2DEG,
        elevationDeg: Math.asin(Math.max(-1, Math.min(1, sy))) * RAD2DEG,
    };
}

/** Elevation the cycle dips to at dawn/dusk (the plan's "dawn −5°"). */
export const CYCLE_HORIZON_DIP_DEG = -5;

/**
 * Day–night cycle pose at `phase` ∈ [0, 1). Azimuth sweeps a full 360°;
 * elevation follows a sine arc: phase 0 = dawn (−5°, rising), 0.25 = noon
 * peak, 0.5 = dusk (−5°, setting), 0.75 = deepest night.
 */
export function sunCycleAngles(phase: number, peakElevationDeg = 60): SunAngles {
    const p = phase - Math.floor(phase);
    return {
        azimuthDeg: p * 360,
        elevationDeg: CYCLE_HORIZON_DIP_DEG
            + (peakElevationDeg - CYCLE_HORIZON_DIP_DEG) * Math.sin(2 * Math.PI * p),
    };
}

/** 0..1 daylight ramp: 0 below −5° elevation (night), 1 above +10°, smooth
 *  twilight between. Scales sun intensity + the ambient floor. */
export function daylightFactor(elevationDeg: number): number {
    const t = (elevationDeg - CYCLE_HORIZON_DIP_DEG) / (10 - CYCLE_HORIZON_DIP_DEG);
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c); // smoothstep
}

/** Fraction of the saved ambient intensity kept at full night. */
const NIGHT_AMBIENT_FLOOR = 0.25;

interface SavedLighting {
    dir: { x: number; y: number; z: number };
    sunIntensity: number;
    ambientIntensity: number;
}

export class SunRig {
    private lighting: SceneLighting;
    private saved: SavedLighting | null = null;
    /** Non-null while a manual override (or cycle) is driving the sun. */
    private angles: SunAngles | null = null;
    private cycleSecondsPerDay = 0;
    private cyclePhase = 0;
    private peakElevationDeg = 60;

    constructor(lighting: SceneLighting) {
        this.lighting = lighting;
    }

    get active(): boolean {
        return this.angles !== null;
    }

    /** Set the sun to explicit angles. Stops a running cycle (an explicit
     *  set is a stronger intent). Missing fields keep their current value
     *  (or the map-authored pose on first use). */
    setSun(a: Partial<SunAngles>): void {
        this.ensureSaved();
        this.cycleSecondsPerDay = 0;
        const cur = this.angles ?? anglesFromLightDirection(this.lighting.sun.direction);
        this.angles = {
            azimuthDeg: a.azimuthDeg ?? cur.azimuthDeg,
            elevationDeg: a.elevationDeg ?? cur.elevationDeg,
        };
        this.apply(this.angles);
    }

    /** Animate a full day (360° azimuth + elevation arc) every
     *  `secondsPerDay` wall-seconds, starting at dawn. */
    startCycle(secondsPerDay: number, peakElevationDeg = 60): void {
        this.ensureSaved();
        this.cycleSecondsPerDay = Math.max(1, secondsPerDay);
        this.peakElevationDeg = peakElevationDeg;
        this.cyclePhase = 0;
        this.angles = sunCycleAngles(0, peakElevationDeg);
        this.apply(this.angles);
    }

    /** Freeze the cycle at its current pose (override stays active). */
    stopCycle(): void {
        this.cycleSecondsPerDay = 0;
    }

    /** Drop the override and put the saved scene lighting back. */
    restore(): void {
        this.cycleSecondsPerDay = 0;
        this.angles = null;
        const s = this.saved;
        if (!s) return;
        this.lighting.sun.direction.set(s.dir.x, s.dir.y, s.dir.z);
        this.lighting.sun.intensity = s.sunIntensity;
        this.lighting.ambient.intensity = s.ambientIntensity;
        this.saved = null;
    }

    /** Per-frame update from the worker render loop (raw wall dt, seconds). */
    tick(dt: number): void {
        if (this.cycleSecondsPerDay > 0) {
            this.cyclePhase = (this.cyclePhase + dt / this.cycleSecondsPerDay) % 1;
            this.angles = sunCycleAngles(this.cyclePhase, this.peakElevationDeg);
        }
        // Re-apply every frame while active — wins over game-Lua lighting
        // re-applies (applyMapLighting) that land between frames.
        if (this.angles) this.apply(this.angles);
    }

    state(): {
        active: boolean;
        azimuthDeg: number | null;
        elevationDeg: number | null;
        cycleSecondsPerDay: number;
        cyclePhase: number;
    } {
        return {
            active: this.active,
            azimuthDeg: this.angles?.azimuthDeg ?? null,
            elevationDeg: this.angles?.elevationDeg ?? null,
            cycleSecondsPerDay: this.cycleSecondsPerDay,
            cyclePhase: this.cyclePhase,
        };
    }

    private ensureSaved(): void {
        if (this.saved) return;
        const d = this.lighting.sun.direction;
        this.saved = {
            dir: { x: d.x, y: d.y, z: d.z },
            sunIntensity: this.lighting.sun.intensity,
            ambientIntensity: this.lighting.ambient.intensity,
        };
    }

    private apply(a: SunAngles): void {
        const s = this.saved;
        if (!s) return;
        const d = sunDirectionFromAngles(a);
        this.lighting.sun.direction.set(d.x, d.y, d.z);
        const day = daylightFactor(a.elevationDeg);
        this.lighting.sun.intensity = s.sunIntensity * day;
        this.lighting.ambient.intensity =
            s.ambientIntensity * (NIGHT_AMBIENT_FLOOR + (1 - NIGHT_AMBIENT_FLOOR) * day);
    }
}
