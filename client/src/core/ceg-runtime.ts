/**
 * CegRuntime — client-side particle effect runtime (PLAN-projectiles.md §5).
 *
 * This is the foundation for Spring's "Custom Explosion Generator" effects:
 * the named muzzle flashes, impact bursts, debris and smoke that fire on
 * weapon events. The full subsystem ships in three phases:
 *
 *  - 5a (this file) — particle pools + render path + a small hand-coded
 *    effect library wired into Fired/Impact events. Existing missile
 *    smoke trails (projectile-trails.ts) keep their dedicated path —
 *    they predate this runtime and will be folded in alongside 5c.
 *  - 5b — port concrete Spring CEG defs (`disintegrator`, `largelaser`,
 *    `lightcannon`, `lightninggun`, `flame`) into EffectDefs here.
 *  - 5c — server-side parser of `gamedata/particles/*.lua` streams
 *    EffectDefs over the wire; the renderer just consumes them.
 *
 * Architecture:
 *
 *  - One `ParticleClass` per visual category (`flare`, `spark`, `smoke`).
 *    Each class owns one Mesh + ShaderMaterial + a Structure-of-Arrays
 *    pool of particles. Per-class capacity is sized for worst-case
 *    cluster bombs.
 *  - Particles are allocated as a ring buffer — when the pool fills, the
 *    next spawn overwrites the oldest slot. For smoke (long-lived,
 *    frequently spawned) this is occasionally visible as an early fade
 *    on the oldest puff; for sparks/flares (short lifetimes) the
 *    oldest is already invisible by the time it's overwritten.
 *  - Per-tick CPU update (pos += vel*dt, age += dt, vel.y -= g*dt).
 *    Plan §5 calls out GPU-side update via transform feedback as the
 *    long-term target; CPU is fine for the 25k-particle steady state
 *    Phase 5a deals with and saves a substantial amount of shader and
 *    pipeline plumbing.
 *  - Per-frame buildBuffers walks every live particle and emits two
 *    thin-instance attributes: a billboard `matrix` (with current size
 *    baked into the scale and current rotation around the view axis)
 *    and a `tint` vec4 carrying lerped colour and lifetime fade alpha.
 *
 * Public API:
 *
 *  - `spawn(name, x, y, z, dx, dy, dz)` — fire an effect by name.
 *    `(dx, dy, dz)` is the spawn direction (e.g. weapon firing axis or
 *    impact normal); each particle's velocity is `base + spread*rand
 *    + scale*dir`, so the same effect adapts to whichever way the gun
 *    or impact is pointing.
 *  - `tick(dt)` — advance every live particle and rebuild thin-instance
 *    buffers per class. Call once per render frame.
 *  - `dispose()` — tear down GPU resources. Called from main.ts on
 *    quit-to-lobby.
 *
 * Texture sourcing: each class reads its sprite from
 * `data/engine/bitmaps/...` via `ProjectileTextureResolver`. The
 * resolver may not have finished loading when classes are first
 * materialised (it's async); the shader is happy with a null texture
 * (samples vec4(1) → tinted-only quad) so visuals just look "plain"
 * during the load window rather than vanishing.
 */

import {
    Scene,
    Mesh,
    MeshBuilder,
    ShaderMaterial,
    Matrix,
    Vector3,
    Quaternion,
    Texture,
} from '@babylonjs/core';

import { stampUrl } from '../config.js';
import type { ProjectileTextureResolver } from './projectile-texture-resolver.js';
import { registerCegParticleShader } from './shaders/ceg-particle.js';
import type { CegDefInfo } from './connection.js';
import { translateCegDef } from './ceg-translator.js';

/// Per-particle gravity is in elmos/sec² (positive pulls down).
/// Sized to roughly match Spring's default gravity feel without
/// importing the actual sim constant — visual-only.
const DEFAULT_GRAVITY = 0;

/// Spring sim tick rate, used to convert SubCegSpawn `delayFrames`
/// → wall-clock seconds. Mirrored from `SIM_HZ` in ceg-translator.ts
/// (kept here so the runtime doesn't have to import a translator
/// constant just to compute a delay).
const SIM_HZ_RUNTIME = 30;

/// Shorthand colour 4-tuple. Components in [0,1]; alpha is the
/// initial particle alpha at age 0 and fades linearly to 0 at
/// `lifetime`. RGB stays constant for the particle's lifetime
/// (Phase 5a — Phase 5c will add per-spawn color-over-life ramps).
type RGBA = [number, number, number, number];

/// One spawn group inside an EffectDef. A single effect typically
/// emits multiple groups (e.g. impact = flash + sparks + smoke).
export interface ParticleSpawn {
    /// Discriminator for `EffectDef.spawns` union. Optional and
    /// defaults to 'particle' so existing BUILTIN_EFFECTS entries
    /// (which predate the SubCegSpawn variant) don't have to be
    /// updated. SubCegSpawn carries an explicit `kind: 'subceg'`.
    kind?: 'particle';
    /// Name of the ParticleClass to allocate from. Must be a class
    /// the runtime knows about — unknown classes are silently
    /// skipped so adding new effects can't break the render loop.
    class: string;
    /// Number of particles to allocate per spawn() call. Static; the
    /// translator clamps to MAX_PARTICLES_PER_SPAWN. For damage-scaled
    /// counts (`numparticles = "i1"`) set `countExpr` instead — the
    /// runtime evaluates it per spawn() and ignores `count`.
    count: number;
    /// Optional override: per-spawn-call particle count. When present
    /// the runtime uses `floor(countExpr(ctx))` instead of `count`.
    /// Translator sets this for properties carrying `i<n>` / `d<n>` /
    /// `r<n>` tokens; otherwise it stays unset and the static count
    /// path runs (one less allocation per spawn).
    countExpr?: Expr;
    /// Lifetime range in seconds; per-particle is uniform random.
    lifetimeMin: number;
    lifetimeMax: number;
    /// Velocity = `velocityBase` + uniform-random[-1,+1]³ * `velocitySpread`
    ///           + `dir` * `velocityScale`.
    /// `velocityBase` is in world axes (typically (0,0,0) or a small
    /// upward bias); `velocityScale` projects the spawn direction
    /// onto each particle so muzzle bursts shoot down the gun barrel.
    velocityBase: [number, number, number];
    velocitySpread: number;
    velocityScale: number;
    /// Per-particle gravity (elmos/sec²). Positive pulls down. Smoke
    /// uses a small *negative* value to drift upward.
    gravity: number;
    /// Quad side length in elmos at age=0 / age=lifetime. Linear lerp.
    sizeStart: number;
    sizeEnd: number;
    /// RGBA tint at age=0. Alpha fades to 0 at age=lifetime.
    colorStart: RGBA;
    /// Max rotation rate in rad/sec; per-particle is uniform random
    /// in [-this, +this] so a smoke cloud has visually distinct puffs.
    rotationSpeedMax: number;
}

