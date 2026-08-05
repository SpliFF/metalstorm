/**
 * CombatFX — client-side combat visual effects.
 *
 * Renders transient effects (impacts, kills, shields) in response to
 * CombatEvent and ProjectileImpact messages from the server.
 *
 * The fast path dispatches into `CegRuntime` keyed by the weapon def's
 * authored `explosionGenerator` (or an archetype fallback). When no
 * CEG can be resolved we fall back to a coloured procedural sphere so
 * something is still visible — the user can grep the console for
 * `[combat-fx] CEG fallback` to find weapon defs missing CEG coverage.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    StandardMaterial,
    Color3,
    Vector3,
    Quaternion,
    Matrix,
} from '@babylonjs/core';
import type { CombatEventInfo, ProjectileImpactInfo, VolleyOutcomeInfo, DamageFieldEventInfo } from './connection.js';
import { AudioManager } from './audio.js';
import type { CegRuntime } from './ceg-runtime.js';
import type { DefCache } from './def-cache.js';
import type { DistortionRenderer } from './distortion-renderer.js';
import {
    ImpactKind,
    effectForImpact,
    impactContextFlags,
} from './weapon-fx-dispatch.js';

/**
 * The procedural fallback shapes CombatFX draws. PLAN-perf.md M18: each is
 * built once, at unit size, as a thin-instance prototype, and every live effect
 * of that shape rides one instance matrix in it — so a volley costs a matrix
 * write instead of a `MeshBuilder` allocation and its own draw call. The
 * per-effect dimensions live in the matrix's scale.
 */
const enum FxShape {
    /** Unit cube — stretched along its local axes for tracers / shells. */
    Box = 0,
    Sphere4 = 1,
    Sphere6 = 2,
    Sphere8 = 3,
}

/** One thin-instance pool: prototype mesh + the matrix buffer `tick()` refills. */
interface FxPool {
    mesh: Mesh;
    matrices: Float32Array;
    capacity: number;
    count: number;       // instances written this frame
}

/** An active visual effect with a remaining lifetime. */
interface ActiveEffect {
    shape: FxShape;
    mat: StandardMaterial;
    /** Own mesh — legacy (pre-M18) path only; null when the effect is pooled. */
    mesh: Mesh | null;
    pos: Vector3;
    /** World-space dimensions of the shape (the prototype is unit-sized). */
    size: Vector3;
    /** Orientation, for the shapes that have one (tracers); null = axis-aligned. */
    rot: Quaternion | null;
    lifetime: number;    // seconds remaining
    velocity?: Vector3;  // for moving effects (tracers)
    noFade?: boolean;    // skip the uniform scale-fade (stretched tracers, markers)
}

/** Shared identity rotation for the axis-aligned shapes. Never mutated. */
const FX_NO_ROT = Quaternion.Identity();

/**
 * The rotation that points a mesh's local +Z down (dx, dy, dz) — i.e. what
 * `Mesh.lookAt` bakes in. Reproduces `TransformNode.setDirection` exactly
 * (Babylon @9.1.0) so a pooled tracer is oriented identically to the per-mesh
 * one it replaces; `lookAt` itself needs a mesh, which the pooled path has not
 * got. Handedness-independent — the scene is right-handed, and so is this.
 */
function lookRotation(dx: number, dy: number, dz: number): Quaternion {
    const yaw = -Math.atan2(dz, dx) + Math.PI / 2;
    const pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    return Quaternion.RotationYawPitchRoll(yaw, pitch, 0);
}

/// Optional attacker-position resolver passed to onVolleyOutcome so the
/// client can invent tracers from the (visible) firing unit. Returns null
/// when the attacker id is unknown/hidden.
export type PositionResolver = (entityId: number) => { x: number; y: number; z: number } | null;

