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
import { registerProjectileBeamShader } from './shaders/projectile-beam.js';
import {
    type MissileTrailState,
    type MissileTrailVisual,
    buildMissileTrailVisual,
    createMissileTrailState,
    disposeMissileTrailVisual,
    flushMissileTrailVisual,
    isTrailFullyFaded,
    recordTrailPuff,
} from './projectile-trails.js';

/** Visual type enum — matches ProjectileVisualType in protocol.fbs */
const enum VisualType {
    Cannon = 0,
    Laser = 1,
    BeamLaser = 2,
    Missile = 3,
    Lightning = 4,
    Flame = 5,
}

/** Default colors per visual type when weapon def doesn't specify one. */
const DEFAULT_COLORS: Record<number, [number, number, number]> = {
    [VisualType.Cannon]:    [1.0, 0.8, 0.2],
    [VisualType.Laser]:     [1.0, 0.2, 0.2],
    [VisualType.BeamLaser]: [0.2, 1.0, 0.2],
    [VisualType.Missile]:   [0.8, 0.8, 0.8],
    [VisualType.Lightning]: [0.5, 0.5, 1.0],
    [VisualType.Flame]:     [1.0, 0.4, 0.0],
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
    visualType: number;
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
    /// Middle stretched-quad mesh + ShaderMaterial.
    mesh: Mesh;
    material: ShaderMaterial;
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

type WeaponVisual = InstancedWeaponVisual | BeamWeaponVisual | LightningWeaponVisual;

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
}

/** Active beam: from-point, to-point and birth time. Each tick the
 *  renderer rebuilds matrices for the beam visual it belongs to and
 *  pushes them as thin instances. The instance's per-frame alpha is
 *  derived in the fragment shader from `(now - bornAtMs) / lifeS`. */
interface LiveBeam {
    weaponDefId: number;
    fromX: number; fromY: number; fromZ: number;
    toX: number; toY: number; toZ: number;
    bornAtMs: number;
    lifeS: number;
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

/// Default tile length for beam textures (elmos per UV cycle along the
/// beam axis). Spring's `tilelength` weapondef field carries this
/// per-weapon; we don't yet plumb it through so each beam falls back
/// to this constant. Bumping the schema for a per-def override is
/// trivial follow-up if needed.
const DEFAULT_BEAM_TILE_LENGTH = 200;

/// Bit 18 of GameWeaponDef.flags — Spring's largeBeamLaser. Only weapons
/// with this set get UV-scrolling per Recoil semantics.
const FLAG_LARGE_BEAM_LASER = 1 << 18;

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
    /// Per-def smoke trail visuals (PLAN §4.4). Entries are created in
    /// setWeaponDefs only for missile-typed defs whose `texture2`
    /// resolves to a URL; missiles of unconfigured defs render as a
    /// .glb model + cone with no trail.
    private trailVisuals = new Map<number, MissileTrailVisual>();
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
        this.fallbackVisual = createFallbackVisual(0, VisualType.Cannon, 1.0,
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

    /** Replace the per-weapon-def visual templates. Defs that reference
     *  a real `.glb` model URL (e.g. ZK missiles, plasma cannons) get
     *  their procedural placeholder swapped out asynchronously once the
     *  model finishes loading; the rest stick with per-visual-type
     *  procedural shapes. */
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
        // Live projectiles' `trail` references now point at disposed
        // visuals — clear the field so a stale state doesn't leak
        // into the next flush. Bodies stay live; trails just stop.
        for (const p of this.live.values()) p.trail = null;

        for (const def of defs) {
            const visual = this.createVisual(def);
            this.weaponVisuals.set(def.defId, visual);
            this.weaponDefs.set(def.defId, def);

            // If the server announced a model URL, kick off a background
            // load and swap the procedural mesh once it completes. The
            // procedural shape stays in place during the load so the
            // first few frames of fire still render something.
            if (def.modelUrl) {
                const size = Math.max(0.5, def.size > 0 ? def.size : 1.0);
                this.swapInModel(def.defId, def.modelUrl, size).catch((e) => {
                    console.warn(`[projectile] model load failed for def ${def.defId} (${def.modelUrl}):`, e);
                });
            }

            // Trail visual is only built for missile-typed defs and
            // only when the resolver hands back a real URL for the
            // smoketrail slot. Other visual types either have no
            // trail concept (cannon, beam) or already render their
            // own (lightning is hit-scan and doesn't trail).
            if (def.visualType === VisualType.Missile) {
                const tv = buildMissileTrailVisual(def, this.scene, this.textureResolver);
                if (tv) this.trailVisuals.set(def.defId, tv);
            }
        }

        this.scheduleResolverRebuild();
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
        const builder = visualBuilders[def.visualType as VisualType] ?? buildBillboardVisual;
        return builder(def, this.scene, this.textureResolver);
    }