/// Scalar evaluator for a Spring CEG property (Phase 2). The closure
/// captures any random-magnitude or damage-scaled terms from the
/// source string; the call site supplies the parent explosion's
/// damage. RNG is `Math.random` baked in. Constants collapse to a
/// trivially-cheap `() => N` closure so call sites don't have to
/// special-case them. See `parseExpr` in ceg-translator.ts.
export type Expr = (ctx: ExprContext) => number;
export interface ExprContext {
    /// Parent explosion damage in HP. Plumbed through the SubCegSpawn
    /// chain so `i1`/`d5` tokens at leaf CEGs scale from the original
    /// weapon's damage rather than the immediate parent's.
    damage: number;
}

/// Sub-CEG spawn — a deferred dispatch back into `spawn()` against a
/// named child CEG. Translates Spring's `CExpGenSpawner` ("delayspawner"
/// — fires a sub-effect after a frame delay) and is also how
/// `CSpherePartSpawner` would chain a sphere-distributed child if it
/// carried an `explosiongenerator` property (rare but valid).
///
/// The runtime evaluates each Expr field once per dispatch so random
/// terms produce staggered fans naturally (e.g. `delay = "r60"` →
/// each pending entry samples a fresh delay).
export interface SubCegSpawn {
    kind: 'subceg';
    /// How many child spawns the parent emits per call. Evaluated
    /// once per parent fire — supports `count = "i1"` damage scaling
    /// and `r3` random magnitudes from the mini-language.
    countExpr: Expr;
    /// Tag of the child CEG. Server-side `CegLoader` strips the
    /// `custom:` prefix; translator lowercases for case-stable lookup.
    targetTag: string;
    /// Delay in sim frames. Evaluated once per pending dispatch;
    /// converted to wall-clock seconds at queue time.
    delayFramesExpr: Expr;
    /// Position offset (in elmos) relative to the parent spawn point.
    /// Each component is its own Expr so `pos = "0, 24 i8, 0"` works
    /// out of the box. Evaluated once per pending dispatch.
    posOffsetExpr: [Expr, Expr, Expr];
    /// When true, the child inherits the parent's spawn direction
    /// (Spring's `dir = "dir"` keyword). When false, child fires with
    /// world up `(0, 1, 0)` — matching the behaviour of impact CEGs
    /// where direction is meaningless.
    dirInherit: boolean;
    /// Spawn distribution mode:
    ///   - 'point': all dispatches share `posOffset`.
    ///   - 'sphere': dispatches are placed on a sphere of `radius`
    ///     around `posOffset`, each with a random unit direction.
    /// CSpherePartSpawner with an `explosiongenerator` becomes
    /// 'sphere'; CExpGenSpawner becomes 'point'.
    distribution: 'point' | 'sphere';
    /// Sphere radius in elmos. Ignored for 'point' distribution.
    radius: number;
}

/// One named effect — what gets fired by `spawn(name, ...)`.
export interface EffectDef {
    name: string;
    spawns: Array<ParticleSpawn | SubCegSpawn>;
}

/// Per-class GPU + CPU state. Capacity is fixed at construction so
/// the pools sit in steady-state memory rather than growing under
/// load and triggering GC pressure. Texture URL is resolved lazily —
/// the binding may be null when the class is first materialised but
/// gets attached the first time the resolver returns a real URL.
interface ParticleClass {
    name: string;
    capacity: number;
    /// Resolver-key (logical texture name from `gamedata/resources.lua`)
    /// — not a URL. The runtime calls `resolver.resolve(textureName)`
    /// every time it tries to wire a texture, so a class created
    /// before the resolver loaded picks up its real sprite once
    /// resources.json + manifests settle.
    textureName: string;
    /// True once the resolver has handed back a real URL and we've
    /// bound the Texture; further resolves are skipped.
    textureBound: boolean;
    /// SoA particle data. Inactive slots have `lifetime[i] <= 0`.
    pos: Float32Array;            // capacity * 3
    vel: Float32Array;            // capacity * 3
    age: Float32Array;            // capacity
    lifetime: Float32Array;       // capacity, <=0 → free slot
    sizeStart: Float32Array;      // capacity
    sizeEnd: Float32Array;        // capacity
    color: Float32Array;          // capacity * 4 (initial RGBA)
    gravity: Float32Array;        // capacity
    rotation: Float32Array;       // capacity (rad)
    rotationSpeed: Float32Array;  // capacity (rad/sec)
    /// Ring-buffer write cursor. Wraps mod capacity. Allocation is
    /// "always overwrite" — the oldest live particle gets clobbered
    /// when the pool is full. For class capacities sized above the
    /// realistic worst-case live count, this never visibly clips.
    nextSlot: number;
    /// GPU resources.
    mesh: Mesh;
    material: ShaderMaterial;
    /// Persistent thin-instance upload buffers, reused across frames
    /// so we don't allocate `Float32Array(live * 16)` + `(live * 4)`
    /// every tick (which produced ~12 MB/s of GC churn at full
    /// combat intensity once Phase 5c routed every ZK weapon's
    /// cegTag through the runtime). Sized to `capacity` once at
    /// class creation; the buffer-rebuild path slots only `live`
    /// entries into the front and tells Babylon how many to draw
    /// via `thinInstanceCount`. Babylon reuses the same GPU buffer
    /// because the JS-side reference is stable.
    matrixBuffer: Float32Array;
    tintBuffer: Float32Array;
}

/// Per-class capacity. Smoke is the longest-lived → biggest pool.
/// Sparks/flares die quickly so 4k each is plenty for steady state.
/// Total memory: ~3MB across all classes. Negligible at game scale.
const CLASS_CAPACITIES: Record<string, number> = {
    flare: 4096,
    spark: 8192,
    smoke: 8192,
};

/// Hard cap on sub-CEG recursion depth (Phase 1). A correctly-authored
/// CEG tree is at most 3–4 levels deep (nuke → mushroom → smokejets →
/// puffs). Eight covers any reasonable author intent and prevents a
/// pathological A→B→A cycle from saturating the pending queue before
/// the per-pending cap kicks in.
const MAX_SUBCEG_DEPTH = 8;

/// Hard cap on the pending-spawn queue. A 30-particle CExpGenSpawner
/// with a 60-frame random delay could legitimately enqueue 30 entries
/// per parent fire; a nuke + a few simultaneous unit deaths comfortably
/// stays under this. The cap exists for buggy CEGs (count = 10000) and
/// the cycle-detection backstop — beyond this the runtime drops new
/// entries silently and warns once.
const MAX_PENDING_SPAWNS = 4096;