/// A live damage-field barrage the client is rendering procedurally (Model 3,
/// C6). The server streams only Created/Removed lifecycle events; this holds
/// the between-pulse timer + remaining lifetime so tick() can invent shell
/// impacts at the field's cadence without any per-shell wire traffic.
interface ActiveBarrage {
    field: DamageFieldEventInfo;
    pulseTimer: number;   // seconds until the next barrage pulse
    remaining: number;    // seconds of lifetime left (from duration)
}

export class CombatFX {
    private scene: Scene;
    private audio: AudioManager | null;
    private cegRuntime: CegRuntime | null;
    private defCache: DefCache | null;
    private distortion: DistortionRenderer | null = null;
    private effects: ActiveEffect[] = [];
    /// Active damage-field barrages keyed by server field id.
    private barrages = new Map<number, ActiveBarrage>();

    /// M18 thin-instance pools, keyed by shape + material. Built on first use;
    /// at most one per (shape, material) pair the spawners actually reach.
    private pools = new Map<string, FxPool>();
    /// M18 A/B switch — false restores the pre-M18 mesh-per-effect path.
    private pooled = true;
    // Scratch for composing instance matrices; tick() runs every frame.
    private readonly _s = new Vector3();
    private readonly _m = new Matrix();

    // Procedural fallback materials. Used only when CEG dispatch
    // can't resolve a name for the weapon def — keeps something on
    // screen rather than dropping silently.
    private impactMat: StandardMaterial;
    private killMat: StandardMaterial;
    private shieldMat: StandardMaterial;
    private dirtMat: StandardMaterial;
    private tracerMat: StandardMaterial;

    /// One-shot warning state per weapon def so a single missing CEG
    /// doesn't flood the console every frame the weapon fires.
    private warnedFallback = new Set<number>();

    constructor(
        scene: Scene,
        audio?: AudioManager,
        cegRuntime?: CegRuntime | null,
        defCache?: DefCache | null,
    ) {
        this.scene = scene;
        this.audio = audio ?? null;
        this.cegRuntime = cegRuntime ?? null;
        this.defCache = defCache ?? null;

        this.impactMat = new StandardMaterial('impactFxMat', scene);
        this.impactMat.diffuseColor = new Color3(1.0, 0.6, 0.1);
        this.impactMat.emissiveColor = new Color3(0.8, 0.4, 0.0);

        this.killMat = new StandardMaterial('killFxMat', scene);
        this.killMat.diffuseColor = new Color3(1.0, 0.2, 0.0);
        this.killMat.emissiveColor = new Color3(1.0, 0.3, 0.0);

        this.shieldMat = new StandardMaterial('shieldFxMat', scene);
        this.shieldMat.diffuseColor = new Color3(0.4, 0.6, 1.0);
        this.shieldMat.emissiveColor = new Color3(0.4, 0.7, 1.0);
        this.shieldMat.alpha = 0.6;

        this.dirtMat = new StandardMaterial('dirtFxMat', scene);
        this.dirtMat.diffuseColor = new Color3(0.45, 0.35, 0.25);
        this.dirtMat.emissiveColor = new Color3(0.0, 0.0, 0.0);

        // Statistical-combat invented tracer (no projectile exists to render).
        this.tracerMat = new StandardMaterial('tracerFxMat', scene);
        this.tracerMat.diffuseColor = new Color3(1.0, 0.85, 0.3);
        this.tracerMat.emissiveColor = new Color3(1.0, 0.8, 0.2);
        this.tracerMat.disableLighting = true;
    }

    /// PLAN-perf.md M18 A/B: `setPooled(false)` restores the pre-M18 path where
    /// every effect allocates its own Babylon mesh, so the pooling win stays a
    /// reversible within-session flip (`__perfToggles.combatFxPooled`). Effects
    /// already alive keep whichever path they were spawned on; they expire
    /// within 0.5 s. Returns the applied value.
    setPooled(on: boolean): boolean {
        this.pooled = on;
        return on;
    }

