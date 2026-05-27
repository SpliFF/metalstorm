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
    Vector2,
    Vector3,
    Quaternion,
    Texture,
    RawTexture,
    Engine,
} from '@babylonjs/core';

import { stampUrl } from '../config.js';
import type { ProjectileTextureResolver } from './projectile-texture-resolver.js';
import { registerCegParticleShader } from './shaders/ceg-particle.js';
import type { CegDefInfo } from './connection.js';
import { translateCegDef, parseAtlasDims } from './ceg-translator.js';

/// Per-particle gravity is in elmos/sec² (positive pulls down).
/// Sized to roughly match Spring's default gravity feel without
/// importing the actual sim constant — visual-only.
const DEFAULT_GRAVITY = 0;

/// Spring sim tick rate, used to convert SubCegSpawn `delayFrames`
/// → wall-clock seconds. Mirrored from `SIM_HZ` in ceg-translator.ts
/// (kept here so the runtime doesn't have to import a translator
/// constant just to compute a delay).
const SIM_HZ_RUNTIME = 30;

/// Name of the built-in fallback effect that fires when a CEG has
/// `useDefaultExplosions = true`. Mirrors Spring's
/// CStdExplosionGenerator chain — a ground flash + heat cloud is
/// enough to read as "there was an explosion here" even when the
/// authored CEG is minimal (or contains only quiet sub-effects). The
/// effect is registered as a built-in in BUILTIN_EFFECTS below; game
/// authors can override by registering their own EffectDef under this
/// name via ingestCegDefs (it'll replace the built-in).
const DEFAULT_EXPLOSION_NAME = '__default_explosion';

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
    /// Logical texture name from the CEG's `texture = "..."` property.
    /// One ParticleClass + thin-instance batch is allocated lazily per
    /// unique name, then shared by every spawn referencing it. The
    /// runtime asks `ProjectileTextureResolver` for the URL. Names with
    /// an `_NxM` suffix (e.g. `FireBall02_8x8`) are parsed as sprite
    /// atlases — see `parseAtlasDims` / Phase 5b.
    ///
    /// Common fallback names for CEGs that didn't author a texture:
    ///   - `'flare'`     — generic glow (the catch-all default)
    ///   - `'smoketrail'`— grey smoke puff (used by smoke/heatcloud classes)
    /// These resolve against the engine's bitmaps manifest.
    texture: string;
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
    /// RGBA tint at age=0. Phase 3 colour ramp: lerped to `colorEnd`
    /// across the particle's lifetime. Alpha is *also* multiplied by
    /// the lifetime fade so even authored "stay opaque" ramps fade
    /// out at end-of-life (matches Spring's tail behaviour without
    /// requiring a third keyframe).
    colorStart: RGBA;
    /// Optional RGBA tint at age=lifetime. When omitted the particle
    /// holds `colorStart` and only fades through the alpha curve.
    /// Translator populates this from the second keyframe of Spring's
    /// `colormap = "R G B A  R G B A ..."` property; intermediates
    /// are dropped (Phase 3 ships 2 stops; 4-keyframe extension can
    /// land later if ZK content needs the resolution).
    colorEnd?: RGBA;
    /// Max rotation rate in rad/sec; per-particle is uniform random
    /// in [-this, +this] so a smoke cloud has visually distinct puffs.
    rotationSpeedMax: number;
    /// Visibility flags from the streamed `CegSpawnInfo.flags`.
    /// 0 = always emit; otherwise the spawn fires only when the
    /// caller's SpawnContext.flags has at least one common bit set.
    /// Translator copies the raw byte; the runtime gates dispatch.
    flags?: number;
    /// Atlas animation override (Phase 5b). When the authored texture
    /// name carries an `_NxM` suffix the runtime derives `cols`/`rows`
    /// from the filename, with `frameCount = cols * rows` and a default
    /// `fps` that fits one full cycle into the particle's lifetime.
    /// CEGs may override the timing via the `animparams = "start end fps"`
    /// property; when present, those values land here. Absent →
    /// runtime uses suffix-derived defaults; non-atlas textures stay at
    /// (1, 1, 0) and the shader path degrades to a single still frame.
    animFrameStart?: number;
    animFrameCount?: number;
    animFps?: number;
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