    /** Async path: load a `.glb`, merge its meshes, and replace the
     *  per-def WeaponVisual's procedural mesh in-place so the next
     *  `tick()` renders thin-instances against the loaded geometry. */
    private async swapInModel(defId: number, modelUrl: string, size: number): Promise<void> {
        const lastSlash = modelUrl.lastIndexOf('/');
        const baseUrl = modelUrl.substring(0, lastSlash + 1);
        const fileName = modelUrl.substring(lastSlash + 1);

        const result = await SceneLoader.ImportMeshAsync(
            '', baseUrl, stampUrl(fileName), this.scene,
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

        // Hit-scan weapons (beam laser, lightning) don't move — render
        // the bolt as a one-shot line from launch pos to impact pos and
        // skip the live-projectile tracking entirely.
        if (ev.hitscan) {
            this.spawnBeam(ev.weaponDefId, ev.pos, ev.targetPos,
                ev.ttl > 0 ? ev.ttl / SIM_TICKS_PER_SEC : DEFAULT_BEAM_LIFE_S);
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
        });
    }

    /** Push a beam onto the live list. The beam pass in `tick()` rebuilds
     *  per-instance matrices and uniforms from these entries every render
     *  frame; expired beams are dropped when `now - bornAtMs > lifeS`.
     *  Beams whose weapon def doesn't have a beam visual still get
     *  recorded but are skipped at render time — the data is harmless. */
    private spawnBeam(weaponDefId: number, from: { x: number; y: number; z: number },
                      to: { x: number; y: number; z: number }, lifeS: number): void {
        // Cap visual duration; long-lived beams just overdraw without
        // adding information once the texture has scrolled fully.
        const clamped = Math.min(lifeS, MAX_BEAM_DURATION_S);
        this.liveBeams.push({
            weaponDefId,
            fromX: from.x, fromY: from.y, fromZ: from.z,
            toX: to.x,     toY: to.y,     toZ: to.z,
            bornAtMs: performance.now(),
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
                this.cegRuntime.spawn(fxName,
                    ev.pos.x, ev.pos.y, ev.pos.z,
                    0, 1, 0, damage);
            }
        }
        if (!p) return;
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

    /** Server reported a trajectory change (bounce / steered). Override
     *  pos+vel in place. */
    onTrajectory(ev: {
        projId: number;
        pos: { x: number; y: number; z: number };
        vel: { x: number; y: number; z: number };
    }): void {
        const p = this.live.get(ev.projId);
        if (!p) return;
        const vps = SIM_TICKS_PER_SEC;
        p.pos.copyFromFloats(ev.pos.x, ev.pos.y, ev.pos.z);
        p.vel.copyFromFloats(ev.vel.x * vps, ev.vel.y * vps, ev.vel.z * vps);
    }

    // ── Per-render-frame integration + draw ─────────────────────────────────

    /** Advance every live projectile by `dtMs` milliseconds, then push
     *  thin-instance buffers per weapon def. Call from the render loop. */
    tick(): void {
        const nowMs = performance.now();
        const dt = Math.min((nowMs - this.lastTickMs) / 1000, 0.1);
        this.lastTickMs = nowMs;

        // 0. Cull expired beams. Fade is computed in the fragment
        //    shader from (now - bornAtMs) / lifeS; we just drop entries
        //    that have aged past their lifetime so the per-tick matrix
        //    rebuild stays bounded.
        for (let i = this.liveBeams.length - 1; i >= 0; i--) {
            const b = this.liveBeams[i];
            if ((nowMs - b.bornAtMs) / 1000 > b.lifeS) {
                this.liveBeams.splice(i, 1);
            }
        }

        // 1. Integrate motion + cull expired/orphan entries. Trail
        //    states on TTL/orphan-culled projectiles get retired to
        //    `orphanedTrails` rather than dropped — same rationale as
        //    onImpact, just for the case where no impact event arrived.
        const nowSec = nowMs / 1000;
        const dead: number[] = [];
        for (const p of this.live.values()) {
            if (p.hitscan) {
                // Should never happen — hit-scan goes through spawnBeam.
                dead.push(p.id);
                continue;
            }
            // pos += vel * dt
            p.pos.x += p.vel.x * dt;
            p.pos.y += p.vel.y * dt;
            p.pos.z += p.vel.z * dt;
            // vel.y -= g * dt   (g positive pulls down)
            p.vel.y -= p.gravity * dt;

            // Record a puff at the missile's post-integration position.
            // recordTrailPuff throttles internally — this call is cheap
            // enough that we don't need to gate it further.
            if (p.trail) {
                recordTrailPuff(p.trail, p.pos.x, p.pos.y, p.pos.z, nowSec);
            }

            if (p.ttl > 0) {
                p.ttl -= dt;
                if (p.ttl <= 0) dead.push(p.id);
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
        //    Live projectiles whose weapon-def maps to a beam visual
        //    fall back to the fallback mesh — a non-hitscan beam-typed
        //    projectile is unusual and the procedural sphere is at
        //    least drawable. Hitscan beams take the dedicated beam
        //    pass below.
        const groups = new Map<number, LiveProjectile[]>();
        for (const p of this.live.values()) {
            const v = this.weaponVisuals.get(p.weaponDefId);
            const key = v && v.kind === 'instanced' ? p.weaponDefId : -1;
            let g = groups.get(key);
            if (!g) { g = []; groups.set(key, g); }
            g.push(p);
        }

        const updated = new Set<number>();
        const tmpQ = new Quaternion();
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

        // 4. Beam pass — group live beams by weapon def, build the
        //    custom matrix layout that the projectile-beam shader
        //    expects (axis vector, midpoint, halfWidth, birthSec
        //    packed into the matrix' free slots), and update the
        //    per-def `time` uniform.
        const beamGroups = new Map<number, LiveBeam[]>();
        for (const b of this.liveBeams) {
            const v = this.weaponVisuals.get(b.weaponDefId);
            if (!v || v.kind !== 'beam') continue;
            let g = beamGroups.get(b.weaponDefId);
            if (!g) { g = []; beamGroups.set(b.weaponDefId, g); }
            g.push(b);
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
                const birthSec = b.bornAtMs / 1000;
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
            visual.material.setFloat('time', nowSec);
            beamUpdated.add(defId);

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
            flushMissileTrailVisual(visual, states, nowSec,
                camX, camY, camZ,
                tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale);
        }

        // Evict orphaned trails whose every puff has aged past the
        // lifetime — keeping them in the list would just inflate the
        // per-tick group iteration with no visible effect.
        for (let i = this.orphanedTrails.length - 1; i >= 0; i--) {
            if (isTrailFullyFaded(this.orphanedTrails[i].state, nowSec)) {
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
    return DEFAULT_COLORS[def.visualType] ?? DEFAULT_COLORS[VisualType.Cannon];
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
    v.mesh.dispose();
    v.material.dispose();
    if (v.kind === 'beam') {
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
        visualType: def.visualType, size, orientation: 'billboard',
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
    // Across-axis half-thickness. Spring's `thickness` weapondef field
    // isn't on our wire yet; size*2 produces visually similar beams for
    // ZK weapons until a per-def override is added.
    const halfWidth = Math.max(0.5, size * 2);
    // Visible duration: prefer the weapon's beam duration, else the
    // hit-scan default; cap at MAX_BEAM_DURATION_S to bound overdraw.
    const duration = Math.min(
        MAX_BEAM_DURATION_S,
        def.duration > 0 ? def.duration : DEFAULT_BEAM_LIFE_S,
    );
    const isLargeBeam = (def.flags & FLAG_LARGE_BEAM_LASER) !== 0;
    // Recoil semantics: only the Large variant scrolls. scrollSpeed
    // defaults to Spring's 5.0 on every weapon — the gate below is what
    // makes plain BeamLaser render as a static stripe.
    const scrollRate = isLargeBeam ? def.scrollSpeed : 0;

    const middleUrl = resolver?.resolve(def.texture1) ?? null;
    const startCapUrl = resolver?.resolve(def.texture2) ?? null;
    const endCapUrl = resolver?.resolve(def.texture3) ?? null;

    const mat = new ShaderMaterial(`projBeamMat_${def.defId}`, scene, 'projectileBeam', {
        attributes: ['position', 'uv'],
        uniforms: ['world', 'viewProjection', 'cameraPosition',
                   'baseColor', 'time', 'scrollRate', 'tileLength', 'duration'],
        samplers: ['beamTex'],
        defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
    });
    mat.setColor3('baseColor', new Color3(color[0], color[1], color[2]));
    mat.setFloat('time', 0);
    mat.setFloat('scrollRate', scrollRate);
    mat.setFloat('tileLength', DEFAULT_BEAM_TILE_LENGTH);
    mat.setFloat('duration', duration);
    // Premultiplied-alpha additive — same convention as the build-beam
    // shader. Pairs with the fragment shader's `vec4(rgb*a, a)` output.
    mat.alphaMode = 7;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;

    if (middleUrl) {
        const tex = new Texture(stampUrl(middleUrl), scene, /*noMipmap*/ false,
            /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;
        // The middle texture tiles along the length axis; tell the
        // sampler to wrap there. UV.x stays in [0,1] across the
        // thickness so clamp doesn't hurt either, but wrap on both
        // axes is fine and simpler.
        tex.wrapU = Texture.WRAP_ADDRESSMODE;
        tex.wrapV = Texture.WRAP_ADDRESSMODE;
        mat.setTexture('beamTex', tex);
    }

    // Unit quad in XY centred on origin. Vertex shader rebuilds the
    // camera-facing across-axis per frame.
    const mesh = MeshBuilder.CreatePlane(
        `projBeam_${def.defId}`,
        { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE },
        scene,
    );
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.alphaIndex = 1000;

    // Start / end cap meshes. Each is a billboarded quad sharing the
    // beam's tint, with the tex2/tex3 texture if it resolves. We build
    // them as standard sprite-billboard meshes — tick() composes the
    // per-instance matrix with billboard rotation at the from/to
    // endpoint, identical to the cannon builder's billboard logic.
    const { mesh: startCapMesh, material: startCapMat } = buildBeamCap(
        `projBeamStart_${def.defId}`, startCapUrl, color, size, scene);
    const { mesh: endCapMesh, material: endCapMat } = buildBeamCap(
        `projBeamEnd_${def.defId}`, endCapUrl, color, size, scene);

    return {
        kind: 'beam',
        defId: def.defId, mesh, material: mat,
        visualType: def.visualType, size,
        duration, halfWidth, tileLength: DEFAULT_BEAM_TILE_LENGTH, scrollRate,
        startCapMesh, startCapMaterial: startCapMat,
        endCapMesh, endCapMaterial: endCapMat,
    };
}

/// Build a beam end-cap sprite. Returns null mesh+material when no
/// texture URL is supplied — caller treats this as "skip the cap".
function buildBeamCap(
    name: string,
    url: string | null,
    color: [number, number, number],
    size: number,
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
        { size: Math.max(2, size * 4), sideOrientation: Mesh.DOUBLESIDE },
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
        visualType: def.visualType,
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
        visualType: def.visualType, size, orientation: 'velocity',
    };
}

/// Module-level dispatch table keyed by visual type. The renderer's
/// createVisual method consults this and falls back to the billboard
/// builder for unknown types (their look as a flat coloured quad is
/// at least distinguishable from beams/missiles).
const visualBuilders: Partial<Record<VisualType, VisualBuilder>> = {
    [VisualType.Cannon]:    buildBillboardVisual,
    [VisualType.Flame]:     buildBillboardVisual,
    [VisualType.Laser]:     buildBeamVisual,
    [VisualType.BeamLaser]: buildBeamVisual,
    [VisualType.Lightning]: buildLightningVisual,
    [VisualType.Missile]:   buildMissileVisual,
};

/// Constructor-time fallback: a synthetic minimal def passed through
/// the billboard builder. Sized at 1.0 with the cannon default colour;
/// no texture lookup since the resolver isn't wired in yet at this
/// point. The fallback's `orientation` is therefore 'billboard' — fine,
/// since tick() will face it at the camera and the lack of texture
/// just gives us a tinted quad.
function createFallbackVisual(
    defId: number,
    visualType: number,
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
        visualType, size, orientation: 'velocity',
    };
}

// ── CEG effect dispatch ────────────────────────────────────────────────────
//
// Maps weapon visual types and impact kinds to named effects in the
// CEG runtime's built-in library. Phase 5b will replace this with
// per-weapon-def `cegtag` / `explosionGenerator` lookups streamed from
// the server; for now the visual type is a coarse-but-useful proxy.

/// Mirror of `SpringWeb::ProjectileImpactKind` in protocol.fbs (also
/// duplicated in combat-fx.ts). Kept local to the file rather than
/// shared because the impact kind is the only enum the renderer reads
/// from the impact event and the protocol is stable.
const enum ImpactKind {
    Terrain = 0,
    Unit = 1,
    Feature = 2,
    Shield = 3,
    SelfDetonate = 4,
    Intercepted = 5,
    Other = 6,
}

/// Coarse archetype tag for a weapon def. Phase 5b dispatches the
/// CEG library by archetype rather than raw visualType so a few
/// hand-ported ZK CEG ports (`disintegrator` etc.) can override the
/// generic muzzle/impact effects. The classifier is heuristic — ZK's
/// real CEG dispatch goes through `cegtag` strings on the weapon def
/// which we don't carry over the wire yet (lands with Phase 5c). For
/// now we look at typeName, weapon name, and a couple of texture/
/// size hints. Returns 'default' when nothing matches; callers fall
/// back to visualType-keyed generic effects in that case.
type WeaponArchetype =
    | 'disintegrator'
    | 'flame'
    | 'lightninggun'
    | 'largelaser'
    | 'lightcannon'
    | 'default';

function classifyWeaponArchetype(def: WeaponDefInfo | undefined): WeaponArchetype {
    if (!def) return 'default';
    const name = (def.name || '').toLowerCase();
    const tex1 = (def.texture1 || '').toLowerCase();
    const typeName = (def.typeName || '').toLowerCase();
    if (typeName === 'dgun' || name.includes('disintegrat')) return 'disintegrator';
    if (typeName === 'flame' || def.visualType === VisualType.Flame) return 'flame';
    if (typeName === 'lightningcannon' || def.visualType === VisualType.Lightning
        || name.includes('lightning')) return 'lightninggun';
    if (tex1.includes('largelaser')
        || (def.visualType === VisualType.BeamLaser && def.size > 4)) {
        return 'largelaser';
    }
    if (def.visualType === VisualType.Cannon && def.size <= 4) return 'lightcannon';
    return 'default';
}

/// Per-archetype muzzle flash. Returning null skips the muzzle CEG
/// entirely — used for beam/lightning weapons where the bolt itself
/// is the muzzle visual and a separate flash would just add overdraw.
const FIRE_EFFECT_BY_ARCHETYPE: Record<WeaponArchetype, string | null> = {
    disintegrator: 'muzzleflash_disintegrator',
    flame:         'muzzleflash_flame',
    lightninggun:  'muzzleflash_lightninggun',
    largelaser:    null,
    lightcannon:   'muzzleflash_default',
    default:       null,
};

/// Per-archetype impact effect. Each entry covers the most common
/// terrain/feature/self-detonate impact case; shield deflections
/// always render `impact_shield` regardless of archetype, and Unit
/// impacts are ceded to combat-fx (see effectForImpact below).
const IMPACT_EFFECT_BY_ARCHETYPE: Record<WeaponArchetype, string | null> = {
    disintegrator: 'impact_disintegrator',
    flame:         'impact_flame',
    lightninggun:  'impact_lightninggun',
    largelaser:    'impact_largelaser',
    lightcannon:   'impact_lightcannon',
    default:       null,
};

/// Pick the muzzle CEG name for a weapon. The streamed `cegTag`
/// (Spring's per-frame trail CEG) is checked first — that's what
/// game authors actually want fired in-flight; archetype/visualType
/// fallbacks only run when no tag is set. Returning null skips the
/// muzzle entirely (beam/lightning weapons where the bolt is the
/// visual).
function effectForFire(def: WeaponDefInfo | undefined): string | null {
    if (def?.cegTag) return def.cegTag;

    const arch = classifyWeaponArchetype(def);
    const archEffect = FIRE_EFFECT_BY_ARCHETYPE[arch];
    if (archEffect !== null || arch !== 'default') return archEffect;
    switch (def?.visualType) {
        case VisualType.Laser:
        case VisualType.BeamLaser:
        case VisualType.Lightning:
            return null;
        case VisualType.Missile:
            return 'muzzleflash_missile';
        case VisualType.Cannon:
        case VisualType.Flame:
        default:
            return 'muzzleflash_default';
    }
}

/// Pick the impact CEG name from impact kind + weapon archetype.
/// Impact kind is checked first: shield deflections always render
/// `impact_shield`; Unit impacts return null because combat-fx
/// already spawns a kill explosion from the matching CombatEvent
/// (doubling reads as a flash). Otherwise the archetype dispatch
/// runs, with a final visualType-keyed fallback.
function effectForImpact(
    impactKind: number,
    def: WeaponDefInfo | undefined,
): string | null {
    const kind = impactKind as ImpactKind;
    if (kind === ImpactKind.Shield) return 'impact_shield';
    if (kind === ImpactKind.Unit) return null;

    // Streamed `explosionGenerator` wins over heuristic dispatch — it's
    // the authored impact CEG the game's weapon def explicitly names.
    // Falls through to archetype fallback when unset.
    if (def?.explosionGenerator) return def.explosionGenerator;

    const arch = classifyWeaponArchetype(def);
    const archEffect = IMPACT_EFFECT_BY_ARCHETYPE[arch];
    if (archEffect !== null) return archEffect;

    switch (kind) {
        case ImpactKind.Terrain:
        case ImpactKind.Feature:
            return 'impact_dirt';
        case ImpactKind.SelfDetonate:
        case ImpactKind.Intercepted:
        case ImpactKind.Other:
        default:
            return 'impact_explosion';
    }
}

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