    /// Build one of the fallback shapes at `size`. `size` is the box's edge or
    /// the sphere's diameter; the pool prototypes use 1 and scale per instance.
    private buildShape(shape: FxShape, size: number, name: string): Mesh {
        switch (shape) {
            case FxShape.Box:
                return MeshBuilder.CreateBox(name, { size }, this.scene);
            case FxShape.Sphere4:
                return MeshBuilder.CreateSphere(
                    name, { diameter: size, segments: 4 }, this.scene);
            case FxShape.Sphere6:
                return MeshBuilder.CreateSphere(
                    name, { diameter: size, segments: 6 }, this.scene);
            case FxShape.Sphere8:
                return MeshBuilder.CreateSphere(
                    name, { diameter: size, segments: 8 }, this.scene);
        }
    }

    private getPool(shape: FxShape, mat: StandardMaterial): FxPool {
        const key = `${shape}:${mat.name}`;
        let pool = this.pools.get(key);
        if (pool) return pool;

        const mesh = this.buildShape(shape, 1, `fxPool_${key}`);
        mesh.material = mat;
        // A pool is a handful of meshes' worth of trivial geometry scattered
        // over the whole battle area. Culling one costs a bounds rebuild over
        // every live instance each frame (`thinInstanceRefreshBoundingInfo` is
        // O(instances)) and can save at most one draw call, so skip it: keep
        // the pool permanently active and let the GPU clip the instances.
        mesh.doNotSyncBoundingInfo = true;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.isVisible = false;

        const capacity = 64;
        const matrices = new Float32Array(capacity * 16);
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        mesh.thinInstanceCount = 0;
        pool = { mesh, matrices, capacity, count: 0 };
        this.pools.set(key, pool);
        return pool;
    }

    /// Append one instance matrix, growing the buffer if the frame's effect
    /// count outran it.
    private writeInstance(pool: FxPool, m: Matrix): void {
        if (pool.count === pool.capacity) {
            const capacity = pool.capacity * 2;
            const matrices = new Float32Array(capacity * 16);
            matrices.set(pool.matrices);
            pool.matrices = matrices;
            pool.capacity = capacity;
            pool.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        }
        m.copyToArray(pool.matrices, pool.count * 16);
        pool.count++;
    }

    private flushPool(pool: FxPool): void {
        pool.mesh.thinInstanceCount = pool.count;
        pool.mesh.isVisible = pool.count > 0;
        if (pool.count > 0) pool.mesh.thinInstanceBufferUpdated('matrix');
    }

    /**
     * Push one procedural effect. On the pooled path it is nothing but an
     * entry in `effects` — the geometry it draws through is the shape's shared
     * prototype, written by `tick()`. On the legacy path it allocates (and
     * later disposes) a Babylon mesh of its own.
     *
     * `sx/sy/sz` are the shape's world dimensions: the box's width/height/depth,
     * or the sphere's diameter in all three.
     */
    private spawn(
        name: string, shape: FxShape, mat: StandardMaterial,
        x: number, y: number, z: number,
        sx: number, sy: number, sz: number,
        lifetime: number,
        opts?: { rot?: Quaternion; velocity?: Vector3; noFade?: boolean },
    ): void {
        const fx: ActiveEffect = {
            shape, mat, mesh: null,
            pos: new Vector3(x, y, z),
            size: new Vector3(sx, sy, sz),
            rot: opts?.rot ?? null,
            lifetime,
            velocity: opts?.velocity,
            noFade: opts?.noFade,
        };
        if (!this.pooled) {
            const mesh = shape === FxShape.Box
                ? MeshBuilder.CreateBox(
                    name, { width: sx, height: sy, depth: sz }, this.scene)
                : this.buildShape(shape, sx, name);
            mesh.position.set(x, y, z);
            if (fx.rot) mesh.rotationQuaternion = fx.rot.clone();
            mesh.material = mat;
            fx.mesh = mesh;
        }
        this.effects.push(fx);
    }

    /// Set / replace the CEG runtime reference. Used when the runtime
    /// is created after CombatFX (init order in main.ts) or rebuilt
    /// for a new game session.
    setCegRuntime(runtime: CegRuntime | null): void {
        this.cegRuntime = runtime;
    }