/// One deferred sub-CEG dispatch. Pushed onto CegRuntime.pending when
/// a parent spawn() walks a SubCegSpawn entry; drained in tick() when
/// `now >= fireAtMs`. Kept as a plain object rather than an SoA pool
/// because the queue is small (≤ MAX_PENDING_SPAWNS, typically <100)
/// and array-of-structs reads more naturally for the drain loop.
interface PendingSpawn {
    effectName: string;
    /// World-space spawn position, already includes the SubCegSpawn's
    /// `posOffset` and (for sphere distribution) the radial component.
    /// Stored as numbers rather than Vector3 to avoid per-spawn
    /// allocation churn when nuke-class effects fire dozens at once.
    px: number;
    py: number;
    pz: number;
    dx: number;
    dy: number;
    dz: number;
    fireAtMs: number;
    /// Damage inherited from the original parent call. Spring's CEG
    /// chains propagate damage downward so that "i1" / "d5" tokens at
    /// leaf level still scale off the original explosion's strength.
    /// Phase 2 will consume this; Phase 1 plumbs it but doesn't use it
    /// at evaluation time yet.
    damage: number;
    /// Sub-CEG recursion depth — increments by 1 per chained spawn().
    /// Compared against MAX_SUBCEG_DEPTH at dispatch time.
    depth: number;
}

/// Engine-bitmap textureName per class. These are bare logical names
/// that `ProjectileTextureResolver` looks up against the engine's
/// `gamedata/resources.lua` `graphics.projectiletextures` table; the
/// resolver's engine-fallback branch picks them up from the engine
/// bitmaps manifest (`/api/engine/data/bitmaps/manifest.json`).
const CLASS_TEXTURE_NAMES: Record<string, string> = {
    flare: 'flare',
    spark: 'flare',         // sparks reuse the flare bitmap (small + bright)
    smoke: 'smoketrail',    // same texture trails use; works as a generic puff
};

export class CegRuntime {
    private scene: Scene;
    private resolver: ProjectileTextureResolver | null = null;
    private classes = new Map<string, ParticleClass>();
    private effects = new Map<string, EffectDef>();
    /// Sub-CEG dispatch queue (Phase 1). FIFO; entries fire in the
    /// first tick() where `nowMs >= fireAtMs`. The drain replaces the
    /// queue with the entries that are still pending (one allocation
    /// per tick at worst) rather than shifting in-place.
    private pending: PendingSpawn[] = [];
    /// One-shot warning state for the cycle / overflow paths so a
    /// pathological CEG doesn't flood the console once per impact.
    private warnedOverflow = false;
    private warnedDepth = new Set<string>();
    /// Reusable scratch — composed into per-particle billboard matrices
    /// in buildBuffers. Allocated once per runtime to avoid GC churn
    /// on per-tick rebuilds.
    private tmpRight = new Vector3();
    private tmpUp = new Vector3();
    private tmpFwd = new Vector3();
    private tmpQ = new Quaternion();
    private tmpScale = new Vector3();
    /// True once `whenReady().then` has fired — all subsequent
    /// `spawn()` calls will look up textures synchronously through
    /// the resolver. Before this point, classes render untextured
    /// (just shaped tinted quads) until the resolver settles.
    private resolverReady = false;

    constructor(scene: Scene) {
        this.scene = scene;
        registerCegParticleShader();

        // Materialise the canonical classes up front so the first
        // spawn() doesn't hitch on mesh creation. Texture binding
        // happens later (resolver may not have loaded yet).
        for (const className of Object.keys(CLASS_CAPACITIES)) {
            this.ensureClass(className);
        }

        // Register the built-in effect library.
        for (const def of BUILTIN_EFFECTS) {
            this.effects.set(def.name, def);
        }
    }

    /// Ingest a batch of streamed CEG defs (Phase 5c). Translates
    /// each one into a runtime EffectDef and registers it under its
    /// tag, overriding any same-named built-in. CEGs the translator
    /// can't render (e.g. classes the runtime doesn't pool yet)
    /// produce no entry — the renderer's archetype dispatch keeps
    /// covering those weapons via BUILTIN_EFFECTS.
    ///
    /// Per-def translation is wrapped in try/catch: ZK ships ~1500
    /// CEGs and a malformed property in any one of them must not
    /// abort the whole ingest (which would propagate up through
    /// connection.ingestFramedMessage → defs-fetch → the game-start
    /// Promise.all chain → black screen).
    ingestCegDefs(defs: CegDefInfo[]): void {
        let translated = 0;
        let failed = 0;
        for (const def of defs) {
            try {
                const eff = translateCegDef(def);
                if (!eff) continue;
                this.effects.set(eff.name, eff);
                translated++;
            } catch (e) {
                failed++;
                if (failed <= 3) {
                    console.warn(`[ceg] translate failed for "${def.tag}":`, e);
                }
            }
        }
        if (translated > 0) {
            console.log(`[ceg] registered ${translated} streamed effect(s) `
                + `(${defs.length - translated} skipped, ${failed} errored)`);
        }
    }

    /// Inject the resolver after init(). Mirrors the projectile
    /// renderer's pattern. Called once per game session from main.ts.
    setTextureResolver(resolver: ProjectileTextureResolver): void {
        this.resolver = resolver;
        // Schedule a one-time texture bind once the resolver finishes
        // loading. Classes created before this point are already in
        // place; we just attach their textures.
        resolver.whenReady().then(() => {
            this.resolverReady = true;
            for (const cls of this.classes.values()) {
                this.tryBindTexture(cls);
            }
        }).catch((e) => {
            console.warn('[ceg] resolver whenReady() rejected:', e);
        });
    }

    /// Fire an effect by name. `(x,y,z)` is the spawn world position;
    /// `(dx,dy,dz)` should be unit-length and points in the effect's
    /// "forward" direction (gun barrel for muzzle flashes; impact
    /// normal or upward (0,1,0) for ground impacts). Unknown effect
    /// names are silently dropped so a missing entry can't crash the
    /// renderer — gameplay-side adoption can outrun the effect library.
    ///
    /// `damage` is the parent explosion's damage in HP. Currently
    /// plumbed through PendingSpawn for Phase 2's expression evaluator
    /// (`i1`, `d5` tokens scale from it). External callers can omit
    /// it (defaults to 0) for muzzle and trail effects which don't
    /// reference damage.
    spawn(
        name: string,
        x: number, y: number, z: number,
        dx: number, dy: number, dz: number,
        damage: number = 0,
    ): void {
        this.spawnInternal(name, x, y, z, dx, dy, dz, damage, /*depth*/ 0);
    }

