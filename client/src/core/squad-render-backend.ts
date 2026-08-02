// squad-render-backend.ts — the game-processor worker's implementation of the
// Metalstorm squad-system RenderBackend interface
// (data/games/metalstorm/client/squads/render-backend.js).
//
// The squad modules are pure logic: one sim unit (squad_size > 1) fans out into
// many cosmetic on-screen "soldiers". This adapter draws those members (and the
// wrecks a casualty leaves) as thin instances in the live Babylon scene, and
// answers the logic's ground-height / on-screen queries against the real
// heightmap + camera. Everything here is presentation only — nothing feeds the
// sim (AGENTS.md squad-based design; PLAN-latency-squads.md).
//
// Members draw as one of three visual classes, in priority order:
//  - IMPOSTOR SPRITE — defs with a registered impostor atlas (beta-units
//    §2.1 impostor-first infantry/civilians: authored `<stem>_impostor.ktx2`
//    sprite sheets) render each member as a camera-facing billboard quad,
//    thin-instanced per (defId, team) with the shared impostor material
//    (impostor-renderer.ts: alpha-tested PBR + TeamColorPlugin).
//  - REAL MODEL — defs with a loaded 3D model draw each member as that
//    model, one thin-instance pool per (defId, team, piece), matrices
//    composed exactly as EntityRenderer.tick() does for a single sim entity
//    (`piece.restWorldMatrix × memberWorld`, translation lifted by the
//    template's yOffset). Models load lazily, so a member created before its
//    def's glTF lands starts on the capsule and is migrated in place by
//    `flush()` the frame the model becomes available.
//  - PROXY CAPSULE — the last resort, for defs that ship neither an impostor
//    atlas nor a model file (see the missing-model warning the server logs at
//    defs-bake time). Not a Recoil divergence: soldier-model fan-out is
//    Metalstorm-specific cosmetic presentation with no Recoil equivalent, and
//    the sim only ever knows the single squad unit.

import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Quaternion,
  Matrix,
} from "@babylonjs/core";
import {
  createImpostorMaterial,
  computeCardRotation,
  layoutOf,
  type ImpostorAtlas,
} from "./impostor-renderer.js";
import type { AtlasLayout } from "./impostor-atlas.js";
import type { SquadMemberModel } from "./entity-renderer.js";

/** One drawable mesh inside a pool, with its own thin-instance buffer.
 *  Capsule / sprite / wreck pools have exactly one; a real-model pool has one
 *  per geometry piece of the model. */
interface PoolPiece {
  mesh: Mesh;
  matrices: Float32Array; // capacity * 16
  /** Rest-pose transform of this piece inside the model. Null on single-mesh
   *  pools, where the member's world matrix IS the instance matrix. */
  rest: Matrix | null;
}

/** A grow-on-demand thin-instance pool for one visual class (members of a
 *  given team, or wrecks). Freed slots are collapsed to a zero-scale matrix so
 *  they render as nothing until the index is reused. A slot index addresses
 *  the same member across every piece of the pool. */
interface InstancePool {
  pieces: PoolPiece[];
  capacity: number;
  highWater: number; // count uploaded to thinInstanceCount
  free: number[]; // released indices, LIFO
  dirty: boolean;
  /** Present on real-model pools only: the template's base lift, so the
   *  model's feet sit on the member's ground position. */
  modelYOffset?: number;
  /** Present on impostor-sprite pools only. Sprite quads face the camera,
   *  so their matrices are recomposed every flush() from the stored member
   *  positions + the current camera — updateMember() just records the
   *  position (a member idling while the camera orbits must still
   *  re-billboard). */
  sprite?: {
    halfH: number; // quad half-height (ground-anchor lift)
    layout: AtlasLayout; // decides whether the card tilts with camera pitch
    pos: Float32Array; // capacity * 3, member ground positions
    alive: Uint8Array; // capacity, 1 = slot has a live member
  };
}