    setDefCache(defCache: DefCache | null): void {
        this.defCache = defCache;
    }

    setDistortion(distortion: DistortionRenderer | null): void {
        this.distortion = distortion;
    }

    /// React to a projectile lifecycle Impact event. The projectile
    /// renderer also fires impact CEGs through its own dispatcher
    /// (for impacts not associated with a unit kill / damage event);
    /// combat-fx covers the cases that bypass that path — shield
    /// deflections and self-detonate / interception bursts.
    onProjectileImpacts(events: ProjectileImpactInfo[]): void {
        for (const e of events) {
            const { x, y, z } = e.pos;
            switch (e.impactKind as ImpactKind) {
                case ImpactKind.Shield:
                    if (!this.spawnCegImpact(e.impactKind, e.weaponDefId, x, y, z, true)) {
                        this.spawnFallbackShield(x, y, z);
                    }
                    break;
                case ImpactKind.SelfDetonate:
                case ImpactKind.Intercepted:
                case ImpactKind.Other:
                    if (!this.spawnCegImpact(e.impactKind, e.weaponDefId, x, y, z, true)) {
                        this.spawnFallbackAirburst(x, y, z);
                    }
                    // No explosion point-light — faithful to ZK (none authored);
                    // the burst's glow is the authored CEG/groundflash + bloom.
                    // See fx-light-pool.ts. Distortion shockwave is separate
                    // (authored LUPS SphereDistortion analogue).
                    this.distortion?.emitShockwave(x, y, z, 60);
                    break;
                // Terrain/Feature/Unit impacts are handled by the
                // projectile renderer's own onImpact hook — see
                // projectile-renderer.ts spawn-impact dispatch.
                case ImpactKind.Terrain:
                case ImpactKind.Feature:
                case ImpactKind.Unit:
                    break;
            }
        }
    }

    /**
     * Process a batch of CombatEvents from the server. Damage / kill
     * events drive the explosion CEG keyed by the firing weapon def.
     */
    onCombatEvents(events: CombatEventInfo[]): void {
        for (const evt of events) {
            switch (evt.result) {
                case 0: // Hit (damage applied, target survives)
                    // Light "impact" CEG on top of the unit. CEG dispatch
                    // is forced (forceWeaponDispatch=true) since the
                    // impact kind is Unit and the default behaviour is
                    // to skip Unit impacts in the projectile renderer.
                    if (!this.spawnCegImpact(ImpactKind.Unit, evt.weaponDefId,
                        evt.x, evt.y, evt.z, true, evt.damage)) {
                        this.spawnFallbackImpact(evt.x, evt.y, evt.z, evt.damage);
                    }
                    // No impact point-light (faithful to ZK — none authored).
                    // Distortion shockwave only, radius scaled by damage.
                    {
                        const r = Math.min(40 + evt.damage * 0.3, 120);
                        this.distortion?.emitShockwave(evt.x, evt.y, evt.z, r);
                    }
                    break;
                case 3: // Kill
                    if (!this.spawnCegImpact(ImpactKind.Unit, evt.weaponDefId,
                        evt.x, evt.y, evt.z, true, evt.damage)) {
                        this.spawnFallbackExplosion(evt.x, evt.y, evt.z);
                    }
                    // Bigger kill burst — distortion shockwave only, no
                    // point-light (faithful to ZK; glow is CEG + bloom).
                    this.distortion?.emitShockwave(evt.x, evt.y, evt.z, 160);
                    break;
                // Miss (1) and Blocked (2) — no visual.
            }
        }
    }