    /// Internal recursive form. `depth` increments on every chained
    /// dispatch from a PendingSpawn drain so MAX_SUBCEG_DEPTH can
    /// abort A→B→A cycles without scanning the whole pending queue.
    /// Public spawn() always enters at depth 0.
    private spawnInternal(
        name: string,
        x: number, y: number, z: number,
        dx: number, dy: number, dz: number,
        damage: number, depth: number,
    ): void {
        const def = this.effects.get(name);
        if (!def) return;

        if (depth >= MAX_SUBCEG_DEPTH) {
            if (!this.warnedDepth.has(name)) {
                this.warnedDepth.add(name);
                console.warn(`[ceg] sub-CEG recursion limit hit at "${name}" `
                    + `(depth ${depth}); chain aborted`);
            }
            return;
        }

        const nowMs = performance.now();
        const ctx: ExprContext = { damage };
        for (const sp of def.spawns) {
            if (sp.kind === 'subceg') {
                this.queueSubCeg(sp, x, y, z, dx, dy, dz, damage, depth, nowMs);
                continue;
            }
            const cls = this.classes.get(sp.class);
            if (!cls) continue;
            // Particle count is normally a static field; only resolve
            // through the Expr path when the translator opted in.
            let n = sp.count;
            if (sp.countExpr) {
                n = Math.max(0, Math.floor(sp.countExpr(ctx)));
                // Clamp against the same per-spawn ceiling the
                // translator uses for static counts so a damage-
                // scaled spawn can't dwarf the pool either.
                if (n > sp.count * 4) n = sp.count * 4;
            }
            for (let i = 0; i < n; i++) {
                const slot = allocateSlot(cls);
                writeParticle(cls, slot, sp, x, y, z, dx, dy, dz);
            }
        }
    }

    /// Translate one SubCegSpawn into N PendingSpawn entries. Drops
    /// silently when the queue would overflow (warns once). Sphere
    /// distribution picks a random unit vector per dispatch so the
    /// children fan out evenly — matching Spring's CSpherePartSpawner
    /// behaviour without a separate sphere-sampling primitive.
    private queueSubCeg(
        sp: SubCegSpawn,
        px: number, py: number, pz: number,
        dx: number, dy: number, dz: number,
        damage: number, parentDepth: number, nowMs: number,
    ): void {
        const childDepth = parentDepth + 1;
        if (childDepth >= MAX_SUBCEG_DEPTH) {
            // The dispatch itself would be capped; skip the enqueue
            // cost rather than enqueueing dead entries.
            return;
        }
        // Evaluate countExpr once per parent fire — its result is
        // shared across this dispatch's children. Clamp negative
        // results to 0 and absurd ones to 64 (sane upper bound; the
        // queue cap is the real backstop).
        const ctx: ExprContext = { damage };
        const rawCount = sp.countExpr(ctx);
        const count = Math.max(0, Math.min(64, Math.floor(rawCount)));
        for (let i = 0; i < count; i++) {
            if (this.pending.length >= MAX_PENDING_SPAWNS) {
                if (!this.warnedOverflow) {
                    this.warnedOverflow = true;
                    console.warn(`[ceg] sub-CEG pending queue full `
                        + `(${MAX_PENDING_SPAWNS} entries); dropping new spawns`);
                }
                return;
            }
            // Evaluate position offset Exprs per pending dispatch so
            // random-magnitude terms (`pos = "~3, 0, ~3"`) produce a
            // spatially-spread fan rather than a tight cluster.
            let ox = sp.posOffsetExpr[0](ctx);
            let oy = sp.posOffsetExpr[1](ctx);
            let oz = sp.posOffsetExpr[2](ctx);
            let sdx = dx, sdy = dy, sdz = dz;
            if (sp.distribution === 'sphere' && sp.radius > 0) {
                // Pick a random unit vector then push the spawn out
                // along it by `radius` elmos. Math.random() pairs
                // sampled in (x,y,z) with rejection would be exact,
                // but a normalised gaussian-like sample is fast and
                // visually equivalent at the small counts (≤ 30)
                // sub-spawners typically use.
                const ux = Math.random() * 2 - 1;
                const uy = Math.random() * 2 - 1;
                const uz = Math.random() * 2 - 1;
                const ulen = Math.hypot(ux, uy, uz);
                if (ulen > 1e-3) {
                    const inv = sp.radius / ulen;
                    ox += ux * inv;
                    oy += uy * inv;
                    oz += uz * inv;
                    sdx = ux / ulen;
                    sdy = uy / ulen;
                    sdz = uz / ulen;
                }
            } else if (!sp.dirInherit) {
                sdx = 0; sdy = 1; sdz = 0;
            }
            // Delay is authored in sim frames. Clamp to [0, 6s] so a
            // malformed expression can't queue spawns hours in the
            // future (the queue would still fire them eventually).
            const delayFrames = Math.max(0, sp.delayFramesExpr(ctx));
            const delayS = Math.min(delayFrames / SIM_HZ_RUNTIME, 6);
            this.pending.push({
                effectName: sp.targetTag,
                px: px + ox, py: py + oy, pz: pz + oz,
                dx: sdx, dy: sdy, dz: sdz,
                fireAtMs: nowMs + delayS * 1000,
                damage,
                depth: childDepth,
            });
        }
    }

    /// Advance every live particle by `dt` seconds, then rebuild thin-
    /// instance buffers per class so the next render frame draws the
    /// updated state. Single pass — particles that age past their
    /// lifetime get marked free in the same loop that integrates
    /// position, no separate sweep.
    tick(dt: number): void {
        if (dt <= 0) return;

        this.drainPending();

        const cam = this.scene.activeCamera;
        const camX = cam ? cam.position.x : 0;
        const camY = cam ? cam.position.y : 0;
        const camZ = cam ? cam.position.z : 0;

        for (const cls of this.classes.values()) {
            // Lazy texture bind: classes created before the resolver
            // settled stay un-textured until it does. The resolverReady
            // gate avoids re-probing on every tick once we're past load.
            if (this.resolverReady && !cls.textureBound) {
                this.tryBindTexture(cls);
            }
            stepClass(cls, dt);
            buildClassBuffers(cls, camX, camY, camZ,
                this.tmpRight, this.tmpUp, this.tmpFwd, this.tmpQ, this.tmpScale);
        }
    }

    /// Total live particle count across all classes. Useful for the
    /// debug overlay; not part of the per-frame hot path.
    get liveCount(): number {
        let n = 0;
        for (const cls of this.classes.values()) {
            for (let i = 0; i < cls.capacity; i++) {
                if (cls.lifetime[i] > 0) n++;
            }
        }
        return n;
    }

    dispose(): void {
        for (const cls of this.classes.values()) {
            cls.mesh.dispose();
            cls.material.dispose();
        }
        this.classes.clear();
        this.effects.clear();
        this.pending.length = 0;
        this.warnedDepth.clear();
        this.warnedOverflow = false;
    }