/// Visibility flag bits — mirror of `CEG_FLAG_*` in `rts/Server/CegLoader.h`.
/// Each `CegSpawnInfo` carries these as a packed byte; the runtime
/// matches against the impact context to skip spawns the author has
/// gated out (e.g. an "underwater bubble burst" entry only fires
/// when the impact happened below the water surface).
export const CEG_FLAG_GROUND     = 1 << 0;
export const CEG_FLAG_AIR        = 1 << 1;
export const CEG_FLAG_WATER      = 1 << 2;
export const CEG_FLAG_UNIT       = 1 << 3;
export const CEG_FLAG_UNDERWATER = 1 << 4;

/// Spawn context bits supplied by the caller — what kind of surface
/// the effect is firing on. `unit` is set when the impact was on a
/// unit body; the others are derived from position vs. water level
/// vs. terrain height. Callers that don't know (muzzle flash, in-
/// flight trail) pass `0`, which the runtime treats as "match all"
/// so unrestricted spawns still fire.
export interface SpawnContext {
    flags: number;
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
    /// Visibility flags — same semantics as ParticleSpawn.flags.
    flags?: number;
}

/// Resolved `CStandardGroundFlash` parameters, converted from sim
/// frames to wall-clock seconds at translate time. The runtime
/// fires one of these on every CEG `spawn()` whose EffectDef
/// carries the field — Spring's behaviour is to render the ground
/// flash unconditionally alongside the regular spawns, not as part
/// of the spawn list.
export interface GroundFlash {
    lifetimeS: number;     // ttl / SIM_HZ
    flashSize: number;
    flashAlpha: number;
    circleAlpha: number;
    circleGrowth: number;  // world-units per second (already converted)
    colorR: number;
    colorG: number;
    colorB: number;
    flags: number;
}

/// One named effect — what gets fired by `spawn(name, ...)`.
export interface EffectDef {
    name: string;
    spawns: Array<ParticleSpawn | SubCegSpawn>;
    /// Mirror of the streamed `useDefaultExplosions` flag. When true,
    /// the runtime appends a built-in fallback set (ground flash +
    /// heat cloud) after the CEG's own spawns. Spring's behaviour
    /// chains `CStdExplosionGenerator::Explosion` here; on a headless
    /// authoritative server that path is a no-op, so the client has
    /// to synthesise the visuals.
    useDefaultExplosions?: boolean;
    /// Top-level `groundflash` subtable (NOT a spawn entry). Spring's
    /// CCustomExplosionGenerator::Explosion renders this on every
    /// fire. Absent when the CEG didn't author one.
    groundFlash?: GroundFlash;
}

