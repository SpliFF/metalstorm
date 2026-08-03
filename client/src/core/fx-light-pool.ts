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

/**
 * Layer-mask bit meaning "the FX light pool must not light this mesh".
 *
 * PLAN-perf **M2**. The pool's per-mesh tax is not the light *maths* — it is
 * that every pooled PointLight in `scene.lights` enters the `_lightSources` of
 * every mesh it can affect, and Babylon then re-binds up to
 * `maxSimultaneousLights` (4) lights' worth of uniforms **per draw call**. A
 * Metalstorm map draws ~400 feature-LOD tiles, so the pool costs ~400 draws ×
 * 4 lights of uniform uploads per frame for vegetation that has no business
 * being lit by a muzzle flash. Tagging those meshes and setting
 * `excludeWithLayerMask` on the pooled lights removes them from
 * `Light.canAffectMesh` in O(1) — unlike `excludedMeshes`, which is an
 * `indexOf` scan per mesh per light.
 *
 * The bit is **additive** (`mesh.layerMask |= …`), and deliberately sits
 * outside a camera's default `0x0FFFFFFF` mask, so it cannot change what any
 * camera renders: cameras test `camera.layerMask & mesh.layerMask`, and the
 * mesh keeps all of its original low bits. Bits 29/30 are already taken
 * (`BLIT_LAYER` 0x20000000 in decal-overlay.ts, `DISTORTION_LAYER` 0x40000000
 * in distortion-renderer.ts); this is bit 28.
 */
export const FX_LIGHT_EXCLUDED_LAYER = 0x10000000;

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
    /** Skip meshes tagged `FX_LIGHT_EXCLUDED_LAYER` (vegetation). Default on. */
    excludeTagged?: boolean;
}

