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
    Vector2,
    Vector3,
    Texture,
    RawTexture,
    Engine,
    type DepthRenderer,
} from '@babylonjs/core';

import { stampUrl } from '../config.js';
import type { ProjectileTextureResolver } from './projectile-texture-resolver.js';
import { registerCegParticleShader } from './shaders/ceg-particle.js';
import type { CegDefInfo } from './connection.js';
import { translateCegDef, parseAtlasDims, takeUnknownClasses } from './ceg-translator.js';

/// Per-particle gravity is in elmos/sec² (positive pulls down).
/// Sized to roughly match Spring's default gravity feel without
/// importing the actual sim constant — visual-only.
const DEFAULT_GRAVITY = 0;

/// Spring sim tick rate, used to convert SubCegSpawn `delayFrames`
/// → wall-clock seconds. Mirrored from `SIM_HZ` in ceg-translator.ts
/// (kept here so the runtime doesn't have to import a translator
/// constant just to compute a delay).
const SIM_HZ_RUNTIME = 30;

/// Soft-particle fade distance in elmos (T3). A particle fragment fades
/// to zero alpha as the opaque surface behind it comes within this range,
/// killing the hard quad-intersection seam. ~24 elmos reads cleanly at
/// RTS-camera height without visibly thinning mid-air puffs.
const SOFT_PARTICLE_RANGE = 24;

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

// Per-particle orientation modes live in a dependency-free leaf so the
// translator (and its unit tests) can share them without loading this
// module's Babylon graph. Imported for local use + re-exported to
// preserve this module's public API.
import { ORIENT_BILLBOARD, ORIENT_GROUND, ORIENT_STRETCH } from './ceg-orient.js';
export { ORIENT_BILLBOARD, ORIENT_GROUND, ORIENT_STRETCH };

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
    /// Orientation mode (Phase T) — one of ORIENT_BILLBOARD (default) /
    /// ORIENT_GROUND / ORIENT_STRETCH. Absent → billboard.
    orient?: number;
    /// Length-vs-width multiplier for ORIENT_STRETCH quads (the quad's
    /// velocity-axis extent = size * stretch; the cross-axis stays
    /// `size`). Ignored for the other modes. Default 1.
    stretch?: number;
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
    /// Per-instance BIRTH state (Phase T2 — GPU integration). Written
    /// once per particle at spawn, never touched again on the CPU; the
    /// vertex shader integrates age/position/colour/orientation each
    /// frame from these. Seven vec4 thin-instance attribute buffers,
    /// `capacity` slots each. A free slot has `iPosLife[w] <= 0`
    /// (lifetime ≤ 0) and is culled in the shader.
    ///   iPosLife  = (birthPos.xyz, lifetime)
    ///   iVelTime  = (birthVel.xyz, birthTime)
    ///   iSize     = (sizeStart, sizeEnd, gravity, stretch)
    ///   iRot      = (rotBase, rotSpeed, orient, animFps)
    ///   iAnim     = (animFrameStart, animFrameCount, _, _)
    ///   iColStart = colourStart RGBA
    ///   iColEnd   = colourEnd RGBA
    iPosLife: Float32Array;       // capacity * 4
    iVelTime: Float32Array;       // capacity * 4
    iSize: Float32Array;          // capacity * 4
    iRot: Float32Array;           // capacity * 4
    iAnim: Float32Array;          // capacity * 4
    iColStart: Float32Array;      // capacity * 4
    iColEnd: Float32Array;        // capacity * 4
    /// Ring-buffer write cursor. Wraps mod capacity — oldest live
    /// particle is clobbered when full (invisible at realistic sizes).
    nextSlot: number;
    /// High-water mark of written slots; `thinInstanceCount`. Grows to
    /// `capacity` once the ring has wrapped. Bounds the GPU upload +
    /// vertex work to slots that have ever been used.
    usedCount: number;
    /// Set when a spawn wrote a slot since the last upload; tick()
    /// re-uploads the instance buffers and clears it. Quiet frames (no
    /// spawns) upload nothing — the per-frame cost is uniforms only.
    dirty: boolean;
    /// GPU resources.
    mesh: Mesh;
    material: ShaderMaterial;
}

/// Default per-texture pool capacity. Phase 5a allocates pools lazily
/// per unique authored texture name, so sizing has to cover the worst
/// authored case across however many distinct sprites a game ships.
/// 2048 keeps a single short-lived spawn comfortably below ring-buffer
/// wraparound; the longest-lived puffs (smoke trails, multi-second
/// fireballs) lap once or twice per peak engagement at this size,
/// which is invisible at typical zoom.
const DEFAULT_CLASS_CAPACITY = 4096;

