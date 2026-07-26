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
// Members draw as one of three visual classes, chosen PER MEMBER PER FRAME by
// camera distance (PLAN-metalstorm-impostors.md M4 — member LOD swap):
//  - MODEL — a member of a def with both a 3D body and an impostor atlas, when
//    it is closer than the def's impostorDistance, draws the real low-poly
//    body (EntityRenderer.getMemberModel: single-piece infantry mesh + team
//    material), thin-instanced per (defId, team) with REAL facing from headingY.
//  - IMPOSTOR SPRITE — the same member beyond impostorDistance (and any member
//    of an atlas def with no 3D model yet) draws the baked directional sprite
//    (8-yaw × 3-pitch atlas, screen-aligned card, per-instance cell select).
//  - PROXY CAPSULE — a def with no impostor atlas at all keeps the small
//    team-coloured capsule (a deliberate placeholder for defs that ship no
//    infantry art, not a Recoil divergence — the sim only ever knows the
//    single squad unit).
//
// A member migrates between the three pools as it moves relative to the camera
// (or as its model finishes loading); the pool move reuses the alloc/free slot
// machinery. Model meshes are BORROWED from EntityRenderer (owned=false) so the
// backend never disposes them.

import {
    Scene, Mesh, MeshBuilder, StandardMaterial, Color3,
    Vector3, Quaternion, Matrix,
} from '@babylonjs/core';
import { createImpostorMaterial, gridOf, type ImpostorAtlas } from './impostor-renderer.js';
import { type AtlasGrid, selectCellIndex } from './impostor-atlas.js';

/** 3D member-model source for the MODEL tier, supplied by EntityRenderer
 *  (getMemberModel). The backend thin-instances `mesh` and composes each
 *  member as `restWorld × (yaw · translate(x, y+yOffset, z))`. */
export interface MemberModel {
    /** Thin-instance-ready render mesh (team-coloured), owned by EntityRenderer. */
    mesh: Mesh;
    /** Piece rest-pose world matrix (identity for a feet-at-origin body). */
    restWorld: Matrix;
    /** Vertical model offset (0 for Recoil feet-at-origin models). */
    yOffset: number;
    /** Model height in elmos (foot→top), for reference / future crossfade. */
    height: number;
}

/** A grow-on-demand thin-instance pool for one visual class (members of a
 *  given team, or wrecks). Freed slots are collapsed to a zero-scale matrix so
 *  they render as nothing until the index is reused. */
interface InstancePool {
    mesh: Mesh;
    /** False for MODEL pools — the mesh is borrowed from EntityRenderer and
     *  must not be disposed here. True for the backend's own capsule/sprite/
     *  wreck meshes. */
    owned: boolean;
    matrices: Float32Array;   // capacity * 16
    capacity: number;
    highWater: number;        // count uploaded to thinInstanceCount
    free: number[];           // released indices, LIFO
    dirty: boolean;
    /** Present on impostor-sprite pools only. Sprite quads are screen-aligned
     *  (shared camera rotation), so their matrices AND per-member directional
     *  cell selectors are recomposed every flush() from the stored member
     *  positions/headings + the current camera — updateMember() just records
     *  the pose (a member idling while the camera orbits must re-billboard and
     *  re-select its yaw column). */
    sprite?: {
        halfH: number;          // quad half-height (ground-anchor lift)
        grid: AtlasGrid;        // atlas directional grid (yaw × pitch × frames)
        pos: Float32Array;      // capacity * 3, member ground positions
        heading: Float32Array;  // capacity, member facing (radians, RH)
        alive: Uint8Array;      // capacity, 1 = slot has a live member
        cells: Float32Array;    // capacity, per-member packed cell index (GPU)
    };
    /** Present on MODEL pools only — the transform data to compose members
     *  against the borrowed body geometry. */
    model?: { restWorld: Matrix; yOffset: number };
}

interface MemberSlot { pool: InstancePool; index: number; }

/** Per-member LOD state (members can migrate between the model/sprite/capsule
 *  pools every frame). Wrecks stay on the simpler MemberSlot. */
interface MemberEntry {
    defId: number;
    team: number;
    pool: InstancePool;         // current pool
    index: number;              // slot in the current pool
    /** Impostor sprite atlas (undefined → capsule-only def, never MODEL/SPRITE). */
    atlas?: ImpostorAtlas;
    /** Full→impostor member switch distance (elmos). Undefined → the def has no
     *  3D model tier, so the member never leaves the sprite pool. */
    impostorDist?: number;
}

const MEMBER_HEIGHT = 9;      // elmos — proxy capsule height
const MEMBER_RADIUS = 1.6;
const WRECK_SIZE = 4;         // elmos — flat debris box