interface MemberSlot {
  pool: InstancePool;
  index: number;
}

/** A member still drawing as a capsule because its def's model had not
 *  finished loading when the member was created. `flush()` retries the model
 *  lookup once per frame and migrates these in place (see `upgradePending`),
 *  replaying the last pose so the swap costs no visible frame. */
interface PendingModelMember {
  handle: number;
  defId: number;
  team: number;
  x: number;
  y: number;
  z: number;
  headingY: number;
}

const MEMBER_HEIGHT = 9; // elmos — proxy capsule height
const MEMBER_RADIUS = 1.6;
const WRECK_SIZE = 4; // elmos — flat debris box

export interface SquadHost {
  /** Terrain height sample (client heightmap) for member Y. */
  getGroundHeight(x: number, z: number): number;
  /** Same team palette the unit meshes use. */
  getTeamColor(team: number): Color3;
  /** Impostor sprite atlas for a def, if one streamed (impostor-renderer's
   *  registry) — members of such defs draw as sprite billboards. */
  getImpostorAtlas(defId: number): ImpostorAtlas | undefined;
  /** The def's real 3D model, prepared for member drawing
   *  (EntityRenderer.getSquadMemberModel). Null while the glTF is still
   *  loading, or permanently for a def that ships no model — the caller falls
   *  back to the proxy capsule and retries each frame until it resolves.
   *  Optional so a host that has no model source (tests, headless) keeps the
   *  old capsule-only behaviour. */
  getSquadMemberModel?(defId: number, team: number): SquadMemberModel | null;
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
  /** One real-model member pool per "defId:team" (lazily created). */
  private modelPools = new Map<string, InstancePool>();
  /** Single shared wreck pool. */
  private wreckPool: InstancePool | null = null;

  /** Members on the capsule fallback whose def may still resolve to a model.
   *  Keyed by handle so a release can drop the entry in O(1). */
  private pendingModel = new Map<number, PendingModelMember>();

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
  private _pm = Matrix.Identity(); // rest × member-world, per model piece

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

  createMember(
    squadId: number,
    _memberId: number,
    v: { defId: number; variant: number },
  ): number {
    const team = this.squadTeam.get(squadId) ?? 0;
    const handle = this.nextHandle++;

    // Priority: impostor sprite → real model → proxy capsule.
    const atlas = this.host.getImpostorAtlas(v.defId);
    let pool = atlas ? this.getSpritePool(v.defId, team, atlas) : null;
    if (!pool) pool = this.getModelPool(v.defId, team);
    if (!pool) {
      pool = this.getMemberPool(team);
      // No atlas and no model *yet* — the glTF may still be in flight, so
      // keep this member on the retry list rather than freezing it as a
      // capsule for the rest of the game.
      if (!atlas) {
        this.pendingModel.set(handle, {
          handle, defId: v.defId, team, x: 0, y: 0, z: 0, headingY: 0,
        });
      }
    }
    const index = this.allocSlot(pool);
    this.memberByHandle.set(handle, { pool, index });
    return handle;
  }

  updateMember(
    handle: number,
    x: number,
    y: number,
    z: number,
    headingY: number,
    gait: number,
  ): void {
    const slot = this.memberByHandle.get(handle);
    if (!slot) return;
    // Gait 0..1 → a subtle vertical bob so a moving squad reads as walking.
    const bob = Math.sin(gait * Math.PI * 2) * 0.4;
    const sprite = slot.pool.sprite;
    if (sprite) {
      // Billboard matrices are composed in flush() against the current
      // camera; here we only record the member's ground position.
      const base = slot.index * 3;
      sprite.pos[base] = x;
      sprite.pos[base + 1] = y + bob;
      sprite.pos[base + 2] = z;
      sprite.alive[slot.index] = 1;
      slot.pool.dirty = true;
      return;
    }
    const pending = this.pendingModel.get(handle);
    if (pending) {
      // Retain the pose so an upgrade to the real model this frame can replay
      // it into the new slot instead of showing an empty matrix for a frame.
      pending.x = x;
      pending.y = y;
      pending.z = z;
      pending.headingY = headingY;
    }
    // A real model is authored with its base at Y=0 and lifted by the
    // template's yOffset (same convention as EntityRenderer.tick()); the proxy
    // capsule is centre-origin, so it lifts by half its height instead.
    const lift =
      slot.pool.modelYOffset !== undefined
        ? slot.pool.modelYOffset
        : MEMBER_HEIGHT * 0.5;
    this.writeMatrix(slot.pool, slot.index, x, y + lift + bob, z, headingY, 1);
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
    this.pendingModel.delete(handle);
  }