    /**
     * Process statistical-combat per-volley outcomes (Metalstorm Model 1).
     * These carry NO projectile — the client invents everything: `rounds`
     * cosmetic tracers from the (visible) attacker toward the impact, plus an
     * impact burst at `target_pos`. Result is visibility-filtered server-side:
     *   0 = Hit     -> full impact CEG scaled by damage + distortion shockwave
     *   1 = Miss    -> a light dirt puff (a shot landed nearby, no damage)
     *   2 = Unknown -> a light dirt puff only (no hit/miss result is leaked)
     * `getPos` resolves the attacker's world position for tracer origins; when
     * it returns null (attacker hidden), only the impact FX is shown.
     */
    onVolleyOutcome(events: VolleyOutcomeInfo[], getPos?: PositionResolver): void {
        for (const e of events) {
            const isHit = e.result === 0;

            // Invent tracers from the firing unit (only if it's visible to us).
            const src = (e.attackerId && getPos) ? getPos(e.attackerId) : null;
            if (src) {
                const n = Math.min(Math.max(e.rounds, 1), 8);
                for (let k = 0; k < n; k++)
                    this.spawnTracer(src, e.x, e.y, e.z);
            }

            if (isHit) {
                if (!this.spawnCegImpact(ImpactKind.Unit, e.weaponDefId,
                    e.x, e.y, e.z, true, e.damage)) {
                    this.spawnFallbackImpact(e.x, e.y, e.z, e.damage);
                }
                const r = Math.min(40 + e.damage * 0.3, 120);
                this.distortion?.emitShockwave(e.x, e.y, e.z, r);
            } else {
                // Miss or Unknown — no result leak, just a dirt puff at impact.
                this.spawnFallbackDust(e.x, e.y, e.z);
            }
        }
    }

    /**
     * Damage-field lifecycle events (Metalstorm Model 3 area bombardment, C6).
     * The server owns all damage and streams only Created/Removed events; the
     * client invents the barrage entirely — periodic shell impacts scattered
     * across the field area at the field's cadence, for its duration. A
     * `Created` starts a barrage; `Removed` (or the duration running out)
     * stops it. No per-shell wire traffic exists (§5 sim/client split).
     */
    onDamageFields(events: DamageFieldEventInfo[]): void {
        for (const e of events) {
            if (e.kind === 1) {              // Removed
                this.barrages.delete(e.fieldId);
                continue;
            }
            // Created (or a refresh) — (re)start the barrage. First pulse fires
            // one cadence in, matching the sim's first damage tick.
            const cadenceSec = Math.max(e.cadence, 1) / 30;
            this.barrages.set(e.fieldId, {
                field: e,
                pulseTimer: cadenceSec,
                remaining: Math.max(e.duration, 0) / 30,
            });
        }
    }

    /// Advance every active barrage: fire a pulse each cadence, expire when
    /// the duration runs out. Called from tick() each frame.
    private tickBarrages(dt: number): void {
        if (this.barrages.size === 0) return;
        for (const [id, b] of this.barrages) {
            b.remaining -= dt;
            if (b.remaining <= 0) {
                this.barrages.delete(id);
                continue;
            }
            b.pulseTimer -= dt;
            if (b.pulseTimer <= 0) {
                const cadenceSec = Math.max(b.field.cadence, 1) / 30;
                b.pulseTimer += cadenceSec;
                this.spawnBarragePulse(b.field);
            }
        }
    }

    /// One barrage pulse: a handful of shell impacts scattered across the
    /// field area, each preceded by a short descending streak for the arc.
    /// Impact count scales weakly with intensity so a heavier field looks
    /// busier, capped so a large field can't flood the FX pool.
    private spawnBarragePulse(f: DamageFieldEventInfo): void {
        const shells = Math.min(Math.max(1, Math.round(f.intensity / 40)), 5);
        for (let s = 0; s < shells; s++) {
            // Random point inside the shape (circle: rejection-free polar;
            // rect: uniform in each half-extent).
            let ox: number, oz: number;
            if (f.shape === 1) {
                ox = (Math.random() * 2 - 1) * f.radius;
                oz = (Math.random() * 2 - 1) * f.halfZ;
            } else {
                const ang = Math.random() * Math.PI * 2;
                const r = Math.sqrt(Math.random()) * f.radius;
                ox = Math.cos(ang) * r;
                oz = Math.sin(ang) * r;
            }
            const x = f.x + ox, y = f.y, z = f.z + oz;
            // Descending shell streak (the "arc"): a thin box falling into the
            // impact point. Cheap; disposed by the lifetime sweep in tick.
            this.spawnBarrageShell(x, y, z);
            // Impact: weapon CEG if the field has a weapon def, else dust.
            if (!f.weaponDefId || !this.spawnCegImpact(
                ImpactKind.Terrain, f.weaponDefId, x, y, z, true, f.intensity)) {
                this.spawnFallbackDust(x, y, z);
            }
        }
    }