/// Hint table — per-texture-name capacity override for textures we
/// know up front will be hot (heavy smoke trails, ground flashes).
/// Unmapped names use DEFAULT_CLASS_CAPACITY. Sized empirically once
/// content profiling lands; today the defaults are fine for ZK.
const CAPACITY_HINTS: Record<string, number> = {
    smoketrail: 8192,  // smoke is long-lived; bigger ring buffer for headroom
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
    /// Runtime clock in seconds (= shader `uNow`). Accumulated in tick();
    /// particles stamp their birthTime from it so the GPU sees age 0 on
    /// the frame they spawn.
    private nowS = 0;
    /// Opaque-scene depth pre-pass for soft particles (T3). Lazily enabled
    /// in tick() once a camera exists; its depth map is bound to every
    /// class material. Phase D reuses the same pass.
    private depthRenderer: DepthRenderer | null = null;
    /// Reusable scratch for the per-frame uniform binds (no per-frame
    /// Vector allocation).
    private tmpCamPos = new Vector3();
    private tmpNearFar = new Vector2();
    private tmpScreen = new Vector2();
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
        // Z4/Z5 gate: report any CEG spawn class that has no client-side
        // translator. Zero entries here is the Phase Z4 exit condition.
        const unknown = takeUnknownClasses();
        if (unknown.size > 0) {
            const summary = [...unknown.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([cls, n]) => `${cls}×${n}`)
                .join(', ');
            console.warn(`[ceg] unknown spawn class(es) with no translator: ${summary}`);
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
                writeParticle(cls, slot, sp, x, y, z, dx, dy, dz, this.nowS);
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

        // Ground flashes use the generic flare bitmap. Spring's
        // CStandardGroundFlash is a textured ground-aligned quad — we
        // emit it with ORIENT_GROUND (Phase T) so it lies flat on the
        // terrain at the impact point instead of facing the camera.
        // (A flat quad doesn't conform to slopes the way the decal
        // projector would, but it reads correctly at RTS-camera range
        // and matches the scar pool's height-snap approach.)
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
                orient: ORIENT_GROUND,
            };
            const slot = allocateSlot(cls);
            // Small +y lift to avoid z-fighting with the terrain mesh.
            writeParticle(cls, slot, flash, x, y + 1, z, 0, 1, 0, this.nowS);
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
                orient: ORIENT_GROUND,
            };
            const slot = allocateSlot(cls);
            writeParticle(cls, slot, circle, x, y + 1, z, 0, 1, 0, this.nowS);
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

    /// Advance the runtime clock, drain pending sub-CEGs, and feed each
    /// class its per-frame uniforms. The particles themselves are
    /// integrated entirely on the GPU (Phase T2) — the CPU only re-uploads
    /// a class's birth-state buffers on frames where a spawn dirtied it.
    tick(dt: number): void {
        if (dt <= 0) return;

        this.nowS += dt;
        this.drainPending();

        const cam = this.scene.activeCamera;
        if (cam) this.tmpCamPos.copyFrom(cam.position);

        // Lazily stand up the opaque-scene depth pre-pass for soft
        // particles (T3) once a camera exists. storeNonLinearDepth=true →
        // the map holds hardware depth, which the fragment linearises.
        if (cam && !this.depthRenderer) {
            this.depthRenderer = this.scene.enableDepthRenderer(cam, /*storeNonLinearDepth*/ true, false);
        }
        const depthMap = this.depthRenderer ? this.depthRenderer.getDepthMap() : null;
        const engine = this.scene.getEngine();
        this.tmpScreen.set(engine.getRenderWidth(), engine.getRenderHeight());
        const near = cam ? cam.minZ : 1;
        const far = cam ? cam.maxZ : 10000;
        this.tmpNearFar.set(near, far);
        const softRange = depthMap ? SOFT_PARTICLE_RANGE : 0;

        for (const cls of this.classes.values()) {
            // Lazy texture bind: classes created before the resolver
            // settled stay un-textured until it does.
            if (this.resolverReady && !cls.textureBound) {
                this.tryBindTexture(cls);
            }

            // Re-upload birth-state buffers only when a spawn dirtied the
            // class since the last frame; quiet frames upload nothing.
            if (cls.dirty) {
                const n4 = cls.usedCount * 4;
                cls.mesh.thinInstanceSetBuffer('iPosLife',  cls.iPosLife.subarray(0, n4),  4, false);
                cls.mesh.thinInstanceSetBuffer('iVelTime',  cls.iVelTime.subarray(0, n4),  4, false);
                cls.mesh.thinInstanceSetBuffer('iSize',     cls.iSize.subarray(0, n4),     4, false);
                cls.mesh.thinInstanceSetBuffer('iRot',      cls.iRot.subarray(0, n4),      4, false);
                cls.mesh.thinInstanceSetBuffer('iAnim',     cls.iAnim.subarray(0, n4),     4, false);
                cls.mesh.thinInstanceSetBuffer('iColStart', cls.iColStart.subarray(0, n4), 4, false);
                cls.mesh.thinInstanceSetBuffer('iColEnd',   cls.iColEnd.subarray(0, n4),   4, false);
                cls.mesh.thinInstanceCount = cls.usedCount;
                cls.dirty = false;
            }

            // Per-frame uniforms: the clock + camera basis the vertex
            // shader integrates from, plus the soft-particle depth inputs.
            const mat = cls.material;
            mat.setFloat('uNow', this.nowS);
            mat.setVector3('camPos', this.tmpCamPos);
            mat.setFloat('softRange', softRange);
            if (depthMap) {
                mat.setTexture('depthTex', depthMap);
                mat.setVector2('camNearFar', this.tmpNearFar);
                mat.setVector2('screenSize', this.tmpScreen);
            }
        }
    }

    /// Total live particle count across all classes. Useful for the
    /// debug overlay; not part of the per-frame hot path.
    get liveCount(): number {
        let n = 0;
        const now = this.nowS;
        for (const cls of this.classes.values()) {
            for (let i = 0; i < cls.usedCount; i++) {
                const b = i * 4;
                const lifetime = cls.iPosLife[b + 3];
                if (lifetime <= 0) continue;
                const age = now - cls.iVelTime[b + 3];
                if (age >= 0 && age < lifetime) n++;
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
        if (this.depthRenderer) {
            this.scene.disableDepthRenderer();
            this.depthRenderer = null;
        }
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
                attributes: ['position', 'uv',
                    'iPosLife', 'iVelTime', 'iSize', 'iRot', 'iAnim',
                    'iColStart', 'iColEnd'],
                uniforms: ['world', 'viewProjection', 'atlasDimsInv',
                    'uNow', 'camPos', 'atlasCols', 'atlasRows',
                    'camNearFar', 'screenSize', 'softRange'],
                samplers: ['particleTex', 'depthTex'],
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
        // Per-class atlas dims: inverse for the fragment sub-rect scale,
        // and cols/rows for the vertex-shader frame→tile math. (1,1) for
        // non-atlas textures degrades the path to identity.
        mat.setVector2('atlasDimsInv', new Vector2(1 / atlas.cols, 1 / atlas.rows));
        mat.setFloat('atlasCols', atlas.cols);
        mat.setFloat('atlasRows', atlas.rows);
        // Soft-particle uniforms start disabled (softRange 0); tick()
        // feeds the real depth target + range once the camera exists.
        mat.setFloat('softRange', 0);
        mat.setTexture('depthTex', this.fallbackWhiteTex);

        const mesh = MeshBuilder.CreatePlane(`cegParticle_${name}`,
            { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.isVisible = true;
        mesh.thinInstanceEnablePicking = false;
        // The quad's world transform is computed per-vertex from the
        // birth attributes, so Babylon's unit-quad bounding box says
        // nothing about where particles actually are — skip frustum cull.
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.alphaIndex = 1000;

        const cls: ParticleClass = {
            textureName: name, capacity, textureBound: false,
            atlasCols: atlas.cols, atlasRows: atlas.rows,
            iPosLife:  new Float32Array(capacity * 4),
            iVelTime:  new Float32Array(capacity * 4),
            iSize:     new Float32Array(capacity * 4),
            iRot:      new Float32Array(capacity * 4),
            iAnim:     new Float32Array(capacity * 4),
            iColStart: new Float32Array(capacity * 4),
            iColEnd:   new Float32Array(capacity * 4),
            nextSlot: 0, usedCount: 0, dirty: false,
            mesh, material: mat,
        };
        this.classes.set(name, cls);

        // Static identity matrix buffer drives Babylon's thin-instance
        // draw path; written once, never per-frame. The shader applies it
        // as a no-op and computes the real transform from birth state.
        const identity = new Float32Array(capacity * 16);
        for (let i = 0; i < capacity; i++) {
            identity[i * 16 + 0] = 1;
            identity[i * 16 + 5] = 1;
            identity[i * 16 + 10] = 1;
            identity[i * 16 + 15] = 1;
        }
        mesh.thinInstanceSetBuffer('matrix', identity, 16, /*staticBuffer*/ true);
        // Register + seed the birth-state attribute buffers (zeroed →
        // every slot free → culled in the shader until spawns write them).
        mesh.thinInstanceSetBuffer('iPosLife',  cls.iPosLife,  4, false);
        mesh.thinInstanceSetBuffer('iVelTime',  cls.iVelTime,  4, false);
        mesh.thinInstanceSetBuffer('iSize',     cls.iSize,     4, false);
        mesh.thinInstanceSetBuffer('iRot',      cls.iRot,      4, false);
        mesh.thinInstanceSetBuffer('iAnim',     cls.iAnim,     4, false);
        mesh.thinInstanceSetBuffer('iColStart', cls.iColStart, 4, false);
        mesh.thinInstanceSetBuffer('iColEnd',   cls.iColEnd,   4, false);
        mesh.thinInstanceCount = 0;

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
    if (slot + 1 > cls.usedCount) cls.usedCount = slot + 1;
    cls.dirty = true;
    return slot;
}

/// Pack one particle's BIRTH state into the class's seven instance
/// buffers at `slot`. Stamped once; the vertex shader does everything
/// from here. `nowS` is the runtime clock (= shader `uNow`), so the
/// shader sees age 0 on the frame the particle is born.
function writeParticle(
    cls: ParticleClass, slot: number,
    sp: ParticleSpawn,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    nowS: number,
): void {
    const b = slot * 4;

    const r1 = (Math.random() - 0.5) * 2;
    const r2 = (Math.random() - 0.5) * 2;
    const r3 = (Math.random() - 0.5) * 2;
    const vx = sp.velocityBase[0] + r1 * sp.velocitySpread + dx * sp.velocityScale;
    const vy = sp.velocityBase[1] + r2 * sp.velocitySpread + dy * sp.velocityScale;
    const vz = sp.velocityBase[2] + r3 * sp.velocitySpread + dz * sp.velocityScale;

    const lifetime = sp.lifetimeMin
        + Math.random() * (sp.lifetimeMax - sp.lifetimeMin);

    // Atlas animation. Single-frame textures → fps 0 (static); undeclared
    // atlas textures default to one full cycle over the lifetime.
    const totalFrames = cls.atlasCols * cls.atlasRows;
    const animFrameStart = sp.animFrameStart ?? 0;
    const animFrameCount = sp.animFrameCount ?? totalFrames;
    let animFps: number;
    if (sp.animFps !== undefined) animFps = sp.animFps;
    else if (totalFrames > 1) animFps = lifetime > 0 ? totalFrames / lifetime : 0;
    else animFps = 0;

    const ce = sp.colorEnd ?? sp.colorStart;

    cls.iPosLife[b]     = x;
    cls.iPosLife[b + 1] = y;
    cls.iPosLife[b + 2] = z;
    cls.iPosLife[b + 3] = lifetime;

    cls.iVelTime[b]     = vx;
    cls.iVelTime[b + 1] = vy;
    cls.iVelTime[b + 2] = vz;
    cls.iVelTime[b + 3] = nowS;

    cls.iSize[b]     = sp.sizeStart;
    cls.iSize[b + 1] = sp.sizeEnd;
    cls.iSize[b + 2] = sp.gravity;
    cls.iSize[b + 3] = sp.stretch ?? 1;

    cls.iRot[b]     = Math.random() * Math.PI * 2;             // rotBase
    cls.iRot[b + 1] = (Math.random() - 0.5) * 2 * sp.rotationSpeedMax; // rotSpeed
    cls.iRot[b + 2] = sp.orient ?? ORIENT_BILLBOARD;
    cls.iRot[b + 3] = animFps;

    cls.iAnim[b]     = animFrameStart;
    cls.iAnim[b + 1] = animFrameCount;
    cls.iAnim[b + 2] = 0;
    cls.iAnim[b + 3] = 0;

    cls.iColStart[b]     = sp.colorStart[0];
    cls.iColStart[b + 1] = sp.colorStart[1];
    cls.iColStart[b + 2] = sp.colorStart[2];
    cls.iColStart[b + 3] = sp.colorStart[3];

    cls.iColEnd[b]     = ce[0];
    cls.iColEnd[b + 1] = ce[1];
    cls.iColEnd[b + 2] = ce[2];
    cls.iColEnd[b + 3] = ce[3];
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