/// Per-class GPU + CPU state. Capacity is fixed at construction so
/// the pools sit in steady-state memory rather than growing under
/// load and triggering GC pressure. Texture URL is resolved lazily —
/// the binding may be null when the class is first materialised but
/// gets attached the first time the resolver returns a real URL.
///
/// One class is materialised per unique authored texture name (Phase 5a).
/// Atlas animation parameters (cols/rows) are decoded once at class
/// creation from the texture name's `_NxM` suffix; per-particle anim
/// state (current frame index) is recomputed each tick in buildBuffers.
interface ParticleClass {
    /// Lowercased authored texture name (also the resolver key and the
    /// `classes` map key). May refer to a sprite atlas — see `atlasCols`.
    textureName: string;
    capacity: number;
    /// True once the resolver has handed back a real URL and we've
    /// bound the Texture; further resolves are skipped.
    textureBound: boolean;
    /// Sprite-atlas dimensions parsed from the texture name's `_NxM`
    /// suffix. (1, 1) for non-atlas textures — the shader's sub-rect
    /// sampling path degrades to identity in that case.
    atlasCols: number;
    atlasRows: number;
    /// SoA particle data. Inactive slots have `lifetime[i] <= 0`.
    pos: Float32Array;            // capacity * 3
    vel: Float32Array;            // capacity * 3
    age: Float32Array;            // capacity
    lifetime: Float32Array;       // capacity, <=0 → free slot
    sizeStart: Float32Array;      // capacity
    sizeEnd: Float32Array;        // capacity
    color: Float32Array;          // capacity * 4 (initial RGBA)
    /// Per-particle end-of-life RGBA tint for the colour ramp. When
    /// the spawn carries no `colorEnd` we copy `color` verbatim into
    /// this slot so the per-frame lerp produces identity (and we
    /// avoid branching in the hot per-particle buffer rebuild).
    colorEnd: Float32Array;       // capacity * 4
    gravity: Float32Array;        // capacity
    rotation: Float32Array;       // capacity (rad)
    rotationSpeed: Float32Array;  // capacity (rad/sec)
    /// Per-particle atlas-animation parameters. `animFps[i] == 0`
    /// means "single frame" — the per-frame frameIdx computation is
    /// skipped and the particle samples `animFrameStart[i]` once.
    animFrameStart: Float32Array; // capacity (sub-rect index)
    animFrameCount: Float32Array; // capacity (frames to cycle through)
    animFps: Float32Array;        // capacity (cycle rate, 0 = static)
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
    /// Per-instance sub-rect offset for atlas sampling. vec2 packing
    /// (col_norm, row_norm) in [0, 1) — multiplied with `atlasDimsInv`
    /// in the shader before adding to the unit-quad UV. Buffer is
    /// allocated for every class even when the texture is single-
    /// frame so the shader doesn't have to branch on atlas presence —
    /// the default zero vec2 gives the top-left tile, which for a
    /// 1×1 atlas covers the whole texture.
    frameOffsetBuffer: Float32Array;
}

/// Default per-texture pool capacity. Phase 5a allocates pools lazily
/// per unique authored texture name, so sizing has to cover the worst
/// authored case across however many distinct sprites a game ships.
/// 2048 keeps a single short-lived spawn comfortably below ring-buffer
/// wraparound; the longest-lived puffs (smoke trails, multi-second
/// fireballs) lap once or twice per peak engagement at this size,
/// which is invisible at typical zoom.
const DEFAULT_CLASS_CAPACITY = 2048;

/// Hint table — per-texture-name capacity override for textures we
/// know up front will be hot (heavy smoke trails, ground flashes).
/// Unmapped names use DEFAULT_CLASS_CAPACITY. Sized empirically once
/// content profiling lands; today the defaults are fine for ZK.
const CAPACITY_HINTS: Record<string, number> = {
    smoketrail: 4096,  // smoke is long-lived; bigger ring buffer for headroom
};

/// Pre-seeded fallback textures that the constructor materialises
/// up front so the first spawn() doesn't hitch on mesh / shader
/// creation. Other textures get pools allocated on first reference.
/// Names match the engine's resources.lua `projectiletextures` table
/// (engine bitmaps manifest); both resolve to .ktx2 via the resolver.
const SEED_TEXTURES = ['flare', 'smoketrail'];

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
    /// Visibility-context flags inherited from the original parent
    /// spawn(). Sub-CEGs see the same surface context so an
    /// "underwater" gate at the leaf level still respects whether the
    /// chain started above or below the water surface.
    contextFlags: number;
}

export class CegRuntime {
    private scene: Scene;
    private resolver: ProjectileTextureResolver | null = null;
    private classes = new Map<string, ParticleClass>();
    private effects = new Map<string, EffectDef>();
    /// Shared 1×1 RGBA(255,255,255,255) sampler. Bound to every class's
    /// `particleTex` slot at creation time so untextured classes render
    /// as a clean tinted billboard instead of opaque black. WebGL's
    /// default for an unbound sampler is (0,0,0,1) — multiplied by
    /// per-instance tint, that yields a black hole under premul-additive
    /// blending. The shared white texture makes the fragment shader's
    /// `t.rgb * vTint.rgb` path collapse to a pure tint while we wait
    /// for the resolver to settle. `tryBindTexture` later overwrites
    /// the slot with the real texture once a URL is available.
    private fallbackWhiteTex: RawTexture;
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

