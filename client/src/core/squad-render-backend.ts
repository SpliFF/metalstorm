// squad-render-backend.ts — the game-processor worker's implementation of the
// Metalstorm squad-system RenderBackend interface
// (data/games/metalstorm/client/squads/render-backend.js).
//
// The squad modules are pure logic: one sim unit (squad_size > 1) fans out into
// many cosmetic on-screen "soldiers". This adapter draws those members (and the
// wrecks a casualty leaves) as thin instances in the live Babylon scene, and
// answers the logic's ground-height / on-screen queries against the real
// heightmap + camera. Everything here is presentation only — nothing feeds the
// sim (CLAUDE.md squad-based design; PLAN-latency-squads.md).
//
// Members are a procedural proxy (a small capsule, team-coloured) rather than a
// per-piece soldier model — a DELIBERATE first-wire simplification, not a Recoil
// divergence: soldier-model fan-out is Metalstorm-specific cosmetic presentation
// with no Recoil equivalent, and the sim only ever knows the single squad unit.
// Swapping the proxy for real member models is a later polish step behind the
// same RenderBackend seam.

import {
    Scene, Mesh, MeshBuilder, StandardMaterial, Color3,
    Vector3, Quaternion, Matrix,
} from '@babylonjs/core';

/** A grow-on-demand thin-instance pool for one visual class (members of a
 *  given team, or wrecks). Freed slots are collapsed to a zero-scale matrix so
 *  they render as nothing until the index is reused. */
interface InstancePool {
    mesh: Mesh;
    matrices: Float32Array;   // capacity * 16
    capacity: number;
    highWater: number;        // count uploaded to thinInstanceCount
    free: number[];           // released indices, LIFO (may hold stale >= highWater)
    freeMask: Uint8Array;     // 1 = index is free; lets flush reclaim the tail
    view: Float32Array;       // matrices.subarray(0, highWater*16) — the live prefix
    viewCount: number;        // highWater `view` was cut at (view is rebuilt when this moves)
    dirty: boolean;
}

interface MemberSlot { pool: InstancePool; index: number; }

const MEMBER_HEIGHT = 9;      // elmos — proxy capsule height
const MEMBER_RADIUS = 1.6;
const WRECK_SIZE = 4;         // elmos — flat debris box

// Icon-tier marker (PLAN-metalstorm-squad-performance.md §12b). A squad at
// `icon` LOD has released every member instance, so this flat ground quad is
// the only thing left standing in for it. INTERIM BY DECREE: the real
// strategic glyph language is PLAN-macro-map.md §3, and when its
// strategic-renderer lands it takes over at the setIcon/clearIcon seam below —
// do not grow this into one.
const ICON_QUAD_SIZE = 1;     // elmos — unit quad; per-instance scale sizes it
const ICON_MIN_SIZE = 48;     // elmos — floor so a small squad still reads far off
const ICON_SIZE_MUL = 2.5;    // × formation radius
const ICON_LIFT = 2;          // elmos above the centroid, to clear the terrain

export interface SquadHost {
    /** Terrain height sample (client heightmap) for member Y. */
    getGroundHeight(x: number, z: number): number;
    /** Same team palette the unit meshes use. */
    getTeamColor(team: number): Color3;
}

export class SquadRenderBackend {
    private scene: Scene;
    private host: SquadHost;

    /** squadId → team, so createMember can colour a member by its owning
     *  squad's team (the RenderBackend member-create call carries only the
     *  squad id + a cosmetic visual, not the team). Set by the adapter driver
     *  (game-processor) as squads are routed. */
    private squadTeam = new Map<number, number>();

    /** One member pool per team (lazily created). */
    private memberPools = new Map<number, InstancePool>();
    /** Single shared wreck pool. */
    private wreckPool: InstancePool | null = null;
    /** One icon-marker pool per team (§12b) — one instance per icon-tier squad. */
    private iconPools = new Map<number, InstancePool>();
    /** squadId → its live icon instance. Absent = the squad isn't at icon tier. */
    private iconBySquad = new Map<number, MemberSlot>();

    /** handle → member slot. Handles are dense positive ints; -1 means "no
     *  instance" (the logic treats -1 as released, per render-backend.js). */
    private memberByHandle = new Map<number, MemberSlot>();
    private wreckByHandle = new Map<number, MemberSlot>();
    private nextHandle = 1;

    // Alloc-free scratch for updateMember (called per member per frame).
    private _s = new Vector3(1, 1, 1);
    private _q = new Quaternion();
    private _t = new Vector3();
    private _m = Matrix.Identity();