    /// A short emissive box descending toward (x,y,z) — the incoming shell
    /// for a barrage impact. noFade so the stretched geometry isn't shrunk.
    private spawnBarrageShell(x: number, y: number, z: number): void {
        this.spawn('barrageShell', FxShape.Box, this.tracerMat,
            x, y + 40, z, 0.9, 14, 0.9, 0.18,
            { noFade: true, velocity: new Vector3(0, -220, 0) });
    }

    /// One invented tracer streak: a thin emissive box from the firer's
    /// muzzle to a lightly-scattered point near the impact. Uses noFade so
    /// the stretched geometry isn't shrunk by the uniform scale-fade in tick.
    private spawnTracer(
        src: { x: number; y: number; z: number },
        tx: number, ty: number, tz: number,
    ): void {
        const from = new Vector3(src.x, src.y + 8, src.z);
        const jitter = 6;
        const to = new Vector3(
            tx + (Math.random() * 2 - 1) * jitter, ty + 6,
            tz + (Math.random() * 2 - 1) * jitter);
        const len = Vector3.Distance(from, to);
        if (len < 1) return;
        // The box is unit-length in the pool and stretched to `len` by the
        // instance matrix (M18), so the pool needs the orientation `lookAt`
        // would have baked into the mesh: local +Z toward `to`. The maths is
        // Babylon's own `TransformNode.setDirection`, which is what `lookAt`
        // calls — copied rather than borrowed so a pooled tracer points exactly
        // where the per-mesh one did. Both box users draw through the
        // unlit `tracerMat`, so the non-uniform scale can't skew any shading.
        const rot = lookRotation(to.x - from.x, to.y - from.y, to.z - from.z);
        this.spawn('volleyTracer', FxShape.Box, this.tracerMat,
            (from.x + to.x) * 0.5, (from.y + to.y) * 0.5, (from.z + to.z) * 0.5,
            0.7, 0.7, len, 0.12, { rot, noFade: true });
    }

    /// Small dirt puff for a statistical miss / unknown outcome — visible
    /// feedback that a volley landed here without revealing the result.
    private spawnFallbackDust(x: number, y: number, z: number): void {
        this.spawn('volleyDust', FxShape.Sphere4, this.dirtMat,
            x, y + 1.5, z, 5, 5, 5, 0.2);
    }

    /// Resolve the weapon-def CEG and spawn through the runtime.
    /// Returns true if a CEG was dispatched, false if the caller
    /// should fall back to a procedural mesh.
    private spawnCegImpact(
        impactKind: number,
        weaponDefId: number,
        x: number, y: number, z: number,
        forceWeaponDispatch: boolean,
        damage: number = 0,
    ): boolean {
        if (!this.cegRuntime) return false;
        const def = (weaponDefId && this.defCache)
            ? this.defCache.getWeaponDef(weaponDefId) : undefined;
        const name = effectForImpact(impactKind, def, forceWeaponDispatch);
        if (!name) return false;

        const flags = impactContextFlags(impactKind, y);
        // Direction: explosions ascend (0,1,0). The CEG translator's
        // particle direction maths multiplies by velocity so the
        // upward bias gives plausible debris arcs without a real
        // surface normal.
        this.cegRuntime.spawn(name, x, y + 1, z, 0, 1, 0, damage, flags);

        // First time we successfully dispatch for a weaponDef remove
        // it from the warned-fallback set so a later regression flags
        // again cleanly. Cheap; happens once per def.
        this.warnedFallback.delete(weaponDefId);
        return true;
    }