    /// Fire every PendingSpawn whose `fireAtMs` has elapsed. Entries
    /// that are still future-dated are kept in-place via two-pointer
    /// compaction — common case (most entries due) avoids reallocating
    /// the queue. Sub-CEG recursion uses spawnInternal() so depth
    /// tracking carries through the chain.
    private drainPending(): void {
        if (this.pending.length === 0) return;
        const nowMs = performance.now();
        let writeIdx = 0;
        const pending = this.pending;
        for (let i = 0; i < pending.length; i++) {
            const p = pending[i];
            if (nowMs >= p.fireAtMs) {
                this.spawnInternal(
                    p.effectName,
                    p.px, p.py, p.pz,
                    p.dx, p.dy, p.dz,
                    p.damage, p.depth);
            } else {
                if (writeIdx !== i) pending[writeIdx] = p;
                writeIdx++;
            }
        }
        pending.length = writeIdx;
    }

    private ensureClass(name: string): ParticleClass {
        const existing = this.classes.get(name);
        if (existing) return existing;

        const capacity = CLASS_CAPACITIES[name] ?? 4096;
        const textureName = CLASS_TEXTURE_NAMES[name] ?? '';

        const mat = new ShaderMaterial(`cegParticleMat_${name}`, this.scene,
            'cegParticle', {
                attributes: ['position', 'uv', 'tint'],
                uniforms: ['world', 'viewProjection'],
                samplers: ['particleTex'],
                defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
            });
        // Premultiplied additive — same convention as trail/beam.
        mat.alphaMode = 7;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;

        const mesh = MeshBuilder.CreatePlane(`cegParticle_${name}`,
            { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.isVisible = false;
        mesh.thinInstanceEnablePicking = false;
        // Particles are camera-facing billboards; Babylon's frustum
        // cull on a unit-quad bounding box would clip them as the
        // camera moves. alwaysSelectAsActiveMesh skips that check.
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.alphaIndex = 1000;
        // Per-instance tint (R, G, B, A) registered up front so the
        // first buildBuffers can populate it without re-registering.
        mesh.thinInstanceRegisterAttribute('tint', 4);

        const cls: ParticleClass = {
            name, capacity, textureName, textureBound: false,
            pos: new Float32Array(capacity * 3),
            vel: new Float32Array(capacity * 3),
            age: new Float32Array(capacity),
            lifetime: new Float32Array(capacity),
            sizeStart: new Float32Array(capacity),
            sizeEnd: new Float32Array(capacity),
            color: new Float32Array(capacity * 4),
            gravity: new Float32Array(capacity),
            rotation: new Float32Array(capacity),
            rotationSpeed: new Float32Array(capacity),
            nextSlot: 0,
            mesh, material: mat,
            // Sized to capacity so a worst-case full pool never has
            // to reallocate. Each entry is mat4 (16 floats) + RGBA
            // tint (4 floats); for the largest pool (smoke 8192)
            // that's 8192 * 20 * 4 ≈ 640 KB total per class.
            matrixBuffer: new Float32Array(capacity * 16),
            tintBuffer: new Float32Array(capacity * 4),
        };
        this.classes.set(name, cls);
        return cls;
    }

    private tryBindTexture(cls: ParticleClass): void {
        if (cls.textureBound) return;
        if (!this.resolver || !cls.textureName) return;
        const url = this.resolver.resolve(cls.textureName);
        if (!url) return;
        const tex = new Texture(stampUrl(url), this.scene, /*noMipmap*/ false,
            /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;
        cls.material.setTexture('particleTex', tex);
        cls.textureBound = true;
    }
}

// ── Allocation + per-particle write ─────────────────────────────────────────

function allocateSlot(cls: ParticleClass): number {
    const slot = cls.nextSlot;
    cls.nextSlot = (slot + 1) % cls.capacity;
    return slot;
}

function writeParticle(
    cls: ParticleClass, slot: number,
    sp: ParticleSpawn,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
): void {
    const p3 = slot * 3;
    cls.pos[p3 + 0] = x;
    cls.pos[p3 + 1] = y;
    cls.pos[p3 + 2] = z;

    const r1 = (Math.random() - 0.5) * 2;
    const r2 = (Math.random() - 0.5) * 2;
    const r3 = (Math.random() - 0.5) * 2;
    cls.vel[p3 + 0] = sp.velocityBase[0]
        + r1 * sp.velocitySpread + dx * sp.velocityScale;
    cls.vel[p3 + 1] = sp.velocityBase[1]
        + r2 * sp.velocitySpread + dy * sp.velocityScale;
    cls.vel[p3 + 2] = sp.velocityBase[2]
        + r3 * sp.velocitySpread + dz * sp.velocityScale;

    cls.lifetime[slot] = sp.lifetimeMin
        + Math.random() * (sp.lifetimeMax - sp.lifetimeMin);
    cls.age[slot] = 0;
    cls.sizeStart[slot] = sp.sizeStart;
    cls.sizeEnd[slot] = sp.sizeEnd;

    const c4 = slot * 4;
    cls.color[c4 + 0] = sp.colorStart[0];
    cls.color[c4 + 1] = sp.colorStart[1];
    cls.color[c4 + 2] = sp.colorStart[2];
    cls.color[c4 + 3] = sp.colorStart[3];

    cls.gravity[slot] = sp.gravity;
    cls.rotation[slot] = Math.random() * Math.PI * 2;
    cls.rotationSpeed[slot] = (Math.random() - 0.5) * 2 * sp.rotationSpeedMax;
}

// ── Per-tick CPU integration ────────────────────────────────────────────────

function stepClass(cls: ParticleClass, dt: number): void {
    const cap = cls.capacity;
    const pos = cls.pos, vel = cls.vel;
    const age = cls.age, life = cls.lifetime;
    const grav = cls.gravity, rot = cls.rotation, rotSpd = cls.rotationSpeed;
    for (let i = 0; i < cap; i++) {
        const lt = life[i];
        if (lt <= 0) continue;
        const newAge = age[i] + dt;
        if (newAge >= lt) {
            life[i] = -1;
            continue;
        }
        age[i] = newAge;
        const p3 = i * 3;
        pos[p3 + 0] += vel[p3 + 0] * dt;
        pos[p3 + 1] += vel[p3 + 1] * dt;
        pos[p3 + 2] += vel[p3 + 2] * dt;
        // Gravity pulls down regardless of sign convention; matches the
        // weapon-projectile integration in projectile-renderer.tick().
        vel[p3 + 1] -= grav[i] * dt;
        rot[i] += rotSpd[i] * dt;
    }
}

// ── Per-frame thin-instance buffer rebuild ──────────────────────────────────

function buildClassBuffers(
    cls: ParticleClass,
    camX: number, camY: number, camZ: number,
    tmpRight: Vector3, tmpUp: Vector3, tmpFwd: Vector3,
    tmpQ: Quaternion, tmpScale: Vector3,
): void {
    // Pass 1: count live particles. Skipping inactive slots keeps the
    // GPU upload proportional to visible count rather than capacity.
    const cap = cls.capacity;
    const life = cls.lifetime;
    let live = 0;
    for (let i = 0; i < cap; i++) {
        if (life[i] > 0) live++;
    }

    if (live === 0) {
        cls.mesh.isVisible = false;
        cls.mesh.thinInstanceCount = 0;
        return;
    }

    // Reuse the persistent per-class buffers — see ParticleClass
    // comment. Reallocating per frame produced multi-MB/sec of GC
    // churn once Phase 5c started routing every weapon's cegTag
    // through the pools; the symptom was the browser tab going
    // unresponsive after a minute of combat.
    const matrices = cls.matrixBuffer;
    const tints = cls.tintBuffer;

    const pos = cls.pos;
    const age = cls.age;
    const sizeStart = cls.sizeStart, sizeEnd = cls.sizeEnd;
    const color = cls.color;
    const rot = cls.rotation;

    let dst = 0;
    for (let i = 0; i < cap; i++) {
        const lt = life[i];
        if (lt <= 0) continue;
        const t = age[i] / lt; // 0 at birth, 1 at death
        const size = sizeStart[i] + (sizeEnd[i] - sizeStart[i]) * t;
        const fade = 1 - t;

        const p3 = i * 3;
        composeBillboardMatrix(matrices, dst * 16,
            pos[p3 + 0], pos[p3 + 1], pos[p3 + 2],
            camX, camY, camZ, size, rot[i],
            tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale);

        const c4 = i * 4;
        const ds = dst * 4;
        tints[ds + 0] = color[c4 + 0];
        tints[ds + 1] = color[c4 + 1];
        tints[ds + 2] = color[c4 + 2];
        tints[ds + 3] = color[c4 + 3] * fade;
        dst++;
    }

    cls.mesh.isVisible = true;
    cls.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
    cls.mesh.thinInstanceSetBuffer('tint', tints, 4, false);
    cls.mesh.thinInstanceCount = live;
}

/// Camera-facing billboard matrix at world (px,py,pz), scaled to `size`,
/// with `rotRad` rotation applied around the view axis so individual
/// puffs in a smoke cloud read as distinct rather than identical.
/// Mirrors the orthonormal-basis trick the projectile renderer uses for
/// its sprite billboards; rotation around forward is the only addition.
function composeBillboardMatrix(
    out: Float32Array, off: number,
    px: number, py: number, pz: number,
    camX: number, camY: number, camZ: number,
    size: number, rotRad: number,
    tmpRight: Vector3, tmpUp: Vector3, tmpFwd: Vector3,
    tmpQ: Quaternion, tmpScale: Vector3,
): void {
    let fx = camX - px, fy = camY - py, fz = camZ - pz;
    let flen = Math.hypot(fx, fy, fz);
    if (flen < 1e-3) { fx = 0; fy = 0; fz = 1; flen = 1; }
    fx /= flen; fy /= flen; fz /= flen;
    let rx = fz, ry = 0, rz = -fx;
    let rlen = Math.hypot(rx, ry, rz);
    if (rlen < 1e-3) { rx = 1; ry = 0; rz = 0; rlen = 1; }
    rx /= rlen; rz /= rlen;
    const ux = fy * rz - fz * ry;
    const uy = fz * rx - fx * rz;
    const uz = fx * ry - fy * rx;
    // Rotate the camera-plane basis around the view axis. Keeps the
    // basis orthonormal so the subsequent quaternion build is valid.
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    const rrX = rx * c + ux * s;
    const rrY = ry * c + uy * s;
    const rrZ = rz * c + uz * s;
    const ruX = ux * c - rx * s;
    const ruY = uy * c - ry * s;
    const ruZ = uz * c - rz * s;
    tmpRight.set(rrX, rrY, rrZ);
    tmpUp.set(ruX, ruY, ruZ);
    tmpFwd.set(fx, fy, fz);
    Quaternion.RotationQuaternionFromAxisToRef(tmpRight, tmpUp, tmpFwd, tmpQ);
    tmpScale.set(size, size, size);
    const m = Matrix.Compose(tmpScale, tmpQ, new Vector3(px, py, pz));
    m.copyToArray(out, off);
}

// ── Built-in effect library ────────────────────────────────────────────────
//
// Hand-coded analogues of the most common Spring CEGs. Phase 5b will
// flesh this out with concrete ports of `disintegrator` / `largelaser`
// / `lightcannon` / `lightninggun` / `flame` from ZK's
// `gamedata/particles/`. Phase 5c will replace this whole block with
// server-streamed defs.
//
// Sizes are in elmos (Spring's world unit). Velocities in elmos/sec
// (different from the per-frame numbers the projectile renderer
// converts at — these effects don't go through the same pipe).
// Colours are RGBA in [0,1]; alpha at age 0, fades to 0 at lifetime.

const BUILTIN_EFFECTS: EffectDef[] = [
    // Generic muzzle flash — single short-lived flare + a few sparks.
    // Emitted by ProjectileRenderer.onFired for any weapon that
    // doesn't have a dedicated muzzle CEG yet.
    {
        name: 'muzzleflash_default',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.08, lifetimeMax: 0.12,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 8, sizeEnd: 18,
                colorStart: [1.0, 0.9, 0.5, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'spark', count: 6,
                lifetimeMin: 0.12, lifetimeMax: 0.25,
                velocityBase: [0, 0, 0], velocitySpread: 25, velocityScale: 50,
                gravity: 30,
                sizeStart: 1.5, sizeEnd: 0.3,
                colorStart: [1.0, 0.9, 0.4, 1.0],
                rotationSpeedMax: 0,
            },
        ],
    },
    // Missile launch — bigger flare, no sparks (the trail handles
    // the in-flight smoke). Wider spread on the launch flare gives
    // the visual impression of an exhaust plume.
    {
        name: 'muzzleflash_missile',
        spawns: [
            {
                class: 'flare', count: 2,
                lifetimeMin: 0.15, lifetimeMax: 0.25,
                velocityBase: [0, 0, 0], velocitySpread: 4, velocityScale: 0,
                gravity: 0,
                sizeStart: 6, sizeEnd: 14,
                colorStart: [1.0, 0.7, 0.3, 1.0],
                rotationSpeedMax: 0.5,
            },
            {
                class: 'smoke', count: 3,
                lifetimeMin: 0.6, lifetimeMax: 1.0,
                velocityBase: [0, 0, 0], velocitySpread: 4,
                velocityScale: -10, // exhaust pushes opposite to barrel direction
                gravity: -2,
                sizeStart: 6, sizeEnd: 14,
                colorStart: [0.5, 0.45, 0.4, 0.6],
                rotationSpeedMax: 1.0,
            },
        ],
    },
    // Generic explosion — flash + radial sparks + lingering smoke.
    // Used for unit / feature impacts where we don't have a dedicated
    // CEG. Spark count and smoke density are tuned for visibility at
    // RTS-camera ranges (50-200 elmos).
    {
        name: 'impact_explosion',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.18, lifetimeMax: 0.25,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 12, sizeEnd: 28,
                colorStart: [1.0, 0.7, 0.3, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'spark', count: 16,
                lifetimeMin: 0.4, lifetimeMax: 0.8,
                velocityBase: [0, 5, 0], velocitySpread: 35, velocityScale: 0,
                gravity: 60,
                sizeStart: 1.8, sizeEnd: 0.3,
                colorStart: [1.0, 0.8, 0.3, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'smoke', count: 5,
                lifetimeMin: 0.8, lifetimeMax: 1.5,
                velocityBase: [0, 8, 0], velocitySpread: 6, velocityScale: 0,
                gravity: -8,
                sizeStart: 8, sizeEnd: 22,
                colorStart: [0.4, 0.4, 0.4, 0.55],
                rotationSpeedMax: 1.5,
            },
        ],
    },
    // Terrain impact — dirt + sparks. Brown smoke and shorter sparks
    // (debris arcs that fall back to ground rather than radial blast).
    {
        name: 'impact_dirt',
        spawns: [
            {
                class: 'smoke', count: 6,
                lifetimeMin: 0.7, lifetimeMax: 1.4,
                velocityBase: [0, 10, 0], velocitySpread: 8, velocityScale: 0,
                gravity: -4,
                sizeStart: 5, sizeEnd: 18,
                colorStart: [0.45, 0.35, 0.25, 0.7],
                rotationSpeedMax: 1.2,
            },
            {
                class: 'spark', count: 10,
                lifetimeMin: 0.3, lifetimeMax: 0.6,
                velocityBase: [0, 12, 0], velocitySpread: 15, velocityScale: 0,
                gravity: 80,
                sizeStart: 1.0, sizeEnd: 0.2,
                colorStart: [0.7, 0.55, 0.4, 1.0],
                rotationSpeedMax: 0,
            },
        ],
    },
    // Shield deflection — short blue flare ring (no sparks/smoke).
    {
        name: 'impact_shield',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.25, lifetimeMax: 0.35,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 14, sizeEnd: 22,
                colorStart: [0.4, 0.7, 1.0, 0.9],
                rotationSpeedMax: 0,
            },
        ],
    },