    constructor(scene: Scene, host: SquadHost) {
        this.scene = scene;
        this.host = host;
    }

    /** Tell the backend which team a squad belongs to (drives member colour). */
    setSquadTeam(squadId: number, team: number): void {
        this.squadTeam.set(squadId, team);
    }

    forgetSquad(squadId: number): void {
        this.squadTeam.delete(squadId);
        this.clearIcon(squadId);
    }

    // --- RenderBackend interface -------------------------------------------

    createMember(squadId: number, _memberId: number, _v: { defId: number; variant: number }): number {
        const team = this.squadTeam.get(squadId) ?? 0;
        const pool = this.getMemberPool(team);
        const index = this.allocSlot(pool);
        const handle = this.nextHandle++;
        this.memberByHandle.set(handle, { pool, index });
        return handle;
    }

    updateMember(handle: number, x: number, y: number, z: number, headingY: number, gait: number): void {
        const slot = this.memberByHandle.get(handle);
        if (!slot) return;
        // Gait 0..1 → a subtle vertical bob so a moving squad reads as walking.
        const bob = Math.sin(gait * Math.PI * 2) * 0.4;
        this.writeMatrix(slot.pool, slot.index, x, y + MEMBER_HEIGHT * 0.5 + bob, z, headingY, 1);
    }

    destroyMember(handle: number, _death: unknown): void {
        // The visible "fallen" cue is the wreck the squad drops separately
        // (spawnWreck); here we just release the standing member instance.
        this.releaseMember(handle);
    }

    releaseMember(handle: number): void {
        const slot = this.memberByHandle.get(handle);
        if (!slot) return;
        this.freeSlot(slot.pool, slot.index);
        this.memberByHandle.delete(handle);
    }

    spawnWreck(x: number, y: number, z: number, headingY: number, _v: unknown): number {
        const pool = this.getWreckPool();
        const index = this.allocSlot(pool);
        this.writeMatrix(pool, index, x, y + WRECK_SIZE * 0.15, z, headingY, 1);
        const handle = this.nextHandle++;
        this.wreckByHandle.set(handle, { pool, index });
        return handle;
    }

    despawnWreck(handle: number): void {
        const slot = this.wreckByHandle.get(handle);
        if (!slot) return;
        this.freeSlot(slot.pool, slot.index);
        this.wreckByHandle.delete(handle);
    }

    fadeWreck(handle: number, alpha: number): void {
        const slot = this.wreckByHandle.get(handle);
        if (!slot) return;
        // No per-instance alpha on a shared material — fade by shrinking the
        // debris toward nothing instead. Preserves position/heading.
        const base = slot.index * 16;
        const m = slot.pool.matrices;
        // Re-scale the rotation/scale 3×3 block by alpha relative to unit.
        // Cheapest correct path: recompose from the stored translation.
        const tx = m[12], ty = m[13], tz = m[14];
        // Recover heading from the current matrix is awkward; wrecks don't
        // move, so just uniformly scale in place around the translation.
        this._s.set(alpha, alpha, alpha);
        this._q.set(0, 0, 0, 1);
        this._t.set(tx, ty, tz);
        Matrix.ComposeToRef(this._s, this._q, this._t, this._m);
        this._m.copyToArray(m, base);
        slot.pool.dirty = true;
    }

    // NB: the RenderBackend contract names this `groundHeight` (render-backend.js
    // / NullRenderBackend), NOT getGroundHeight — Squad calls this.backend.groundHeight.
    groundHeight(x: number, z: number): number {
        const h = this.host.getGroundHeight(x, z);
        return Number.isFinite(h) ? h : 0;
    }