export interface SquadHost {
    /** Terrain height sample (client heightmap) for member Y. */
    getGroundHeight(x: number, z: number): number;
    /** Same team palette the unit meshes use. */
    getTeamColor(team: number): Color3;
    /** Impostor sprite atlas for a def, if one streamed (impostor-renderer's
     *  registry) — members of such defs draw as sprite billboards (far tier). */
    getImpostorAtlas(defId: number): ImpostorAtlas | undefined;
    /** 3D member-model source for the close-range MODEL tier (M4). Returns
     *  undefined while the model is still loading, when the def has no model,
     *  or for a multi-piece model. Optional — a host without it (or a def
     *  without a model) keeps members on the sprite tier at all ranges. */
    getMemberModel?(defId: number, team: number): MemberModel | undefined;
    /** The def's Full→impostor member switch distance (elmos). Undefined
     *  disables the MODEL tier for that def (sprite-only). */
    getImpostorDistance?(defId: number): number | undefined;
}

export class SquadRenderBackend {
    private scene: Scene;
    private host: SquadHost;

    /** squadId → team, so createMember can colour a member by its owning
     *  squad's team (the RenderBackend member-create call carries only the
     *  squad id + a cosmetic visual, not the team). Set by the adapter driver
     *  (game-processor) as squads are routed. */
    private squadTeam = new Map<number, number>();

    /** One capsule member pool per team (lazily created). */
    private memberPools = new Map<number, InstancePool>();
    /** One sprite member pool per "defId:team" (lazily created). */
    private spritePools = new Map<string, InstancePool>();
    /** One 3D-model member pool per "defId:team" (lazily created; mesh borrowed
     *  from EntityRenderer). */
    private modelPools = new Map<string, InstancePool>();
    /** Single shared wreck pool. */
    private wreckPool: InstancePool | null = null;

    /** handle → member entry (carries LOD state for per-frame pool migration).
     *  Handles are dense positive ints; -1 means "no instance" (the logic
     *  treats -1 as released, per render-backend.js). */
    private memberByHandle = new Map<number, MemberEntry>();
    private wreckByHandle = new Map<number, MemberSlot>();
    private nextHandle = 1;

    // Alloc-free scratch for updateMember (called per member per frame).
    private _s = new Vector3(1, 1, 1);
    private _q = new Quaternion();
    private _t = new Vector3();
    private _m = Matrix.Identity();
    private _m2 = Matrix.Identity();   // second scratch for MODEL composition

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

    createMember(squadId: number, _memberId: number, v: { defId: number; variant: number }): number {
        const team = this.squadTeam.get(squadId) ?? 0;
        const atlas = this.host.getImpostorAtlas(v.defId);
        // Model tier only when the host can supply a body AND the def declares a
        // switch distance (the serializer emits both together). Cached per
        // member; the model itself is resolved live (it may still be loading).
        const impostorDist = (atlas && this.host.getMemberModel)
            ? this.host.getImpostorDistance?.(v.defId) : undefined;
        const entry: MemberEntry = {
            defId: v.defId, team, atlas, impostorDist,
            pool: null!, index: 0,
        };
        // Initial pool: sprite for atlas defs (the safe far-tier default until
        // the first updateMember re-evaluates distance), capsule otherwise.
        const pool = atlas ? this.getSpritePool(v.defId, team, atlas) : this.getMemberPool(team);
        entry.pool = pool;
        entry.index = this.allocSlot(pool);
        const handle = this.nextHandle++;
        this.memberByHandle.set(handle, entry);
        return handle;
    }

    updateMember(handle: number, x: number, y: number, z: number, headingY: number, gait: number): void {
        const entry = this.memberByHandle.get(handle);
        if (!entry) return;
        // Gait 0..1 → a subtle vertical bob so a moving squad reads as walking.
        const bob = Math.sin(gait * Math.PI * 2) * 0.4;

        // Per-frame LOD: pick the pool this member belongs in at its current
        // distance, migrating its slot (free old, alloc new) when the tier
        // changes. Sprite↔model popping across the boundary is smoothed in M5.
        const target = this.pickPool(entry, x, y, z);
        if (target !== entry.pool) {
            this.freeSlot(entry.pool, entry.index);
            entry.pool = target;
            entry.index = this.allocSlot(target);
        }

        const sprite = entry.pool.sprite;
        if (sprite) {
            // Screen-aligned matrices + directional cell are composed in flush()
            // against the current camera; here we only record the member's pose
            // (ground position + facing).
            const base = entry.index * 3;
            sprite.pos[base] = x;
            sprite.pos[base + 1] = y + bob;
            sprite.pos[base + 2] = z;
            sprite.heading[entry.index] = headingY;
            sprite.alive[entry.index] = 1;
            entry.pool.dirty = true;
            return;
        }
        if (entry.pool.model) {
            // 3D body — real facing from headingY, feet on the ground (models
            // are authored feet-at-origin; yOffset is 0 for Recoil placement).
            this.writeModelMatrix(entry.pool, entry.index, x, y + bob, z, headingY);
            return;
        }
        this.writeMatrix(entry.pool, entry.index, x, y + MEMBER_HEIGHT * 0.5 + bob, z, headingY, 1);
    }