    // ── Phase 5b: per-archetype ports of named ZK CEGs ─────────────────
    //
    // These approximate the visual signature of five common ZK weapon
    // archetypes the renderer can reach via `classifyWeaponArchetype`
    // in projectile-renderer.ts. Numbers come from the corresponding
    // `content/games/zk/effects/*.lua` defs (ZK's `particlelife` is in
    // sim frames at 30 Hz; `particlespeed` is elmos/frame). Direct
    // 1:1 ports would over-spawn vs. the SoA pool budgets — counts
    // and per-particle sizes are scaled down where the original
    // exceeds Phase 5a's per-effect ceiling (~24 particles total).

    // Disintegrator muzzle (from `ataalaser`): purple flash + blue
    // sparks + small purple ground smoke. The original spawns ~14
    // particles across five sub-emitters; this port collapses them
    // into the three pool classes while preserving the colour
    // signature (R<G<B in the blue-violet band).
    {
        name: 'muzzleflash_disintegrator',
        spawns: [
            {
                class: 'flare', count: 2,
                lifetimeMin: 0.25, lifetimeMax: 0.55,
                velocityBase: [0, 5, 0], velocitySpread: 6, velocityScale: 4,
                gravity: -2,
                sizeStart: 6, sizeEnd: 26,
                colorStart: [0.3, 0.2, 1.0, 0.9],
                rotationSpeedMax: 0.5,
            },
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.4, lifetimeMax: 0.6,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 12, sizeEnd: 18,
                colorStart: [0.6, 0.25, 1.0, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'spark', count: 5,
                lifetimeMin: 0.35, lifetimeMax: 0.85,
                velocityBase: [0, 0, 0], velocitySpread: 90, velocityScale: 60,
                gravity: 0,
                sizeStart: 6, sizeEnd: 1,
                colorStart: [0.15, 0.25, 1.0, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'smoke', count: 3,
                lifetimeMin: 0.3, lifetimeMax: 1.0,
                velocityBase: [0, 0, 0], velocitySpread: 8, velocityScale: 0,
                gravity: -2,
                sizeStart: 4, sizeEnd: 26,
                colorStart: [0.3, 0.0, 0.5, 0.55],
                rotationSpeedMax: 1.0,
            },
        ],
    },

    // Disintegrator impact (from `dguntrace`): one large lingering
    // orange flare + heatcloud, no sparks. The original groundflash
    // ttl=80 frames ≈ 2.6s; we render it as a slow-fading flare with
    // the same colour ramp.
    {
        name: 'impact_disintegrator',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 2.4, lifetimeMax: 2.8,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 20, sizeEnd: 28,
                colorStart: [1.0, 0.3, 0.2, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.7, lifetimeMax: 1.1,
                velocityBase: [0, 4, 0], velocitySpread: 0, velocityScale: 0,
                gravity: -3,
                sizeStart: 32, sizeEnd: 14,
                colorStart: [1.0, 0.5, 0.2, 0.9],
                rotationSpeedMax: 0.3,
            },
            {
                class: 'smoke', count: 4,
                lifetimeMin: 1.0, lifetimeMax: 2.0,
                velocityBase: [0, 6, 0], velocitySpread: 6, velocityScale: 0,
                gravity: -4,
                sizeStart: 6, sizeEnd: 24,
                colorStart: [0.3, 0.15, 0.1, 0.55],
                rotationSpeedMax: 1.2,
            },
        ],
    },

