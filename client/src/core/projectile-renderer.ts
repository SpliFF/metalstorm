/**
 * ProjectileRenderer — event-driven projectile visualisation.
 *
 * The server no longer streams projectile positions every tick. Instead it
 * emits three lifecycle events:
 *   - Fired:      proj_id, weapon_def_id, pos, vel, target_pos, gravity, ttl, hitscan
 *   - Impact:     proj_id, pos, impact_kind, target_id
 *   - Trajectory: proj_id, pos, vel  (bounce / steered)
 *
 * The client tracks each live projectile in a `Map<projId, LiveProjectile>`
 * and integrates pos += vel*dt; vel.y -= gravity*dt every render tick. On
 * impact the entry is removed (the explosion VFX is fired by combat-fx /
 * combat events). On trajectory it overwrites pos+vel.
 *
 * Hit-scan weapons (lasers, lightning) live for one tick only — we draw a
 * line from launch pos → target_pos and discard on the next frame. Beam
 * weapons follow the same path but with a longer tail.
 *
 * Rendering uses thin instances per weapon-def so a hundred bullets in
 * flight cost one draw call per weapon type. Each Live entry contributes
 * one instance matrix; per render tick we rebuild the per-def matrix
 * arrays and push to thinInstanceSetBuffer.
 */

