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
    StandardMaterial,
    Color3,
    Color4,
    Matrix,
    Vector3,
    Quaternion,
    LinesMesh,
    SceneLoader,
} from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';

import type { WeaponDefInfo } from './connection.js';
import { stampUrl } from '../config.js';

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

/** Per-weapon-def rendering template + cached size. The mesh and material
 *  are mutable because async model loads (see `swapInModel`) replace the
 *  procedural placeholder once the `.glb` finishes loading. */
interface WeaponVisual {
    defId: number;
    mesh: Mesh;
    material: StandardMaterial;
    visualType: number;
    /// Average projectile size — used to scale the thin instance mesh in y.
    size: number;
}

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
}

/** Active hit-scan beam: a line from launch pos to impact pos with a
 *  short fade-out. Disposed when its lifetime hits zero. */
interface BeamFx {
    line: LinesMesh;
    /// Lifetime remaining in seconds.
    lifeS: number;
    /// Initial lifetime — used to compute the fade-out alpha.
    initialLifeS: number;
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

export class ProjectileRenderer {
    private scene: Scene;
    private weaponVisuals = new Map<number, WeaponVisual>();
    private fallbackVisual: WeaponVisual;
    private live = new Map<number, LiveProjectile>();
    private beams: BeamFx[] = [];
    private lastTickMs = performance.now();

    constructor(scene: Scene) {
        this.scene = scene;
        this.fallbackVisual = this.createVisual(0, VisualType.Cannon, 1.0, [1, 0.8, 0.2], 0.8);
    }

    /** Replace the per-weapon-def visual templates. Defs that reference
     *  a real `.glb` model URL (e.g. ZK missiles, plasma cannons) get
     *  their procedural placeholder swapped out asynchronously once the
     *  model finishes loading; the rest stick with per-visual-type
     *  procedural shapes. */
    setWeaponDefs(defs: WeaponDefInfo[]): void {
        for (const v of this.weaponVisuals.values()) {
            v.mesh.dispose();
            v.material.dispose();
        }
        this.weaponVisuals.clear();

        for (const def of defs) {
            const hasColor = def.colorR > 0 || def.colorG > 0 || def.colorB > 0;
            const color: [number, number, number] = hasColor
                ? [def.colorR, def.colorG, def.colorB]
                : (DEFAULT_COLORS[def.visualType] ?? DEFAULT_COLORS[VisualType.Cannon]);

            const size = Math.max(0.5, def.size > 0 ? def.size : 1.0);
            const intensity = def.intensity > 0 ? def.intensity : 0.8;

            const visual = this.createVisual(def.defId, def.visualType, size, color, intensity);
            this.weaponVisuals.set(def.defId, visual);

            // If the server announced a model URL, kick off a background
            // load and swap the procedural mesh once it completes. The
            // procedural shape stays in place during the load so the
            // first few frames of fire still render something.
            if (def.modelUrl) {
                this.swapInModel(def.defId, def.modelUrl, size).catch((e) => {
                    console.warn(`[projectile] model load failed for def ${def.defId} (${def.modelUrl}):`, e);
                });
            }
        }
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
        if (!visual) {
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
        // but our procedural shapes were `4*size` elmos across. Scale
        // the model down so the loaded geometry sits in the same size
        // bracket as the procedural fallback would have.
        const targetExtent = 4 * size;
        const bb = merged.getBoundingInfo().boundingBox;
        const longest = Math.max(
            bb.maximum.x - bb.minimum.x,
            bb.maximum.y - bb.minimum.y,
            bb.maximum.z - bb.minimum.z,
        );
        if (longest > 1e-3) {
            const s = targetExtent / longest;
            merged.scaling.set(s, s, s);
            merged.bakeCurrentTransformIntoVertices();
        }

        // Replace the procedural mesh on the visual and dispose it.
        // Material reuse: the loaded model's material is fine, but if
        // it has no emissive component the projectile won't glow — copy
        // the procedural visual's emissive across.
        const oldMesh = visual.mesh;
        const oldMat = visual.material;
        visual.mesh = merged;
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
        });
    }

    /** Spawn a one-shot beam mesh between two world points. The beam
     *  fades out over `lifeS` seconds and is then disposed. */
    private spawnBeam(weaponDefId: number, from: { x: number; y: number; z: number },
                      to: { x: number; y: number; z: number }, lifeS: number): void {
        const visual = this.weaponVisuals.get(weaponDefId) ?? this.fallbackVisual;
        const colDiffuse = visual.material.diffuseColor;
        // Brighten colour a touch — laser bolts read better as near-white cores.
        const r = Math.min(1, colDiffuse.r + 0.3);
        const g = Math.min(1, colDiffuse.g + 0.3);
        const b = Math.min(1, colDiffuse.b + 0.3);

        const line = MeshBuilder.CreateLines(`beam_${weaponDefId}`, {
            points: [
                new Vector3(from.x, from.y, from.z),
                new Vector3(to.x, to.y, to.z),
            ],
            colors: [
                new Color4(r, g, b, 1),
                new Color4(r, g, b, 1),
            ],
            updatable: false,
        }, this.scene);
        line.alphaIndex = 1000;
        line.isPickable = false;
        line.color = new Color3(r, g, b);
        // LinesMesh has no material that respects alpha out of the box —
        // fade by scaling alpha on the underlying material if present, or
        // re-render every tick by interpolating colour. Using `alpha` on
        // the mesh works because Babylon multiplies the per-vertex colour
        // by `mesh.color * mesh.alpha`.

        this.beams.push({ line, lifeS, initialLifeS: lifeS });
    }