    // Largelaser impact (from `flashlazer` / `lasers_melt2` / sparks):
    // BeamLaser is the muzzle, so muzzle is null; the impact is a
    // red-orange ground flash + sparks. Mirrors ZK's red molten-metal
    // signature without the persistent decal.
    {
        name: 'impact_largelaser',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.4, lifetimeMax: 0.6,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 14, sizeEnd: 26,
                colorStart: [1.0, 0.4, 0.1, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'spark', count: 12,
                lifetimeMin: 0.3, lifetimeMax: 0.7,
                velocityBase: [0, 8, 0], velocitySpread: 60, velocityScale: 0,
                gravity: 90,
                sizeStart: 1.6, sizeEnd: 0.3,
                colorStart: [1.0, 0.7, 0.2, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'smoke', count: 3,
                lifetimeMin: 0.6, lifetimeMax: 1.2,
                velocityBase: [0, 6, 0], velocitySpread: 4, velocityScale: 0,
                gravity: -3,
                sizeStart: 5, sizeEnd: 18,
                colorStart: [0.4, 0.2, 0.15, 0.5],
                rotationSpeedMax: 1.0,
            },
        ],
    },

    // Lightcannon impact: small kinetic burst — short flare + a few
    // dirt sparks + thin smoke. Cannon archetypes don't have a single
    // canonical CEG in ZK; this is a synthesis of `RAIDMUZZLE` /
    // `LEVLRMUZZLE` impact halos sized for raider-class projectiles
    // (size ≤ 4 elmo).
    {
        name: 'impact_lightcannon',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.18, lifetimeMax: 0.25,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 8, sizeEnd: 18,
                colorStart: [1.0, 0.7, 0.2, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'spark', count: 8,
                lifetimeMin: 0.25, lifetimeMax: 0.5,
                velocityBase: [0, 8, 0], velocitySpread: 25, velocityScale: 0,
                gravity: 80,
                sizeStart: 1.2, sizeEnd: 0.25,
                colorStart: [0.9, 0.6, 0.3, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'smoke', count: 2,
                lifetimeMin: 0.5, lifetimeMax: 0.9,
                velocityBase: [0, 6, 0], velocitySpread: 4, velocityScale: 0,
                gravity: -3,
                sizeStart: 4, sizeEnd: 12,
                colorStart: [0.4, 0.35, 0.3, 0.55],
                rotationSpeedMax: 1.0,
            },
        ],
    },