import {
    Scene,
    MeshBuilder,
    Mesh,
    LinesMesh,
    StandardMaterial,
    ShaderMaterial,
    Color3,
    Color4,
    Matrix,
    Vector3,
    Quaternion,
    SceneLoader,
    Texture,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';

import type { WeaponDefInfo } from './connection.js';
import { stampUrl } from '../config.js';
import type { ProjectileTextureResolver } from './projectile-texture-resolver.js';
import type { CegRuntime } from './ceg-runtime.js';
import type { FxLightPool } from './fx-light-pool.js';
import type { DistortionRenderer } from './distortion-renderer.js';
import { type MuzzleFlareRenderer, muzzleFlashColor } from './muzzle-flare-renderer.js';
import {
    ProjectileType,
    effectForFire,
    effectForImpact,
    impactContextFlags,
} from './weapon-fx-dispatch.js';
import { registerProjectileBeamShader } from './shaders/projectile-beam.js';
import { registerProjectileLaserShader } from './shaders/projectile-laser.js';
import {
    type MissileTrailState,
    type MissileTrailVisual,
    buildMissileTrailVisual,
    createMissileTrailState,
    disposeMissileTrailVisual,
    flushMissileTrailVisual,
    isTrailFullyFaded,
    recordTrailPuff,
    resetMissileTrailState,
} from './projectile-trails.js';
import {
    type CosmeticFlight,
    type CosmeticTracking,
    TRACK_VEL_SAMPLE_LAG,
    applyCosmeticTracking,
    beginCosmeticTracking,
    evalCosmeticFlight,
    solveCosmeticFlight,
} from './cosmetic-flight.js';
import {
    KEYFRAME_LAUNCH,
    type Keyframe,
    type KeyframeTrack,
    createKeyframeTrack,
    evalKeyframeTrack,
    keyframeResidual,
    pruneKeyframes,
    pushKeyframe,
} from './keyframe-flight.js';

/** Default colors per projectile type when the weapon def doesn't
 *  specify one. Keyed by `ProjectileType` (Recoil's
 *  `WEAPON_*_PROJECTILE` bitmask). */
const DEFAULT_COLORS: Record<number, [number, number, number]> = {
    [ProjectileType.Explosive]:      [1.0, 0.8, 0.2],
    [ProjectileType.Emg]:            [1.0, 0.9, 0.3],
    [ProjectileType.Laser]:          [1.0, 0.2, 0.2],
    [ProjectileType.BeamLaser]:      [0.2, 1.0, 0.2],
    [ProjectileType.LargeBeamLaser]: [0.4, 1.0, 0.4],
    [ProjectileType.Missile]:        [0.8, 0.8, 0.8],
    [ProjectileType.Starburst]:      [0.9, 0.9, 0.9],
    [ProjectileType.Torpedo]:        [0.7, 0.8, 0.9],
    [ProjectileType.Lightning]:      [0.5, 0.5, 1.0],
    [ProjectileType.Flame]:          [1.0, 0.4, 0.0],
    [ProjectileType.Fireball]:       [1.0, 0.5, 0.1],
};

/** How `tick()` builds the per-instance world matrix.
 *  - `velocity`: align local +Y to the projectile's velocity vector.
 *    Used by missile cones and the placeholder cylinders for laser/beam.
 *  - `billboard`: rotate each instance so the quad's local +Z faces the
 *    active camera. Used by sprite billboards (4.1) and beam end-caps. */
type ProjectileOrientation = 'velocity' | 'billboard';

/** Common fields across every weapon-def visual. */
interface BaseWeaponVisual {
    defId: number;
    projectileType: number;
    /// Average projectile size — used to scale the thin instance mesh in y.
    size: number;
}

/** Standard thin-instanced visual: per-frame matrix is composed via
 *  Matrix.Compose with either velocity-aligned or billboard rotation.
 *  Used by cannon/flame sprites, missile cones, and the procedural
 *  placeholders for lightning. The mesh and material are mutable because
 *  async model loads (see `swapInModel`) replace them in-place. */
interface InstancedWeaponVisual extends BaseWeaponVisual {
    kind: 'instanced';
    mesh: Mesh;
    material: StandardMaterial;
    orientation: ProjectileOrientation;
    /// Uniform scale applied at thin-instance compose time. Set by
    /// swapInModel to fit the loaded .glb into the procedural shape's
    /// size envelope. Procedural meshes are already authored at the
    /// right size (4*size elmos) so this stays 1.
    modelScale?: number;
}

/** Beam visual (Laser / BeamLaser). The middle mesh is a unit quad
 *  thin-instanced once per live beam, with the per-instance matrix
 *  encoding axis vector, midpoint, halfWidth and birth time (see
 *  shaders/projectile-beam.ts for the layout). Optional start/end
 *  cap meshes are billboarded sprite quads at the beam endpoints. */
interface BeamWeaponVisual extends BaseWeaponVisual {
    kind: 'beam';
    /// Outer edge layer — stretched-quad mesh + ShaderMaterial, tinted
    /// `color`, half-width `thickness`. Recoil's `beamEdgeSize` quad.
    mesh: Mesh;
    material: ShaderMaterial;
    /// Inner core layer drawn on top of the edge, tinted `color2`,
    /// half-width `thickness * coreThickness` — Recoil's `beamCoreSize`
    /// quad. This is the bright centre line of a beam (white-hot core
    /// inside the coloured glow). Null only if coreThickness == 0.
    coreMesh: Mesh | null;
    coreMaterial: ShaderMaterial | null;
    coreHalfWidth: number;
    /// Camera-facing muzzle flare at the emission point (Recoil's texture3
    /// quads at pos1). Two layers like the beam: a beam-COLOURED edge glow
    /// (`flareMesh`, edgeTint, the larger quad) and a white-hot core
    /// (`flareCoreMesh`, coreTint, smaller). Reads as "the beam, but a
    /// bigger/brighter burst" at the barrel. Sized by laserFlareSize.
    flareMesh: Mesh | null;
    flareMaterial: StandardMaterial | null;
    flareCoreMesh: Mesh | null;
    flareCoreMaterial: StandardMaterial | null;
    /// Lifetime in seconds — clamped to MAX_BEAM_DURATION_S to bound
    /// overdraw on long-duration beams.
    duration: number;
    /// Across-axis half-thickness in elmos.
    halfWidth: number;
    /// Texture footprint along the length axis. Tuning param for the
    /// fragment shader's tile count.
    tileLength: number;
    /// Pixels per second the beam texture scrolls. Zero unless the
    /// largeBeamLaser flag is set on the weapon (Recoil parity).
    scrollRate: number;
    /// Optional start cap (sprite billboard at the muzzle).
    startCapMesh: Mesh | null;
    startCapMaterial: StandardMaterial | null;
    /// Optional end cap (sprite billboard at the impact point).
    endCapMesh: Mesh | null;
    endCapMaterial: StandardMaterial | null;
}

/** Lightning visual: a single LinesMesh per weapon def holding every
 *  active bolt's zigzag polyline. Replaced wholesale on rebuild because
 *  Babylon's `CreateLineSystem` `instance` update path can't change
 *  topology and the bolt count drifts as bolts spawn / expire.
 *  Animation is throttled by `lastRebuildMs` so the polyline shape
 *  shimmers at ~10 Hz rather than every render frame. */
interface LightningWeaponVisual extends BaseWeaponVisual {
    kind: 'lightning';
    /// Currently rendered polylines, or null when no bolts are active.
    linesMesh: LinesMesh | null;
    /// Per-vertex tint baked into the line vertex colors. RGB pre-
    /// multiplied by intensity; alpha is varied along the polyline for
    /// the centre-bright glow falloff.
    color: Color3;
    /// Last rebuild timestamp in ms. Combined with lastBoltCount to
    /// throttle regeneration to LIGHTNING_REBUILD_INTERVAL_MS.
    lastRebuildMs: number;
    /// Bolt count at the previous rebuild. When the count differs from
    /// the current frame's count, we rebuild immediately regardless of
    /// the throttle so new/expired bolts pop in/out without delay.
    lastBoltCount: number;
    /// Per-segment perpendicular jitter as a fraction of segment length.
    /// 0.25 matches the plan's `randomNormal() * (segLen * 0.25)`
    /// recommendation; bigger values produce more chaotic bolts.
    jitter: number;
}

/** Laser-bolt visual (Recoil's `CLaserProjectile::Draw`). The bolt is
 *  a velocity-aligned stretched quad of the *current* length (which
 *  grows 0 → maxLength as the bolt flies, then contracts after impact).
 *  Up to four meshes per def:
 *
 *   - `shaftOuterMesh` — outer glow shaft, width=`thickness`, tinted `color`.
 *   - `shaftCoreMesh`  — inner core shaft, width=`thickness * coreThickness`, tinted `color2`.
 *   - `capOuterMesh`   — optional head/tail caps (one mesh, two thin instances per bolt).
 *   - `capCoreMesh`    — optional core caps, drawn with `color2`.
 *
 *  Cap meshes are populated only when `def.texture2` resolves — Recoil
 *  draws four cap quads per bolt when `validTextures[2]` (start + end,
 *  each as outer+core); we approximate with two billboarded cap quads
 *  per endpoint (outer + core) since our single-texture cap quad maps
 *  onto Recoil's tex2 page.
 *
 *  Both texture and colour come from the weapon def. The per-tick pass
 *  composes a basis `(perp_cam, dir, dir × perp_cam)` so the quad's
 *  long axis lies along velocity and the short axis faces the camera,
 *  matching Recoil's `dir1 = (pos-cam) × dir; dir2 = dif × dir1` setup.
 */
interface LaserBoltVisual extends BaseWeaponVisual {
    kind: 'laserBolt';
    shaftOuterMesh: Mesh;
    shaftOuterMaterial: ShaderMaterial;
    shaftCoreMesh: Mesh;
    shaftCoreMaterial: ShaderMaterial;
    capOuterMesh: Mesh | null;
    capOuterMaterial: ShaderMaterial | null;
    capCoreMesh: Mesh | null;
    capCoreMaterial: ShaderMaterial | null;
    /// Outer half-width (elmos). Per Recoil's `weaponDef->visuals.thickness`.
    thickness: number;
    /// Core width as a fraction of thickness (0..1).
    coreThickness: number;
    /// `duration × projectileSpeed × SIM_TICKS_PER_SEC` — max bolt length
    /// in elmos. Per-frame `curLength` is clamped to this.
    maxLength: number;
    /// Cached projectile speed in elmos / second, used to grow curLength
    /// per render tick.
    speedf: number;
    /// `weaponDef->laserHardStop` — controls post-impact behaviour.
    hardStop: boolean;
    /// Per-frame intensity decay rate (non-hardstop lasers only).
    intensityFalloff: number;
}

type WeaponVisual = InstancedWeaponVisual | BeamWeaponVisual | LightningWeaponVisual | LaserBoltVisual;

/** Visual-type → builder dispatch. Builders return a synchronous
 *  `WeaponVisual` ready to receive thin instances; any async upgrades
 *  (model load, late texture bind) attach later. */
type VisualBuilder = (
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
) => WeaponVisual;

/** Lifetime state for one live projectile. */
interface LiveProjectile {
    id: number;
    weaponDefId: number;
    pos: Vector3;
    vel: Vector3;
    /// Per-frame gravity in elmos/frame². 0 for direct/laser/missile-with-tracker.
    gravity: number;
    /// Remaining sim frames before self-detonate. -1 for no limit.
    ttl: number;
    /// Hit-scan beams die after rendering once.
    hitscan: boolean;
    targetPos: Vector3;
    /// Frame at which the Fired event landed — used to evict stale orphans.
    spawnedAtMs: number;
    /// Smoke trail ring buffer. Non-null only when the projectile's
    /// weapon def has a trail visual configured (Missile-typed defs
    /// whose `texture2` resolved to a real URL). On Impact the state
    /// is moved to `orphanedTrails` so the puffs keep fading.
    trail: MissileTrailState | null;
    /// LaserCannon bolt length in elmos (Recoil's `curLength`). Grows
    /// at `speedf` per second from 0 to `maxLength` while in flight;
    /// contracts back to 0 after impact (delayed by `stayTime` for
    /// hardstop lasers). 0 for non-laser projectiles — the laser pass
    /// is the only consumer.
    curLength: number;
    /// Recoil's `stayTime` for hardstop lasers — number of seconds the
    /// bolt holds its current length before contracting after collision
    /// is suppressed. 0 for non-laser / fading-laser projectiles.
    stayTime: number;
    /// Per-frame intensity for the fade-out path (non-hardstop lasers).
    /// Starts at the weapon def's `intensity` (default 1.0) and decays
    /// after impact. Drives the laser shaft + cap quad colour scale.
    intensity: number;
    /// Set true the moment an Impact event arrives for this projectile.
    /// For laser bolts, this defers deletion: hardstop bolts hold for
    /// `stayTime` seconds at full length then contract `curLength`
    /// to zero (then dead); non-hardstop bolts persist while
    /// `intensity` decays via `intensityFalloff * dt` and die once
    /// it crosses zero. Non-laser projectiles still delete immediately
    /// from onImpact and never see this flag flip.
    impacted: boolean;
    /// Sim-time accumulator (seconds) for the per-tick `cegTag` emit.
    /// Recoil's WeaponProjectile subclasses each call GenExplosion(cegID,
    /// pos, speed, ...) once per sim tick while `ttl > 0`; we mirror that
    /// with a sim-time accumulator so the emit cadence matches the server
    /// clock at non-1× sim speeds (dt already factors simSpeed). Drained
    /// in CEG_EMIT_PERIOD_S chunks per emit, capped at MAX_CEG_EMITS_PER_FRAME
    /// to bound work at very high sim speed.
    cegEmitAccumS: number;
    /// Sim-time accumulator (seconds) for the dynamic follow-light emit
    /// (Phase L). Decoupled from the CEG cadence — follow-lights re-emit
    /// on a slower period than the per-tick CEG trail so the pool isn't
    /// churned every frame. Only used for emissive projectile types.
    lightEmitAccumS: number;
    /// PLAN-latency L2.2 — non-null for an *invented* Tier-C flight. When
    /// set, `pos`/`vel` are recomputed from the presentation cursor each
    /// tick instead of being integrated in wall time, so the bolt is a pure
    /// function of the frame and lands exactly on its explosion.
    cosmetic: CosmeticFlight | null;
    /// PLAN-latency L2.3 — non-null when this invented flight is guided
    /// (`weaponDef.tracks`) at a live unit. Bends the middle of the arc toward
    /// the target's current expected pose at `impactFrame`; both endpoints stay
    /// pinned, so convergence is untouched.
    cosmeticTrack: CosmeticTracking | null;
    /// PLAN-latency L3.2 — non-null once a `TrajectoryKeyframe` has arrived for
    /// this (Tier-S, simulated) projectile. Like `cosmetic` it makes `pos`/`vel`
    /// a pure function of the presentation cursor, but from knots the server
    /// streams as the flight happens rather than from a closed form solved at
    /// fire time: a Tier-S outcome is contingent, so its path cannot be known
    /// up front. Null on a pre-L3 server, or with `LatencyTierSKeyframes` off,
    /// in which case the wall-time integrator and `onTrajectory` still run.
    keyframes: KeyframeTrack | null;
    /// Gravity exactly as `ProjectileFiredEvent` sent it: per sim-**frame**²,
    /// signed in Recoil's `mygravity` convention (negative pulls down). Kept
    /// alongside the seconds-scaled `gravity` above because the keyframe
    /// solver's arc is written in the sim's own frame recurrence and must not
    /// round-trip through a unit conversion to get there.
    wireGravity: number;
}

/** Active beam: from-point, to-point and birth time. Each tick the
 *  renderer rebuilds matrices for the beam visual it belongs to and
 *  pushes them as thin instances. The instance's per-frame alpha is
 *  derived in the fragment shader from `(fxNow - bornSimSec) / lifeS`,
 *  both measured on the sim-time FX clock (see simClockSec). */
interface LiveBeam {
    /// Server projectile id of the Fired event that spawned this beam.
    /// Kept so the A3 projectile-query seam (snapshotForWorker) can expose
    /// beams to Lua under the same id space as point projectiles — ZK's
    /// gfx_projectile_lights.lua reads GetProjectileVelocity(id) for beams.
    id: number;
    weaponDefId: number;
    fromX: number; fromY: number; fromZ: number;
    toX: number; toY: number; toZ: number;
    /// Birth time on the sim-time FX clock (seconds). Sim-scaled so the
    /// beam ages slower at low game speed — the capture lever.
    bornSimSec: number;
    lifeS: number;
}

/** Beam pass input: a single instance row in the per-def matrix
 *  buffer. Fed from both `liveBeams` (hit-scan) and synthesised from
 *  moving Laser-bolt entries in `this.live`. The beam pass only needs
 *  these six positional floats plus the birth seconds for the fade. */
interface BeamMatrixSource {
    fromX: number; fromY: number; fromZ: number;
    toX: number; toY: number; toZ: number;
    bornSec: number;
}

/// Spring sim ticks per game-second.
const SIM_TICKS_PER_SEC = 30;

/// How long an orphaned projectile (no impact event ever arrived) lives
/// before we drop it client-side. Defends against packet loss.
const MAX_ORPHAN_LIFE_MS = 15_000;

/// Default beam visible duration for hit-scan weapons. Server-side beam
/// projectiles carry a TTL via the Fired event; if it's 0 (typical for
/// instant-hit weapons) we fall back to this so the player at least
/// sees the bolt / laser flash.
const DEFAULT_BEAM_LIFE_S = 0.12;

/// Hard upper bound on beam visual duration. Caps overdraw on very
/// long-lived BeamLasers without affecting sim damage timing (the
/// renderer fades the visual; the server controls hit/damage windows).
const MAX_BEAM_DURATION_S = 2.0;
/// FIDELITY-STANDIN: these specific HDR multipliers are NOT from Recoil —
/// Recoil applies the weapon's authored `intensity` and renders into HDR; the
/// blow-out comes from the data, not magic numbers. We scale colours past 1.0
/// to push the core white through bloom because our colours arrive in [0,1].
/// PLAN.md drift #4 / Stage D2: document+justify against Recoil or remove.
const BEAM_EDGE_HDR = 1.4;
const BEAM_CORE_HDR = 3.0;

/// Default tile length for beam textures (elmos per UV cycle along the
/// beam axis). Spring's `tilelength` weapondef field carries this
/// per-weapon; we don't yet plumb it through so each beam falls back
/// to this constant. Bumping the schema for a per-def override is
/// trivial follow-up if needed.
const DEFAULT_BEAM_TILE_LENGTH = 200;

/// Bit 18 of GameWeaponDef.flags — Spring's largeBeamLaser. Only weapons
/// with this set get UV-scrolling per Recoil semantics.
const FLAG_LARGE_BEAM_LASER = 1 << 18;

/// Hold duration for hardstop laser bolts after impact, before contraction
/// begins. Recoil's CLaserProjectile::Collision sets `stayTime = 3` sim
/// frames; at 30 Hz that's 0.1 s of wall time. The hardstop bolt freezes
/// at full curLength during this window then contracts to zero at the
/// weapon's projectileSpeed.
const LASER_HARDSTOP_HOLD_S = 3 / SIM_TICKS_PER_SEC;

/// Per-tick in-flight CEG emit cadence. Recoil's WeaponProjectile
/// subclasses (MissileProjectile, StarburstProjectile, TorpedoProjectile,
/// FireBallProjectile, ExplosiveProjectile, FlameProjectile, EmgProjectile,
/// LaserProjectile) each call `explGenHandler.GenExplosion(cegID, pos,
/// speed, ttl, ...)` from their Update() while `ttl > 0`. That's once
/// per sim tick, i.e. every 1/30 s of sim time. We match the cadence so
/// authored CEG defs that bake spawn count + per-spawn variance assume
/// the same emit rate.
const CEG_EMIT_PERIOD_S = 1 / SIM_TICKS_PER_SEC;

/// Per-render-frame cap on per-tick CEG emits for a single projectile.
/// At very high sim speed the accumulator can build up multiple periods
/// worth of debt per render frame (e.g. simSpeed=8 at 60 fps ≈ 4 periods
/// per frame); without a cap, a 30-projectile salvo at 16× sim speed
/// would spawn 256 particles in one frame and stall the GPU. 4 emits
/// per frame keeps work bounded while still letting trails read as
/// continuous at moderate fast-forward.
const MAX_CEG_EMITS_PER_FRAME = 4;

/// Dynamic follow-light cadence/shape for emissive in-flight projectiles
/// (PLAN-weapon-fx-gaps Phase L). Re-emitted every FOLLOW_LIGHT_PERIOD_S
/// of sim time at the projectile's current position. Peak is deliberately
/// low so the pool's priority eviction keeps these subordinate to the
/// brighter muzzle/explosion lights; ttl slightly exceeds the period so
/// the glow reads as continuous rather than strobing.
const FOLLOW_LIGHT_PERIOD_S = 0.09;
const FOLLOW_LIGHT_TTL_S = 0.16;
const FOLLOW_LIGHT_PEAK = 5;
const FOLLOW_LIGHT_RANGE = 80;

/// Squared position delta (elmos²) above which a trajectory snapshot
/// is treated as a real course correction and the missile trail is
/// reset. Below this threshold the snapshot just nudges the client
/// extrapolation by a few elmos and the existing puffs are still close
/// enough to the corrected path to read fine. 20² = 400 elmos² — two
/// puff cadences of slip at typical missile speed (~100 elmos/s),
/// which is the most a non-steering missile can drift from server
/// truth between 1 Hz snapshots.
const TRAIL_RESET_DELTA_SQ = 400;

/**
 * PLAN-latency L3.2 — projectile classes whose sim `Update()` actually
 * integrates `mygravity`, as a `ProjectileType` mask.
 *
 * `ProjectileFiredEvent.gravity` carries `mygravity` unconditionally, and
 * `CProjectile`'s constructor initialises that from the map for *every*
 * projectile whether or not its class ever reads it. Only these classes do:
 *
 *   - `CExplosiveProjectile::Update` → `CProjectile::Update` (the ballistic step)
 *   - `CFireBallProjectile`, `CMissileProjectile`, `CStarburstProjectile`,
 *     `CTorpedoProjectile` — each adds `UpVector * mygravity` explicitly
 *
 * `CLaserProjectile::UpdatePos` and `CEmgProjectile::Update` are plain
 * `pos += speed`, and flame/beam/lightning never reach a live flight path at
 * all. Applying map gravity to those was worth **~32 elmos of phantom drop
 * over a 19-frame LaserCannon flight** — measured as the entire residual on
 * ZK's `striderdante_heatray` before this mask existed, swamping the guided
 * steering the residual is meant to report.
 *
 * The alternative fix is server-side (send the gravity the projectile really
 * experiences, which would also help the legacy integrator); this stays
 * client-side because it needs no wire change and the client already keys
 * per-class behaviour off `projectileType` throughout this file.
 */
const GRAVITY_INTEGRATING_TYPES =
    ProjectileType.Explosive | ProjectileType.Fireball | ProjectileType.Missile
    | ProjectileType.Starburst | ProjectileType.Torpedo;

/** Gravity the keyframe track should continue an unbracketed flight under.
 *  Unknown def (never streamed, or a game that ships none) keeps the wire
 *  value: a shot that arcs slightly wrong reads better than one that does not
 *  arc at all, and the terminal knot corrects it either way. */
function continuationGravity(def: WeaponDefInfo | undefined, wire: number): number {
    if (!def) return wire;
    return (def.projectileType & GRAVITY_INTEGRATING_TYPES) !== 0 ? wire : 0;
}

export class ProjectileRenderer {
    private scene: Scene;
    private weaponVisuals = new Map<number, WeaponVisual>();
    /// Original per-def metadata kept for runtime queries that need
    /// fields the visual doesn't carry (typeName, name, texture1, aoe,
    /// flags). The CEG dispatch in onFired/onImpact reads from this
    /// to pick per-archetype effect names; lookups are bounded by
    /// def-id keyspace so a Map keeps the hot path O(1).
    private weaponDefs = new Map<number, WeaponDefInfo>();
    private fallbackVisual: InstancedWeaponVisual;
    private live = new Map<number, LiveProjectile>();
    private liveBeams: LiveBeam[] = [];
    private lastTickMs = performance.now();
    /// Presentation cursor (fractional sim frame) — the clock invented Tier-C
    /// flights run on. See setPresentationFrame.
    private presFrame = 0;
    /**
     * PLAN-latency L3.2 gate instrumentation — the client-side counterpart of
     * the server's `[L3tally]` line, read with
     * `window.__gp('__projectileRenderer.getKeyframeStats()')`.
     *
     * It exists because this lane has twice paid for discovering late that a
     * stream was empty: `knots` separates "the flag is off / the wrong binary
     * is serving" from "the spline is misbehaving", and `byKind` separates an
     * unguided flight (Launch + Terminal only) from a guided one, which is the
     * distinction the L3.1 A/B could not make with the vehicle it had.
     *
     * The two measured quantities:
     *   * `residual*` — how far the rendered path moves when a knot lands, the
     *     one correction L3 does not design away. Zero for unguided by
     *     construction (`keyframeResidual`); quoted as a ratio against the
     *     bolt's own per-frame travel, because a shift smaller than the
     *     distance it was already covering in a frame cannot read as a snap.
     *   * `approach*` — the gap between where the spline had the bolt on the
     *     detonation tick and the terminal knot it is snapped onto, in the same
     *     per-frame-travel units. The L2.2 analogue read 0.60× a render step.
     */
    private keyframeStats = {
        knots: 0, knotsDropped: 0, tracks: 0,
        byKind: [0, 0, 0, 0, 0, 0],
        residualSamples: 0, residualSum: 0, residualMax: 0,
        residualRatioSum: 0, residualRatioMax: 0,
        outcomes: 0, approachSum: 0, approachMax: 0,
        approachRatioSum: 0, approachRatioMax: 0,
        /// Legacy trajectory events arriving for a projectile that already has
        /// a track. The server makes the two streams exclusive at the emit
        /// site, so a non-zero reading here is a server-side defect, not a
        /// client one — and it would otherwise show up only as a bolt that
        /// twitches.
        legacyTrajSuppressed: 0,
        /// Render ticks a bolt was held at the muzzle because the cursor had
        /// not reached its launch frame. Non-zero is the pre-L3 pop-in being
        /// removed; zero would mean the gate never fires.
        preLaunchTicks: 0,
    };

    /// PLAN-latency L2.3 — resolves a unit's interpolated pose at an arbitrary
    /// frame. Injected (rather than reached for) because the projectile
    /// renderer has no business holding an entity renderer, and because a host
    /// without one — tests, native-UI games — then simply leaves Tier-C flights
    /// untracked instead of needing a stub. See setTargetPoseProvider.
    private targetPose:
        ((unitId: number, frame: number) => { x: number; y: number; z: number } | null)
        | null = null;
    /// Per-def smoke trail visuals (PLAN §4.4). Entries are created
    /// lazily on the first onFired event for a given missile def whose
    /// `texture2` resolves to a URL; missiles of unconfigured defs
    /// render as a .glb model + cone with no trail.
    private trailVisuals = new Map<number, MissileTrailVisual>();
    /// Defs whose .glb / trail textures have been requested already.
    /// Populated on first sighting (onFired / onTrajectory) so the
    /// game-start path doesn't fan out an HTTP request per weapon def
    /// in the roster — matches the entity-renderer lazy-load policy.
    private assetsRequested = new Set<number>();
    /// Trail states whose missile died but whose puffs are still
    /// fading. Drained when `isTrailFullyFaded` reports the buffer
    /// is empty so the per-tick flush loop stays bounded.
    private orphanedTrails: { defId: number; state: MissileTrailState }[] = [];
    /// Resolver for `def.texture1/2/3` → KTX2 URL. Wired in by main.ts
    /// at game start; null until then. Future visual builders (sprite
    /// billboards, animated beams) consult `resolve(name)` to fetch
    /// the right texture URL — for now only the model-URL path is
    /// consumed by createVisual / swapInModel, but the resolver is
    /// owned here so widget-loaded weapons get the same resolution.
    private textureResolver: ProjectileTextureResolver | null = null;
    /// CEG particle runtime. Wired in by main.ts at game start.
    /// onFired/onImpact dispatch named effects through this for muzzle
    /// flashes, impact bursts and debris (PLAN-projectiles.md §5).
    /// Null until injected; spawn calls are guarded.
    private cegRuntime: CegRuntime | null = null;

    /// Dynamic FX light pool (PLAN-weapon-fx-gaps Phase L). Null until
    /// injected from main.ts; emits a muzzle flash on fire and an
    /// explosion light on impact. Guarded everywhere.
    private lightPool: FxLightPool | null = null;

    /// PLAN.md Stage B1d. Set true once ZK's authored projectile lights
    /// (gfx_projectile_lights.lua via the WG.DeferredLighting registry) start
    /// flowing into the same FxLightPool. While true, this renderer's INVENTED
    /// IN-FLIGHT light emissions are suppressed so the authored data is the
    /// single source for them (PLAN drift #1): the muzzle flash on fire and
    /// the per-frame follow-light — both of which gfx_projectile_lights covers
    /// by lighting the live projectile every frame.
    ///
    /// DELIBERATELY NOT suppressed: the impact explosion light. ZK's
    /// gfx_projectile_lights widget lights only LIVE projectiles; it stops at
    /// impact, so there is no authored replacement for the explosion flash
    /// online in B1 (its faithful source is the explosion CEG groundflash /
    /// LUPS, a separate path not yet wired). Suppressing it would make impacts
    /// go dark — a silent degradation. It stays as a tagged stand-in until the
    /// explosion-light authored path lands. The CEG / muzzle-flare / distortion
    /// paths are also unaffected. Defaults false so a game WITHOUT the widget
    /// keeps the full Phase-L stand-in behaviour.
    private authoredLights = false;

    /// Screen-space distortion composite (PLAN-weapon-fx-gaps Phase D).
    /// Null until injected; emits an explosion shockwave warp on impact.
    private distortion: DistortionRenderer | null = null;

    /// Muzzle-flare flash renderer (PLAN-weapon-fx-gaps Phase F item 2).
    /// Null until injected; emits a flash on fire for every weapon.
    private muzzleFlare: MuzzleFlareRenderer | null = null;

    /// Current sim-speed multiplier (1 = 30 ticks/sec, 2 = 60, 0.5 = 15).
    /// Updated from the server's GameInfo broadcast via main.ts. The
    /// per-frame integrator scales wall-clock dt by this so projectile
    /// motion and ttl decay stay in lockstep with the server clock —
    /// otherwise at >1x bolts arrive at the impact event before the
    /// integrator has reached the target (visually short), and at <1x
    /// the integrator overshoots before the impact arrives (visually
    /// long, then vanishes).
    private simSpeed = 1;

    /// Sim-time FX clock, in seconds. Accumulates the *sim-scaled* dt
    /// (`wallDt * simSpeed`) each tick, so it advances at the same rate as
    /// the server sim — faster at >1x, slower at <1x. Every weapon-FX
    /// fade/scroll/age that should track the simulation (beam lifetime,
    /// beam texture scroll, missile-trail puff age) is measured against
    /// THIS clock rather than wall-time. Two payoffs: (1) it's faithful —
    /// the engine ages beams by sim-frame TTL, not wall-seconds; (2)
    /// reducing the game speed slows the effects down proportionally,
    /// which is exactly what makes transient hit-scan FX (0.12 s beams)
    /// capturable for screenshots — no temporary constant hacks needed.
    /// Wall-time is still used for pure housekeeping (orphan eviction).
    private simClockSec = 0;

    /// Most recent def list passed to setWeaponDefs. Retained so we
    /// can rebuild visuals after the resolver finishes loading
    /// resources.json + manifests — see the async-init race section
    /// of PLAN-projectiles.md issue 4.0.
    private lastDefs: WeaponDefInfo[] = [];
    /// Set true when a re-run after resolver.whenReady() has already
    /// been scheduled, so a flurry of setWeaponDefs calls during
    /// def streaming doesn't queue duplicate rebuilds.
    private rebuildScheduled = false;
    /// Latches true once the resolver has settled (resolved or rejected)
    /// and we've done the one-shot rebuild. Subsequent setWeaponDefs
    /// calls then skip scheduleResolverRebuild entirely — the rebuild
    /// is only there to upgrade pre-resolver placeholders, and re-running
    /// it triggers an infinite recursion through the microtask queue
    /// (see scheduleResolverRebuild's comment).
    private resolverSettled = false;

    constructor(scene: Scene) {
        this.scene = scene;
        this.fallbackVisual = createFallbackVisual(0, ProjectileType.Explosive, 1.0,
            [1, 0.8, 0.2], 0.8, scene);
    }

    /// Inject the CEG runtime after init(). Same lifecycle as
    /// setTextureResolver — main.ts wires it once per session before
    /// any projectile events arrive. Effects are spawned from
    /// onFired/onImpact based on weapon visual type and impact kind;
    /// see effectForFire / effectForImpact at the bottom of this file.
    setCegRuntime(r: CegRuntime): void {
        this.cegRuntime = r;
    }

    setLightPool(pool: FxLightPool | null): void {
        this.lightPool = pool;
    }

    /// PLAN.md Stage B1d. Toggle suppression of this renderer's invented
    /// FxLightPool emissions once ZK's authored projectile lights take over.
    setAuthoredLightsActive(on: boolean): void {
        this.authoredLights = on;
    }

    setDistortion(distortion: DistortionRenderer | null): void {
        this.distortion = distortion;
    }

    setMuzzleFlare(flare: MuzzleFlareRenderer | null): void {
        this.muzzleFlare = flare;
    }

    /// A3 projectile-query seam. Snapshots the live projectile + beam set
    /// into a plain array the LuaUI worker mirrors into
    /// `liveState.projectiles`, so ZK's authored projectile-FX widgets
    /// (gfx_projectile_lights.lua, LUPS emitters) read it via
    /// Spring.GetProjectile*. Called once per render frame from main.ts.
    ///
    /// Units match Recoil's projectile Lua API:
    ///  - point projectiles: velocity in elmos/sim-frame (live.vel is
    ///    elmos/sec, so divided by SIM_TICKS_PER_SEC here);
    ///  - beam projectiles: v* carries the beam endpoint delta (to - from),
    ///    which is what GetProjectileVelocity returns for beam types;
    ///  - ttl is remaining sim frames (-1 = no limit). live.ttl is stored
    ///    in seconds (-1 = no limit), so it scales back to frames here.
    /// Positions are render-space (same convention as streamed unit state);
    /// the worker getters apply the legacy-coord Z flip exactly as they do
    /// for GetUnitPosition.
    snapshotForWorker(): Array<{
        id: number; defId: number;
        x: number; y: number; z: number;
        vx: number; vy: number; vz: number;
        ttl: number; isBeam: boolean;
    }> {
        const out: Array<{
            id: number; defId: number;
            x: number; y: number; z: number;
            vx: number; vy: number; vz: number;
            ttl: number; isBeam: boolean;
        }> = [];
        const invTick = 1 / SIM_TICKS_PER_SEC;
        for (const p of this.live.values()) {
            // L3.2: a bolt the player cannot see yet must not be visible to
            // Lua either — ZK's gfx_projectile_lights.lua would otherwise light
            // an unlaunched projectile sitting inside the barrel.
            if (this.isPreLaunch(p)) continue;
            out.push({
                id: p.id,
                defId: p.weaponDefId,
                x: p.pos.x, y: p.pos.y, z: p.pos.z,
                // elmos/sec -> elmos/sim-frame for Recoil parity.
                vx: p.vel.x * invTick, vy: p.vel.y * invTick, vz: p.vel.z * invTick,
                // live.ttl is seconds (-1 = no limit) -> sim frames.
                ttl: p.ttl < 0 ? -1 : p.ttl * SIM_TICKS_PER_SEC,
                isBeam: false,
            });
        }
        const now = this.simClockSec;
        for (const b of this.liveBeams) {
            const remainingS = Math.max(0, b.lifeS - (now - b.bornSimSec));
            out.push({
                id: b.id,
                defId: b.weaponDefId,
                // Beam "position" is the start point; velocity is the
                // start->end delta (Recoil's beam GetProjectileVelocity).
                x: b.fromX, y: b.fromY, z: b.fromZ,
                vx: b.toX - b.fromX, vy: b.toY - b.fromY, vz: b.toZ - b.fromZ,
                ttl: remainingS * SIM_TICKS_PER_SEC,
                isBeam: true,
            });
        }
        return out;
    }

    /// Push the current sim-speed multiplier. Called from main.ts's
    /// onGameInfo handler. 0 = paused (motion freezes), positive
    /// scales motion by that factor; nonsense values are ignored.
    setSimSpeed(speed: number): void {
        if (Number.isFinite(speed) && speed >= 0) this.simSpeed = speed;
    }

    /// Inject the resolver after init(). Called once per game session
    /// from main.ts. Not constructor-injected because the resolver's
    /// init is async and the renderer is created earlier in the
    /// game-bootstrap sequence.
    setTextureResolver(r: ProjectileTextureResolver): void {
        this.textureResolver = r;
        // If defs already arrived before the resolver was wired in,
        // schedule a rebuild once it's ready so sprite builders can
        // upgrade flat-color placeholders to textured billboards.
        this.scheduleResolverRebuild();
    }

    /** Register the per-weapon-def metadata and create procedural
     *  visual placeholders. Model `.glb` and missile trail textures are
     *  NOT fetched here — they load lazily on first fire of each def
     *  via `ensureWeaponAssetsLoaded`. With ZK's ~500 weapon defs that
     *  saves a fan-out of HTTP requests at game-start for weapons no
     *  one will ever fire in this match. */
    setWeaponDefs(defs: WeaponDefInfo[]): void {
        this.lastDefs = defs;

        for (const v of this.weaponVisuals.values()) {
            disposeVisual(v);
        }
        this.weaponVisuals.clear();
        this.weaponDefs.clear();
        // Trail visuals share the def id keyspace with weaponVisuals
        // and the def-list rebuild is wholesale, so dispose every
        // trail visual too. Orphaned trail states reference puff
        // positions only — they're harmless to drop, since a fresh
        // def list usually means a new game session.
        for (const tv of this.trailVisuals.values()) disposeMissileTrailVisual(tv);
        this.trailVisuals.clear();
        this.orphanedTrails = [];
        this.assetsRequested.clear();
        // Live projectiles' `trail` references now point at disposed
        // visuals — clear the field so a stale state doesn't leak
        // into the next flush. Bodies stay live; trails just stop.
        for (const p of this.live.values()) p.trail = null;

        for (const def of defs) {
            const visual = this.createVisual(def);
            this.weaponVisuals.set(def.defId, visual);
            this.weaponDefs.set(def.defId, def);
        }

        this.scheduleResolverRebuild();
    }

    /// Kick off the model + trail-texture fetch for `defId` if it
    /// hasn't been requested yet. Idempotent and cheap — a Set lookup
    /// per call. Called from onFired / onTrajectory so weapons that
    /// never appear in this match never pay the load cost.
    private ensureWeaponAssetsLoaded(defId: number): void {
        if (this.assetsRequested.has(defId)) return;
        const def = this.weaponDefs.get(defId);
        if (!def) return;
        this.assetsRequested.add(defId);

        if (def.modelUrl) {
            const size = Math.max(0.5, def.size > 0 ? def.size : 1.0);
            this.swapInModel(defId, def.modelUrl, size).catch((e) => {
                console.warn(`[projectile] model load failed for def ${defId} (${def.modelUrl}):`, e);
            });
        }

        // Smoke trails attach to anything that flies on a propellant arc
        // — Missile (cruise), Starburst (ascent + tracker), Torpedo
        // (underwater wake). Cannon shells and beams get no trail.
        const pt = def.projectileType;
        if (pt === ProjectileType.Missile
            || pt === ProjectileType.Starburst
            || pt === ProjectileType.Torpedo) {
            const tv = buildMissileTrailVisual(def, this.scene, this.textureResolver);
            if (tv) this.trailVisuals.set(defId, tv);
        }
    }

    /// Visual builders that consult the texture resolver (4.1 sprite
    /// billboards, 4.2 beams, 4.4 missile trails) return procedural /
    /// flat-color placeholders when the resolver hasn't loaded yet.
    /// Once `whenReady()` settles we re-run setWeaponDefs against the
    /// stored def list so those placeholders pick up real KTX2 URLs.
    ///
    /// Critical: once the resolver has resolved, this is a no-op. The
    /// rebuild kicked off inside the `.then()` calls `setWeaponDefs`,
    /// which itself calls `scheduleResolverRebuild` again — without
    /// the `resolverSettled` short-circuit, that produces an infinite
    /// microtask loop (resolved promise → .then → setWeaponDefs →
    /// scheduleResolverRebuild → resolved promise → ...) that floods
    /// the browser with thousands of model fetches and pegs the main
    /// thread, manifesting as a black screen on game start.
    private scheduleResolverRebuild(): void {
        if (this.rebuildScheduled || this.resolverSettled) return;
        const r = this.textureResolver;
        if (!r || this.lastDefs.length === 0) return;
        this.rebuildScheduled = true;
        r.whenReady().then(() => {
            this.rebuildScheduled = false;
            this.resolverSettled = true;
            // The def list may have been replaced (or cleared) while we
            // were awaiting the resolver. Use whatever's current.
            if (this.lastDefs.length === 0) return;
            const defs = this.lastDefs;
            this.lastDefs = [];          // setWeaponDefs re-stamps it
            this.setWeaponDefs(defs);
        }).catch((e) => {
            this.rebuildScheduled = false;
            this.resolverSettled = true;  // don't retry forever
            console.warn('[projectile] resolver whenReady() rejected:', e);
        });
    }

    /// Dispatch by visual type (or modelUrl for 3D-model weapons).
    /// Each branch is a top-level builder; this method just picks the
    /// right one and delegates. The async `.glb` swap-in stays separate
    /// (see swapInModel) — model-bearing weapons start as a procedural
    /// placeholder so the first frames of fire still render.
    private createVisual(def: WeaponDefInfo): WeaponVisual {
        const builder = visualBuilders[def.projectileType] ?? buildBillboardVisual;
        return builder(def, this.scene, this.textureResolver);
    }

    /** Async path: load a `.glb`, merge its meshes, and replace the
     *  per-def WeaponVisual's procedural mesh in-place so the next
     *  `tick()` renders thin-instances against the loaded geometry. */
    private async swapInModel(defId: number, modelUrl: string, size: number): Promise<void> {
        const lastSlash = modelUrl.lastIndexOf('/');
        const baseUrl = modelUrl.substring(0, lastSlash + 1);
        const fileName = modelUrl.substring(lastSlash + 1);

        // Don't stamp model URLs — see entity-renderer.ts loadModel().
        const result = await SceneLoader.ImportMeshAsync(
            '', baseUrl, fileName, this.scene,
        );

        // The current visual may have been replaced or disposed (e.g.
        // setWeaponDefs called again with new data) while we were
        // awaiting the load. Bail in that case to avoid leaking the
        // imported meshes — caller's catch-all handler logs the
        // failure but treats this as a non-error.
        const visual = this.weaponVisuals.get(defId);
        // Beam visuals don't go through the model-swap path (no .glb
        // expected for laser/beam weapons). If the def somehow ended
        // up classified as a beam, leave the procedural beam mesh in
        // place rather than corrupting the BeamWeaponVisual shape.
        if (!visual || visual.kind !== 'instanced') {
            for (const m of result.meshes) m.dispose();
            return;
        }

        // Glb-loaded scenes typically arrive as a list of __root__ +
        // children; we want a single thin-instance source mesh. Merge
        // every concrete sub-mesh into one. MergeMeshes preserves
        // material/UVs and disposes the originals when `disposeSource`.
        const concrete: Mesh[] = [];
        for (const m of result.meshes) {
            if (m instanceof Mesh && m.getTotalVertices() > 0) concrete.push(m);
        }
        if (concrete.length === 0) {
            for (const m of result.meshes) m.dispose();
            return;
        }
        const merged = concrete.length === 1
            ? concrete[0]
            : Mesh.MergeMeshes(concrete, true, true, undefined, false, true);
        if (!merged) return;

        // Dispose the orphaned root and any transform nodes the loader
        // created — leaving them around inflates the scene-graph node
        // count without contributing geometry.
        for (const m of result.meshes) {
            if (m !== merged && !m.isDisposed()) m.dispose();
        }

        // Inherit colour from the procedural visual's emissive so the
        // loaded model still picks up the weapondef-specified tint.
        // The model's own material wins on diffuse; we just boost
        // emissive to match the original brightness.
        merged.name = `proj_model_${defId}`;
        merged.isVisible = false;
        merged.thinInstanceEnablePicking = false;
        // Normalize size — the .glb is authored at full unit-elmo scale
        // but our procedural shapes were `4*size` elmos across. We can't
        // bake the scale into vertices because Babylon's glTF loader
        // discards CPU position/normal data after GPU upload, and
        // bakeCurrentTransformIntoVertices then null-derefs. Instead,
        // stash the scale on the visual and let the per-instance matrix
        // pick it up at compose time (thin instances ignore mesh.scaling
        // because the per-instance matrix replaces the world matrix).
        const targetExtent = 4 * size;
        const bb = merged.getBoundingInfo().boundingBox;
        const longest = Math.max(
            bb.maximum.x - bb.minimum.x,
            bb.maximum.y - bb.minimum.y,
            bb.maximum.z - bb.minimum.z,
        );
        const modelScale = longest > 1e-3 ? targetExtent / longest : 1;

        // Replace the procedural mesh on the visual and dispose it.
        // Material reuse: the loaded model's material is fine, but if
        // it has no emissive component the projectile won't glow — copy
        // the procedural visual's emissive across.
        const oldMesh = visual.mesh;
        const oldMat = visual.material;
        visual.mesh = merged;
        visual.modelScale = modelScale;
        if (merged.material instanceof StandardMaterial) {
            const stdMat = merged.material;
            stdMat.emissiveColor = oldMat.emissiveColor.clone();
            visual.material = stdMat;
        }
        oldMesh.dispose();
        if (visual.material !== oldMat) oldMat.dispose();
    }

    // ── Event hooks (called from connection.ts) ─────────────────────────────

    /** Server announced a new projectile. Spawn a local entry. */
    onFired(ev: {
        projId: number;
        weaponDefId: number;
        pos: { x: number; y: number; z: number };
        vel: { x: number; y: number; z: number };
        targetPos: { x: number; y: number; z: number };
        ttl: number;
        gravity: number;
        hitscan: boolean;
    }): void {
        // Lazy-load: first fire of a weapon def kicks off the .glb +
        // trail-texture fetch. Until those settle the projectile
        // renders as the procedural placeholder created in setWeaponDefs.
        this.ensureWeaponAssetsLoaded(ev.weaponDefId);

        // Muzzle CEG. Direction is the firing axis derived from the
        // initial velocity; fall back to "toward target" when the
        // server reports zero velocity (e.g. shields/projectors).
        if (this.cegRuntime) {
            const dir = unitDirection(
                ev.vel.x, ev.vel.y, ev.vel.z,
                ev.targetPos.x - ev.pos.x,
                ev.targetPos.y - ev.pos.y,
                ev.targetPos.z - ev.pos.z,
            );
            const def = this.weaponDefs.get(ev.weaponDefId);
            const fxName = effectForFire(def);
            if (fxName) {
                this.cegRuntime.spawn(fxName,
                    ev.pos.x, ev.pos.y, ev.pos.z,
                    dir.x, dir.y, dir.z);
            }
        }

        // NOTE — no invented muzzle-flash dynamic light here (faithful to ZK,
        // 2026-06-04). ZK authors no muzzle deferred light (`muzzleFlashLights`
        // is always empty — see fx-light-pool.ts); the muzzle glow is the
        // authored muzzle CEG (above) + the muzzle-flare quad (below) + bloom.
        // The previous `lightPool.emitMuzzle` was an unfounded invention
        // (master-plan drift #1) and is removed. ZK's in-flight projectile
        // lights still feed the pool via the deferred-light registry.

        // Muzzle flare flash (Phase F item 2) — the visual companion to the
        // muzzle light, sized by the weapon's blast (Recoil's
        // `muzzleFlareSize`, derived from AoE) and biased toward white so it
        // reads hot. Emitted for every weapon incl. beams (the hitscan
        // branch returns below).
        // Beam-kind weapons render their own beam-COLOURED two-layer flare
        // at the muzzle (buildBeamVisual), so skip the generic white flash
        // for them — it was the wrong colour and shape for a beam. Other
        // weapon types still get the generic muzzle flare.
        const fv = this.weaponVisuals.get(ev.weaponDefId);
        if (this.muzzleFlare && fv?.kind !== 'beam') {
            const mdef = this.weaponDefs.get(ev.weaponDefId);
            if (mdef) {
                const size = Math.min(Math.max((mdef.aoe ?? 0) * 0.2, 4), 30);
                this.muzzleFlare.emit(ev.pos.x, ev.pos.y, ev.pos.z,
                    muzzleFlashColor(resolveColor(mdef)), size);
            }
        }

        // Hit-scan weapons (beam laser, lightning) don't move — render
        // the bolt as a one-shot line from launch pos to impact pos and
        // skip the live-projectile tracking entirely. For beam-kind
        // visuals the entry must stay in `liveBeams` exactly as long
        // as the shader's age-based fade window (already floored at
        // DEFAULT_BEAM_LIFE_S in buildBeamVisual); otherwise the entry
        // is culled while still partly visible, or held past full
        // fade-out. ZK BeamLaser defs ship with ttl=0 so the previous
        // `ev.ttl/30 || DEFAULT_BEAM_LIFE_S` fallback gave a 0.12s
        // entry life paired with a 0.05s shader fade — beam vanished
        // visually at 50ms and only the impact CEG remained on screen.
        if (ev.hitscan) {
            const v = this.weaponVisuals.get(ev.weaponDefId);
            const lifeS = v && v.kind === 'beam'
                ? v.duration
                : (ev.ttl > 0 ? ev.ttl / SIM_TICKS_PER_SEC : DEFAULT_BEAM_LIFE_S);
            this.spawnBeam(ev.projId, ev.weaponDefId, ev.pos, ev.targetPos, lifeS);
            return;
        }

        // Velocity from the server is in elmos / sim-frame. Convert to
        // elmos / second so our render-tick integration uses real time
        // (the sim ticks at 30 Hz, so multiply by SIM_TICKS_PER_SEC).
        const vps = SIM_TICKS_PER_SEC;
        // Trail state is allocated up-front so the very first tick
        // can record a puff at the muzzle position; the per-tick code
        // path only checks `p.trail !== null` rather than re-querying
        // the trailVisuals map.
        const trail = this.trailVisuals.has(ev.weaponDefId)
            ? createMissileTrailState() : null;
        // Seed the bolt-state fields from the weapon def — for
        // non-laser projectiles `curLength` stays 0 and the laser pass
        // skips them. `intensity` defaults to 1.0 (Recoil's
        // `weaponDef->intensity` default), so non-laser projectiles
        // ignoring this field don't get a misleading value either.
        const def = this.weaponDefs.get(ev.weaponDefId);
        const intensity = def?.intensity && def.intensity > 0 ? def.intensity : 1.0;
        this.live.set(ev.projId, {
            id: ev.projId,
            weaponDefId: ev.weaponDefId,
            pos: new Vector3(ev.pos.x, ev.pos.y, ev.pos.z),
            vel: new Vector3(ev.vel.x * vps, ev.vel.y * vps, ev.vel.z * vps),
            gravity: ev.gravity * vps * vps,
            ttl: ev.ttl > 0 ? ev.ttl / SIM_TICKS_PER_SEC : -1,
            hitscan: false,
            targetPos: new Vector3(ev.targetPos.x, ev.targetPos.y, ev.targetPos.z),
            spawnedAtMs: performance.now(),
            trail,
            curLength: 0,
            stayTime: 0,
            intensity,
            impacted: false,
            // Start at -CEG_EMIT_PERIOD_S so the first per-tick emit fires
            // ~1 sim-tick *after* spawn rather than on the spawn frame —
            // gives the muzzle CEG (which `effectForFire` already spawned
            // via cegTag in onFire) a frame of breathing room before the
            // in-flight emit starts overlaying it. Without this offset
            // the missile spawns two near-identical bursts at the same
            // position and reads as a single brighter flash.
            cegEmitAccumS: -CEG_EMIT_PERIOD_S,
            lightEmitAccumS: 0,
            cosmetic: null,
            cosmeticTrack: null,
            // L3.2: filled by the Launch knot, which rides the same batch as
            // this event when `LatencyTierSKeyframes` is on. Until then (and
            // for good on a server without it) the integration below runs.
            keyframes: null,
            wireGravity: continuationGravity(def, ev.gravity),
        });
    }

    /**
     * PLAN-latency L2.2 — spawn the invented visual for a Tier-C shot.
     *
     * Called from the L1 timeline's `projSpawn` drain, i.e. on the frame the
     * presentation cursor reaches `ev.fireFrame`; `detonateCosmetic` is
     * scheduled for `ev.impactFrame` by the same caller, against the same
     * `id` — which the caller minted up front (see
     * `nextCosmeticProjectileId`), so the detonation is well-defined even if
     * this spawn never ran.
     *
     * The entry goes into the *same* `live` map as server-driven projectiles,
     * which is what makes the authored FX faithful by construction: the A3
     * read-seam (`snapshotForWorker`) exposes it to `Spring.GetProjectile*`,
     * so ZK's `gfx_projectile_lights.lua` lights a Tier-C bolt exactly as it
     * lights a simulated one, and the per-tick CEG trail, missile trail,
     * follow-light and laser-bolt passes all run unchanged.
     */
    spawnCosmetic(id: number, ev: {
        fireFrame: number;
        impactFrame: number;
        weaponDefId: number;
        origin: { x: number; y: number; z: number };
        targetId: number;
        targetPos: { x: number; y: number; z: number };
        impactPos: { x: number; y: number; z: number };
        gravity: number;
    }): void {
        this.ensureWeaponAssetsLoaded(ev.weaponDefId);

        const flight = solveCosmeticFlight(
            ev.origin, ev.impactPos, ev.fireFrame, ev.impactFrame, ev.gravity);

        // Muzzle CEG + flare. Same treatment onFired gives a real shot, with
        // the firing axis taken from the solved launch velocity rather than a
        // wire `vel` field (there is no projectile, so the event carries none).
        if (this.cegRuntime) {
            const dir = unitDirection(
                flight.vx, flight.vy, flight.vz,
                ev.targetPos.x - ev.origin.x,
                ev.targetPos.y - ev.origin.y,
                ev.targetPos.z - ev.origin.z,
            );
            const fxName = effectForFire(this.weaponDefs.get(ev.weaponDefId));
            if (fxName) {
                this.cegRuntime.spawn(fxName,
                    ev.origin.x, ev.origin.y, ev.origin.z, dir.x, dir.y, dir.z);
            }
        }
        const fv = this.weaponVisuals.get(ev.weaponDefId);
        const mdef = this.weaponDefs.get(ev.weaponDefId);
        if (this.muzzleFlare && fv?.kind !== 'beam' && mdef) {
            const size = Math.min(Math.max((mdef.aoe ?? 0) * 0.2, 4), 30);
            this.muzzleFlare.emit(ev.origin.x, ev.origin.y, ev.origin.z,
                muzzleFlashColor(resolveColor(mdef)), size);
        }

        const trail = this.trailVisuals.has(ev.weaponDefId)
            ? createMissileTrailState() : null;
        const intensity = mdef?.intensity && mdef.intensity > 0 ? mdef.intensity : 1.0;
        const p: LiveProjectile = {
            id,
            weaponDefId: ev.weaponDefId,
            pos: new Vector3(ev.origin.x, ev.origin.y, ev.origin.z),
            vel: new Vector3(),
            // The polynomial owns the arc; the wall-time integrator never runs
            // for this entry, so the seconds-scaled `gravity` field is unused.
            gravity: 0,
            // Lifetime is the schedule's, not a countdown: the detonation is
            // already queued on the timeline. MAX_ORPHAN_LIFE_MS still applies
            // as the backstop if that drain never happens (quit, clock reset).
            ttl: -1,
            hitscan: false,
            targetPos: new Vector3(ev.targetPos.x, ev.targetPos.y, ev.targetPos.z),
            spawnedAtMs: performance.now(),
            trail,
            curLength: 0,
            stayTime: 0,
            intensity,
            impacted: false,
            cegEmitAccumS: -CEG_EMIT_PERIOD_S,
            lightEmitAccumS: 0,
            cosmetic: flight,
            // L2.3: only weapons the sim would itself have guided. A real
            // CMissileProjectile with `tracks` steers at its target every tick;
            // a cannon shell does not, and bending one toward a target that
            // dodged would be *less* faithful than letting it fly to the point
            // the explosion actually happened at.
            cosmeticTrack: mdef?.tracks
                ? beginCosmeticTracking(flight, ev.targetId,
                    this.targetPose?.(ev.targetId, flight.fireFrame) ?? null,
                    this.targetPose?.(
                        ev.targetId, flight.fireFrame - TRACK_VEL_SAMPLE_LAG) ?? null)
                : null,
            // A Tier-C shot is not in the sim, so no keyframe can ever name it
            // — the two latency paths are disjoint by construction.
            keyframes: null,
            // Unused on this path — a Tier-C shot never gets a track — but the
            // wire value here is already the *solved* gravity (0 for a straight
            // shot), so no mask is wanted even if one day it were read.
            wireGravity: ev.gravity,
        };
        evalCosmeticFlight(flight, this.presFrame - flight.fireFrame, p.pos, p.vel);
        this.live.set(id, p);
    }

    /**
     * PLAN-latency L2.3 — supply the interpolated pose of a unit at an
     * arbitrary presentation frame (`EntityRenderer.getEntityPosition`).
     *
     * Queried at `impactFrame`, which is normally *inside* the interpolator's
     * buffer rather than beyond it: the shot is fired at the leading edge `E`
     * and presented `D` frames behind it, so by the time a bolt is airborne the
     * client usually holds real samples spanning the frame it will land on.
     * That is the whole reason a Tier-C shot can track a moving target without
     * predicting anything — it is reading the future off a buffer, not guessing
     * at it.
     */
    setTargetPoseProvider(
        fn: ((unitId: number, frame: number) => { x: number; y: number; z: number } | null)
            | null,
    ): void {
        this.targetPose = fn;
    }

    /**
     * PLAN-latency L2.2 — terminate an invented flight on its impact frame.
     * Drained from the timeline at `ev.impactFrame`, so the bolt is already
     * standing on `impactPos` when the explosion goes off.
     *
     * `id` is the one the scheduler minted for this shot and handed to
     * `spawnCosmetic`. If that spawn never ran (no renderer at the time) the
     * id is simply absent from `live` — the same case `onImpact` already
     * handles for a pruned or hitscan projectile, and the reason the id must
     * be a real cosmetic-range one rather than a `0` placeholder. The impact
     * FX still fire: a missing bolt is a cosmetic loss, a missing explosion is
     * a missing *event*.
     */
    detonateCosmetic(id: number, ev: {
        impactPos: { x: number; y: number; z: number };
        impactKind: number;
        weaponDefId: number;
    }): void {
        const p = this.live.get(id);
        if (p?.cosmetic) {
            // Snap to the endpoint before handing over to onImpact. For a
            // laser bolt this matters: onImpact freezes it in place for the
            // hardstop/fade animation, and the last tick left it a fraction of
            // a frame short of the explosion.
            //
            // No tracking term here on purpose: `trackingWeight(1) === 0`, so a
            // tracked bolt terminates on `impactPos` exactly as an untracked
            // one does. L2.3 bends the middle of the arc, never its ends.
            evalCosmeticFlight(p.cosmetic, p.cosmetic.frames, p.pos, p.vel);
        }
        this.onImpact({
            projId: id,
            pos: ev.impactPos,
            impactKind: ev.impactKind,
            weaponDefId: ev.weaponDefId,
        });
    }

    /**
     * PLAN-latency L3.2 — terminate a keyframed Tier-S flight on the frame the
     * sim resolved it, drained from the timeline at `OutcomeKnownEvent`'s
     * `outcome_frame`.
     *
     * The Terminal knot and this event are written by the same server call with
     * the same frame and the same position, so the spline already ends here.
     * Taking the knot verbatim rather than re-evaluating makes "the bolt is
     * standing on its explosion" exact instead of within the fraction of a
     * frame the cursor happens to sit past `outcome_frame` — the same reason
     * `detonateCosmetic` snaps before handing over.
     */
    detonateKeyframed(projId: number, ev: {
        impactPos: { x: number; y: number; z: number };
        impactKind: number;
        weaponDefId: number;
    }): void {
        const p = this.live.get(projId);
        if (p?.keyframes) {
            const k = p.keyframes.knots[p.keyframes.knots.length - 1];
            const st = this.keyframeStats;
            const gap = Math.hypot(k.x - p.pos.x, k.y - p.pos.y, k.z - p.pos.z);
            const perFrame = Math.hypot(p.vel.x, p.vel.y, p.vel.z) / SIM_TICKS_PER_SEC;
            st.outcomes++;
            st.approachSum += gap;
            if (gap > st.approachMax) st.approachMax = gap;
            if (perFrame > 1e-6) {
                const ratio = gap / perFrame;
                st.approachRatioSum += ratio;
                if (ratio > st.approachRatioMax) st.approachRatioMax = ratio;
            }
            p.pos.copyFromFloats(k.x, k.y, k.z);
            p.vel.copyFromFloats(
                k.vx * SIM_TICKS_PER_SEC, k.vy * SIM_TICKS_PER_SEC,
                k.vz * SIM_TICKS_PER_SEC);
        }
        this.onImpact({
            projId,
            pos: ev.impactPos,
            impactKind: ev.impactKind,
            weaponDefId: ev.weaponDefId,
        });
    }

    /**
     * Presentation cursor (fractional sim frame, PresentationClock.P) for this
     * render frame. Pushed from the worker render loop right before `tick()`.
     * Only cosmetic flights read it — everything else still integrates in wall
     * time off the server's position stream.
     */
    setPresentationFrame(frame: number): void {
        if (Number.isFinite(frame)) this.presFrame = frame;
    }

    /** Warm the .glb/texture fetch for a weapon def ahead of its first shot.
     *  The L1 pre-roll (`EventScheduler` `prep`) calls this while a scheduled
     *  Tier-C spawn is still in the `(P, E]` window, so the model is resident
     *  by the time the bolt appears. Idempotent — see ensureWeaponAssetsLoaded. */
    warmWeaponAssets(defId: number): void {
        this.ensureWeaponAssetsLoaded(defId);
    }

    /** Push a beam onto the live list. The beam pass in `tick()` rebuilds
     *  per-instance matrices and uniforms from these entries every render
     *  frame; expired beams are dropped when `now - bornAtMs > lifeS`.
     *  Beams whose weapon def doesn't have a beam visual still get
     *  recorded but are skipped at render time — the data is harmless. */
    private spawnBeam(id: number, weaponDefId: number,
                      from: { x: number; y: number; z: number },
                      to: { x: number; y: number; z: number }, lifeS: number): void {
        // Cap visual duration; long-lived beams just overdraw without
        // adding information once the texture has scrolled fully.
        const clamped = Math.min(lifeS, MAX_BEAM_DURATION_S);
        this.liveBeams.push({
            id,
            weaponDefId,
            fromX: from.x, fromY: from.y, fromZ: from.z,
            toX: to.x,     toY: to.y,     toZ: to.z,
            // Stamp on the sim-time FX clock so the beam ages in sim time.
            // spawnBeam runs outside tick(), so this is last tick's value —
            // at most one frame stale, which is immaterial.
            bornSimSec: this.simClockSec,
            lifeS: clamped,
        });
    }

    /** Server reported an impact. Remove the local entry; combat-fx
     *  spawns the impact VFX from the same event batch. */
    onImpact(ev: {
        projId: number;
        pos: { x: number; y: number; z: number };
        impactKind?: number;
        weaponDefId?: number;
    }): void {
        const p = this.live.get(ev.projId);
        // Fire the impact CEG even when the local projectile entry
        // has already been pruned (orphan eviction or hit-scan beams
        // never enter this.live in the first place). Falls back to the
        // generic explosion effect when we can't pin down the def.
        // `weaponDefId` on the event is the authoritative def for
        // free-floating explosions (unit death / self-destruct, where
        // there's no live projectile entry to look up).
        if (this.cegRuntime) {
            const def = ev.weaponDefId
                ? this.weaponDefs.get(ev.weaponDefId)
                : (p ? this.weaponDefs.get(p.weaponDefId) : undefined);
            const fxName = effectForImpact(ev.impactKind ?? 0, def);
            if (fxName) {
                // Impact "direction" is upward — sparks/smoke fly off
                // the surface rather than along the projectile axis.
                // `defaultDamage` propagates through sub-CEG chains so
                // Phase 2's `i1`/`d5` damage-scaled spawns size off the
                // weapon's authored damage rather than a hard-coded
                // assumption.
                const damage = def?.defaultDamage ?? 0;
                const ctxFlags = impactContextFlags(
                    ev.impactKind ?? 0, ev.pos.y);
                this.cegRuntime.spawn(fxName,
                    ev.pos.x, ev.pos.y, ev.pos.z,
                    0, 1, 0, damage, ctxFlags);
            }
        }

        // No impact point-light — faithful to ZK (it authors no explosion
        // deferred light; the glow is the authored CEG/groundflash + bloom).
        // See fx-light-pool.ts. The distortion shockwave is a separate
        // authored effect (LUPS SphereDistortion analogue); radius from AoE.
        {
            const ldef = ev.weaponDefId
                ? this.weaponDefs.get(ev.weaponDefId)
                : (p ? this.weaponDefs.get(p.weaponDefId) : undefined);
            const radius = Math.max(40, ldef?.aoe ?? 0);
            this.distortion?.emitShockwave(ev.pos.x, ev.pos.y, ev.pos.z, radius);
        }

        if (!p) return;

        // Laser bolts get a deferred deletion so the eye registers the
        // hit before the bolt vanishes. Recoil's CLaserProjectile drives
        // this off two separate signals — hardstop bolts hold for
        // `stayTime` then contract `curLength` to zero; non-hardstop
        // bolts fade `intensity` to zero. Both are now reproduced
        // faithfully (Phase F item 3): the shaft shader carries a
        // per-instance `iIntensity`, so a bolt can dim on its own. The
        // tick loop applies the right death per `hardStop`; the fade is
        // wall-time-bounded so bolts can't stack at low sim speed.
        const v = this.weaponVisuals.get(p.weaponDefId);
        if (v && v.kind === 'laserBolt') {
            p.impacted = true;
            p.stayTime = v.hardStop ? LASER_HARDSTOP_HOLD_S : 0;
            // Leave `p.vel` intact even though motion is frozen — the
            // impacted branch in tick() skips the integration step via
            // `continue`, so the bolt stays anchored. The laser-bolt
            // pass reads `p.vel` to build the shaft basis (dir = unit
            // velocity); zeroing it makes the pass fall back to +Y and
            // visibly rotates the contracting bolt during collapse.
            // Leave the entry in this.live; do not push trail to orphans
            // yet — laser bolts have no trail in the current builder.
            return;
        }

        this.live.delete(ev.projId);
        // Retain the trail past impact so puffs keep fading rather
        // than vanishing the moment the missile dies. The per-tick
        // flush sees orphaned trails alongside live ones; once every
        // puff is past TRAIL_LIFETIME_S the entry is evicted.
        if (p.trail) {
            this.orphanedTrails.push({ defId: p.weaponDefId, state: p.trail });
        }
        // The position snapshot in the event drives the impact VFX
        // (see combat-fx) — we don't need to keep the projectile entry
        // alive for one more tick because the explosion renders at
        // the event position directly.
    }

    /**
     * PLAN-latency L3.2 — a knot on a Tier-S projectile's flight path.
     *
     * Unlike every other projectile event this one is *not* scheduled onto the
     * L1 timeline. A keyframe is not an event on the flight, it is data about
     * it: the frame it applies to is carried in the knot itself, and the track
     * is sampled at the presentation cursor. Delaying delivery by `D` frames
     * would only mean the cursor spends that long unbracketed for no gain.
     *
     * A knot for an unknown projectile is dropped. That is the normal case for
     * a bolt already reaped by TTL or an impact, and for a `Fired` event this
     * client never saw (LOS, join-in-progress) — inventing a track from a
     * mid-flight knot would draw a bolt from nowhere.
     */
    onKeyframe(ev: {
        projId: number;
        frame: number;
        pos: { x: number; y: number; z: number };
        vel: { x: number; y: number; z: number };
        kind: number;
    }): void {
        const p = this.live.get(ev.projId);
        const st = this.keyframeStats;
        if (!p) { st.knotsDropped++; return; }
        st.knots++;
        if (ev.kind >= 0 && ev.kind < st.byKind.length) st.byKind[ev.kind]++;
        const kf: Keyframe = {
            frame: ev.frame,
            x: ev.pos.x, y: ev.pos.y, z: ev.pos.z,
            vx: ev.vel.x, vy: ev.vel.y, vz: ev.vel.z,
            kind: ev.kind,
        };
        if (p.keyframes) {
            // Measure before pushing: this is the visible cost of the knot,
            // i.e. how far the path the cursor is standing on jumps. Sampled at
            // the cursor rather than at the knot's own frame — a shift out in
            // the unrendered future is not a correction anyone can see.
            const r = keyframeResidual(p.keyframes, kf, this.presFrame);
            const perFrame = Math.hypot(p.vel.x, p.vel.y, p.vel.z) / SIM_TICKS_PER_SEC;
            st.residualSamples++;
            st.residualSum += r;
            if (r > st.residualMax) st.residualMax = r;
            if (perFrame > 1e-6) {
                const ratio = r / perFrame;
                st.residualRatioSum += ratio;
                if (ratio > st.residualRatioMax) st.residualRatioMax = ratio;
            }
        }
        if (!p.keyframes) {
            st.tracks++;
            // First knot for this projectile takes over its motion. Normally
            // it is the Launch knot; if the Launch was lost or filtered, a
            // later knot still yields a well-formed track — one whose
            // `launchFrame` is that knot's, so the bolt appears from there
            // rather than being drawn at a position nothing has vouched for.
            p.keyframes = createKeyframeTrack(kf, p.wireGravity);
        } else {
            pushKeyframe(p.keyframes, kf);
        }
        if (ev.kind === KEYFRAME_LAUNCH) {
            // Seed pos/vel from the track immediately so a bolt drawn in the
            // same frame this arrived is already on the spline rather than at
            // the muzzle. Everything after this comes from tick().
            evalKeyframeTrack(p.keyframes, this.presFrame, p.pos, p.vel);
        }
    }

    /**
     * PLAN-latency L3.2 gate readout. See `keyframeStats`. Derived means are
     * computed here rather than accumulated so the hot path stays two adds.
     *
     * `live`/`keyframed` are the instantaneous picture, deliberately alongside
     * the cumulative counters: "0 keyframed of 12 live" is the flag being off,
     * "12 of 12" with `knots` flat is a stalled stream, and the two failures
     * look identical from the totals alone.
     */
    getKeyframeStats(): Record<string, unknown> {
        const s = this.keyframeStats;
        let keyframed = 0;
        for (const p of this.live.values()) if (p.keyframes) keyframed++;
        const mean = (sum: number, n: number) => (n > 0 ? sum / n : 0);
        return {
            live: this.live.size, keyframed,
            knots: s.knots, knotsDropped: s.knotsDropped, tracks: s.tracks,
            byKind: {
                launch: s.byKind[0], heartbeat: s.byKind[1],
                stageChange: s.byKind[2], retarget: s.byKind[3],
                bounce: s.byKind[4], terminal: s.byKind[5],
            },
            residual: {
                n: s.residualSamples,
                meanElmos: mean(s.residualSum, s.residualSamples),
                maxElmos: s.residualMax,
                meanPerFrameTravel: mean(s.residualRatioSum, s.residualSamples),
                maxPerFrameTravel: s.residualRatioMax,
            },
            approach: {
                n: s.outcomes,
                meanElmos: mean(s.approachSum, s.outcomes),
                maxElmos: s.approachMax,
                meanPerFrameTravel: mean(s.approachRatioSum, s.outcomes),
                maxPerFrameTravel: s.approachRatioMax,
            },
            legacyTrajSuppressed: s.legacyTrajSuppressed,
            preLaunchTicks: s.preLaunchTicks,
        };
    }

    /**
     * Zero the counters above. Call immediately before a measured window.
     *
     * This is not a convenience. The counters are cumulative from page load,
     * and the first seconds of a session are exactly when the presentation
     * cursor is furthest from the knots it is being asked to interpolate —
     * measured here, an unreset run reported a mean residual of **538 elmos**
     * against **7.3 elmos** for the same battle with the counters zeroed after
     * the clock settled. A gate that quotes the unreset figure is quoting the
     * boot transient, not the spline.
     */
    resetKeyframeStats(): void {
        const s = this.keyframeStats;
        s.knots = 0; s.knotsDropped = 0; s.tracks = 0;
        s.byKind = [0, 0, 0, 0, 0, 0];
        s.residualSamples = 0; s.residualSum = 0; s.residualMax = 0;
        s.residualRatioSum = 0; s.residualRatioMax = 0;
        s.outcomes = 0; s.approachSum = 0; s.approachMax = 0;
        s.approachRatioSum = 0; s.approachRatioMax = 0;
        s.legacyTrajSuppressed = 0; s.preLaunchTicks = 0;
    }

    /**
     * PLAN-latency L3.2 — is this projectile's launch still in the cursor's
     * future? True only on the keyframe path; without a track there is no
     * frame to compare against and the bolt draws from the moment it arrives,
     * exactly as it did pre-L3.
     */
    private isPreLaunch(p: LiveProjectile): boolean {
        return p.keyframes !== null && this.presFrame < p.keyframes.launchFrame;
    }

    /** Server reported a trajectory change (bounce / steered). Override
     *  pos+vel in place. */
    onTrajectory(ev: {
        projId: number;
        pos: { x: number; y: number; z: number };
        vel: { x: number; y: number; z: number };
    }): void {
        const p = this.live.get(ev.projId);
        if (!p) return;
        // PLAN-latency L3.2 — the keyframe stream and the trajectory stream are
        // mutually exclusive at the server's emit site (TrajectoryKeyframes.h),
        // so this should be unreachable for a keyframed projectile. Guard it
        // anyway: applying a legacy snapshot would teleport a bolt whose whole
        // point is that its position is a pure function of the cursor, and the
        // failure would look like a rendering glitch rather than a stream that
        // stacked.
        if (p.keyframes) { this.keyframeStats.legacyTrajSuppressed++; return; }
        const vps = SIM_TICKS_PER_SEC;
        // Trajectory snapshots arrive once per second per missile
        // (MissileProjectile.cpp's id-staggered rotor). Between snapshots
        // the client straight-line extrapolates `pos += vel*dt`, so the
        // missile's trail puff buffer accumulates puffs along the
        // extrapolated path. When a guided missile steers mid-flight,
        // the server-corrected pos diverges from the client extrapolation
        // and `p.pos` gets teleported below. The puff buffer then bridges
        // the stale extrapolated path to the new server position with a
        // long stray ribbon segment that reads as the trail "going
        // backwards" past the missile. Reset the trail when the delta is
        // large enough to be a true correction rather than a tiny noise
        // floor — preserves continuous trails for non-steering missiles
        // (where extrapolation matched reality) without leaving stale
        // puffs from aggressive guidance updates.
        if (p.trail) {
            const dx = ev.pos.x - p.pos.x;
            const dy = ev.pos.y - p.pos.y;
            const dz = ev.pos.z - p.pos.z;
            if (dx * dx + dy * dy + dz * dz > TRAIL_RESET_DELTA_SQ) {
                resetMissileTrailState(p.trail);
            }
        }
        p.pos.copyFromFloats(ev.pos.x, ev.pos.y, ev.pos.z);
        p.vel.copyFromFloats(ev.vel.x * vps, ev.vel.y * vps, ev.vel.z * vps);
    }

    // ── Per-render-frame integration + draw ─────────────────────────────────

    /** Advance every live projectile by `dtMs` milliseconds, then push
     *  thin-instance buffers per weapon def. Call from the render loop. */
    tick(): void {
        const nowMs = performance.now();
        const wallDt = Math.min((nowMs - this.lastTickMs) / 1000, 0.1);
        this.lastTickMs = nowMs;
        // Sim-time delta drives projectile motion + ttl decay so they
        // stay in lockstep with the server clock at non-1x speeds (see
        // setSimSpeed). Wall-time delta is preserved separately for
        // visuals that genuinely tick on wall-time (beam fade, trail
        // puff age, orphan eviction).
        const dt = wallDt * this.simSpeed;
        // Advance the sim-time FX clock (see simClockSec docs). Beam fade,
        // beam scroll and trail-puff age all measure against this so they
        // slow down with the game speed — faithful, and the lever that
        // makes hit-scan FX capturable by just lowering sim speed.
        this.simClockSec += dt;
        const fxNowSec = this.simClockSec;

        // 0. Cull expired beams. Fade is computed in the fragment shader
        //    from (fxNow - bornSimSec) / lifeS — i.e. in SIM time; we just
        //    drop entries aged past their lifetime so the per-tick matrix
        //    rebuild stays bounded.
        for (let i = this.liveBeams.length - 1; i >= 0; i--) {
            const b = this.liveBeams[i];
            if (fxNowSec - b.bornSimSec > b.lifeS) {
                this.liveBeams.splice(i, 1);
            }
        }

        // 1. Integrate motion + cull expired/orphan entries. Trail
        //    states on TTL/orphan-culled projectiles get retired to
        //    `orphanedTrails` rather than dropped — same rationale as
        //    onImpact, just for the case where no impact event arrived.
        //    Trail/beam visual ages run on fxNowSec (sim time); only
        //    orphan eviction below uses wall-time (nowMs) as a GC backstop.
        const dead: number[] = [];
        for (const p of this.live.values()) {
            if (p.hitscan) {
                // Should never happen — hit-scan goes through spawnBeam.
                dead.push(p.id);
                continue;
            }
            const lv = this.weaponVisuals.get(p.weaponDefId);

            if (p.impacted && lv && lv.kind === 'laserBolt') {
                // Post-impact laser bolt death animation, split by
                // Recoil's `laserHardStop` (Phase F item 3 — now that the
                // shaft has a per-instance alpha, the two flavours render
                // their authored death over one shared draw path):
                if (lv.hardStop) {
                    // Hardstop: hold full length+intensity for `stayTime`,
                    // then contract `curLength` to the impact point — the
                    // visible snap-back. Intensity stays full throughout.
                    if (p.stayTime > 0) {
                        p.stayTime -= dt;
                    } else {
                        p.curLength -= lv.speedf * dt;
                        if (p.curLength <= 0) {
                            p.curLength = 0;
                            dead.push(p.id);
                        }
                    }
                } else {
                    // Non-hardstop: fade `intensity` in place (Recoil's
                    // per-frame `intensity -= intensity*falloffRate`). The
                    // per-instance shader alpha dims the bolt out while it
                    // holds position. Decay is per wall-second (× the sim
                    // tick rate), so it evicts in bounded wall time at any
                    // sim speed — the old fix for bolts stacking at 0.25×.
                    p.intensity -= lv.intensityFalloff * SIM_TICKS_PER_SEC * dt;
                    if (p.intensity <= 0) {
                        p.intensity = 0;
                        dead.push(p.id);
                    }
                }
                // Hard safety: evict any impacted bolt that's overstayed
                // MAX_ORPHAN_LIFE_MS even if its decay stalled (numerical
                // edge or a tick storm). Without this the impacted branch
                // had no upper bound on live-set size.
                if (nowMs - p.spawnedAtMs > MAX_ORPHAN_LIFE_MS) dead.push(p.id);
                continue;
            }

            if (p.cosmetic) {
                // PLAN-latency L2.2: an invented Tier-C flight is a function
                // of the presentation frame, not of elapsed wall time. Nothing
                // is integrated, so nothing accumulates error and nothing has
                // to be corrected — it is standing on its explosion at
                // impactFrame because the polynomial says so.
                const ct = this.presFrame - p.cosmetic.fireFrame;
                evalCosmeticFlight(p.cosmetic, ct, p.pos, p.vel);
                if (p.cosmeticTrack) {
                    // L2.3: read where the target actually is at the cursor and
                    // bend the middle of the arc by however far that is off the
                    // course the shot was aimed at. Null (dead / out of LOS /
                    // evicted) holds the last correction — see
                    // applyCosmeticTracking.
                    applyCosmeticTracking(
                        p.cosmetic, p.cosmeticTrack, ct,
                        this.targetPose?.(p.cosmeticTrack.targetId, this.presFrame) ?? null,
                        p.pos, p.vel);
                }
            } else if (p.keyframes) {
                // PLAN-latency L3.2: same property as the Tier-C branch above,
                // reached from streamed knots instead of a solved arc. Nothing
                // is integrated, so the extrapolate-and-snap the legacy branch
                // below needs — and the trail reset that hides it — have no
                // analogue here: a knot landing ahead of the cursor changes the
                // path the cursor is *about* to walk, not the path it is on.
                pruneKeyframes(p.keyframes, this.presFrame);
                evalKeyframeTrack(p.keyframes, this.presFrame, p.pos, p.vel);
            } else {
                // pos += vel * dt
                p.pos.x += p.vel.x * dt;
                p.pos.y += p.vel.y * dt;
                p.pos.z += p.vel.z * dt;
                // vel.y -= g * dt   (g positive pulls down)
                p.vel.y -= p.gravity * dt;
            }

            // PLAN-latency L3.2 — the Fired event arrives at the leading edge
            // `E`, so a Tier-S bolt exists client-side `D` frames before the
            // cursor says it was fired. Pre-L3 it started flying on arrival and
            // was that much ahead of the units around it; now the knot stamps
            // the launch frame, so it holds at the muzzle, undrawn, until the
            // cursor gets there. Nothing that marks the world — trail puffs,
            // per-tick CEG, follow-lights — may run during that window.
            if (this.isPreLaunch(p)) {
                this.keyframeStats.preLaunchTicks++;
                // The orphan backstop still applies. Pre-launch normally lasts
                // `D` frames, but a stalled presentation clock would otherwise
                // strand an undrawn entry in `live` indefinitely.
                if (nowMs - p.spawnedAtMs > MAX_ORPHAN_LIFE_MS) dead.push(p.id);
                continue;
            }

            // Record a puff at the missile's post-integration position.
            // recordTrailPuff throttles internally — this call is cheap
            // enough that we don't need to gate it further.
            if (p.trail) {
                recordTrailPuff(p.trail, p.pos.x, p.pos.y, p.pos.z, fxNowSec);
            }

            // LaserCannon bolts grow in length as they fly (Recoil's
            // `curLength = min(curLength + speedf, maxLength)` in
            // CLaserProjectile::UpdateLength). We integrate in real-time
            // here using the visual's cached `speedf` (elmos/sec). The
            // laser-bolt pass below reads `p.curLength` to size the
            // per-instance shaft matrix.
            if (lv && lv.kind === 'laserBolt') {
                p.curLength = Math.min(p.curLength + lv.speedf * dt, lv.maxLength);
            }

            // Per-tick in-flight CEG emit (Recoil's WeaponProjectile
            // Update() pattern — exhaust flames for missiles, bubble
            // trails for torpedoes, smoke wisps for cannon shells).
            // Drained in fixed sim-time chunks so the emit rate matches
            // the server clock at any sim speed. `effectForFire` already
            // spawned a muzzle burst from the same cegTag in onFire; the
            // cegEmitAccumS init offset (-CEG_EMIT_PERIOD_S) skips the
            // first frame's emit so the two don't overlap at t=0.
            if (this.cegRuntime && !p.impacted) {
                const def = this.weaponDefs.get(p.weaponDefId);
                const tag = def?.cegTag;
                if (tag && tag.toLowerCase() !== 'none') {
                    p.cegEmitAccumS += dt;
                    let emits = 0;
                    while (p.cegEmitAccumS >= CEG_EMIT_PERIOD_S
                           && emits < MAX_CEG_EMITS_PER_FRAME) {
                        p.cegEmitAccumS -= CEG_EMIT_PERIOD_S;
                        emits++;
                        // Emit direction = unit velocity. Recoil passes the
                        // raw `speed` vector (with magnitude); the CEG def
                        // is authored against a normalised direction in our
                        // runtime (`spawn` signature is `dx,dy,dz` unit
                        // vector). Skip the spawn if velocity is degenerate
                        // — a stationary missile has nothing to trail from.
                        const vmag = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
                        if (vmag < 1e-3) break;
                        const inv = 1 / vmag;
                        this.cegRuntime.spawn(tag,
                            p.pos.x, p.pos.y, p.pos.z,
                            p.vel.x * inv, p.vel.y * inv, p.vel.z * inv);
                    }
                    // Catastrophic catch-up guard: if a frame stalled and
                    // the accumulator built up >> MAX_CEG_EMITS_PER_FRAME
                    // periods of debt, drop the excess rather than carry
                    // it forward — otherwise the next few frames burst-
                    // spawn at the cap until the debt clears.
                    if (p.cegEmitAccumS > CEG_EMIT_PERIOD_S * MAX_CEG_EMITS_PER_FRAME) {
                        p.cegEmitAccumS = 0;
                    }
                }
            }

            // Dynamic follow-light (Phase L) for emissive projectile types
            // — flame, plasma, lasers, lightning glow and should light the
            // ground they pass over. Re-emitted on a slow cadence at the
            // current position; the pool's priority system keeps these dim
            // lights subordinate to muzzle/explosion bursts.
            // B1d: suppressed once ZK's authored projectile lights drive the
            // pool — gfx_projectile_lights.lua lights the live projectile every
            // frame, so this invented follow-light would double-count.
            if (this.lightPool && !this.authoredLights && !p.impacted) {
                const ldef = this.weaponDefs.get(p.weaponDefId);
                if (ldef && isEmissiveProjectile(ldef)) {
                    p.lightEmitAccumS += dt;
                    if (p.lightEmitAccumS >= FOLLOW_LIGHT_PERIOD_S) {
                        p.lightEmitAccumS = 0;
                        this.lightPool.emit(p.pos.x, p.pos.y, p.pos.z,
                            resolveColor(ldef), FOLLOW_LIGHT_PEAK,
                            FOLLOW_LIGHT_RANGE, FOLLOW_LIGHT_TTL_S);
                    }
                }
            }

            if (p.ttl > 0) {
                p.ttl -= dt;
                if (p.ttl <= 0) {
                    // Laser bolts whose ttl expires without an impact
                    // event = the bolt outflew its range. Flip to the
                    // collapse path so the next tick contracts curLength
                    // instead of vanishing the bolt mid-air. Keep `vel`
                    // intact — the impacted branch skips integration via
                    // `continue`, and the laser pass needs the direction
                    // to orient the contracting shaft (see onImpact).
                    if (lv && lv.kind === 'laserBolt') {
                        p.impacted = true;
                        p.stayTime = 0;
                    } else {
                        dead.push(p.id);
                    }
                }
            }
            if (nowMs - p.spawnedAtMs > MAX_ORPHAN_LIFE_MS) dead.push(p.id);
        }
        for (const id of dead) {
            const p = this.live.get(id);
            if (p?.trail) {
                this.orphanedTrails.push({ defId: p.weaponDefId, state: p.trail });
            }
            this.live.delete(id);
        }

        // 2. Group by weapon def and push thin-instance buffers.
        //    Live projectiles with a non-instanced visual kind go via
        //    their own pass below:
        //      - beam-kind (moving Laser bolts) → beam pass synthesises
        //        per-frame endpoints from pos ± velDir * boltLength/2.
        //      - lightning-kind → lightning pass.
        //    Anything else with no visual at all falls into key=-1 so
        //    it still draws as the procedural fallback sphere.
        const groups = new Map<number, LiveProjectile[]>();
        // Laser bolts get their own pass — same reason as beam/lightning
        // (the per-instance matrix shape doesn't match the generic
        // billboard/velocity composer).
        const laserGroups = new Map<number, LiveProjectile[]>();
        for (const p of this.live.values()) {
            // L3.2: a Tier-S bolt whose launch frame the cursor has not reached
            // is not drawn at all. It is held at the muzzle rather than dropped
            // because the knots for the rest of its flight are already arriving.
            if (this.isPreLaunch(p)) continue;
            const v = this.weaponVisuals.get(p.weaponDefId);
            if (v && (v.kind === 'beam' || v.kind === 'lightning')) continue;
            if (v && v.kind === 'laserBolt') {
                let g = laserGroups.get(p.weaponDefId);
                if (!g) { g = []; laserGroups.set(p.weaponDefId, g); }
                g.push(p);
                continue;
            }
            const key = v ? p.weaponDefId : -1;
            let g = groups.get(key);
            if (!g) { g = []; groups.set(key, g); }
            g.push(p);
        }

        const updated = new Set<number>();
        const tmpQ = new Quaternion();
        const tmpCapQ = new Quaternion();
        const tmpScale = new Vector3(1, 1, 1);
        const tmpRight = new Vector3();
        const tmpUp = new Vector3();
        const tmpFwd = new Vector3();
        // Cache the camera position once per tick — billboard rotation
        // is keyed off it. Falls back to origin if no active camera yet.
        const cam = this.scene.activeCamera;
        const camX = cam ? cam.position.x : 0;
        const camY = cam ? cam.position.y : 0;
        const camZ = cam ? cam.position.z : 0;
        for (const [key, projs] of groups) {
            const lookup = key === -1 ? this.fallbackVisual : this.weaponVisuals.get(key)!;
            // Group already filtered to instanced-kind visuals — the
            // narrowing is exhaustive in practice but TS can't see
            // that, so cast for the inner loop.
            const visual = lookup as InstancedWeaponVisual;
            const matrices = new Float32Array(projs.length * 16);
            const billboard = visual.orientation === 'billboard';
            // Loaded .glb projectiles fit themselves into the procedural
            // shape's size via visual.modelScale (set in swapInModel).
            // Procedural meshes are already authored at the right size
            // and leave it undefined → scale of 1. Apply this in the
            // per-instance matrix because thin instances replace the
            // mesh's world matrix wholesale.
            const groupScale = visual.modelScale ?? 1;
            tmpScale.set(groupScale, groupScale, groupScale);
            for (let i = 0; i < projs.length; i++) {
                const p = projs[i];
                if (billboard) {
                    // Camera-facing rotation: build orthonormal basis
                    // {right, up, forward} where forward points from
                    // the projectile to the camera. The quad's local
                    // +Z (CreatePlane front face) ends up pointing at
                    // the camera, so the textured face is visible.
                    let fx = camX - p.pos.x, fy = camY - p.pos.y, fz = camZ - p.pos.z;
                    let flen = Math.hypot(fx, fy, fz);
                    if (flen < 1e-3) { fx = 0; fy = 0; fz = 1; flen = 1; }
                    fx /= flen; fy /= flen; fz /= flen;
                    // right = cross(worldUp, forward), worldUp = (0,1,0)
                    let rx = fz, ry = 0, rz = -fx;
                    let rlen = Math.hypot(rx, ry, rz);
                    if (rlen < 1e-3) {
                        // Forward parallel to world up — use world +X
                        // as right and recompute up.
                        rx = 1; ry = 0; rz = 0; rlen = 1;
                    }
                    rx /= rlen; rz /= rlen;
                    // up = cross(forward, right)
                    const ux = fy * rz - fz * ry;
                    const uy = fz * rx - fx * rz;
                    const uz = fx * ry - fy * rx;
                    tmpRight.set(rx, ry, rz);
                    tmpUp.set(ux, uy, uz);
                    tmpFwd.set(fx, fy, fz);
                    Quaternion.RotationQuaternionFromAxisToRef(tmpRight, tmpUp, tmpFwd, tmpQ);
                } else {
                    // Velocity-aligned: rotate local +Y onto velocity.
                    const len = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
                    if (len > 1e-3) {
                        const dirY = p.vel.y / len;
                        const axisX = -p.vel.z / len, axisZ = p.vel.x / len;
                        const angle = Math.acos(Math.max(-1, Math.min(1, dirY)));
                        Quaternion.RotationAxisToRef(new Vector3(axisX, 0, axisZ), angle, tmpQ);
                    } else {
                        tmpQ.set(0, 0, 0, 1);
                    }
                }
                const m = Matrix.Compose(tmpScale, tmpQ, p.pos);
                m.copyToArray(matrices, i * 16);
            }
            visual.mesh.isVisible = true;
            visual.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
            visual.mesh.thinInstanceCount = projs.length;
            updated.add(key);
        }

        // tmpScale may have been left at the last group's modelScale —
        // beam end-caps and missile trail composers share this temporary
        // and expect unit scale, so reset before those passes run.
        tmpScale.set(1, 1, 1);

        // 3. Hide instanced visuals with no live projectiles this
        //    frame. Beam visuals are managed by the dedicated beam
        //    pass below — skip them here.
        for (const [defId, visual] of this.weaponVisuals) {
            if (visual.kind !== 'instanced') continue;
            if (!updated.has(defId)) {
                visual.mesh.isVisible = false;
                visual.mesh.thinInstanceCount = 0;
            }
        }
        if (!updated.has(-1)) {
            this.fallbackVisual.mesh.isVisible = false;
            this.fallbackVisual.mesh.thinInstanceCount = 0;
        }

        // 3a. Laser-bolt pass — Recoil's `CLaserProjectile::Draw`
        //     equivalent. For every live LaserCannon bolt, build the
        //     basis (dir1 = (pos-cam) × velocity, dir = velocity,
        //     dir2 = dir × dir1) and push four thin-instance matrices
        //     per bolt: shaft outer (color × thickness), shaft core
        //     (color2 × thickness × coreThickness), plus head + tail
        //     caps when the def has texture2. Caps are emitted as two
        //     thin instances per bolt on the same mesh.
        const laserUpdated = new Set<number>();
        for (const [defId, projs] of laserGroups) {
            const v = this.weaponVisuals.get(defId)!;
            if (v.kind !== 'laserBolt') continue;          // TS narrowing
            const shaftOuterMats = new Float32Array(projs.length * 16);
            const shaftCoreMats  = new Float32Array(projs.length * 16);
            // Per-instance intensity (Phase F item 3): the weapon-def
            // intensity × the per-bolt death fade. Shafts: one per bolt;
            // caps: two per bolt (head + tail). Slots left at 0 for bolts
            // skipped below render invisible (their matrix is zeroed too).
            const shaftOuterInten = new Float32Array(projs.length);
            const shaftCoreInten  = new Float32Array(projs.length);
            const hasCaps = v.capOuterMesh != null;
            const capOuterMats = hasCaps ? new Float32Array(projs.length * 32) : null;
            const capCoreMats  = hasCaps ? new Float32Array(projs.length * 32) : null;
            const capOuterInten = hasCaps ? new Float32Array(projs.length * 2) : null;
            const capCoreInten  = hasCaps ? new Float32Array(projs.length * 2) : null;
            for (let i = 0; i < projs.length; i++) {
                const p = projs[i];
                if (p.curLength <= 0.01) continue;          // not yet visible
                shaftOuterInten[i] = p.intensity;
                shaftCoreInten[i]  = p.intensity;
                if (capOuterInten && capCoreInten) {
                    capOuterInten[i * 2] = p.intensity;
                    capOuterInten[i * 2 + 1] = p.intensity;
                    capCoreInten[i * 2] = p.intensity;
                    capCoreInten[i * 2 + 1] = p.intensity;
                }
                // Unit velocity (Recoil's `dir`).
                const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
                const dx = speed > 1e-3 ? p.vel.x / speed : 0;
                const dy = speed > 1e-3 ? p.vel.y / speed : 1;
                const dz = speed > 1e-3 ? p.vel.z / speed : 0;
                // Unit (pos - camera). Falls back to +Z when degenerate.
                let difx = p.pos.x - camX, dify = p.pos.y - camY, difz = p.pos.z - camZ;
                const difLen = Math.hypot(difx, dify, difz);
                if (difLen > 1e-3) {
                    difx /= difLen; dify /= difLen; difz /= difLen;
                } else {
                    difx = 0; dify = 0; difz = 1;
                }
                // dir1 = (dif × dir).normalize — width axis, perpendicular
                // to both view ray and velocity (so the shaft is visible
                // from any angle except looking down the velocity axis).
                let ax1x = dify * dz - difz * dy;
                let ax1y = difz * dx - difx * dz;
                let ax1z = difx * dy - dify * dx;
                let ax1Len = Math.hypot(ax1x, ax1y, ax1z);
                if (ax1Len < 1e-3) {
                    // Camera aligned with velocity — pick a stable
                    // perpendicular. World +X is fine; the result
                    // degenerates into a point at this viewpoint anyway.
                    ax1x = 1; ax1y = 0; ax1z = 0; ax1Len = 1;
                }
                ax1x /= ax1Len; ax1y /= ax1Len; ax1z /= ax1Len;
                // dir2 = dir1 × dir — the quad's front-face normal.
                // Recoil uses `dif × dir1` for its tex2 cap layout, which
                // is left-handed. Our Babylon scene is right-handed, so
                // we form the third basis vector via `right × up` to keep
                // the basis RH and avoid `RotationQuaternionFromAxisToRef`
                // collapsing into a reflection.
                const ax2x = ax1y * dz - ax1z * dy;
                const ax2y = ax1z * dx - ax1x * dz;
                const ax2z = ax1x * dy - ax1y * dx;
                tmpRight.set(ax1x, ax1y, ax1z);    // local X = dir1 (width)
                tmpUp.set(dx, dy, dz);             // local Y = dir   (length)
                tmpFwd.set(ax2x, ax2y, ax2z);      // local Z = X × Y (normal)
                Quaternion.RotationQuaternionFromAxisToRef(tmpRight, tmpUp, tmpFwd, tmpQ);
                // Shaft midpoint = pos - dir × (curLength / 2)
                const halfLen = p.curLength * 0.5;
                const mx = p.pos.x - dx * halfLen;
                const my = p.pos.y - dy * halfLen;
                const mz = p.pos.z - dz * halfLen;
                const midPos = new Vector3(mx, my, mz);
                // Outer shaft: width = 2 × thickness (Recoil draws ±size).
                tmpScale.set(v.thickness * 2, p.curLength, 1);
                Matrix.Compose(tmpScale, tmpQ, midPos).copyToArray(shaftOuterMats, i * 16);
                // Core shaft: width = 2 × thickness × coreThickness.
                tmpScale.set(v.thickness * v.coreThickness * 2, p.curLength, 1);
                Matrix.Compose(tmpScale, tmpQ, midPos).copyToArray(shaftCoreMats, i * 16);
                if (capOuterMats && capCoreMats) {
                    // Caps live in the plane perpendicular to bolt
                    // direction — Recoil's tex2 quads use the (dir1,
                    // dir2) basis, not the shaft's (dir1, dir). That
                    // makes the cap read as a small round end-glow at
                    // the tip rather than a continuation of the shaft.
                    //   local X = dir1 (width, same as shaft)
                    //   local Y = dir2 (depth, camera-facing-ish)
                    //   local Z = dir  (normal — bolt-axis)
                    // Same RH-basis caveat as the shaft: form Z via
                    // X × Y so RotationQuaternionFromAxisToRef doesn't
                    // collapse into a reflection in our RH scene.
                    tmpRight.set(ax1x, ax1y, ax1z);
                    tmpUp.set(ax2x, ax2y, ax2z);
                    tmpFwd.set(dx, dy, dz);
                    Quaternion.RotationQuaternionFromAxisToRef(
                        tmpRight, tmpUp, tmpFwd, tmpCapQ);
                    const headPos = p.pos;
                    const tailPos = new Vector3(
                        p.pos.x - dx * p.curLength,
                        p.pos.y - dy * p.curLength,
                        p.pos.z - dz * p.curLength);
                    tmpScale.set(v.thickness * 2, v.thickness * 2, 1);
                    Matrix.Compose(tmpScale, tmpCapQ, headPos)
                        .copyToArray(capOuterMats, i * 32);
                    Matrix.Compose(tmpScale, tmpCapQ, tailPos)
                        .copyToArray(capOuterMats, i * 32 + 16);
                    tmpScale.set(v.thickness * v.coreThickness * 2,
                                 v.thickness * v.coreThickness * 2, 1);
                    Matrix.Compose(tmpScale, tmpCapQ, headPos)
                        .copyToArray(capCoreMats, i * 32);
                    Matrix.Compose(tmpScale, tmpCapQ, tailPos)
                        .copyToArray(capCoreMats, i * 32 + 16);
                }
            }
            v.shaftOuterMesh.isVisible = true;
            v.shaftOuterMesh.thinInstanceSetBuffer('matrix', shaftOuterMats, 16, false);
            v.shaftOuterMesh.thinInstanceSetBuffer('iIntensity', shaftOuterInten, 1, false);
            v.shaftOuterMesh.thinInstanceCount = projs.length;
            v.shaftCoreMesh.isVisible = true;
            v.shaftCoreMesh.thinInstanceSetBuffer('matrix', shaftCoreMats, 16, false);
            v.shaftCoreMesh.thinInstanceSetBuffer('iIntensity', shaftCoreInten, 1, false);
            v.shaftCoreMesh.thinInstanceCount = projs.length;
            if (capOuterMats && capCoreMats && capOuterInten && capCoreInten
                && v.capOuterMesh && v.capCoreMesh) {
                v.capOuterMesh.isVisible = true;
                v.capOuterMesh.thinInstanceSetBuffer('matrix', capOuterMats, 16, false);
                v.capOuterMesh.thinInstanceSetBuffer('iIntensity', capOuterInten, 1, false);
                v.capOuterMesh.thinInstanceCount = projs.length * 2;
                v.capCoreMesh.isVisible = true;
                v.capCoreMesh.thinInstanceSetBuffer('matrix', capCoreMats, 16, false);
                v.capCoreMesh.thinInstanceSetBuffer('iIntensity', capCoreInten, 1, false);
                v.capCoreMesh.thinInstanceCount = projs.length * 2;
            }
            laserUpdated.add(defId);
        }
        // Hide laser-bolt visuals with no live bolts.
        for (const [defId, visual] of this.weaponVisuals) {
            if (visual.kind !== 'laserBolt') continue;
            if (laserUpdated.has(defId)) continue;
            visual.shaftOuterMesh.isVisible = false;
            visual.shaftOuterMesh.thinInstanceCount = 0;
            visual.shaftCoreMesh.isVisible = false;
            visual.shaftCoreMesh.thinInstanceCount = 0;
            if (visual.capOuterMesh) {
                visual.capOuterMesh.isVisible = false;
                visual.capOuterMesh.thinInstanceCount = 0;
            }
            if (visual.capCoreMesh) {
                visual.capCoreMesh.isVisible = false;
                visual.capCoreMesh.thinInstanceCount = 0;
            }
        }
        tmpScale.set(1, 1, 1);

        // 4. Beam pass — group live beams by weapon def, build the
        //    custom matrix layout that the projectile-beam shader
        //    expects (axis vector, midpoint, halfWidth, birthSec
        //    packed into the matrix' free slots), and update the
        //    per-def `time` uniform.
        //
        //    Two sources feed this pass:
        //      a) Hit-scan beams in `liveBeams` (BeamLaser / LargeBeamLaser).
        //         from/to come straight off the Fired event.
        //      b) Moving Laser-bolt projectiles in `this.live` whose
        //         weapon visual is beam-kind. These don't have stable
        //         endpoints — synthesize from current pos ± velDir *
        //         boltLength/2 each frame. Without this branch the
        //         regular tick group routes them to the tiny fallback
        //         sphere (visual.kind !== 'instanced' → key -1).
        const beamGroups = new Map<number, BeamMatrixSource[]>();
        for (const b of this.liveBeams) {
            const v = this.weaponVisuals.get(b.weaponDefId);
            if (!v || v.kind !== 'beam') continue;
            let g = beamGroups.get(b.weaponDefId);
            if (!g) { g = []; beamGroups.set(b.weaponDefId, g); }
            g.push({
                fromX: b.fromX, fromY: b.fromY, fromZ: b.fromZ,
                toX:   b.toX,   toY:   b.toY,   toZ:   b.toZ,
                bornSec: b.bornSimSec,
            });
        }
        for (const p of this.live.values()) {
            const v = this.weaponVisuals.get(p.weaponDefId);
            if (!v || v.kind !== 'beam') continue;
            const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
            // Bolt length: speed * visual duration gives a Spring-style
            // dash. Floor at a couple of elmos so a near-stationary
            // projectile (e.g. arcing laser at apex) still draws something.
            const boltLen = Math.max(4, speed * v.duration);
            const half = boltLen * 0.5;
            const dx = speed > 1e-3 ? p.vel.x / speed : 0;
            const dy = speed > 1e-3 ? p.vel.y / speed : 1;
            const dz = speed > 1e-3 ? p.vel.z / speed : 0;
            let g = beamGroups.get(p.weaponDefId);
            if (!g) { g = []; beamGroups.set(p.weaponDefId, g); }
            // Re-synthesised every frame, so birth = now keeps the
            // shader's age-based fade at full alpha.
            g.push({
                fromX: p.pos.x - dx * half,
                fromY: p.pos.y - dy * half,
                fromZ: p.pos.z - dz * half,
                toX:   p.pos.x + dx * half,
                toY:   p.pos.y + dy * half,
                toZ:   p.pos.z + dz * half,
                bornSec: fxNowSec,
            });
        }

        const beamUpdated = new Set<number>();
        for (const [defId, beams] of beamGroups) {
            const visual = this.weaponVisuals.get(defId) as BeamWeaponVisual;
            const n = beams.length;
            const matrices = new Float32Array(n * 16);
            for (let i = 0; i < n; i++) {
                const b = beams[i];
                const ax = b.toX - b.fromX;
                const ay = b.toY - b.fromY;
                const az = b.toZ - b.fromZ;
                const midX = (b.fromX + b.toX) * 0.5;
                const midY = (b.fromY + b.toY) * 0.5;
                const midZ = (b.fromZ + b.toZ) * 0.5;
                const birthSec = b.bornSec;
                const off = i * 16;
                // Column 0: m[3] = halfWidth (vertex shader reads this
                // as world0.w).
                matrices[off + 0] = 0;
                matrices[off + 1] = 0;
                matrices[off + 2] = 0;
                matrices[off + 3] = visual.halfWidth;
                // Column 1: alongVec.xyz, m[7] = birthSec.
                matrices[off + 4] = ax;
                matrices[off + 5] = ay;
                matrices[off + 6] = az;
                matrices[off + 7] = birthSec;
                // Column 2: unused; leave zero.
                matrices[off + 8] = 0;
                matrices[off + 9] = 0;
                matrices[off + 10] = 0;
                matrices[off + 11] = 0;
                // Column 3: midpoint translation, m[15] = 1.
                matrices[off + 12] = midX;
                matrices[off + 13] = midY;
                matrices[off + 14] = midZ;
                matrices[off + 15] = 1;
            }
            visual.mesh.isVisible = true;
            visual.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
            visual.mesh.thinInstanceCount = n;
            visual.material.setFloat('time', fxNowSec);
            beamUpdated.add(defId);

            // Core layer — same geometry, narrower half-width, brighter
            // color2 tint, drawn on top (Recoil's beamCoreSize quad).
            if (visual.coreMesh && visual.coreMaterial) {
                const coreMatrices = matrices.slice();
                for (let i = 0; i < n; i++) {
                    coreMatrices[i * 16 + 3] = visual.coreHalfWidth;
                }
                visual.coreMesh.isVisible = true;
                visual.coreMesh.thinInstanceSetBuffer('matrix', coreMatrices, 16, false);
                visual.coreMesh.thinInstanceCount = n;
                visual.coreMaterial.setFloat('time', fxNowSec);
            }

            // Muzzle flare — camera-facing billboards at each beam's start
            // point (Recoil draws texture3 at pos1). Edge + core layers
            // share the same billboard matrix; only their size/tint differ.
            if (visual.flareMesh) {
                const flareMatrices = new Float32Array(n * 16);
                for (let i = 0; i < n; i++) {
                    const b = beams[i];
                    composeBillboardMatrix(
                        flareMatrices, i * 16,
                        b.fromX, b.fromY, b.fromZ,
                        camX, camY, camZ,
                        tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale,
                    );
                }
                visual.flareMesh.isVisible = true;
                visual.flareMesh.thinInstanceSetBuffer('matrix', flareMatrices, 16, false);
                visual.flareMesh.thinInstanceCount = n;
                if (visual.flareCoreMesh) {
                    visual.flareCoreMesh.isVisible = true;
                    visual.flareCoreMesh.thinInstanceSetBuffer('matrix', flareMatrices.slice(), 16, false);
                    visual.flareCoreMesh.thinInstanceCount = n;
                }
            }

            // End-cap matrices (start cap at fromX/Y/Z, end cap at
            // toX/Y/Z) — billboarded standard quads. Only build the
            // arrays for caps the def actually has.
            if (visual.startCapMesh) {
                const capMatrices = new Float32Array(n * 16);
                for (let i = 0; i < n; i++) {
                    const b = beams[i];
                    composeBillboardMatrix(
                        capMatrices, i * 16,
                        b.fromX, b.fromY, b.fromZ,
                        camX, camY, camZ,
                        tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale,
                    );
                }
                visual.startCapMesh.isVisible = true;
                visual.startCapMesh.thinInstanceSetBuffer('matrix', capMatrices, 16, false);
                visual.startCapMesh.thinInstanceCount = n;
            }
            if (visual.endCapMesh) {
                const capMatrices = new Float32Array(n * 16);
                for (let i = 0; i < n; i++) {
                    const b = beams[i];
                    composeBillboardMatrix(
                        capMatrices, i * 16,
                        b.toX, b.toY, b.toZ,
                        camX, camY, camZ,
                        tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale,
                    );
                }
                visual.endCapMesh.isVisible = true;
                visual.endCapMesh.thinInstanceSetBuffer('matrix', capMatrices, 16, false);
                visual.endCapMesh.thinInstanceCount = n;
            }
        }

        // 5. Hide beam visuals with no live beams this frame.
        for (const [defId, visual] of this.weaponVisuals) {
            if (visual.kind !== 'beam') continue;
            if (beamUpdated.has(defId)) continue;
            visual.mesh.isVisible = false;
            visual.mesh.thinInstanceCount = 0;
            if (visual.coreMesh) {
                visual.coreMesh.isVisible = false;
                visual.coreMesh.thinInstanceCount = 0;
            }
            if (visual.flareMesh) {
                visual.flareMesh.isVisible = false;
                visual.flareMesh.thinInstanceCount = 0;
            }
            if (visual.flareCoreMesh) {
                visual.flareCoreMesh.isVisible = false;
                visual.flareCoreMesh.thinInstanceCount = 0;
            }
            if (visual.startCapMesh) {
                visual.startCapMesh.isVisible = false;
                visual.startCapMesh.thinInstanceCount = 0;
            }
            if (visual.endCapMesh) {
                visual.endCapMesh.isVisible = false;
                visual.endCapMesh.thinInstanceCount = 0;
            }
        }

        // 6. Lightning pass — group live beams by lightning-typed
        //    weapon def, regenerate the per-def LinesMesh from the
        //    bolts' from→to endpoints. Topology changes whenever a
        //    bolt spawns or expires, so we can't share a fixed-size
        //    mesh across frames; rebuild is throttled when the bolt
        //    count is stable to keep the shimmer on a 10 Hz cadence.
        const lightningGroups = new Map<number, LiveBeam[]>();
        for (const b of this.liveBeams) {
            const v = this.weaponVisuals.get(b.weaponDefId);
            if (!v || v.kind !== 'lightning') continue;
            let g = lightningGroups.get(b.weaponDefId);
            if (!g) { g = []; lightningGroups.set(b.weaponDefId, g); }
            g.push(b);
        }
        const lightningUpdated = new Set<number>();
        for (const [defId, bolts] of lightningGroups) {
            const visual = this.weaponVisuals.get(defId) as LightningWeaponVisual;
            rebuildLightningMesh(visual, bolts, this.scene, nowMs);
            lightningUpdated.add(defId);
        }
        // Clear lightning meshes for defs with no live bolts. We
        // dispose the LinesMesh outright (rather than just hiding it)
        // because the next bolt for this def will rebuild from scratch
        // anyway and an idle LinesMesh keeps a vertex buffer pinned.
        for (const [defId, visual] of this.weaponVisuals) {
            if (visual.kind !== 'lightning') continue;
            if (lightningUpdated.has(defId)) continue;
            if (visual.linesMesh) {
                visual.linesMesh.dispose();
                visual.linesMesh = null;
                visual.lastBoltCount = 0;
            }
        }

        // 7. Missile trail pass — group every live + orphaned puff
        //    by weapon def and flush into the per-def trail visual.
        //    Live missiles' trails were already advanced (puff
        //    recording) in step 1; this pass just turns the ring
        //    buffers into thin instances + per-instance alpha.
        const trailStatesByDef = new Map<number, MissileTrailState[]>();
        for (const p of this.live.values()) {
            if (!p.trail) continue;
            let g = trailStatesByDef.get(p.weaponDefId);
            if (!g) { g = []; trailStatesByDef.set(p.weaponDefId, g); }
            g.push(p.trail);
        }
        for (const ot of this.orphanedTrails) {
            let g = trailStatesByDef.get(ot.defId);
            if (!g) { g = []; trailStatesByDef.set(ot.defId, g); }
            g.push(ot.state);
        }

        for (const [defId, visual] of this.trailVisuals) {
            const states = trailStatesByDef.get(defId) ?? [];
            flushMissileTrailVisual(visual, states, fxNowSec,
                camX, camY, camZ,
                tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale);
        }

        // Evict orphaned trails whose every puff has aged past the
        // lifetime — keeping them in the list would just inflate the
        // per-tick group iteration with no visible effect.
        for (let i = this.orphanedTrails.length - 1; i >= 0; i--) {
            if (isTrailFullyFaded(this.orphanedTrails[i].state, fxNowSec)) {
                this.orphanedTrails.splice(i, 1);
            }
        }
    }

    /** Number of live projectiles tracked client-side. */
    get count(): number {
        return this.live.size;
    }

    dispose(): void {
        for (const v of this.weaponVisuals.values()) {
            disposeVisual(v);
        }
        this.weaponVisuals.clear();
        disposeVisual(this.fallbackVisual);
        for (const tv of this.trailVisuals.values()) {
            disposeMissileTrailVisual(tv);
        }
        this.trailVisuals.clear();
        this.orphanedTrails = [];
        this.live.clear();
        this.liveBeams = [];
    }

}

// ── Top-level visual builders ──────────────────────────────────────────────
//
// Each builder returns a WeaponVisual ready to receive thin instances.
// The renderer's tick() handles per-instance matrix composition based on
// `visual.orientation` ('velocity' for legacy procedural shapes, 'billboard'
// for camera-facing sprites). Builders that consult the resolver fall back
// to flat-color placeholders when it isn't ready yet — setWeaponDefs
// re-runs once whenReady() settles, swapping in textured visuals.

function resolveColor(def: WeaponDefInfo): [number, number, number] {
    const hasColor = def.colorR > 0 || def.colorG > 0 || def.colorB > 0;
    if (hasColor) return [def.colorR, def.colorG, def.colorB];
    return DEFAULT_COLORS[def.projectileType] ?? DEFAULT_COLORS[ProjectileType.Explosive];
}

/// True for projectile types that visibly glow in flight and so should
/// carry a follow-light (Phase L). Missiles/starbursts/torpedoes are
/// excluded — their exhaust trail is the light cue, not the body, and a
/// follow-light on a long-lived cruise missile would dominate the pool.
function isEmissiveProjectile(def: WeaponDefInfo): boolean {
    switch (def.projectileType) {
        case ProjectileType.Flame:
        case ProjectileType.Fireball:
        case ProjectileType.Laser:
        case ProjectileType.Lightning:
        case ProjectileType.Emg:
            return true;
        default:
            return false;
    }
}

function resolveSize(def: WeaponDefInfo): number {
    return Math.max(0.5, def.size > 0 ? def.size : 1.0);
}

function resolveIntensity(def: WeaponDefInfo): number {
    return def.intensity > 0 ? def.intensity : 0.8;
}

/// Dispose every Babylon resource owned by a visual. Beam visuals
/// drag along optional cap meshes/materials; lightning visuals own
/// only an optional LinesMesh (no separate material — the LinesMesh
/// uses Babylon's built-in colour shader). The conditionals keep
/// dispose() in the renderer compact.
function disposeVisual(v: WeaponVisual): void {
    if (v.kind === 'lightning') {
        v.linesMesh?.dispose();
        return;
    }
    if (v.kind === 'laserBolt') {
        v.shaftOuterMesh.dispose();
        v.shaftOuterMaterial.dispose();
        v.shaftCoreMesh.dispose();
        v.shaftCoreMaterial.dispose();
        v.capOuterMesh?.dispose();
        v.capOuterMaterial?.dispose();
        v.capCoreMesh?.dispose();
        v.capCoreMaterial?.dispose();
        return;
    }
    v.mesh.dispose();
    v.material.dispose();
    if (v.kind === 'beam') {
        if (v.coreMesh) v.coreMesh.dispose();
        if (v.coreMaterial) v.coreMaterial.dispose();
        if (v.flareMesh) v.flareMesh.dispose();
        if (v.flareMaterial) v.flareMaterial.dispose();
        if (v.flareCoreMesh) v.flareCoreMesh.dispose();
        if (v.flareCoreMaterial) v.flareCoreMaterial.dispose();
        if (v.startCapMesh) v.startCapMesh.dispose();
        if (v.startCapMaterial) v.startCapMaterial.dispose();
        if (v.endCapMesh) v.endCapMesh.dispose();
        if (v.endCapMaterial) v.endCapMaterial.dispose();
    }
}

/// Build a camera-facing matrix at world position (px, py, pz) into
/// `out[off..off+16]`. Same orthonormal-basis trick the projectile
/// pass uses inline, lifted here so the beam end-caps share the same
/// billboard logic. The temporaries are passed in so callers can reuse
/// allocations across the per-tick rebuild.
function composeBillboardMatrix(
    out: Float32Array, off: number,
    px: number, py: number, pz: number,
    camX: number, camY: number, camZ: number,
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
    tmpRight.set(rx, ry, rz);
    tmpUp.set(ux, uy, uz);
    tmpFwd.set(fx, fy, fz);
    Quaternion.RotationQuaternionFromAxisToRef(tmpRight, tmpUp, tmpFwd, tmpQ);
    const m = Matrix.Compose(tmpScale, tmpQ, new Vector3(px, py, pz));
    m.copyToArray(out, off);
}

function makeMaterial(
    name: string,
    scene: Scene,
    color: [number, number, number],
    intensity: number,
): StandardMaterial {
    const mat = new StandardMaterial(name, scene);
    mat.diffuseColor = new Color3(color[0], color[1], color[2]);
    mat.emissiveColor = new Color3(
        color[0] * intensity,
        color[1] * intensity,
        color[2] * intensity,
    );
    mat.specularColor = new Color3(0, 0, 0);
    return mat;
}

/// 4.1 — Billboard sprite for cannons, plasma, EMG, flame. A unit quad
/// per weapon def, rotated by tick() each frame to face the camera.
/// Texture comes from `def.texture1` via the resolver; missing/null
/// texture → flat-color quad (still distinguishable from beam/missile
/// types because tick() billboards it).
function buildBillboardVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    const color = resolveColor(def);
    const size = resolveSize(def);
    const intensity = resolveIntensity(def);
    const mat = makeMaterial(`projMat_${def.defId}`, scene, color, intensity);
    mat.disableLighting = true;
    // Additive blend (alphaMode = 1) — projectile sprites stack on top
    // of each other and the background without ever obscuring it.
    mat.alphaMode = 1;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;

    const url = resolver?.resolve(def.texture1) ?? null;
    if (url) {
        // KTX2 loader is pinned globally in main.ts; passing the URL
        // straight to Texture() picks it up.
        const tex = new Texture(stampUrl(url), scene, /*noMipmap*/ false,
            /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;
        mat.diffuseTexture = tex;
        mat.useAlphaFromDiffuseTexture = true;
        // White diffuse so the texture's own colour shows through —
        // weapondef colour is applied via emissive only.
        mat.diffuseColor = new Color3(1, 1, 1);
    }

    const baseDiameter = 4 * size;
    const mesh = MeshBuilder.CreatePlane(
        `proj_${def.defId}`,
        { size: baseDiameter, sideOrientation: Mesh.DOUBLESIDE },
        scene,
    );
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;
    mesh.alphaIndex = 1000;

    return {
        kind: 'instanced',
        defId: def.defId, mesh, material: mat,
        projectileType: def.projectileType, size, orientation: 'billboard',
    };
}

/// 4.2 — Laser / BeamLaser textured stretched-quad. Returns a
/// BeamWeaponVisual whose middle mesh is a unit quad thin-instanced
/// once per live beam (matrix layout described in
/// shaders/projectile-beam.ts). `texture1` drives the middle, `texture2`
/// the start cap, `texture3` the end cap; missing textures degrade
/// gracefully (cap → null mesh, missing middle → flat-color
/// untextured quad).
function buildBeamVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    registerProjectileBeamShader();

    const color = resolveColor(def);
    const size = resolveSize(def);
    // Across-axis half-width. Recoil's `BeamLaserProjectile::Draw` draws the
    // beam edge at ±`visuals.thickness` (thickness == half-width, same
    // convention the laser-bolt builder uses), so map it straight through.
    // `thickness` IS on our wire (LuaDefsSerializer emits it); the old
    // `size*2` heuristic ignored it and mis-sized every beam. Fall back to
    // the heuristic only for defs that ship thickness == 0.
    const halfWidth = def.thickness > 0
        ? def.thickness
        : Math.max(0.5, size * 2);
    // Visible duration: floor at DEFAULT_BEAM_LIFE_S so the shader's
    // age-based alpha fade always covers at least one or two render
    // frames. ZK BeamLaser defs typically ship with `duration = 0.05`
    // (≈1.5 sim frames at 30 Hz; 3 render frames at 60 Hz) — without
    // the floor the beam fades to zero alpha before the eye catches it
    // and the only thing visible is the impact CEG, leaving the laser
    // looking like a stationary dot at the impact point.
    const duration = Math.min(
        MAX_BEAM_DURATION_S,
        Math.max(DEFAULT_BEAM_LIFE_S,
                 def.duration > 0 ? def.duration : DEFAULT_BEAM_LIFE_S),
    );
    const isLargeBeam = (def.flags & FLAG_LARGE_BEAM_LASER) !== 0;
    // Recoil semantics: only the Large variant scrolls. scrollSpeed
    // defaults to Spring's 5.0 on every weapon — the gate below is what
    // makes plain BeamLaser render as a static stripe.
    const scrollRate = isLargeBeam ? def.scrollSpeed : 0;

    // Recoil texture roles (ProjectileTextureDefaults): texture1 = beam
    // body (laserfalloff / largebeam), texture2 = laserend used for BOTH
    // the start and end caps, texture3 = the muzzle flare. The old code
    // mis-used texture3 as the end cap.
    const bodyUrl  = resolver?.resolve(def.texture1) ?? null;
    const capUrl   = resolver?.resolve(def.texture2) ?? null;
    const flareUrl = resolver?.resolve(def.texture3) ?? null;

    const color2: [number, number, number] = [def.color2R, def.color2G, def.color2B];
    const coreThickness = def.coreThickness > 0 ? def.coreThickness : 0.5;
    const coreHalfWidth = halfWidth * coreThickness;

    // HDR tints (see BEAM_*_HDR). Scale by the weapon's intensity and push
    // past 1.0 so the bloom pass produces the white-hot core + glow halo
    // the references show. Edge keeps its colour; core saturates to white.
    const intensity = resolveIntensity(def);
    const edgeTint: [number, number, number] = [
        color[0] * intensity * BEAM_EDGE_HDR,
        color[1] * intensity * BEAM_EDGE_HDR,
        color[2] * intensity * BEAM_EDGE_HDR,
    ];
    const coreTint: [number, number, number] = [
        color2[0] * intensity * BEAM_CORE_HDR,
        color2[1] * intensity * BEAM_CORE_HDR,
        color2[2] * intensity * BEAM_CORE_HDR,
    ];

    // Build one stretched-quad beam layer (edge or core). Both share the
    // body texture + scroll/tile/duration params and the projectileBeam
    // shader (which rebuilds the camera-facing across-axis per frame);
    // only the tint and the per-instance half-width differ. Recoil draws
    // the beam as two such layers — edge (`color`, thickness) then core
    // (`color2`, thickness*corethickness) on top — which is what gives a
    // beam its bright centre line inside a coloured glow.
    const makeLayer = (tag: string, tint: [number, number, number], alphaIndex: number)
            : { mesh: Mesh; mat: ShaderMaterial } => {
        const m = new ShaderMaterial(`projBeam${tag}Mat_${def.defId}`, scene, 'projectileBeam', {
            attributes: ['position', 'uv'],
            uniforms: ['world', 'viewProjection', 'cameraPosition',
                       'baseColor', 'time', 'scrollRate', 'tileLength', 'duration'],
            samplers: ['beamTex'],
            defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
            needAlphaBlending: true,
        });
        m.setColor3('baseColor', new Color3(tint[0], tint[1], tint[2]));
        m.setFloat('time', 0);
        m.setFloat('scrollRate', scrollRate);
        m.setFloat('tileLength', DEFAULT_BEAM_TILE_LENGTH);
        m.setFloat('duration', duration);
        // PURE ADDITIVE (GL_ONE / GL_ONE = Babylon ALPHA_ONEONE). A beam is
        // emissive light: it must only ever ADD to the scene, never darken
        // it. The old premultiplied-OVER mode (alphaMode 7) replaced the
        // background with the beam's premultiplied colour where alpha was
        // high, which darkened bright terrain — the dark-band bug.
        m.alphaMode = 6;
        m.backFaceCulling = false;
        m.disableDepthWrite = true;
        if (bodyUrl) {
            const tex = new Texture(stampUrl(bodyUrl), scene, /*noMipmap*/ false,
                /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
            tex.hasAlpha = true;
            tex.wrapU = Texture.WRAP_ADDRESSMODE;
            tex.wrapV = Texture.WRAP_ADDRESSMODE;
            m.setTexture('beamTex', tex);
        }
        const lm = MeshBuilder.CreatePlane(`projBeam${tag}_${def.defId}`,
            { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
        lm.material = m;
        lm.isPickable = false;
        lm.isVisible = false;
        lm.thinInstanceEnablePicking = false;
        lm.alwaysSelectAsActiveMesh = true;
        lm.alphaIndex = alphaIndex;
        return { mesh: lm, mat: m };
    };

    // Outer edge layer (always present), then the brighter inner core on
    // top (skipped only when corethickness collapses it to nothing).
    const { mesh, mat } = makeLayer('Edge', edgeTint, 1000);
    let coreMesh: Mesh | null = null;
    let coreMaterial: ShaderMaterial | null = null;
    if (coreHalfWidth > 0.01) {
        const core = makeLayer('Core', coreTint, 1001);
        coreMesh = core.mesh;
        coreMaterial = core.mat;
    }

    // Start + end caps both use texture2 (laserend), billboarded at the
    // beam endpoints — these are the bright glows at the emission and
    // impact points. Tinted with the HDR edge colour (not the raw [0,1]
    // colour) so they bloom like the shaft, and sized a little larger
    // than the beam so the end "pops". The end cap doubles as the
    // beam-side impact glow; the impact CEG adds the sparks on top.
    const capDiameter = Math.max(4, halfWidth * 3.0);
    const { mesh: startCapMesh, material: startCapMat } = buildBeamCap(
        `projBeamStart_${def.defId}`, capUrl, edgeTint, capDiameter, scene);
    const { mesh: endCapMesh, material: endCapMat } = buildBeamCap(
        `projBeamEnd_${def.defId}`, capUrl, edgeTint, capDiameter, scene);

    // Muzzle flare: a camera-facing texture3 billboard at the emission
    // point — the bright "hot spot" where the beam leaves the barrel.
    // Recoil sizes it thickness*laserFlareSize; we render it for EVERY
    // beam (ZK ships most with laserFlareSize 0 but still shows a muzzle
    // glow, carried in-engine by the bright beam end + muzzle CEG), using
    // a sensible default size and the white-hot CORE tint so it reads as a
    // bloomed flash rather than a faint dot.
    let flareMesh: Mesh | null = null;
    let flareMaterial: StandardMaterial | null = null;
    let flareCoreMesh: Mesh | null = null;
    let flareCoreMaterial: StandardMaterial | null = null;
    if (flareUrl) {
        // FIDELITY-STANDIN: Recoil only draws the muzzle flare when
        // laserflaresize>0; we render it for EVERY beam with a 2.5 default.
        // PLAN.md drift #3 / Stage D1: gate on laserflaresize>0 + size from the
        // real field once muzzleFlareSize is wired (Stage A2).
        const flareScale = def.laserFlareSize > 0 ? def.laserFlareSize : 2.5;
        // Edge flare — beam-coloured, the larger outer glow.
        const edgeDia = Math.max(6, halfWidth * flareScale * 2.0);
        const ef = buildBeamCap(
            `projBeamFlare_${def.defId}`, flareUrl, edgeTint, edgeDia, scene);
        flareMesh = ef.mesh;
        flareMaterial = ef.material;
        // Core flare — white-hot, smaller, sits inside the edge glow
        // (Recoil's flareCoreSize = flareEdgeSize * corethickness).
        const coreDia = Math.max(4, edgeDia * coreThickness);
        const cf = buildBeamCap(
            `projBeamFlareCore_${def.defId}`, flareUrl, coreTint, coreDia, scene);
        flareCoreMesh = cf.mesh;
        flareCoreMaterial = cf.material;
    }

    return {
        kind: 'beam',
        defId: def.defId, mesh, material: mat,
        coreMesh, coreMaterial, coreHalfWidth,
        flareMesh, flareMaterial, flareCoreMesh, flareCoreMaterial,
        projectileType: def.projectileType, size,
        duration, halfWidth, tileLength: DEFAULT_BEAM_TILE_LENGTH, scrollRate,
        startCapMesh, startCapMaterial: startCapMat,
        endCapMesh, endCapMaterial: endCapMat,
    };
}

/// Build a beam cap / flare sprite. Returns null mesh+material when no
/// texture URL is supplied — caller treats this as "skip". `diameter` is
/// the full plane size in elmos (caller already scaled it from the
/// engine's edge size); tick() billboards it at the endpoint.
function buildBeamCap(
    name: string,
    url: string | null,
    color: [number, number, number],
    diameter: number,
    scene: Scene,
): { mesh: Mesh | null; material: StandardMaterial | null } {
    if (!url) return { mesh: null, material: null };
    const mat = makeMaterial(`${name}_mat`, scene, color, 1.0);
    mat.disableLighting = true;
    mat.alphaMode = 1;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    const tex = new Texture(stampUrl(url), scene, /*noMipmap*/ false,
        /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.hasAlpha = true;
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.diffuseColor = new Color3(1, 1, 1);

    const mesh = MeshBuilder.CreatePlane(name,
        { size: Math.max(2, diameter), sideOrientation: Mesh.DOUBLESIDE },
        scene);
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.isPickable = false;
    mesh.thinInstanceEnablePicking = false;
    mesh.alphaIndex = 1001;
    return { mesh, material: mat };
}

/// 4.3 — Lightning bolt. Returns a LightningWeaponVisual whose
/// LinesMesh is built lazily on the first tick that has live bolts.
/// `texture1` is intentionally ignored per the plan: the polyline
/// itself conveys the look, and skipping the texture sample saves
/// one draw call's worth of state changes per def.
function buildLightningVisual(
    def: WeaponDefInfo,
    _scene: Scene,
    _resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    const [r, g, b] = resolveColor(def);
    const intensity = resolveIntensity(def);
    return {
        kind: 'lightning',
        defId: def.defId,
        projectileType: def.projectileType,
        size: resolveSize(def),
        linesMesh: null,
        // Pre-multiply the tint by intensity so the per-vertex Color4
        // alpha can encode the centre-bright glow falloff cleanly.
        color: new Color3(r * intensity, g * intensity, b * intensity),
        lastRebuildMs: 0,
        lastBoltCount: 0,
        jitter: 0.25,
    };
}

/// Number of segments per bolt polyline. 12 is the plan's recommended
/// number — enough to read as a zigzag, cheap enough for hundreds
/// of simultaneous bolts.
const LIGHTNING_SEGMENTS = 12;

/// Throttle window for lightning shimmer. When the bolt count is
/// unchanged we skip rebuilds shorter than this, animating the
/// polyline shape at ~10 Hz. New / expiring bolts always trigger an
/// immediate rebuild, so visual latency on bolt spawn is bounded by
/// the render frame interval, not this throttle.
const LIGHTNING_REBUILD_INTERVAL_MS = 100;

/// Generate a zigzag polyline between two points. The endpoints are
/// anchored (no jitter) so the bolt visually starts at the muzzle and
/// ends at the impact; intermediate vertices are perturbed perpen-
/// dicular to the bolt axis. Two perpendicular axes are computed once
/// per bolt and shared across all interior vertices — cheaper than
/// rebuilding a basis per segment.
function generateBoltPoints(
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
    segments: number,
    jitter: number,
): Vector3[] {
    const dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) {
        return [new Vector3(fromX, fromY, fromZ),
                new Vector3(toX, toY, toZ)];
    }
    const fxN = dx / len, fyN = dy / len, fzN = dz / len;
    // Pick world up unless the bolt itself is near-vertical, in which
    // case fall back to world +X so cross(forward, up) doesn't degenerate.
    const upX = Math.abs(fyN) > 0.99 ? 1 : 0;
    const upY = Math.abs(fyN) > 0.99 ? 0 : 1;
    const upZ = 0;
    let p1x = fyN * upZ - fzN * upY;
    let p1y = fzN * upX - fxN * upZ;
    let p1z = fxN * upY - fyN * upX;
    const p1Len = Math.hypot(p1x, p1y, p1z) || 1;
    p1x /= p1Len; p1y /= p1Len; p1z /= p1Len;
    const p2x = fyN * p1z - fzN * p1y;
    const p2y = fzN * p1x - fxN * p1z;
    const p2z = fxN * p1y - fyN * p1x;

    const segLen = len / segments;
    const amp = segLen * jitter;
    const points: Vector3[] = new Array(segments + 1);
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        let px = fromX + dx * t;
        let py = fromY + dy * t;
        let pz = fromZ + dz * t;
        // Endpoints stay at from/to — bolt anchored to muzzle + impact.
        if (i > 0 && i < segments) {
            const j1 = (Math.random() - 0.5) * 2 * amp;
            const j2 = (Math.random() - 0.5) * 2 * amp;
            px += p1x * j1 + p2x * j2;
            py += p1y * j1 + p2y * j2;
            pz += p1z * j1 + p2z * j2;
        }
        points[i] = new Vector3(px, py, pz);
    }
    return points;
}

/// Per-vertex colour buffer matching `generateBoltPoints` output.
/// Alpha follows a quadratic falloff peaking at the polyline midpoint;
/// the resulting bolt reads as a bright core that fades into both
/// endpoints — the "glow falloff" the plan calls out.
function generateBoltColors(color: Color3, segments: number): Color4[] {
    const colors: Color4[] = new Array(segments + 1);
    const centre = segments / 2;
    for (let i = 0; i <= segments; i++) {
        const d = Math.abs(i - centre) / centre;
        const alpha = Math.max(0, 1 - d * d);
        colors[i] = new Color4(color.r, color.g, color.b, alpha);
    }
    return colors;
}

/// Rebuild the LinesMesh for one lightning weapon def. Called once
/// per tick that has live bolts; throttled internally so a steady
/// bolt count animates at ~10 Hz instead of every render frame.
function rebuildLightningMesh(
    visual: LightningWeaponVisual,
    bolts: LiveBeam[],
    scene: Scene,
    nowMs: number,
): void {
    const sameTopology = visual.linesMesh != null
        && visual.lastBoltCount === bolts.length;
    if (sameTopology
        && nowMs - visual.lastRebuildMs < LIGHTNING_REBUILD_INTERVAL_MS) {
        return;
    }

    const lines: Vector3[][] = new Array(bolts.length);
    const colors: Color4[][] = new Array(bolts.length);
    for (let i = 0; i < bolts.length; i++) {
        const b = bolts[i];
        lines[i] = generateBoltPoints(
            b.fromX, b.fromY, b.fromZ, b.toX, b.toY, b.toZ,
            LIGHTNING_SEGMENTS, visual.jitter);
        colors[i] = generateBoltColors(visual.color, LIGHTNING_SEGMENTS);
    }

    // CreateLineSystem's `instance` update path can't change the
    // vertex count, and our bolt count drifts as bolts spawn/expire,
    // so we dispose+recreate. The mesh is small (~13 verts × few-
    // dozen bolts) and the alloc cost is dwarfed by the throttle.
    visual.linesMesh?.dispose();
    visual.linesMesh = MeshBuilder.CreateLineSystem(
        `projLightning_${visual.defId}`,
        { lines, colors, useVertexAlpha: true },
        scene,
    );
    visual.linesMesh.isPickable = false;
    visual.linesMesh.alphaIndex = 1000;
    visual.lastBoltCount = bolts.length;
    visual.lastRebuildMs = nowMs;
}

/// 4.4 placeholder — missile cone. Existing `.glb` swap-in remains; the
/// smoke-trail ring buffer lands with 4.4.
function buildMissileVisual(
    def: WeaponDefInfo,
    scene: Scene,
    _resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    const color = resolveColor(def);
    const size = resolveSize(def);
    const intensity = resolveIntensity(def);
    const mat = makeMaterial(`projMat_${def.defId}`, scene, color, intensity);

    const baseDiameter = 4 * size;
    const mesh = MeshBuilder.CreateCylinder(`proj_${def.defId}`, {
        diameterTop: 0,
        diameterBottom: baseDiameter * 0.8,
        height: baseDiameter * 2,
        tessellation: 6,
    }, scene);
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;

    return {
        kind: 'instanced',
        defId: def.defId, mesh, material: mat,
        projectileType: def.projectileType, size, orientation: 'velocity',
    };
}

/// Recoil's `CStarburstProjectile::Draw` — missile body with a longer,
/// more pronounced smoke trail and corkscrew launch pattern (the
/// corkscrew is sim-side, not visual). The visual is essentially a
/// velocity-aligned cone like a regular missile; the distinguishing
/// look comes from the trail (which builds via `buildMissileTrailVisual`
/// based on `texture2`) being noticeably thicker. We don't yet tune
/// per-projectile-type trail width here — the missile builder's output
/// is identical until the trail subsystem grows a Starburst-specific
/// puff size. Kept as a separate entry so future divergence (rocket
/// .glb model, dual-stage flame) lands here without touching the
/// generic missile path.
function buildStarburstVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    return buildMissileVisual(def, scene, resolver);
}

/// Recoil's `CTorpedoProjectile::Draw` — underwater missile with a
/// bubble trail. The body itself is a missile cone (Recoil ships a
/// `torpedo` model but our content layer doesn't always — fall back
/// to the generic cone). Bubble trails would need a distinct white-
/// cyan particle texture which isn't on our wire yet; with `texture2`
/// the missile trail builder produces a smoke trail that reads as
/// underwater wake without much fidelity loss at typical RTS zoom.
function buildTorpedoVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    return buildMissileVisual(def, scene, resolver);
}