        this.fallbackWhiteTex = new RawTexture(
            new Uint8Array([255, 255, 255, 255]),
            1, 1, Engine.TEXTUREFORMAT_RGBA, scene,
            /*generateMipMaps*/ false, /*invertY*/ false,
            Texture.NEAREST_SAMPLINGMODE,
        );
        this.fallbackWhiteTex.name = 'ceg-fallback-white';
        this.fallbackWhiteTex.hasAlpha = true;

        // Materialise the canonical fallback classes up front so the
        // first spawn() (typically a CEG that authored no texture →
        // falls back to 'flare') doesn't hitch on mesh + shader
        // compile. Real textures get pools allocated on first
        // reference via ensureClass(). Texture binding for these
        // pre-seeded entries happens later once the resolver settles.
        for (const seedName of SEED_TEXTURES) {
            this.ensureClass(seedName);
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
        contextFlags: number = 0,
    ): void {
        if (!name) return;
        // CEG table keys are lowercased on the server; weapon-def
        // `cegTag` / `explosionGenerator` strings are normalised to
        // match in the same bake but mixed-case authors can still slip
        // through Lua-side callers. Lowercasing here keeps both paths
        // working without a second canonicalisation step in callers.
        // Spring's documented sentinel `"none"` skips dispatch — it's
        // common on weapon defs that opt out of CEGs explicitly.
        const key = name.toLowerCase();
        if (key === 'none') return;
        this.spawnInternal(key, x, y, z, dx, dy, dz,
            damage, contextFlags, /*depth*/ 0);
    }

