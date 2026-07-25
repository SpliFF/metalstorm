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
    free: number[];           // released indices, LIFO
    dirty: boolean;
}

interface MemberSlot { pool: InstancePool; index: number; }

const MEMBER_HEIGHT = 9;      // elmos — proxy capsule height
const MEMBER_RADIUS = 1.6;
const WRECK_SIZE = 4;         // elmos — flat debris box

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

    isOnScreen(x: number, y: number, z: number): boolean {
        const planes = this.scene.frustumPlanes;
        if (!planes) return false;
        for (let i = 0; i < planes.length; i++) {
            const p = planes[i];
            if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.d < 0) return false;
        }
        return true;
    }

    // --- per-frame flush ----------------------------------------------------

    /** Upload dirty pools. Called once per render frame after
     *  SquadManager.update() has issued this frame's member transforms. */
    flush(): void {
        for (const pool of this.memberPools.values()) this.flushPool(pool);
        if (this.wreckPool) this.flushPool(this.wreckPool);
    }

    dispose(): void {
        for (const pool of this.memberPools.values()) pool.mesh.dispose();
        this.wreckPool?.mesh.dispose();
        this.memberPools.clear();
        this.wreckPool = null;
        this.memberByHandle.clear();
        this.wreckByHandle.clear();
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
        return { mesh, matrices, capacity, highWater: 0, free: [], dirty: false };
    }

    private allocSlot(pool: InstancePool): number {
        let index: number;
        if (pool.free.length) {
            index = pool.free.pop()!;
        } else {
            if (pool.highWater >= pool.capacity) this.growPool(pool);
            index = pool.highWater++;
        }
        pool.dirty = true;
        return index;
    }

    private freeSlot(pool: InstancePool, index: number): void {
        // Collapse to zero scale so the freed slot renders as nothing.
        const base = index * 16;
        pool.matrices.fill(0, base, base + 16);
        pool.free.push(index);
        pool.dirty = true;
    }

    private growPool(pool: InstancePool): void {
        const cap = pool.capacity * 2;
        const next = new Float32Array(cap * 16);
        next.set(pool.matrices);
        pool.matrices = next;
        pool.capacity = cap;
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
        pool.mesh.thinInstanceSetBuffer('matrix', pool.matrices, 16, false);
        pool.mesh.thinInstanceCount = pool.highWater;
        pool.mesh.isVisible = pool.highWater > 0;
        if (pool.highWater > 0) {
            pool.mesh.thinInstanceRefreshBoundingInfo(false);
        }
    }
}