    // Lightninggun muzzle (from `zeus_fire_fx` → `zeusmuzzle`):
    // bright white-blue ball + ring expansion. Original uses three
    // sub-emitters with distinct textures — collapsed into two
    // overlaid flares in different colour bands.
    {
        name: 'muzzleflash_lightninggun',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.55, lifetimeMax: 0.7,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 14, sizeEnd: 22,
                colorStart: [1.0, 1.0, 1.0, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.5, lifetimeMax: 0.7,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 4, sizeEnd: 36,
                colorStart: [0.3, 0.5, 1.0, 0.6],
                rotationSpeedMax: 0,
            },
        ],
    },

    // Lightninggun impact (from `lightningplosion` / `bluebolts1`):
    // bright white inner ball + radial blue sparks + groundflash.
    // The original `electric thingies` spawns 10 size-15 puffs at
    // particlespeed=20 elmos/frame (=600 elmos/sec); ours is scaled
    // down so the spark fan reads cleanly at typical zoom.
    {
        name: 'impact_lightninggun',
        spawns: [
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.35, lifetimeMax: 0.5,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 16, sizeEnd: 28,
                colorStart: [0.7, 0.85, 1.0, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'spark', count: 10,
                lifetimeMin: 0.3, lifetimeMax: 0.5,
                velocityBase: [0, 0, 0], velocitySpread: 120, velocityScale: 0,
                gravity: 0,
                sizeStart: 5, sizeEnd: 0.5,
                colorStart: [0.5, 0.6, 1.0, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.4, lifetimeMax: 0.5,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 4, sizeEnd: 46,
                colorStart: [0.5, 0.5, 1.0, 0.4],
                rotationSpeedMax: 0,
            },
        ],
    },

    // Flame muzzle (from `large_muzzle_flash_fx`): a yellow→white
    // tongue projected along the firing axis plus drifting smoke.
    // The original `CBitmapMuzzleFlame` is a stretched quad — we
    // approximate with a velocity-projected flare cluster so the
    // muzzle "sticks" to the gun barrel for a frame or two.
    {
        name: 'muzzleflash_flame',
        spawns: [
            {
                class: 'flare', count: 4,
                lifetimeMin: 0.18, lifetimeMax: 0.35,
                velocityBase: [0, 0, 0], velocitySpread: 6, velocityScale: 60,
                gravity: -2,
                sizeStart: 8, sizeEnd: 22,
                colorStart: [0.95, 0.7, 0.15, 1.0],
                rotationSpeedMax: 1.5,
            },
            {
                class: 'flare', count: 1,
                lifetimeMin: 0.12, lifetimeMax: 0.2,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 30,
                gravity: 0,
                sizeStart: 14, sizeEnd: 6,
                colorStart: [1.0, 0.95, 0.8, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'smoke', count: 3,
                lifetimeMin: 0.6, lifetimeMax: 1.0,
                velocityBase: [0, 4, 0], velocitySpread: 4, velocityScale: 20,
                gravity: -4,
                sizeStart: 4, sizeEnd: 18,
                colorStart: [0.35, 0.3, 0.25, 0.55],
                rotationSpeedMax: 1.0,
            },
        ],
    },

    // Flame impact (from `burn` heatcloud + groundflash): warm
    // halo + lingering low smoke. ZK's `burn` spawns 25 gfx +
    // 6 heatclouds; ours shaves both counts to keep the per-burst
    // particle budget reasonable when napalm tongues stack.
    {
        name: 'impact_flame',
        spawns: [
            {
                class: 'flare', count: 2,
                lifetimeMin: 0.4, lifetimeMax: 0.7,
                velocityBase: [0, 4, 0], velocitySpread: 6, velocityScale: 0,
                gravity: -2,
                sizeStart: 12, sizeEnd: 22,
                colorStart: [1.0, 0.5, 0.1, 1.0],
                rotationSpeedMax: 1.0,
            },
            {
                class: 'spark', count: 4,
                lifetimeMin: 0.3, lifetimeMax: 0.6,
                velocityBase: [0, 6, 0], velocitySpread: 18, velocityScale: 0,
                gravity: 50,
                sizeStart: 1.5, sizeEnd: 0.3,
                colorStart: [1.0, 0.7, 0.2, 1.0],
                rotationSpeedMax: 0,
            },
            {
                class: 'smoke', count: 4,
                lifetimeMin: 1.0, lifetimeMax: 1.6,
                velocityBase: [0, 5, 0], velocitySpread: 4, velocityScale: 0,
                gravity: -5,
                sizeStart: 6, sizeEnd: 22,
                colorStart: [0.25, 0.2, 0.18, 0.6],
                rotationSpeedMax: 1.2,
            },
        ],
    },
];

// Default-gravity export so tests / future callers don't have to
// hard-code the literal. Currently zero — gravity is per-spawn-defined
// in the library above; this constant is reserved for future use when
// CEG defs that omit gravity inherit a runtime default.
export const _DEFAULT_PARTICLE_GRAVITY = DEFAULT_GRAVITY;