    /** Server reported an impact. Remove the local entry; combat-fx
     *  spawns the impact VFX from the same event batch. */
    onImpact(ev: { projId: number; pos: { x: number; y: number; z: number } }): void {
        if (!this.live.delete(ev.projId)) return;
        // The position snapshot in the event drives the VFX (see combat-fx);
        // we don't need to keep the local entry alive for one more tick
        // because the impact VFX renders at the event position directly.
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

        // 0. Tick beams (hit-scan one-shot lines). Fade out over their
        //    lifetime and dispose when expired.
        for (let i = this.beams.length - 1; i >= 0; i--) {
            const b = this.beams[i];
            b.lifeS -= dt;
            if (b.lifeS <= 0) {
                b.line.dispose();
                this.beams.splice(i, 1);
                continue;
            }
            const t = Math.max(0, Math.min(1, b.lifeS / b.initialLifeS));
            b.line.alpha = t;
        }

        // 1. Integrate motion + cull expired/orphan entries.
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

            if (p.ttl > 0) {
                p.ttl -= dt;
                if (p.ttl <= 0) dead.push(p.id);
            }
            if (nowMs - p.spawnedAtMs > MAX_ORPHAN_LIFE_MS) dead.push(p.id);
        }
        for (const id of dead) this.live.delete(id);

        // 2. Group by weapon def and push thin-instance buffers.
        const groups = new Map<number, LiveProjectile[]>();
        for (const p of this.live.values()) {
            const key = this.weaponVisuals.has(p.weaponDefId) ? p.weaponDefId : -1;
            let g = groups.get(key);
            if (!g) { g = []; groups.set(key, g); }
            g.push(p);
        }

        const updated = new Set<number>();
        const tmpQ = new Quaternion();
        const tmpScale = new Vector3(1, 1, 1);
        for (const [key, projs] of groups) {
            const visual = key === -1 ? this.fallbackVisual : this.weaponVisuals.get(key)!;
            const matrices = new Float32Array(projs.length * 16);
            for (let i = 0; i < projs.length; i++) {
                const p = projs[i];
                // Orient the mesh along its velocity vector for missile/laser shapes.
                const len = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
                if (len > 1e-3) {
                    const dirX = p.vel.x / len, dirY = p.vel.y / len, dirZ = p.vel.z / len;
                    const upDot = dirY;
                    const axisX = -dirZ, axisZ = dirX;
                    const angle = Math.acos(Math.max(-1, Math.min(1, upDot)));
                    Quaternion.RotationAxisToRef(new Vector3(axisX, 0, axisZ), angle, tmpQ);
                } else {
                    tmpQ.set(0, 0, 0, 1);
                }
                Matrix.ComposeToRef(tmpScale, tmpQ, p.pos, Matrix.Identity());
                const m = Matrix.Compose(tmpScale, tmpQ, p.pos);
                m.copyToArray(matrices, i * 16);
            }
            visual.mesh.isVisible = true;
            visual.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
            visual.mesh.thinInstanceCount = projs.length;
            updated.add(key);
        }

        // 3. Hide visuals with no live projectiles this frame.
        for (const [defId, visual] of this.weaponVisuals) {
            if (!updated.has(defId)) {
                visual.mesh.isVisible = false;
                visual.mesh.thinInstanceCount = 0;
            }
        }
        if (!updated.has(-1)) {
            this.fallbackVisual.mesh.isVisible = false;
            this.fallbackVisual.mesh.thinInstanceCount = 0;
        }
    }

    /** Number of live projectiles tracked client-side. */
    get count(): number {
        return this.live.size;
    }

    dispose(): void {
        for (const v of this.weaponVisuals.values()) {
            v.mesh.dispose();
            v.material.dispose();
        }
        this.weaponVisuals.clear();
        this.fallbackVisual.mesh.dispose();
        this.fallbackVisual.material.dispose();
        this.live.clear();
        for (const b of this.beams) b.line.dispose();
        this.beams = [];
    }

    private createVisual(
        defId: number,
        visualType: number,
        size: number,
        color: [number, number, number],
        intensity: number,
    ): WeaponVisual {
        const mat = new StandardMaterial(`projMat_${defId}`, this.scene);
        mat.diffuseColor = new Color3(color[0], color[1], color[2]);
        mat.emissiveColor = new Color3(
            color[0] * intensity,
            color[1] * intensity,
            color[2] * intensity,
        );
        mat.specularColor = new Color3(0, 0, 0);

        let mesh: Mesh;
        const baseDiameter = 4 * size;

        switch (visualType) {
            case VisualType.Laser:
                mesh = MeshBuilder.CreateCylinder(
                    `proj_${defId}`, { diameter: baseDiameter * 0.4, height: baseDiameter * 3, tessellation: 6 }, this.scene);
                break;
            case VisualType.BeamLaser:
                mesh = MeshBuilder.CreateCylinder(
                    `proj_${defId}`, { diameter: baseDiameter * 0.2, height: baseDiameter * 6, tessellation: 6 }, this.scene);
                break;
            case VisualType.Missile:
                mesh = MeshBuilder.CreateCylinder(
                    `proj_${defId}`, { diameterTop: 0, diameterBottom: baseDiameter * 0.8, height: baseDiameter * 2, tessellation: 6 }, this.scene);
                break;
            case VisualType.Lightning:
            case VisualType.Flame:
                mesh = MeshBuilder.CreateSphere(
                    `proj_${defId}`, { diameter: baseDiameter * 0.6, segments: 4 }, this.scene);
                break;
            case VisualType.Cannon:
            default:
                mesh = MeshBuilder.CreateSphere(
                    `proj_${defId}`, { diameter: baseDiameter, segments: 4 }, this.scene);
                break;
        }

        mesh.material = mat;
        mesh.isVisible = false;
        mesh.thinInstanceEnablePicking = false;

        return { defId, mesh, material: mat, visualType, size };
    }
}