/// Recoil's `CFireBallProjectile::Draw` — a bright, oversized billboard
/// (DGun being the canonical user) with an attached fire trail. The
/// generic billboard builder draws a 4×size camera-facing quad; here
/// we bump the visible footprint by 2× and force the tint toward fire
/// orange when the weapondef didn't author a colour, so the projectile
/// reads as a glowing flame rather than a generic sprite. Trail wiring
/// hooks the same `buildMissileTrailVisual` path missiles use — any
/// fireball weapon with a `texture2` set gets a smoke trail.
function buildFireballVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    const baseColor = resolveColor(def);
    // Default fireball colour: warm orange. Only override when the
    // def didn't carry an explicit RGB — defaultized DEFAULT_COLORS
    // entry is already orange-ish but resolveColor returns the
    // weapondef value when any of R/G/B is non-zero, so authored
    // colours win.
    const color: [number, number, number] = baseColor;
    const size = resolveSize(def);
    const intensity = resolveIntensity(def);
    const mat = makeMaterial(`projMat_${def.defId}`, scene, color, intensity);
    mat.disableLighting = true;
    mat.alphaMode = 1;               // additive — fireballs glow
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;

    const url = resolver?.resolve(def.texture1) ?? null;
    if (url) {
        const tex = new Texture(stampUrl(url), scene, /*noMipmap*/ false,
            /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;
        mat.diffuseTexture = tex;
        mat.useAlphaFromDiffuseTexture = true;
        mat.diffuseColor = new Color3(1, 1, 1);
    }

    // 2× the billboard's nominal footprint — Recoil's fireball reads
    // as substantially larger than a standard cannon shell.
    const baseDiameter = 8 * size;
    const mesh = MeshBuilder.CreatePlane(
        `proj_${def.defId}`,
        { size: baseDiameter, sideOrientation: Mesh.DOUBLESIDE },
        scene,
    );
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;
    mesh.alphaIndex = 1000;

    return {
        kind: 'instanced',
        defId: def.defId, mesh, material: mat,
        projectileType: def.projectileType, size, orientation: 'billboard',
    };
}