    destroyMember(handle: number, _death: unknown): void {
        // The visible "fallen" cue is the wreck the squad drops separately
        // (spawnWreck); here we just release the standing member instance.
        this.releaseMember(handle);
    }

    releaseMember(handle: number): void {
        const entry = this.memberByHandle.get(handle);
        if (!entry) return;
        this.freeSlot(entry.pool, entry.index);
        this.memberByHandle.delete(handle);
    }

    /** Choose the pool a member belongs in at its current world position:
     *  MODEL when a body is available and the member is within impostorDistance,
     *  else SPRITE for atlas defs, else the proxy CAPSULE. */
    private pickPool(entry: MemberEntry, x: number, y: number, z: number): InstancePool {
        if (!entry.atlas) return this.getMemberPool(entry.team);
        if (entry.impostorDist !== undefined && this.host.getMemberModel) {
            const cam = this.scene.activeCamera?.position;
            if (cam) {
                const dx = cam.x - x, dy = cam.y - y, dz = cam.z - z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < entry.impostorDist * entry.impostorDist) {
                    const model = this.host.getMemberModel(entry.defId, entry.team);
                    if (model) return this.getModelPool(entry.defId, entry.team, model);
                }
            }
        }
        return this.getSpritePool(entry.defId, entry.team, entry.atlas);
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
     *  SquadManager.update() has issued this frame's member transforms.
     *  Sprite pools re-billboard against the active camera every flush
     *  (yaw-only camera facing, same convention as impostor-renderer.ts) —
     *  an idle member must still turn with an orbiting camera. */
    flush(): void {
        for (const pool of this.memberPools.values()) this.flushPool(pool);
        const cam = this.scene.activeCamera;
        const cameraPos = cam?.position;
        // Screen-aligned card orientation, shared by every sprite this frame:
        // the camera's world rotation (view yaw + pitch, no roll).
        const cardRot = cam?.absoluteRotation ?? Quaternion.Identity();
        for (const pool of this.spritePools.values()) {
            if (cameraPos) this.billboardSpritePool(pool, cameraPos, cardRot);
            this.flushPool(pool);
        }
        for (const pool of this.modelPools.values()) this.flushPool(pool);
        if (this.wreckPool) this.flushPool(this.wreckPool);
    }