    /// Internal recursive form. `depth` increments on every chained
    /// dispatch from a PendingSpawn drain so MAX_SUBCEG_DEPTH can
    /// abort A→B→A cycles without scanning the whole pending queue.
    /// Public spawn() always enters at depth 0.
    private spawnInternal(
        name: string,
        x: number, y: number, z: number,
        dx: number, dy: number, dz: number,
        damage: number, contextFlags: number, depth: number,
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

        // Phase 7: append the default-explosion visuals when the CEG
        // opted in. We dispatch the built-in effect first so the
        // authored CEG's spawns layer on top (matching Spring's
        // chain-order: standard generator runs *before* the custom
        // particles in execution order, but Spring draws back-to-
        // front so the custom ends up on top — same net effect).
        // The DEFAULT_EXPLOSION_NAME guard breaks the recursion: the
        // built-in default itself never opts into more defaults, but
        // an author-supplied override might forget to clear the flag.
        if (def.useDefaultExplosions && name !== DEFAULT_EXPLOSION_NAME) {
            this.spawnInternal(DEFAULT_EXPLOSION_NAME,
                x, y, z, dx, dy, dz,
                damage, contextFlags, depth + 1);
        }

        // Top-level groundflash subtable — Spring renders this on
        // every CEG fire (not as a spawn entry). Translate into a
        // pair of slot writes: an outer flash quad sized to flashSize
        // and an inner growing disc keyed off circleAlpha/Growth.
        // Both go into the flare pool — they're billboarded ground-
        // aligned in the existing shader, which reads close enough
        // to Spring's `CStandardGroundFlash` quad at typical zoom.
        // Only emitted at depth 0 so recursive sub-CEG chains don't
        // stack a fresh flash on top of every chained explosion.
        if (def.groundFlash && depth === 0) {
            this.emitGroundFlash(def.groundFlash, x, y, z, contextFlags);
        }

        for (const sp of def.spawns) {
            // Visibility gate. flags === 0 means "always emit"
            // (CEG author left every visibility bool false, which the
            // server packed as zero). When set, at least one bit must
            // match the caller's context — e.g. an underwater-only
            // bubble spawn drops on a dry ground impact.
            if (sp.flags && contextFlags && (sp.flags & contextFlags) === 0) {
                continue;
            }
            if (sp.kind === 'subceg') {
                this.queueSubCeg(sp, x, y, z, dx, dy, dz,
                    damage, contextFlags, depth, nowMs);
                continue;
            }
            // Lazy class creation keyed by authored texture name —
            // first spawn referencing a new texture allocates its
            // pool, subsequent spawns share the thin-instance batch.
            const cls = this.ensureClass(sp.texture);
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

    /// Emit the outer flash + inner growing disc for a CEG's
    /// `groundflash` subtable. Both go into the flare pool; the
    /// `gf.flags` visibility byte is honoured against the caller's
    /// context so an underwater-only groundflash drops cleanly.
    private emitGroundFlash(
        gf: GroundFlash,
        x: number, y: number, z: number,
        contextFlags: number,
    ): void {
        if (gf.flags && contextFlags && (gf.flags & contextFlags) === 0) return;

        // Ground flashes use the generic flare bitmap — Spring's
        // CStandardGroundFlash is a textured ground-aligned quad we
        // approximate as a billboarded flare at the impact point.
        const cls = this.ensureClass('flare');
        if (!cls) return;

        // Outer flash quad — short bright halo. flashAlpha == 0 means
        // the CEG opted out of the outer flash; skip emission in that
        // case rather than allocating a 0-alpha particle.
        if (gf.flashAlpha > 0 && gf.flashSize > 0) {
            const flash: ParticleSpawn = {
                texture: 'flare',
                count: 1,
                lifetimeMin: gf.lifetimeS,
                lifetimeMax: gf.lifetimeS,
                velocityBase: [0, 0, 0],
                velocitySpread: 0,
                velocityScale: 0,
                gravity: 0,
                sizeStart: gf.flashSize,
                sizeEnd: gf.flashSize * 0.4,
                colorStart: [gf.colorR, gf.colorG, gf.colorB, gf.flashAlpha],
                colorEnd:   [gf.colorR, gf.colorG, gf.colorB, 0],
                rotationSpeedMax: 0,
            };
            const slot = allocateSlot(cls);
            writeParticle(cls, slot, flash, x, y + 0.5, z, 0, 1, 0);
        }

        // Inner circle — grows over the lifetime. circleAlpha == 0
        // means no inner disc was authored.
        if (gf.circleAlpha > 0) {
            const start = Math.max(gf.flashSize * 0.25, 1);
            const end = Math.max(start + gf.circleGrowth * gf.lifetimeS, start);
            const circle: ParticleSpawn = {
                texture: 'flare',
                count: 1,
                lifetimeMin: gf.lifetimeS,
                lifetimeMax: gf.lifetimeS,
                velocityBase: [0, 0, 0],
                velocitySpread: 0,
                velocityScale: 0,
                gravity: 0,
                sizeStart: start,
                sizeEnd: end,
                colorStart: [gf.colorR, gf.colorG, gf.colorB, gf.circleAlpha],
                colorEnd:   [gf.colorR, gf.colorG, gf.colorB, 0],
                rotationSpeedMax: 0,
            };
            const slot = allocateSlot(cls);
            writeParticle(cls, slot, circle, x, y + 0.3, z, 0, 1, 0);
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
        damage: number, contextFlags: number,
        parentDepth: number, nowMs: number,
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
                contextFlags,
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
        this.fallbackWhiteTex.dispose();
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
                    p.damage, p.contextFlags, p.depth);
            } else {
                if (writeIdx !== i) pending[writeIdx] = p;
                writeIdx++;
            }
        }
        pending.length = writeIdx;
    }

