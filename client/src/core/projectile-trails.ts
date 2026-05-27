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
    Engine,
    Mesh,
    MeshBuilder,
    ShaderMaterial,
    Color3,
    Vector3,
    Quaternion,
    Texture,
    RawTexture,
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

/// Per-weapon-def GPU resources for trail ribbons. The mesh and
/// material are reused across every live and orphaned trail of this
/// def; per-segment variance is encoded in the world matrix plus
/// the `uvRange` / `alphaRange` thin-instance attributes.
export interface MissileTrailVisual {
    defId: number;
    mesh: Mesh;
    material: ShaderMaterial;
    /// Ribbon width in elmos. Per-segment matrices scale the unit-
    /// quad's Y axis by this much so the strip's vertical extent
    /// is constant across the trail.
    width: number;
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

/// Shared 1×1 white RawTexture, lazily allocated on first builder call.
/// Used as the initial binding for every trail material so the shader
/// samples (1,1,1,1) until the real .ktx2 finishes loading — without
/// this, WebGL hands back (0,0,0,1) from the unbound sampler and the
/// premul-additive blend (alphaMode 7) writes opaque black quads at
/// every puff position. Same root cause and fix as the CEG runtime's
/// `fallbackWhiteTex` (commit 5832b8be7a).
let sharedTrailFallback: RawTexture | null = null;
function getTrailFallback(scene: Scene): RawTexture {
    if (sharedTrailFallback) return sharedTrailFallback;
    const t = new RawTexture(
        new Uint8Array([255, 255, 255, 255]),
        1, 1, Engine.TEXTUREFORMAT_RGBA, scene,
        /*generateMipMaps*/ false, /*invertY*/ false,
        Texture.NEAREST_SAMPLINGMODE,
    );
    t.name = 'projTrail-fallback-white';
    t.hasAlpha = true;
    sharedTrailFallback = t;
    return t;
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
            attributes: ['position', 'uv', 'uvRange', 'alphaRange'],
            uniforms: ['world', 'viewProjection', 'tint'],
            samplers: ['trailTex'],
            defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
            // ShaderMaterial.needAlphaBlending() returns false by default
            // (it only checks `this.alpha < 1.0` or this flag). Without
            // it the mesh renders in the opaque pass with blending
            // disabled — `alphaMode = 7` below would be silently ignored
            // and the shader's premul output `vec4(rgb*a, a)` would
            // write opaque black where the smoke texture's alpha is low.
            // Flipping the flag puts the mesh into the alpha-blend pass
            // where alphaMode is honoured.
            needAlphaBlending: true,
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

    // Bind the shared white fallback first so the very first puffs
    // emitted (during the .ktx2 load window) sample (1,1,1,1) instead
    // of WebGL's unbound-sampler (0,0,0,1). The real texture swaps in
    // via the onLoad callback below.
    mat.setTexture('trailTex', getTrailFallback(scene));

    const tex = new Texture(stampUrl(url), scene, /*noMipmap*/ false,
        /*invertY*/ true, Texture.TRILINEAR_SAMPLINGMODE,
        () => { mat.setTexture('trailTex', tex); });
    tex.hasAlpha = true;
    // ZK *smoketrail.* textures are 320×24 horizontal strips meant to
    // tile along the trail's length (Recoil's CSmokeTrailProjectile
    // convention). Wrap U so successive ribbon segments can extend
    // past U=1 and keep sampling the strip seamlessly.
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    // Premultiplied additive — same convention as the beam shader so
    // faded ends contribute zero to the framebuffer.
    mat.alphaMode = 7;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;

    // Ribbon half-width. `def.size` (engine elmos) is the projectile
    // visual radius; the trail historically reads roughly 2× the
    // projectile body, with a floor so the ribbon stays visible for
    // tiny weapons. Used directly as scale on the ribbon Y axis when
    // composing per-segment matrices.
    const ribbonWidth = Math.max(2, (def.size > 0 ? def.size : 1) * 2);
    const mesh = MeshBuilder.CreatePlane(`projTrail_${def.defId}`,
        { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.isVisible = false;
    mesh.thinInstanceEnablePicking = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.alphaIndex = 1000;

    // Per-instance attributes for the ribbon path. `uvRange` carries
    // (uMin, uMax) so consecutive segments tile the strip texture by
    // cumulative trail arc-length; `alphaRange` carries (a1, a2) so
    // each segment fades smoothly from older end to younger end.
    mesh.thinInstanceRegisterAttribute('uvRange', 2);
    mesh.thinInstanceRegisterAttribute('alphaRange', 2);

    return { defId: def.defId, mesh, material: mat, width: ribbonWidth };
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

/// Texture tile length: the strip texture repeats once per this many
/// elmos of trail arc-length. Smaller value = denser tiling (more
/// visible repetitions along long trails); larger = sparser. 60 elmos
/// reads as a continuous wispy ribbon at typical missile sizes.
const TRAIL_TILE_LEN = 60;

/// Flush one or more trail states into the per-def visual's thin-
/// instance buffers as ribbon segments — one segment per pair of
/// consecutive live puff positions in the ring buffer, matching
/// Recoil's `CSmokeTrailProjectile::Draw` quad layout. Hides the
/// mesh when there are no full segments to draw this frame.
///
/// `tmp*` and the matrix scratch are passed in so callers can reuse
/// allocations across the per-tick loop over multiple defs. The
/// `Vector3` / `Quaternion` parameters are kept for API parity with
/// the prior billboard implementation but only `tmpScale` is read.
export function flushMissileTrailVisual(
    visual: MissileTrailVisual,
    states: MissileTrailState[],
    nowSec: number,
    camX: number, camY: number, camZ: number,
    _tmpRight: Vector3, _tmpUp: Vector3, _tmpFwd: Vector3,
    _tmpQ: Quaternion, tmpScale: Vector3,
): void {
    // Pass 1: per-state live-puff count → (count - 1) segments per
    // state, summed across every state for this def. A state with
    // 0 or 1 live puffs contributes nothing — a ribbon needs two
    // endpoints.
    let totalSegments = 0;
    const perStateLive: number[] = [];
    for (const s of states) {
        let live = 0;
        for (let i = 0; i < TRAIL_PUFF_COUNT; i++) {
            const birth = s.birthSecs[i];
            if (birth < 0) continue;
            if (nowSec - birth >= TRAIL_LIFETIME_S) continue;
            live++;
        }
        perStateLive.push(live);
        if (live >= 2) totalSegments += (live - 1);
    }

    if (totalSegments === 0) {
        visual.mesh.isVisible = false;
        visual.mesh.thinInstanceCount = 0;
        return;
    }

    const matrices = new Float32Array(totalSegments * 16);
    const uvRanges = new Float32Array(totalSegments * 2);
    const alphaRanges = new Float32Array(totalSegments * 2);
    const width = visual.width;

    // Scratch arrays — reused per state. Sized for the worst case.
    const orderedX = new Float32Array(TRAIL_PUFF_COUNT);
    const orderedY = new Float32Array(TRAIL_PUFF_COUNT);
    const orderedZ = new Float32Array(TRAIL_PUFF_COUNT);
    const orderedAlpha = new Float32Array(TRAIL_PUFF_COUNT);

    let dst = 0;
    for (let si = 0; si < states.length; si++) {
        if (perStateLive[si] < 2) continue;
        const s = states[si];

        // Walk the ring buffer in chronological order (oldest first)
        // and pack live puffs into the scratch arrays. nextSlot is
        // the next-to-overwrite index, which is also the oldest slot
        // once the buffer has been filled at least once.
        let orderedCount = 0;
        for (let k = 0; k < TRAIL_PUFF_COUNT; k++) {
            const i = (s.nextSlot + k) % TRAIL_PUFF_COUNT;
            const birth = s.birthSecs[i];
            if (birth < 0) continue;
            const age = nowSec - birth;
            if (age >= TRAIL_LIFETIME_S) continue;
            const base = i * 3;
            orderedX[orderedCount] = s.positions[base + 0];
            orderedY[orderedCount] = s.positions[base + 1];
            orderedZ[orderedCount] = s.positions[base + 2];
            orderedAlpha[orderedCount] = 1 - age / TRAIL_LIFETIME_S;
            orderedCount++;
        }

        // Emit (orderedCount - 1) segments, accumulating arc length
        // for tiling UV.x so the strip texture flows continuously
        // along the trail rather than restarting per segment.
        let cumLen = 0;
        for (let k = 0; k < orderedCount - 1; k++) {
            const x1 = orderedX[k],     y1 = orderedY[k],     z1 = orderedZ[k];
            const x2 = orderedX[k + 1], y2 = orderedY[k + 1], z2 = orderedZ[k + 1];
            const ex = x2 - x1, ey = y2 - y1, ez = z2 - z1;
            const segLen = Math.hypot(ex, ey, ez);
            if (segLen < 1e-3) continue; // degenerate; skip

            // Ribbon "out" axis = (camera_to_midpoint × travel).normalize().
            // Falls back to world up cross travel if camera is on the
            // segment line — keeps the ribbon visible from any angle
            // including straight overhead.
            const mx = (x1 + x2) * 0.5, my = (y1 + y2) * 0.5, mz = (z1 + z2) * 0.5;
            let cx = camX - mx, cy = camY - my, cz = camZ - mz;
            let ox = cy * ez - cz * ey;
            let oy = cz * ex - cx * ez;
            let oz = cx * ey - cy * ex;
            let olen = Math.hypot(ox, oy, oz);
            if (olen < 1e-3) {
                // Camera nearly on segment line — pick a stable
                // fallback perpendicular by crossing travel with
                // world up. Travel can't itself be (0,1,0) and yield
                // zero here because that'd require segLen=0 already.
                ox = ez; oy = 0; oz = -ex;
                olen = Math.hypot(ox, oy, oz) || 1;
            }
            ox /= olen; oy /= olen; oz /= olen;

            // Per-segment matrix (column-major):
            //   col0 = edge vector (X → travel direction, length = segLen)
            //   col1 = odir * width (Y → ribbon width)
            //   col2 = ignored (flat quad; pick segment normal for
            //          completeness so the matrix is non-degenerate)
            //   col3 = midpoint
            // The plane mesh's local positions are (±0.5, ±0.5, 0),
            // so after this transform the four corners land at
            // (pos1 ± 0.5*width*odir, pos2 ± 0.5*width*odir) —
            // matching Recoil's `pos1 ± odir1*size1, pos2 ± odir2*size2`
            // pattern (we collapse to a single odir per segment
            // rather than per-endpoint — the visual difference is
            // negligible at typical missile travel).
            const off = dst * 16;
            matrices[off + 0]  = ex;         matrices[off + 1]  = ey;         matrices[off + 2]  = ez;         matrices[off + 3]  = 0;
            matrices[off + 4]  = ox * width; matrices[off + 5]  = oy * width; matrices[off + 6]  = oz * width; matrices[off + 7]  = 0;
            // col2 = edge × out (segment-plane normal), unit length.
            const nx = ey * oz - ez * oy;
            const ny = ez * ox - ex * oz;
            const nz = ex * oy - ey * ox;
            const nlen = Math.hypot(nx, ny, nz) || 1;
            matrices[off + 8]  = nx / nlen;  matrices[off + 9]  = ny / nlen;  matrices[off + 10] = nz / nlen;  matrices[off + 11] = 0;
            matrices[off + 12] = mx;         matrices[off + 13] = my;         matrices[off + 14] = mz;         matrices[off + 15] = 1;

            const uMin = cumLen / TRAIL_TILE_LEN;
            cumLen += segLen;
            const uMax = cumLen / TRAIL_TILE_LEN;
            uvRanges[dst * 2 + 0] = uMin;
            uvRanges[dst * 2 + 1] = uMax;
            alphaRanges[dst * 2 + 0] = orderedAlpha[k];
            alphaRanges[dst * 2 + 1] = orderedAlpha[k + 1];

            dst++;
        }
    }

    // Loop above may have skipped degenerate segments; trim totals.
    const finalCount = dst;
    if (finalCount === 0) {
        visual.mesh.isVisible = false;
        visual.mesh.thinInstanceCount = 0;
        return;
    }

    // Avoid the unused-warning on tmpScale — kept in the signature
    // for caller-side allocation reuse parity with peer flush paths.
    void tmpScale;

    visual.mesh.isVisible = true;
    visual.mesh.thinInstanceSetBuffer('matrix',
        finalCount === totalSegments ? matrices : matrices.subarray(0, finalCount * 16), 16, false);
    visual.mesh.thinInstanceSetBuffer('uvRange',
        finalCount === totalSegments ? uvRanges : uvRanges.subarray(0, finalCount * 2), 2, false);
    visual.mesh.thinInstanceSetBuffer('alphaRange',
        finalCount === totalSegments ? alphaRanges : alphaRanges.subarray(0, finalCount * 2), 2, false);
    visual.mesh.thinInstanceCount = finalCount;
}
