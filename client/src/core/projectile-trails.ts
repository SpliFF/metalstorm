/**
 * Missile smoke trails (PLAN-projectiles.md §4.4).
 *
 * Each live missile owns a `MissileTrailState` ring buffer of recent
 * puff positions. Once per render tick the projectile renderer calls
 * `recordTrailPuff` with the missile's current position; if more than
 * `TRAIL_SPAWN_INTERVAL_MS` has passed since the last puff, a new one
 * overwrites the oldest slot.
 *
 * One `MissileTrailVisual` per weapon def owns the GPU resources: a
 * unit quad mesh + ShaderMaterial with the resolved `texture2` (the
 * Spring smoketrail slot). Per render tick the renderer flushes every
 * live + orphaned puff into the visual's thin-instance + per-instance
 * alpha buffers via `flushMissileTrailVisual`.
 *
 * When a missile impacts, its trail state is moved to an orphaned
 * list rather than discarded — the puffs continue to fade out as they
 * age, matching Spring's behaviour where smoke lingers after the
 * projectile dies. Orphaned trails are evicted once every puff has
 * aged past `TRAIL_LIFETIME_S`.
 *
 * Texture resolution is delegated to `ProjectileTextureResolver`.
 * If a def's `texture2` doesn't resolve to a URL (resolver miss or
 * the def doesn't carry a smoketrail slot at all), `buildMissile-
 * TrailVisual` returns null and the renderer simply skips trail
 * tracking for missiles of that def — the .glb body still renders.
 */

import {
    Scene,
    Mesh,
    MeshBuilder,
    ShaderMaterial,
    Color3,
    Matrix,
    Vector3,
    Quaternion,
    Texture,
} from '@babylonjs/core';

import type { WeaponDefInfo } from './connection.js';
import { stampUrl } from '../config.js';
import type { ProjectileTextureResolver } from './projectile-texture-resolver.js';
import { registerProjectileTrailShader } from './shaders/projectile-trail.js';

/// Number of slots in each missile's trail ring buffer. 12 is the
/// plan's recommended count — long enough to read as a contiguous
/// trail at the spawn cadence below, short enough that per-frame
/// matrix composition for hundreds of missiles stays cheap.
export const TRAIL_PUFF_COUNT = 12;

/// Puff lifetime in seconds. Alpha fades linearly from 1 at birth to
/// 0 at this age. Combined with the spawn interval below, an in-
/// flight missile maintains roughly TRAIL_LIFETIME_S * (1000 /
/// TRAIL_SPAWN_INTERVAL_MS) ≈ 18 visible puffs at any instant — the
/// ring buffer's 12-slot cap then overwrites the oldest, which is
/// fine because they've already faded most of the way to zero.
export const TRAIL_LIFETIME_S = 1.5;

/// Minimum interval between puff spawns. Drops the per-frame work to
/// at most one buffer write per missile; faster missiles still get
/// a contiguous trail because their 100ms-spaced puffs are spaced
/// out in world space by their velocity * 0.1s.
export const TRAIL_SPAWN_INTERVAL_MS = 100;

/// Per-projectile ring buffer. Positions are flat (x,y,z per puff)
/// for cache locality and to avoid per-puff Vector3 allocations on
/// the per-tick recordTrailPuff hot path.
export interface MissileTrailState {
    /// TRAIL_PUFF_COUNT * 3 floats, slot i at offset i*3.
    positions: Float32Array;
    /// Birth timestamp in seconds for each slot; -1 means empty.
    birthSecs: Float32Array;
    /// Index of the slot the next spawn will write to (wraps mod
    /// TRAIL_PUFF_COUNT). Always points at the oldest live slot once
    /// the buffer has been filled, since we overwrite oldest-first.
    nextSlot: number;
    /// Last spawn time in seconds; throttle key for recordTrailPuff.
    lastSpawnSec: number;
}

/// Per-weapon-def GPU resources for trail puffs. The mesh and
/// material are reused across every live and orphaned trail of this
/// def; per-puff variance is encoded in the world matrix and the
/// per-instance alpha attribute.
export interface MissileTrailVisual {
    defId: number;
    mesh: Mesh;
    material: ShaderMaterial;
    /// Per-puff base size in elmos (square quad side length). Carried
    /// here so flushMissileTrailVisual doesn't need to look it up
    /// from a WeaponDefInfo on every tick.
    size: number;
}

/// Allocate a fresh ring buffer for a missile that just spawned.
/// All slots are marked empty (birthSecs = -1) so the first
/// flush will skip them until recordTrailPuff populates one.
export function createMissileTrailState(): MissileTrailState {
    const birthSecs = new Float32Array(TRAIL_PUFF_COUNT);
    birthSecs.fill(-1);
    return {
        positions: new Float32Array(TRAIL_PUFF_COUNT * 3),
        birthSecs,
        nextSlot: 0,
        // -Infinity so the first call to recordTrailPuff always spawns,
        // regardless of how soon after construction it happens.
        lastSpawnSec: -Infinity,
    };
}