    /// Lazily materialise a particle class for `textureName`. First
    /// reference to a name allocates the mesh + material + SoA pool;
    /// subsequent references return the cached entry. Names are
    /// lowercased before keying so case differences between the CEG
    /// author's `texture = "FireBall02_8x8"` and any other reference
    /// to the same bitmap end up in the same batch.
    ///
    /// Atlas dims are decoded from the name's `_NxM` suffix at class
    /// creation; the same dims are pushed to the shader as a
    /// `atlasDimsInv` uniform so the fragment shader can compute the
    /// sub-rect UV without per-instance scale data.
    ///
    /// Returns null only for empty / falsy names — every other name
    /// gets a pool, even if the resolver can't find a URL for it
    /// (the class renders untextured / tinted-only until the resolver
    /// either resolves or the user gives up).
    private ensureClass(rawName: string): ParticleClass | null {
        if (!rawName) return null;
        const name = rawName.toLowerCase();
        const existing = this.classes.get(name);
        if (existing) return existing;

        const capacity = CAPACITY_HINTS[name] ?? DEFAULT_CLASS_CAPACITY;
        const atlas = parseAtlasDims(name) ?? { cols: 1, rows: 1 };

        const mat = new ShaderMaterial(`cegParticleMat_${name}`, this.scene,
            'cegParticle', {
                attributes: ['position', 'uv', 'tint', 'frameOffset'],
                uniforms: ['world', 'viewProjection', 'atlasDimsInv'],
                samplers: ['particleTex'],
                defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
                // Without this `alphaMode = 7` below is silently ignored —
                // mesh renders in the opaque pass with blending off and
                // the premul output `vec4(rgb*a, a)` writes dark squares.
                // See feedback_scenario_iteration.md / project_trail_alpha_blending.md.
                needAlphaBlending: true,
            });
        // Premultiplied additive — same convention as trail/beam.
        mat.alphaMode = 7;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        // Per-class atlas dims as inverse so the fragment shader can
        // multiply rather than divide. (1/1, 1/1) for non-atlas
        // textures degrades the sub-rect path to identity sampling.
        mat.setVector2('atlasDimsInv',
            new Vector2(1 / atlas.cols, 1 / atlas.rows));

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
        // Per-instance tint (R, G, B, A) + sub-rect offset (col_norm,
        // row_norm). Registered up front so the first buildBuffers
        // can populate the buffers without re-registering.
        mesh.thinInstanceRegisterAttribute('tint', 4);
        mesh.thinInstanceRegisterAttribute('frameOffset', 2);

        const cls: ParticleClass = {
            textureName: name, capacity, textureBound: false,
            atlasCols: atlas.cols, atlasRows: atlas.rows,
            pos: new Float32Array(capacity * 3),
            vel: new Float32Array(capacity * 3),
            age: new Float32Array(capacity),
            lifetime: new Float32Array(capacity),
            sizeStart: new Float32Array(capacity),
            sizeEnd: new Float32Array(capacity),
            color: new Float32Array(capacity * 4),
            colorEnd: new Float32Array(capacity * 4),
            gravity: new Float32Array(capacity),
            rotation: new Float32Array(capacity),
            rotationSpeed: new Float32Array(capacity),
            animFrameStart: new Float32Array(capacity),
            animFrameCount: new Float32Array(capacity),
            animFps: new Float32Array(capacity),
            nextSlot: 0,
            mesh, material: mat,
            // Sized to capacity so a worst-case full pool never has
            // to reallocate. Each entry is mat4 (16 floats) + RGBA
            // tint (4 floats) + frameOffset (2 floats) ≈ 22 floats
            // per slot. For a 4096-entry pool that's ~360 KB per
            // class; well below GC pressure thresholds even with
            // dozens of unique textures.
            matrixBuffer: new Float32Array(capacity * 16),
            tintBuffer: new Float32Array(capacity * 4),
            frameOffsetBuffer: new Float32Array(capacity * 2),
        };
        this.classes.set(name, cls);

        // Bind the shared 1×1 white fallback so the shader samples
        // (1,1,1,1) for unresolved classes — the per-instance tint
        // then governs the visible colour. Without this, WebGL hands
        // back (0,0,0,1) from the unbound sampler and the premul-
        // additive blend produces opaque black quads.
        mat.setTexture('particleTex', this.fallbackWhiteTex);

        // If the resolver is already settled, swap the real texture in
        // now — otherwise the lazy bind in tick() will pick it up once
        // resolverReady flips. Pre-bind avoids one frame of untextured
        // rendering on first reference to a new texture mid-game.
        if (this.resolverReady) {
            this.tryBindTexture(cls);
        }
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
    // Spawn carries an end-of-life RGBA when the source CEG had a
    // multi-keyframe colormap; otherwise the per-frame lerp degrades
    // to identity by copying start into end.
    const ce = sp.colorEnd ?? sp.colorStart;
    cls.colorEnd[c4 + 0] = ce[0];
    cls.colorEnd[c4 + 1] = ce[1];
    cls.colorEnd[c4 + 2] = ce[2];
    cls.colorEnd[c4 + 3] = ce[3];

    cls.gravity[slot] = sp.gravity;
    cls.rotation[slot] = Math.random() * Math.PI * 2;
    cls.rotationSpeed[slot] = (Math.random() - 0.5) * 2 * sp.rotationSpeedMax;

    // Atlas animation per-particle state. The translator stamps
    // animFrameCount / animFps on spawns whose texture name carries a
    // `_NxM` suffix (or that authored explicit `animparams`). When the
    // spawn is silent we fall back to the class's natural frame count:
    // single-frame textures stay at (start=0, count=1, fps=0) → static
    // sample of the top-left tile, while undeclared atlas textures
    // animate exactly once over the particle's lifetime.
    const totalFrames = cls.atlasCols * cls.atlasRows;
    cls.animFrameStart[slot] = sp.animFrameStart ?? 0;
    if (sp.animFrameCount !== undefined) {
        cls.animFrameCount[slot] = sp.animFrameCount;
    } else {
        cls.animFrameCount[slot] = totalFrames;
    }
    if (sp.animFps !== undefined) {
        cls.animFps[slot] = sp.animFps;
    } else if (totalFrames > 1) {
        // No authored animparams: default to one full cycle over the
        // particle's actual lifetime. Sampled here rather than in
        // buildBuffers so the rate stays stable across the particle's
        // life even if dt jitters between frames.
        const lifeS = cls.lifetime[slot];
        cls.animFps[slot] = lifeS > 0 ? totalFrames / lifeS : 0;
    } else {
        cls.animFps[slot] = 0;
    }
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
    const frameOffsets = cls.frameOffsetBuffer;

    const pos = cls.pos;
    const age = cls.age;
    const sizeStart = cls.sizeStart, sizeEnd = cls.sizeEnd;
    const color = cls.color;
    const colorEnd = cls.colorEnd;
    const rot = cls.rotation;
    const animFps = cls.animFps;
    const animFrameStart = cls.animFrameStart;
    const animFrameCount = cls.animFrameCount;
    const atlasCols = cls.atlasCols;
    const atlasRows = cls.atlasRows;

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

        // Per-frame colour-ramp lerp (Phase 3). Spawns without a
        // colorEnd see the SoA slot pre-filled with colorStart, so
        // this lerp degrades to identity at zero branch cost. Alpha
        // is multiplied by the lifetime fade so authored "constant
        // alpha" ramps still tail off cleanly.
        const c4 = i * 4;
        const ds = dst * 4;
        const r0 = color[c4 + 0], r1 = colorEnd[c4 + 0];
        const g0 = color[c4 + 1], g1 = colorEnd[c4 + 1];
        const b0 = color[c4 + 2], b1 = colorEnd[c4 + 2];
        const a0 = color[c4 + 3], a1 = colorEnd[c4 + 3];
        tints[ds + 0] = r0 + (r1 - r0) * t;
        tints[ds + 1] = g0 + (g1 - g0) * t;
        tints[ds + 2] = b0 + (b1 - b0) * t;
        tints[ds + 3] = (a0 + (a1 - a0) * t) * fade;

        // Atlas sub-rect offset (Phase 5b). For single-frame textures
        // animFps[i] is 0 and the offset stays at (0, 0) → top-left
        // tile, which for a 1×1 atlas is the whole texture. For
        // multi-frame atlas textures we step through frames at the
        // authored (or lifetime-derived) rate, wrapping mod count so
        // long-lived particles cycle.
        const fos = dst * 2;
        const fps = animFps[i];
        if (fps > 0) {
            const frameIdx = (Math.floor(age[i] * fps) % animFrameCount[i])
                + animFrameStart[i];
            const col = frameIdx % atlasCols;
            const row = Math.floor(frameIdx / atlasCols) % atlasRows;
            frameOffsets[fos + 0] = col / atlasCols;
            frameOffsets[fos + 1] = row / atlasRows;
        } else {
            // Static texture (or 1×1 atlas): hold on the start frame.
            // For non-atlas textures animFrameStart is 0 so we end up
            // sampling the whole quad. For 1×1 atlases this is the
            // identity path; for genuine atlases with animFps=0 it
            // freezes on whatever frame the author specified.
            const frameIdx = animFrameStart[i];
            const col = frameIdx % atlasCols;
            const row = Math.floor(frameIdx / atlasCols) % atlasRows;
            frameOffsets[fos + 0] = col / atlasCols;
            frameOffsets[fos + 1] = row / atlasRows;
        }
        dst++;
    }