    /** Frustum test, optionally padded by `radius` so a sphere straddling a
     *  frustum plane still counts as visible (LOD tiering evaluates this at a
     *  squad's centroid with its formation radius — §12a). Babylon's frustum
     *  planes are normalized, so `d` is a true signed distance.
     *
     *  NB (perf plan §15 risk 2): scene.frustumPlanes is refreshed inside
     *  scene.render(), which runs LATER in the frame than the squad tick, so
     *  callers see last frame's frustum. One frame of lag, absorbed by the LOD
     *  dwell hysteresis — not a bug. */
    isOnScreen(x: number, y: number, z: number, radius = 0): boolean {
        const planes = this.scene.frustumPlanes;
        if (!planes) return false;
        for (let i = 0; i < planes.length; i++) {
            const p = planes[i];
            if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.d < -radius) return false;
        }
        return true;
    }

    // --- icon-tier markers (§12b) -------------------------------------------
    //
    // THE SEAM. PLAN-macro-map.md's strategic renderer replaces the two methods
    // below (and nothing else) when it lands; the squad logic calls them
    // through the optional setIcon/clearIcon slots of the RenderBackend
    // contract and knows nothing about what gets drawn.

    /** Show or move this squad's icon marker. Upsert — the manager re-issues it
     *  every frame while the squad is at icon tier so the marker tracks the
     *  interpolated centroid. */
    setIcon(squadId: number, x: number, y: number, z: number, radius: number): void {
        const team = this.squadTeam.get(squadId) ?? 0;
        const pool = this.getIconPool(team);
        let slot = this.iconBySquad.get(squadId);
        // Pool mismatch = the squad changed team since the marker was allocated
        // (rare — capture/unit-give); move it rather than leaving a stray quad.
        if (slot && slot.pool !== pool) {
            this.freeSlot(slot.pool, slot.index);
            slot = undefined;
        }
        if (!slot) {
            slot = { pool, index: this.allocSlot(pool) };
            this.iconBySquad.set(squadId, slot);
        }
        const scale = Math.max(ICON_MIN_SIZE, radius * ICON_SIZE_MUL) / ICON_QUAD_SIZE;
        this.writeMatrix(pool, slot.index, x, y + ICON_LIFT, z, 0, scale);
    }

    /** The squad left icon tier (or was removed) — drop its marker. */
    clearIcon(squadId: number): void {
        const slot = this.iconBySquad.get(squadId);
        if (!slot) return;
        this.freeSlot(slot.pool, slot.index);
        this.iconBySquad.delete(squadId);
    }

    // --- per-frame flush ----------------------------------------------------

    /** Upload dirty pools. Called once per render frame after
     *  SquadManager.update() has issued this frame's member transforms. */
    flush(): void {
        for (const pool of this.memberPools.values()) this.flushPool(pool);
        for (const pool of this.iconPools.values()) this.flushPool(pool);
        if (this.wreckPool) this.flushPool(this.wreckPool);
    }

    dispose(): void {
        for (const pool of this.memberPools.values()) pool.mesh.dispose();
        for (const pool of this.iconPools.values()) pool.mesh.dispose();
        this.wreckPool?.mesh.dispose();
        this.memberPools.clear();
        this.iconPools.clear();
        this.wreckPool = null;
        this.memberByHandle.clear();
        this.wreckByHandle.clear();
        this.iconBySquad.clear();
        this.squadTeam.clear();
    }

    // --- internals ----------------------------------------------------------

    private getMemberPool(team: number): InstancePool {
        let pool = this.memberPools.get(team);
        if (pool) return pool;
        const mesh = MeshBuilder.CreateCapsule(`squadMember_t${team}`, {
            height: MEMBER_HEIGHT, radius: MEMBER_RADIUS, tessellation: 6, subdivisions: 1,
        }, this.scene);
        const mat = new StandardMaterial(`squadMemberMat_t${team}`, this.scene);
        const c = this.host.getTeamColor(team);
        mat.diffuseColor = c;
        mat.specularColor = new Color3(0.1, 0.1, 0.1);
        mat.emissiveColor = c.scale(0.25);
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        pool = this.newPool(mesh);
        this.memberPools.set(team, pool);
        return pool;
    }

    /** Per-team icon-marker pool. The quad is authored lying flat (rotation
     *  baked into its vertices) so per-instance matrices stay plain
     *  yaw+scale+translate — same `writeMatrix` path as members, which keeps
     *  the W-row untouched (docs/lighting.md's thin-instance packing trap).
     *  Unlit and non-shadow-casting: a marker is a UI affordance drawn in the
     *  world, not a lit object. */
    private getIconPool(team: number): InstancePool {
        let pool = this.iconPools.get(team);
        if (pool) return pool;
        const mesh = MeshBuilder.CreatePlane(`squadIcon_t${team}`, { size: ICON_QUAD_SIZE }, this.scene);
        mesh.rotation.x = Math.PI / 2;
        mesh.bakeCurrentTransformIntoVertices();
        const mat = new StandardMaterial(`squadIconMat_t${team}`, this.scene);
        const c = this.host.getTeamColor(team);
        mat.disableLighting = true;
        mat.emissiveColor = c;
        mat.diffuseColor = c;
        mat.specularColor = new Color3(0, 0, 0);
        mat.backFaceCulling = false;
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        pool = this.newPool(mesh);
        this.iconPools.set(team, pool);
        return pool;
    }

    private getWreckPool(): InstancePool {
        if (this.wreckPool) return this.wreckPool;
        const mesh = MeshBuilder.CreateBox('squadWreck', {
            width: WRECK_SIZE, height: WRECK_SIZE * 0.3, depth: WRECK_SIZE,
        }, this.scene);
        const mat = new StandardMaterial('squadWreckMat', this.scene);
        mat.diffuseColor = new Color3(0.18, 0.16, 0.14);
        mat.specularColor = new Color3(0.05, 0.05, 0.05);
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        this.wreckPool = this.newPool(mesh);
        return this.wreckPool;
    }

    private newPool(mesh: Mesh, capacity = 64): InstancePool {
        const matrices = new Float32Array(capacity * 16);
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        mesh.thinInstanceCount = 0;
        mesh.isVisible = false;
        return {
            mesh, matrices, capacity, highWater: 0,
            free: [], freeMask: new Uint8Array(capacity),
            view: matrices, viewCount: -1, dirty: false,
        };
    }

    private allocSlot(pool: InstancePool): number {
        let index = -1;
        // Entries left in `free` by a tail trim (see flushPool) are stale — the
        // slot no longer exists. Discard them lazily on pop rather than
        // compacting the array, which keeps alloc/free O(1) amortized even
        // when an LOD sweep frees tens of thousands of slots at once.
        while (pool.free.length) {
            const i = pool.free.pop()!;
            if (i < pool.highWater && pool.freeMask[i]) { index = i; break; }
        }
        if (index < 0) {
            if (pool.highWater >= pool.capacity) this.growPool(pool);
            index = pool.highWater++;
        }
        pool.freeMask[index] = 0;
        pool.dirty = true;
        return index;
    }

    private freeSlot(pool: InstancePool, index: number): void {
        // Collapse the 3×3 to zero scale so the freed slot renders as nothing.
        // The W-row must stay (0,0,0,1) — docs/lighting.md "thin-instance matrix
        // packing breaks shadow casting": the CSM depth shader never
        // reconstructs w, so m[15]=0 corrupts the caster silhouette even though
        // the main pass looks fine.
        const base = index * 16;
        pool.matrices.fill(0, base, base + 16);
        pool.matrices[base + 15] = 1;
        pool.free.push(index);
        pool.freeMask[index] = 1;
        pool.dirty = true;
    }

    private growPool(pool: InstancePool): void {
        const cap = pool.capacity * 2;
        const next = new Float32Array(cap * 16);
        next.set(pool.matrices);
        pool.matrices = next;
        const mask = new Uint8Array(cap);
        mask.set(pool.freeMask);
        pool.freeMask = mask;
        pool.capacity = cap;
        pool.viewCount = -1;    // `view` pointed into the old buffer
    }

    /** Compose scale·yaw·translate into the pool's matrix buffer at `index`.
     *  Alloc-free (reuses scratch). */
    private writeMatrix(
        pool: InstancePool, index: number,
        x: number, y: number, z: number, headingY: number, scale: number,
    ): void {
        this._s.set(scale, scale, scale);
        Quaternion.RotationYawPitchRollToRef(headingY, 0, 0, this._q);
        this._t.set(x, y, z);
        Matrix.ComposeToRef(this._s, this._q, this._t, this._m);
        this._m.copyToArray(pool.matrices, index * 16);
        pool.dirty = true;
    }

    private flushPool(pool: InstancePool): void {
        if (!pool.dirty) return;
        pool.dirty = false;
        // Reclaim the free tail. LOD demotion (PLAN-metalstorm-squad-performance
        // §12) releases members in bulk — at 5k squads it frees ~95% of the
        // pool — and without this the pool would keep drawing (and uploading)
        // every dead hole forever, eating the entire tiering win. Amortized
        // O(1): the loop stops at the first live slot.
        let hw = pool.highWater;
        while (hw > 0 && pool.freeMask[hw - 1]) hw--;
        pool.highWater = hw;
        // Upload only the live prefix. thinInstanceSetBuffer re-uploads the
        // WHOLE Float32Array it is handed and `matrices` is sized to capacity,
        // so passing the full array costs a multi-MB copy per frame once a pool
        // has ever grown large. The subarray view is cached, not recut per
        // frame, so Babylon keeps seeing the same object while hw is stable.
        if (pool.viewCount !== hw) {
            pool.view = pool.matrices.subarray(0, hw * 16);
            pool.viewCount = hw;
        }
        pool.mesh.thinInstanceSetBuffer('matrix', pool.view, 16, false);
        pool.mesh.thinInstanceCount = hw;
        pool.mesh.isVisible = hw > 0;
        if (hw > 0) {
            pool.mesh.thinInstanceRefreshBoundingInfo(false);
        }
    }
}