    dispose(): void {
        for (const pool of this.memberPools.values()) pool.mesh.dispose();
        for (const pool of this.spritePools.values()) pool.mesh.dispose();
        // MODEL pools borrow their mesh from EntityRenderer (owned=false) —
        // reset its thin-instance state but leave disposal to EntityRenderer.
        for (const pool of this.modelPools.values()) {
            if (pool.owned) pool.mesh.dispose();
            else { pool.mesh.thinInstanceCount = 0; pool.mesh.isVisible = false; }
        }
        this.wreckPool?.mesh.dispose();
        this.memberPools.clear();
        this.spritePools.clear();
        this.modelPools.clear();
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

    private getSpritePool(defId: number, team: number, atlas: ImpostorAtlas): InstancePool {
        const key = `${defId}:${team}`;
        let pool = this.spritePools.get(key);
        if (pool) return pool;
        const mesh = MeshBuilder.CreatePlane(`squadSprite_d${defId}_t${team}`, {
            width: atlas.width, height: atlas.height, sideOrientation: Mesh.DOUBLESIDE,
        }, this.scene);
        mesh.material = createImpostorMaterial(
            `squadSpriteMat_d${defId}_t${team}`, atlas, team, this.scene);
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        pool = this.newPool(mesh);
        pool.sprite = {
            halfH: atlas.height * 0.5,
            grid: gridOf(atlas),
            pos: new Float32Array(pool.capacity * 3),
            heading: new Float32Array(pool.capacity),
            alive: new Uint8Array(pool.capacity),
            cells: new Float32Array(pool.capacity),
        };
        this.spritePools.set(key, pool);
        return pool;
    }

    /** Recompose every live sprite slot as a SCREEN-ALIGNED billboard (shared
     *  camera rotation — no per-member twist-toward-camera, which is what kills
     *  the point-blank fan-out) and re-select its directional atlas cell from
     *  the member's facing + the camera (impostor-atlas.ts). Alloc-free. */
    private billboardSpritePool(pool: InstancePool, cameraPos: Vector3, cardRot: Quaternion): void {
        const sprite = pool.sprite;
        if (!sprite || pool.highWater === 0) return;
        // Ground-anchor lift along the card's local up so feet stay on terrain
        // as the card pitches with the camera.
        this._t.set(0, sprite.halfH, 0);
        this._t.rotateByQuaternionToRef(cardRot, this._t);
        const upx = this._t.x, upy = this._t.y, upz = this._t.z;
        this._s.set(1, 1, 1);
        for (let i = 0; i < pool.highWater; i++) {
            if (!sprite.alive[i]) continue;
            const base = i * 3;
            const x = sprite.pos[base], y = sprite.pos[base + 1], z = sprite.pos[base + 2];
            this._t.set(x + upx, y + upy, z + upz);
            Matrix.ComposeToRef(this._s, cardRot, this._t, this._m);
            this._m.copyToArray(pool.matrices, i * 16);
            sprite.cells[i] = selectCellIndex(
                cameraPos.x - x, cameraPos.y - y, cameraPos.z - z,
                sprite.heading[i], sprite.grid);
        }
        pool.dirty = true;
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

    /** One 3D-model member pool per (defId, team). The mesh is BORROWED from
     *  EntityRenderer (getMemberModel) — the backend thin-instances it but does
     *  not own/dispose it. Composition data (rest pose, yOffset) rides the pool
     *  so writeModelMatrix places each member as restWorld × member world. */
    private getModelPool(defId: number, team: number, model: MemberModel): InstancePool {
        const key = `${defId}:${team}`;
        let pool = this.modelPools.get(key);
        if (pool) return pool;
        pool = this.newPool(model.mesh, 64, false);
        pool.model = { restWorld: model.restWorld, yOffset: model.yOffset };
        this.modelPools.set(key, pool);
        return pool;
    }

    private newPool(mesh: Mesh, capacity = 64, owned = true): InstancePool {
        const matrices = new Float32Array(capacity * 16);
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        mesh.thinInstanceCount = 0;
        mesh.isVisible = false;
        return { mesh, owned, matrices, capacity, highWater: 0, free: [], dirty: false };
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
        if (pool.sprite) pool.sprite.alive[index] = 0;
        pool.free.push(index);
        pool.dirty = true;
    }

    private growPool(pool: InstancePool): void {
        const cap = pool.capacity * 2;
        const next = new Float32Array(cap * 16);
        next.set(pool.matrices);
        pool.matrices = next;
        pool.capacity = cap;
        if (pool.sprite) {
            const pos = new Float32Array(cap * 3);
            pos.set(pool.sprite.pos);
            pool.sprite.pos = pos;
            const heading = new Float32Array(cap);
            heading.set(pool.sprite.heading);
            pool.sprite.heading = heading;
            const alive = new Uint8Array(cap);
            alive.set(pool.sprite.alive);
            pool.sprite.alive = alive;
            const cells = new Float32Array(cap);
            cells.set(pool.sprite.cells);
            pool.sprite.cells = cells;
        }
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

    /** Compose a MODEL member: `restWorld × (yaw · translate(x, y+yOffset, z))`,
     *  matching EntityRenderer's per-piece placement so a member reads exactly
     *  like a full unit of the same def. Babylon multiplies row-vector local ×
     *  parent, so member-world is the left operand. Alloc-free. */
    private writeModelMatrix(
        pool: InstancePool, index: number,
        x: number, y: number, z: number, headingY: number,
    ): void {
        const m = pool.model!;
        this._s.set(1, 1, 1);
        Quaternion.RotationYawPitchRollToRef(headingY, 0, 0, this._q);
        this._t.set(x, y + m.yOffset, z);
        Matrix.ComposeToRef(this._s, this._q, this._t, this._m);   // member world
        m.restWorld.multiplyToRef(this._m, this._m2);              // restWorld × member
        this._m2.copyToArray(pool.matrices, index * 16);
        pool.dirty = true;
    }

    private flushPool(pool: InstancePool): void {
        if (!pool.dirty) return;
        pool.dirty = false;
        pool.mesh.thinInstanceSetBuffer('matrix', pool.matrices, 16, false);
        // Per-member directional cell selector (ImpostorUvPlugin reads it in the
        // vertex shader). Only sprite pools carry it; capsule/wreck pools don't.
        if (pool.sprite) {
            pool.mesh.thinInstanceSetBuffer('cellIndex', pool.sprite.cells, 1, false);
        }
        pool.mesh.thinInstanceCount = pool.highWater;
        pool.mesh.isVisible = pool.highWater > 0;
        if (pool.highWater > 0) {
            pool.mesh.thinInstanceRefreshBoundingInfo(false);
        }
    }
}