/// Build the per-def trail visual. Returns null when the resolver
/// can't supply a texture URL for `def.texture2` — caller should
/// then skip trail tracking for missiles of this def entirely.
/// `tint` defaults to the def's color when set, otherwise white so
/// the texture's own color shows through.
export function buildMissileTrailVisual(
    def: WeaponDefInfo,
    scene: Scene,
    resolver: ProjectileTextureResolver | null,
): MissileTrailVisual | null {
    const url = resolver?.resolve(def.texture2) ?? null;
    if (!url) return null;

    registerProjectileTrailShader();

    const mat = new ShaderMaterial(
        `projTrailMat_${def.defId}`, scene, 'projectileTrail',
        {
            attributes: ['position', 'uv', 'alpha'],
            uniforms: ['world', 'viewProjection', 'tint'],
            samplers: ['trailTex'],
            defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
        },
    );

    // Tint: prefer the weapon's authored colour, fall back to white so
    // a coloured smoketrail texture (e.g. ZK's purpletrail) renders
    // its own colour rather than getting forced to grey.
    const hasColor = def.colorR > 0 || def.colorG > 0 || def.colorB > 0;
    const tint = hasColor
        ? new Color3(def.colorR, def.colorG, def.colorB)
        : new Color3(1, 1, 1);
    mat.setColor3('tint', tint);

    const tex = new Texture(stampUrl(url), scene, /*noMipmap*/ false,
        /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.hasAlpha = true;
    mat.setTexture('trailTex', tex);
    // Premultiplied additive — same convention as the beam shader so
    // faded puffs contribute zero to the framebuffer.
    mat.alphaMode = 7;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;

    const baseSize = Math.max(2, (def.size > 0 ? def.size : 1) * 4);
    const mesh = MeshBuilder.CreatePlane(`projTrail_${def.defId}`,
        { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.alphaIndex = 1000;

    // Register the per-instance alpha attribute up front so the first
    // flush can populate it without re-registering. Stride 1 (one
    // float per instance).
    mesh.thinInstanceRegisterAttribute('alpha', 1);

    return { defId: def.defId, mesh, material: mat, size: baseSize };
}

/// Tear down a trail visual. The renderer calls this from
/// setWeaponDefs (when defs change) and from dispose().
export function disposeMissileTrailVisual(v: MissileTrailVisual): void {
    v.mesh.dispose();
    v.material.dispose();
}

/// Record a new puff at (x,y,z) if more than TRAIL_SPAWN_INTERVAL_MS
/// has passed since the last spawn. Overwrites the oldest slot when
/// the ring buffer is full. nowSec must be a wall-clock timestamp in
/// seconds (performance.now() / 1000).
export function recordTrailPuff(
    state: MissileTrailState,
    x: number, y: number, z: number,
    nowSec: number,
): void {
    if ((nowSec - state.lastSpawnSec) * 1000 < TRAIL_SPAWN_INTERVAL_MS) return;
    const slot = state.nextSlot;
    const base = slot * 3;
    state.positions[base + 0] = x;
    state.positions[base + 1] = y;
    state.positions[base + 2] = z;
    state.birthSecs[slot] = nowSec;
    state.nextSlot = (slot + 1) % TRAIL_PUFF_COUNT;
    state.lastSpawnSec = nowSec;
}

/// True iff every puff in the buffer has aged past TRAIL_LIFETIME_S.
/// Called by the renderer to evict orphaned trails that are fully
/// faded — keeping them around just wastes per-frame iteration.
export function isTrailFullyFaded(
    state: MissileTrailState,
    nowSec: number,
): boolean {
    for (let i = 0; i < TRAIL_PUFF_COUNT; i++) {
        const birth = state.birthSecs[i];
        if (birth >= 0 && nowSec - birth < TRAIL_LIFETIME_S) return false;
    }
    return true;
}

/// Flush one or more trail states into the per-def visual's thin-
/// instance buffers. Builds a camera-facing matrix per live puff and
/// the matching per-instance alpha (linear fade over TRAIL_LIFETIME_S).
/// Hides the mesh when no puffs are live this frame.
///
/// `tmp*` and the matrix scratch are passed in so callers can reuse
/// allocations across the per-tick loop over multiple defs.
export function flushMissileTrailVisual(
    visual: MissileTrailVisual,
    states: MissileTrailState[],
    nowSec: number,
    camX: number, camY: number, camZ: number,
    tmpRight: Vector3, tmpUp: Vector3, tmpFwd: Vector3,
    tmpQ: Quaternion, tmpScale: Vector3,
): void {
    // Pass 1: count live puffs across every state for this def so we
    // can size the matrix + alpha buffers exactly. Skipping faded
    // puffs keeps GPU work proportional to visible count.
    let liveCount = 0;
    for (const s of states) {
        for (let i = 0; i < TRAIL_PUFF_COUNT; i++) {
            const birth = s.birthSecs[i];
            if (birth < 0) continue;
            if (nowSec - birth >= TRAIL_LIFETIME_S) continue;
            liveCount++;
        }
    }

    if (liveCount === 0) {
        visual.mesh.isVisible = false;
        visual.mesh.thinInstanceCount = 0;
        return;
    }

    const matrices = new Float32Array(liveCount * 16);
    const alphas = new Float32Array(liveCount);
    tmpScale.set(visual.size, visual.size, visual.size);

    let dst = 0;
    for (const s of states) {
        for (let i = 0; i < TRAIL_PUFF_COUNT; i++) {
            const birth = s.birthSecs[i];
            if (birth < 0) continue;
            const age = nowSec - birth;
            if (age >= TRAIL_LIFETIME_S) continue;
            const base = i * 3;
            const px = s.positions[base + 0];
            const py = s.positions[base + 1];
            const pz = s.positions[base + 2];
            composeBillboardMatrix(matrices, dst * 16, px, py, pz,
                camX, camY, camZ,
                tmpRight, tmpUp, tmpFwd, tmpQ, tmpScale);
            alphas[dst] = 1 - age / TRAIL_LIFETIME_S;
            dst++;
        }
    }

    visual.mesh.isVisible = true;
    visual.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
    visual.mesh.thinInstanceSetBuffer('alpha', alphas, 1, false);
    visual.mesh.thinInstanceCount = liveCount;
}

/// Camera-facing billboard matrix at world (px,py,pz), scaled by
/// `tmpScale`. Lifted from the renderer's beam end-cap helper so
/// trail puffs share the same orthonormal-basis logic without
/// importing across modules.
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