  spawnWreck(
    x: number,
    y: number,
    z: number,
    headingY: number,
    _v: unknown,
  ): number {
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
    const m = slot.pool.pieces[0].matrices; // the wreck pool is single-mesh
    // Re-scale the rotation/scale 3×3 block by alpha relative to unit.
    // Cheapest correct path: recompose from the stored translation.
    const tx = m[12],
      ty = m[13],
      tz = m[14];
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
      if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.d < 0)
        return false;
    }
    return true;
  }

  // --- per-frame flush ----------------------------------------------------

  /** Upload dirty pools. Called once per render frame after
   *  SquadManager.update() has issued this frame's member transforms.
   *  Sprite pools re-billboard against the active camera every flush — an idle
   *  member must still turn with an orbiting camera. The card rotation comes
   *  from `computeCardRotation` (impostor-renderer.ts), so this path and the
   *  entity impostor path share one convention, including whether the card
   *  tilts with camera pitch (a property of the pool's atlas layout). */
  flush(): void {
    if (this.pendingModel.size) this.upgradePending();
    for (const pool of this.memberPools.values()) this.flushPool(pool);
    for (const pool of this.modelPools.values()) this.flushPool(pool);
    const camera = this.scene.activeCamera;
    for (const pool of this.spritePools.values()) {
      if (camera && pool.sprite) {
        this.billboardSpritePool(
          pool,
          computeCardRotation(camera, pool.sprite.layout),
        );
      }
      this.flushPool(pool);
    }
    if (this.wreckPool) this.flushPool(this.wreckPool);
  }

  /** Move every capsule member whose def's model has finished loading onto
   *  that model, replaying its last pose. Runs once per frame and only while
   *  something is still pending, so a game whose defs all resolved (or that
   *  ships no models at all) pays a single Map.size check per frame. */
  private upgradePending(): void {
    for (const p of [...this.pendingModel.values()]) {
      const pool = this.getModelPool(p.defId, p.team);
      if (!pool) continue; // still loading, or this def has no model at all
      const slot = this.memberByHandle.get(p.handle);
      if (!slot) {
        this.pendingModel.delete(p.handle);
        continue;
      }
      this.freeSlot(slot.pool, slot.index);
      const index = this.allocSlot(pool);
      this.memberByHandle.set(p.handle, { pool, index });
      this.pendingModel.delete(p.handle);
      this.writeMatrix(
        pool, index, p.x, p.y + (pool.modelYOffset ?? 0), p.z, p.headingY, 1);
    }
  }

  dispose(): void {
    for (const pool of this.memberPools.values()) this.disposePool(pool);
    for (const pool of this.spritePools.values()) this.disposePool(pool);
    // Model pools' meshes are OWNED BY EntityRenderer (its squadMemberMeshes
    // cache, shared across pools of the same def+team) — dropping the pool
    // must not dispose them. EntityRenderer.dispose() frees them.
    this.memberPools.clear();
    this.spritePools.clear();
    this.modelPools.clear();
    if (this.wreckPool) this.disposePool(this.wreckPool);
    this.wreckPool = null;
    this.memberByHandle.clear();
    this.wreckByHandle.clear();
    this.squadTeam.clear();
    this.pendingModel.clear();
  }

  private disposePool(pool: InstancePool): void {
    for (const p of pool.pieces) p.mesh.dispose();
  }

  // --- internals ----------------------------------------------------------

  private getMemberPool(team: number): InstancePool {
    let pool = this.memberPools.get(team);
    if (pool) return pool;
    const mesh = MeshBuilder.CreateCapsule(
      `squadMember_t${team}`,
      {
        height: MEMBER_HEIGHT,
        radius: MEMBER_RADIUS,
        tessellation: 6,
        subdivisions: 1,
      },
      this.scene,
    );
    const mat = new StandardMaterial(`squadMemberMat_t${team}`, this.scene);
    const c = this.host.getTeamColor(team);
    mat.diffuseColor = c;
    mat.specularColor = new Color3(0.1, 0.1, 0.1);
    mat.emissiveColor = c.scale(0.25);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    pool = this.newPool([{ mesh, rest: null }]);
    this.memberPools.set(team, pool);
    return pool;
  }

  /** The real-model pool for a def+team, or null if the host has no model for
   *  it (yet, or ever). Never caches the negative itself — the host owns that
   *  decision (EntityRenderer keeps a permanent null for model-less defs), so
   *  a repeated call while a glTF is in flight stays a cheap Map lookup there. */
  private getModelPool(defId: number, team: number): InstancePool | null {
    const key = `${defId}:${team}`;
    const existing = this.modelPools.get(key);
    if (existing) return existing;
    const model = this.host.getSquadMemberModel?.(defId, team);
    if (!model || model.pieces.length === 0) return null;
    const pool = this.newPool(
      model.pieces.map((p) => ({ mesh: p.mesh, rest: p.rest })),
    );
    pool.modelYOffset = model.yOffset;
    this.modelPools.set(key, pool);
    return pool;
  }

  private getSpritePool(
    defId: number,
    team: number,
    atlas: ImpostorAtlas,
  ): InstancePool {
    const key = `${defId}:${team}`;
    let pool = this.spritePools.get(key);
    if (pool) return pool;
    const mesh = MeshBuilder.CreatePlane(
      `squadSprite_d${defId}_t${team}`,
      {
        width: atlas.width,
        height: atlas.height,
        sideOrientation: Mesh.DOUBLESIDE,
      },
      this.scene,
    );
    mesh.material = createImpostorMaterial(
      `squadSpriteMat_d${defId}_t${team}`,
      atlas,
      team,
      this.scene,
    );
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    pool = this.newPool([{ mesh, rest: null }]);
    pool.sprite = {
      halfH: atlas.height * 0.5,
      layout: layoutOf(atlas),
      pos: new Float32Array(pool.capacity * 3),
      alive: new Uint8Array(pool.capacity),
    };
    this.spritePools.set(key, pool);
    return pool;
  }

  /** Recompose every live sprite slot's matrix against the batch's shared card
   *  rotation (mesh-level billboardMode doesn't apply per-thin-instance — see
   *  impostor-renderer.ts). `cardRot` is uniform across the pool, so it is
   *  resolved once per flush in the caller, never per sprite. Alloc-free. */
  private billboardSpritePool(pool: InstancePool, cardRot: Quaternion): void {
    const sprite = pool.sprite;
    if (!sprite || pool.highWater === 0) return;
    const matrices = pool.pieces[0].matrices; // sprite pools are single-mesh
    this._s.set(1, 1, 1);
    // Ground-anchor lift along the card's own local up, so a tilted card keeps
    // its base on the terrain instead of hovering (or sinking) as the camera
    // pitches. For an upright card this is exactly the old world-up lift.
    this._t.set(0, sprite.halfH, 0);
    this._t.rotateByQuaternionToRef(cardRot, this._t);
    const lx = this._t.x,
      ly = this._t.y,
      lz = this._t.z;
    for (let i = 0; i < pool.highWater; i++) {
      if (!sprite.alive[i]) continue;
      const base = i * 3;
      const x = sprite.pos[base],
        y = sprite.pos[base + 1],
        z = sprite.pos[base + 2];
      this._t.set(x + lx, y + ly, z + lz);
      Matrix.ComposeToRef(this._s, cardRot, this._t, this._m);
      this._m.copyToArray(matrices, i * 16);
    }
    pool.dirty = true;
  }

  private getWreckPool(): InstancePool {
    if (this.wreckPool) return this.wreckPool;
    const mesh = MeshBuilder.CreateBox(
      "squadWreck",
      {
        width: WRECK_SIZE,
        height: WRECK_SIZE * 0.3,
        depth: WRECK_SIZE,
      },
      this.scene,
    );
    const mat = new StandardMaterial("squadWreckMat", this.scene);
    mat.diffuseColor = new Color3(0.18, 0.16, 0.14);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    this.wreckPool = this.newPool([{ mesh, rest: null }]);
    return this.wreckPool;
  }

  private newPool(
    meshes: { mesh: Mesh; rest: Matrix | null }[],
    capacity = 64,
  ): InstancePool {
    const pieces: PoolPiece[] = meshes.map(({ mesh, rest }) => {
      const matrices = new Float32Array(capacity * 16);
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      mesh.thinInstanceCount = 0;
      mesh.isVisible = false;
      return { mesh, matrices, rest };
    });
    return { pieces, capacity, highWater: 0, free: [], dirty: false };
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
    for (const p of pool.pieces) p.matrices.fill(0, base, base + 16);
    if (pool.sprite) pool.sprite.alive[index] = 0;
    pool.free.push(index);
    pool.dirty = true;
  }

  private growPool(pool: InstancePool): void {
    const cap = pool.capacity * 2;
    for (const p of pool.pieces) {
      const next = new Float32Array(cap * 16);
      next.set(p.matrices);
      p.matrices = next;
    }
    pool.capacity = cap;
    if (pool.sprite) {
      const pos = new Float32Array(cap * 3);
      pos.set(pool.sprite.pos);
      pool.sprite.pos = pos;
      const alive = new Uint8Array(cap);
      alive.set(pool.sprite.alive);
      pool.sprite.alive = alive;
    }
  }

  /** Compose scale·yaw·translate into the pool's matrix buffer at `index`.
   *  Alloc-free (reuses scratch). */
  private writeMatrix(
    pool: InstancePool,
    index: number,
    x: number,
    y: number,
    z: number,
    headingY: number,
    scale: number,
  ): void {
    this._s.set(scale, scale, scale);
    Quaternion.RotationYawPitchRollToRef(headingY, 0, 0, this._q);
    this._t.set(x, y, z);
    Matrix.ComposeToRef(this._s, this._q, this._t, this._m);
    const base = index * 16;
    for (const p of pool.pieces) {
      // Same composition order as EntityRenderer.tick(): piece-local vertices
      // → model space via the piece's rest transform → world via the member's
      // transform. Single-mesh pools have no rest transform and write direct.
      if (p.rest) {
        p.rest.multiplyToRef(this._m, this._pm);
        this._pm.copyToArray(p.matrices, base);
      } else {
        this._m.copyToArray(p.matrices, base);
      }
    }
    pool.dirty = true;
  }

  private flushPool(pool: InstancePool): void {
    if (!pool.dirty) return;
    pool.dirty = false;
    for (const p of pool.pieces) {
      p.mesh.thinInstanceSetBuffer("matrix", p.matrices, 16, false);
      p.mesh.thinInstanceCount = pool.highWater;
      p.mesh.isVisible = pool.highWater > 0;
      if (pool.highWater > 0) {
        p.mesh.thinInstanceRefreshBoundingInfo(false);
      }
    }
  }
}