    cls.mesh.isVisible = true;
    cls.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
    cls.mesh.thinInstanceSetBuffer('tint', tints, 4, false);
    cls.mesh.thinInstanceSetBuffer('frameOffset', frameOffsets, 2, false);
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
// Built-in CEG fallbacks. Phase 8 cleanup pared this down to the two
// effects the runtime *itself* references unconditionally:
//
//  - `__default_explosion` — fired by spawnInternal whenever a CEG opts
//    into `useDefaultExplosions`, and by weapon-fx-dispatch when a
//    weapondef doesn't author an `explosionGenerator`. Without it,
//    terrain/feature impacts on un-authored weapons would silently
//    no-op. Spring's CStdExplosionGenerator equivalent — a flare flash
//    + a heat cloud puff sized for a generic mid-damage hit.
//  - `impact_shield` — fired by combat-fx and projectile-renderer
//    whenever an Impact event reports a shield deflection. Always-on
//    bypass of the weapondef dispatch.
//
// Every other named effect (muzzleflash_*, impact_*) now comes from
// the server-streamed CEG library (ingestCegDefs). The earlier hand-
// ported placeholder library lived here during Phase 5b but was
// duplicate work — game authors override via streamed defs anyway.
//
// Sizes are in elmos (Spring's world unit). Velocities in elmos/sec
// (different from the per-frame numbers the projectile renderer
// converts at — these effects don't go through the same pipe).
// Colours are RGBA in [0,1]; alpha at age 0, fades to 0 at lifetime.

const BUILTIN_EFFECTS: EffectDef[] = [
    {
        name: DEFAULT_EXPLOSION_NAME,
        spawns: [
            {
                texture: 'flare', count: 1,
                lifetimeMin: 0.4, lifetimeMax: 0.6,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 10, sizeEnd: 22,
                colorStart: [1.0, 0.7, 0.3, 0.9],
                colorEnd:   [0.5, 0.2, 0.05, 0.0],
                rotationSpeedMax: 0,
            },
            {
                texture: 'smoketrail', count: 2,
                lifetimeMin: 0.8, lifetimeMax: 1.4,
                velocityBase: [0, 5, 0], velocitySpread: 3, velocityScale: 0,
                gravity: -3,
                sizeStart: 6, sizeEnd: 18,
                colorStart: [0.45, 0.4, 0.35, 0.55],
                colorEnd:   [0.25, 0.2, 0.18, 0.0],
                rotationSpeedMax: 0.8,
            },
        ],
    },
    // Shield deflection — short blue flare ring (no sparks/smoke).
    {
        name: 'impact_shield',
        spawns: [
            {
                texture: 'flare', count: 1,
                lifetimeMin: 0.25, lifetimeMax: 0.35,
                velocityBase: [0, 0, 0], velocitySpread: 0, velocityScale: 0,
                gravity: 0,
                sizeStart: 14, sizeEnd: 22,
                colorStart: [0.4, 0.7, 1.0, 0.9],
                rotationSpeedMax: 0,
            },
        ],
    },
];

// Default-gravity export so tests / future callers don't have to
// hard-code the literal. Currently zero — gravity is per-spawn-defined
// in the library above; this constant is reserved for future use when
// CEG defs that omit gravity inherit a runtime default.
export const _DEFAULT_PARTICLE_GRAVITY = DEFAULT_GRAVITY;