    private spawnFallbackImpact(x: number, y: number, z: number, damage: number): void {
        const size = Math.min(4 + damage * 0.02, 20);
        this.spawn('impact', FxShape.Sphere4, this.impactMat,
            x, y + 2, z, size, size, size, 0.15);
    }

    private spawnFallbackExplosion(x: number, y: number, z: number): void {
        this.spawn('explosion', FxShape.Sphere6, this.killMat,
            x, y + 5, z, 30, 30, 30, 0.5);
    }

    private spawnFallbackShield(x: number, y: number, z: number): void {
        this.spawn('shieldHit', FxShape.Sphere8, this.shieldMat,
            x, y, z, 16, 16, 16, 0.4);
    }

    private spawnFallbackAirburst(x: number, y: number, z: number): void {
        this.spawn('airburst', FxShape.Sphere6, this.impactMat,
            x, y, z, 12, 12, 12, 0.3);
    }

    /**
     * Update all active effects. Call every frame with delta time.
     * @param dt Delta time in seconds
     */
    tick(dt: number): void {
        // Advance procedural damage-field barrages (spawns their impacts).
        this.tickBarrages(dt);
        // The pools are rebuilt from scratch each frame rather than slot-
        // allocated: almost every live effect moves or fades, so it would be
        // rewriting nearly every matrix anyway, and this way expiry needs no
        // free-list bookkeeping. There are ~100 live effects at the L-battle.
        for (const pool of this.pools.values()) pool.count = 0;

        for (let i = this.effects.length - 1; i >= 0; i--) {
            const fx = this.effects[i];
            fx.lifetime -= dt;

            if (fx.lifetime <= 0) {
                fx.mesh?.dispose();
                this.effects.splice(i, 1);
                continue;
            }

            // Move if it has velocity
            if (fx.velocity) {
                fx.pos.x += fx.velocity.x * dt;
                fx.pos.y += fx.velocity.y * dt;
                fx.pos.z += fx.velocity.z * dt;
            }

            // Fade out by scaling down (skipped for stretched tracers/markers).
            const fade = fx.noFade
                ? 1
                : Math.min(Math.max(fx.lifetime * 4, 0), 1);  // 0.25s → scale 0..1

            if (fx.mesh) {                       // legacy own-mesh path
                fx.mesh.position.copyFrom(fx.pos);
                if (!fx.noFade) fx.mesh.scaling.setAll(fade);
                continue;
            }

            this._s.copyFrom(fx.size).scaleInPlace(fade);
            Matrix.ComposeToRef(this._s, fx.rot ?? FX_NO_ROT, fx.pos, this._m);
            this.writeInstance(this.getPool(fx.shape, fx.mat), this._m);
        }

        for (const pool of this.pools.values()) this.flushPool(pool);
    }

    get activeCount(): number {
        return this.effects.length;
    }

    /// PLAN-quickstart.md §3.2 (Part B — resync): drop every in-flight combat
    /// effect so the parked session's explosions/tracers don't hang on screen
    /// after re-entry, while KEEPING the procedural fallback materials (they are
    /// session-agnostic and expensive to recreate). Distinct from `dispose()`,
    /// which also tears down those materials.
    reset(): void {
        for (const fx of this.effects) {
            fx.mesh?.dispose();
        }
        this.effects = [];
        // Keep the pool prototypes (session-agnostic, like the materials) —
        // just stop drawing what the parked session left in them.
        for (const pool of this.pools.values()) {
            pool.count = 0;
            this.flushPool(pool);
        }
        this.warnedFallback.clear();
    }

    dispose(): void {
        for (const fx of this.effects) {
            fx.mesh?.dispose();
        }
        this.effects = [];
        for (const pool of this.pools.values()) {
            pool.mesh.dispose();
        }
        this.pools.clear();
        this.impactMat.dispose();
        this.killMat.dispose();
        this.shieldMat.dispose();
        this.dirtMat.dispose();
        this.tracerMat.dispose();
    }
}