const DEFAULTS = {
    count: 16,
    intensityScale: 1.0,
    intensityFloor: 0.05,
    maxCameraDistance: 7000,
    excludeTagged: true,
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

        for (let i = 0; i < this.opts.count; i++) this.slots.push(this.makeSlot(i));

        // GW4-c5: globalThis (not window) so this resolves in the game-processor
        // worker too; re-proxied to main for devtools in GW8.
        (globalThis as unknown as { __fxLightPool: unknown }).__fxLightPool = this;
    }

    /** One pooled light + its slot bookkeeping. */
    private makeSlot(i: number): LightSlot {
        // Position is irrelevant while intensity is 0; start at origin.
        const light = new PointLight(`fxLight${i}`, new Vector3(0, 0, 0), this.scene);
        light.intensity = 0;
        light.range = 1;
        light.diffuse = new Color3(0, 0, 0);
        light.specular = new Color3(0, 0, 0);
        // FX lights never cast shadows — the CSM is the sun's alone and
        // adding point-light shadow maps would be ruinous.
        light.shadowEnabled = false;
        light.excludeWithLayerMask = this.opts.excludeTagged ? FX_LIGHT_EXCLUDED_LAYER : 0;
        return { light, active: false, age: 0, ttl: 0, peak: 0, priority: 0 };
    }

    /**
     * PLAN-perf M2 lever + its A/B toggle: whether pooled lights skip meshes
     * tagged `FX_LIGHT_EXCLUDED_LAYER` (the feature-LOD vegetation tiles).
     * Babylon's `excludeWithLayerMask` setter calls `_resyncMeshes()`, so this
     * takes effect live — the attribution run flips it at a plateau.
     * Returns the applied value.
     */
    setExcludeTagged(on: boolean): boolean {
        this.opts.excludeTagged = on;
        const mask = on ? FX_LIGHT_EXCLUDED_LAYER : 0;
        for (const s of this.slots) s.light.excludeWithLayerMask = mask;
        return on;
    }

    /** Whether tagged meshes are currently excluded from the pool. */
    get excludeTagged(): boolean { return this.opts.excludeTagged; }

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

    /** Live-resize the pool by disposing/creating PointLights so `scene.lights`
     *  actually shrinks or grows. `setEnabled(false)` is not enough for the
     *  PLAN-perf P0 light-pool isolation toggle: idled lights stay in
     *  `scene.lights`, so every StandardMaterial mesh still pays the per-frame
     *  light-selection sort over them. This removes them from the scene.
     *  Returns the new slot count. */
    setPoolCount(n: number): number {
        n = Math.max(0, n | 0);
        while (this.slots.length > n) {
            this.slots.pop()!.light.dispose();  // dispose() removes it from scene.lights
        }
        while (this.slots.length < n) this.slots.push(this.makeSlot(this.slots.length));
        this.opts.count = n;
        return this.slots.length;
    }

    /** Current pooled-light count (P0 matrix read-back). */
    get poolCount(): number { return this.slots.length; }

    // NOTE — no muzzle-flash light by design (faithful to ZK, 2026-06-04).
    // ZK adds deferred MUZZLE lights only via gfx_deferred_rendering_gl4.lua's
    // `widget:Barrelfire`, keyed by `muzzleFlashLights[weaponID]` — but that
    // table is built from `LuaUI/Configs/UnitLights/*.lua` `.muzzle` entries,
    // and ZK's only UnitLights file (economy.lua) authors ZERO muzzle (and zero
    // event) entries. So `muzzleFlashLights` is ALWAYS EMPTY in ZK content,
    // exactly like `explosionLights` below — a ZK muzzle's glow is its authored
    // muzzle CEG (effectForFire) + the muzzle-flare quad + bloom, NOT a
    // terrain-flooding point light. The previous hardcoded `emitMuzzle`
    // (peak 10, range 110, fired on every weapon's Fired event) was an
    // invention with no authored basis (master-plan drift #1). Removed. ZK's
    // authored in-flight projectile lights (gfx_projectile_lights.lua) DO feed
    // this pool — via the deferred-light registry, not from here. See PLAN.md
    // Stage B + _SpringWebEmitDeferredLights in lua-widget-worker.ts.

    // NOTE — no explosion light by design (faithful to ZK, 2026-06-04).
    // ZK adds deferred explosion point-lights only via
    // gfx_deferred_rendering_gl4.lua's `widget:VisibleExplosion`, keyed by
    // `explosionLights[weaponDefID]` — but that table is ALWAYS EMPTY in
    // ZK's content (DeferredLightsGL4config seeds `explosionLights = {}`
    // and the per-unit `UnitLights/*` loader only populates static/event/
    // muzzle, never explosion). So a ZK explosion's glow comes from its
    // authored CEG emissive particles + groundflash + bloom — NOT a
    // terrain-flooding point light. The previous hardcoded `emitExplosion`
    // (peak 12–32, range r*2.2, "tuned against bright daylit terrain") was
    // an invention with no authored basis; on a normally-lit scene it
    // flooded the whole battlefield yellow and blew firing units to white
    // (master-plan drift #1). Removed. The authored per-weapon MUZZLE-flash
    // path (Barrelfire/`muzzleFlashLights`) is the remaining faithful
    // light-wiring follow-up; see PLAN.md Stage B.

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

    /**
     * Fill caller-provided flat arrays with the currently-lit slots, for
     * shaders that sample the pool directly rather than through Babylon's
     * stock light uniforms (the unit team-colour / ZK ShaderMaterials —
     * Phase U). `outPos` packs vec4 (x, y, z, range) per light; `outColor`
     * packs vec3 (r, g, b already multiplied by HDR intensity). Returns the
     * number written, capped at `maxLights`. Brightest-first is not enforced
     * — slot order is fine for the small N units sample.
     */
    fillLightArrays(maxLights: number, outPos: number[], outColor: number[]): number {
        let n = 0;
        for (const s of this.slots) {
            if (n >= maxLights) break;
            const lt = s.light;
            if (!s.active || lt.intensity <= 0) continue;
            const p = lt.position, d = lt.diffuse, I = lt.intensity;
            outPos[n * 4 + 0] = p.x;
            outPos[n * 4 + 1] = p.y;
            outPos[n * 4 + 2] = p.z;
            outPos[n * 4 + 3] = lt.range;
            outColor[n * 3 + 0] = d.r * I;
            outColor[n * 3 + 1] = d.g * I;
            outColor[n * 3 + 2] = d.b * I;
            n++;
        }
        return n;
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