/// Recoil's `CLaserProjectile::Draw` — a velocity-aligned, length-
/// extending bolt with outer glow + inner core, plus optional head /
/// tail caps. `maxLength = duration × speed × SIM_TICKS_PER_SEC`
/// (matches Recoil's `weaponDef->duration * (speedf * GAME_SPEED)`).
/// curLength is integrated per render frame in `tick()` and consumed
/// by the laser-bolt pass to build the per-instance matrix.
///
/// Per bolt the renderer emits up to six thin instances:
///   - 1 shaft outer (colour, thickness)              — (dir1, dir) basis
///   - 1 shaft core  (colour2, thickness × coreThickness)
///   - 2 cap outer   (head + tail) when texture2 set  — (dir1, dir2) basis
///   - 2 cap core    (head + tail)
/// The cap basis is rotated 90° relative to the shaft so the cap quads
/// read as round end-glows perpendicular to the bolt rather than a
/// continuation of the shaft. Recoil's tex2 uses the same plane.
function buildLaserBoltVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): WeaponVisual {
    registerProjectileLaserShader();
    const color: [number, number, number] = resolveColor(def);
    // Default color2 to white when the def doesn't override — matches
    // Recoil's typical "white core inside coloured glow" appearance.
    const color2: [number, number, number] = (def.color2R > 0 || def.color2G > 0 || def.color2B > 0)
        ? [def.color2R, def.color2G, def.color2B]
        : [1, 1, 1];
    const intensity = resolveIntensity(def);
    // Recoil defaults thickness/coreThickness to non-zero values when
    // unset (see Sim/Weapons/WeaponDef.cpp). Use safe fallbacks here
    // for weapons that ship without explicit values.
    const thickness = def.thickness > 0 ? def.thickness : 2.0;
    const coreThickness = def.coreThickness > 0 ? def.coreThickness : 0.5;
    const maxLength = Math.max(1, def.duration * def.projectileSpeed * SIM_TICKS_PER_SEC);
    const speedf = def.projectileSpeed * SIM_TICKS_PER_SEC;

    // Helper: unit quad with additive material + emissive tint.
    // Source mesh is a 1×1 plane centered at origin, lying in the
    // local XY plane (front face = +Z). The per-frame matrix scales
    // and orients it per bolt. `name` is per-mesh so the Babylon
    // inspector can tell them apart.
    // Per-instance-tinted laser shaft material (Phase F item 3). `baseColor`
    // is the raw tint; the per-bolt `iIntensity` attribute folds in the
    // weapon-def intensity *and* the death fade, so each bolt dims on its
    // own over one shared draw path (no per-material special-casing).
    const mkQuad = (
        name: string,
        tex: string,
        c: [number, number, number],
    ): { mesh: Mesh; mat: ShaderMaterial } => {
        const mat = new ShaderMaterial(name + 'Mat', scene, 'projectileLaser', {
            attributes: ['position', 'uv', 'iIntensity'],
            uniforms: ['viewProjection', 'baseColor', 'hasTex'],
            samplers: ['tex'],
            defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
            needAlphaBlending: true,
        });
        mat.alphaMode = 1;               // additive
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.setColor3('baseColor', new Color3(c[0], c[1], c[2]));
        mat.setFloat('hasTex', 0);
        const url = resolver?.resolve(tex) ?? null;
        if (url) {
            const t = new Texture(stampUrl(url), scene, false, true,
                Texture.TRILINEAR_SAMPLINGMODE);
            t.hasAlpha = true;
            mat.setTexture('tex', t);
            mat.setFloat('hasTex', 1);
        }
        const mesh = MeshBuilder.CreatePlane(name,
            { size: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
        mesh.material = mat;
        mesh.isVisible = false;
        mesh.thinInstanceEnablePicking = false;
        mesh.alphaIndex = 1000;
        return { mesh, mat };
    };

    const shaftOuter = mkQuad(`laserShaft_${def.defId}`, def.texture1, color);
    const shaftCore  = mkQuad(`laserCore_${def.defId}`,  def.texture1, color2);

    // Caps use texture2. When the def has no texture2 we skip caps —
    // matches Recoil's `validTextures[2]` gate. The shaft alone still
    // looks correct; caps are a polish layer.
    let capOuterMesh: Mesh | null = null;
    let capOuterMat: ShaderMaterial | null = null;
    let capCoreMesh: Mesh | null = null;
    let capCoreMat: ShaderMaterial | null = null;
    if (def.texture2) {
        const co = mkQuad(`laserCapOuter_${def.defId}`, def.texture2, color);
        const cc = mkQuad(`laserCapCore_${def.defId}`,  def.texture2, color2);
        capOuterMesh = co.mesh; capOuterMat = co.mat;
        capCoreMesh  = cc.mesh; capCoreMat  = cc.mat;
    }

    return {
        kind: 'laserBolt',
        defId: def.defId,
        projectileType: def.projectileType,
        size: thickness,             // used by the generic fallback path
        shaftOuterMesh: shaftOuter.mesh, shaftOuterMaterial: shaftOuter.mat,
        shaftCoreMesh:  shaftCore.mesh,  shaftCoreMaterial:  shaftCore.mat,
        capOuterMesh, capOuterMaterial: capOuterMat,
        capCoreMesh,  capCoreMaterial:  capCoreMat,
        thickness, coreThickness,
        maxLength, speedf,
        hardStop: def.laserHardStop,
        intensityFalloff: intensity * (def.falloffRate > 0 ? def.falloffRate : 0.05),
    };
}

/// Module-level dispatch table keyed by Recoil's
/// `WEAPON_*_PROJECTILE` bitmask (`ProjectileType`). The renderer's
/// createVisual method consults this and falls back to the billboard
/// builder for anything unmapped. Each entry mirrors which
/// `CXxxProjectile::Draw` Recoil would invoke for that weapon class.
const visualBuilders: Partial<Record<number, VisualBuilder>> = {
    [ProjectileType.BeamLaser]:      buildBeamVisual,
    [ProjectileType.LargeBeamLaser]: buildBeamVisual,
    [ProjectileType.Lightning]:      buildLightningVisual,
    [ProjectileType.Missile]:        buildMissileVisual,
    [ProjectileType.Starburst]:      buildStarburstVisual,
    [ProjectileType.Torpedo]:        buildTorpedoVisual,
    [ProjectileType.Explosive]:      buildBillboardVisual,
    [ProjectileType.Emg]:            buildBillboardVisual,
    [ProjectileType.Flame]:          buildBillboardVisual,
    [ProjectileType.Fireball]:       buildFireballVisual,
    [ProjectileType.Laser]:          buildLaserBoltVisual,
};

/// Constructor-time fallback: a synthetic minimal def passed through
/// the billboard builder. Sized at 1.0 with the cannon default colour;
/// no texture lookup since the resolver isn't wired in yet at this
/// point. The fallback's `orientation` is therefore 'billboard' — fine,
/// since tick() will face it at the camera and the lack of texture
/// just gives us a tinted quad.
function createFallbackVisual(
    defId: number,
    projectileType: number,
    size: number,
    color: [number, number, number],
    intensity: number,
    scene: Scene,
): InstancedWeaponVisual {
    const mat = makeMaterial(`projMat_${defId}`, scene, color, intensity);
    const mesh = MeshBuilder.CreateSphere(`proj_${defId}`,
        { diameter: 4 * size, segments: 4 }, scene);
    mesh.material = mat;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;
    return {
        kind: 'instanced',
        defId, mesh, material: mat,
        projectileType, size, orientation: 'velocity',
    };
}

// CEG effect dispatch helpers (effectForFire / effectForImpact /
// impactContextFlags / classifyWeaponArchetype) live in
// weapon-fx-dispatch.ts so combat-fx can share them.

/// Build a unit-length direction. Prefers `vel` when non-zero; falls
/// back to the launch→target offset; yields (0,1,0) when both are
/// degenerate. Returned object is a fresh literal so callers can
/// store it without aliasing concerns; the call rate is bounded by
/// the projectile spawn rate, so allocation pressure is minimal.
function unitDirection(
    vx: number, vy: number, vz: number,
    fx: number, fy: number, fz: number,
): { x: number; y: number; z: number } {
    let len = Math.hypot(vx, vy, vz);
    if (len > 1e-3) {
        return { x: vx / len, y: vy / len, z: vz / len };
    }
    len = Math.hypot(fx, fy, fz);
    if (len > 1e-3) {
        return { x: fx / len, y: fy / len, z: fz / len };
    }
    return { x: 0, y: 1, z: 0 };
}
