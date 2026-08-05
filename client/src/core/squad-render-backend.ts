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
// Members draw as one of three visual classes, chosen PER MEMBER PER FRAME by
// camera distance (PLAN-metalstorm-impostors.md M4 — member LOD swap):
//  - MODEL — a member of a def with a 3D body, closer than the def's
//    impostorDistance, draws the real low-poly body (EntityRenderer
//    .getMemberModel: one team-material mesh per model piece), thin-instanced
//    per (defId, team, piece) with REAL facing from headingY.
//  - IMPOSTOR SPRITE — the same member beyond impostorDistance (and any member
//    of an atlas def with no 3D model yet) draws the baked directional sprite
//    (8-yaw × 3-pitch atlas, screen-aligned card, per-instance cell select).
//  - PROXY CAPSULE — the LAST RESORT: a member whose def offers NEITHER tier
//    this frame (no impostor atlas and no loadable body) keeps the small
//    team-coloured capsule. A deliberate placeholder for defs that ship no art,
//    not a Recoil divergence — the sim only ever knows the single squad unit.
//
// The two art tiers are independent gates. A def with a body but no atlas (e.g.
// `ms_tanks_s2`, `objectname = fable_tank`) has no sprite tier to switch TO, so
// its effective impostorDistance is Infinity and it holds the model tier at
// every range; the capsule stays reachable only while the body is still loading
// or if the def has no body at all. Gating MODEL on the def carrying BOTH a body
// and an atlas is what stranded those defs on the capsule.
//
// A member migrates between the three pools as it moves relative to the camera
// (or as its model finishes loading); the pool move reuses the alloc/free slot
// machinery. Model meshes are BORROWED from EntityRenderer (owned=false) so the
// backend never disposes them.
//
// M5 — no-pop boundary crossfade (PLAN-metalstorm-impostors.md §2.1 "no pop"
// gate): the MODEL↔SPRITE swap is not a hard cut. Over a distance band just
// inside impostorDistance a member is drawn in BOTH pools at once — the 3D
// body fading out (fade 1→0) while the sprite fades in (fade 0→1) — via a
// screen-door (ordered-dither) opacity that discards fragments per-pixel
// (DitherFadePlugin). No alpha blending, so the alpha-test / opaque pipelines
// and depth writes are untouched; the two tiers just interleave per pixel.

import {
    Scene, Mesh, MeshBuilder, StandardMaterial, Color3,
    Vector3, Quaternion, Matrix,
} from '@babylonjs/core';
import {
    createImpostorMaterial, createImpostorCard, computeCardRotation, layoutOf,
    cardLift, type ImpostorAtlas,
} from './impostor-renderer.js';
import { type AtlasLayout, selectAtlasCell } from './impostor-atlas.js';

/** One geometry piece of a member body. Infantry are a single `body` piece;
 *  vehicles ship several (hull / tracks / turret / barrel), each its own mesh
 *  with its own rest-pose transform. */
export interface MemberModelPiece {
    /** Thin-instance-ready render mesh (team-coloured), owned by EntityRenderer. */
    mesh: Mesh;
    /** Piece rest-pose world matrix (identity for a feet-at-origin body). */
    restWorld: Matrix;
}

/** 3D member-model source for the MODEL tier, supplied by EntityRenderer
 *  (getMemberModel). The backend thin-instances every piece and composes each
 *  member as `piece.restWorld × (yaw · translate(x, y+yOffset, z))`.
 *
 *  Pieces are drawn in their REST pose — a member's turret does not track its
 *  target the way a full sim unit's does. Members are cosmetic fan-out, and the
 *  sim only ever knows the single squad unit, so there is no per-member aim to
 *  read; the alternative is per-member per-piece animation across every soldier
 *  on screen. */
export interface MemberModel {
    /** At least one piece; drawn in array order, one thin-instance pool each. */
    pieces: MemberModelPiece[];
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
    /** Present on MODEL and SPRITE pools (those whose material carries
     *  DitherFadePlugin): per-instance screen-door fade (1 = opaque). Uploaded
     *  each flush as the `ditherFade` thin-instance buffer. Default 1 so a slot not
     *  in the crossfade band renders fully. */
    fade?: Float32Array;
    /** Present on impostor-sprite pools only. Sprite quads are screen-aligned
     *  (shared camera rotation), so their matrices AND per-member directional
     *  cell selectors are recomposed every flush() from the stored member
     *  positions/headings + the current camera — updateMember() just records
     *  the pose (a member idling while the camera orbits must re-billboard and
     *  re-select its yaw column). */
    sprite?: {
        /** Ground-anchor lift (elmos) from the member's ground point up to
         *  the card's centre — the atlas's own `cardLift`, not always h/2. */
        lift: number;
        /** The grid, elevation arc and azimuth phase THIS atlas was baked on —
         *  it also decides whether the card tilts with camera pitch. */
        layout: AtlasLayout;
        pos: Float32Array;      // capacity * 3, member ground positions
        heading: Float32Array;  // capacity, member facing (radians, RH)
        alive: Uint8Array;      // capacity, 1 = slot has a live member
        cells: Float32Array;    // capacity, per-member packed cell index (GPU)
    };
    /** Present on MODEL pools only — the transform data to compose members
     *  against the borrowed body geometry. */
    model?: { restWorld: Matrix; yOffset: number };
    /** PLAN-perf M21: whether this pool's thin-instance vertex buffers are
     *  currently bound to its live typed arrays. `thinInstanceSetBuffer`
     *  DISPOSES and RE-CREATES the GPU buffer (and, for user kinds, re-registers
     *  the vertex attribute) on every call, so it must run once per array
     *  identity — at creation and after `growPool` reallocates — not once per
     *  frame. Steady-state flushes re-upload in place instead. */
    buffersBound?: boolean;
    /** PLAN-perf M21: flushes remaining before the next bounding-info refresh.
     *  0 forces one on the next flush. */
    bboxCountdown?: number;
}

interface MemberSlot { pool: InstancePool; index: number; }

/** Per-member LOD state. A member holds model slots and a sprite slot
 *  simultaneously (both live only inside the crossfade band, M5); the capsule
 *  is held only when neither art tier drew it. Wrecks stay on the simpler
 *  MemberSlot. */
interface MemberEntry {
    defId: number;
    team: number;
    /** Impostor sprite atlas (undefined → the def has no sprite tier). */
    atlas?: ImpostorAtlas;
    /** Full→impostor member switch distance (elmos). Undefined → the def has no
     *  3D model tier, so the member never leaves the sprite pool. `Infinity`
     *  for a body-without-atlas def: the model tier has nothing to hand over to,
     *  so it holds at every range. */
    impostorDist?: number;
    /** Current occupancy. One model slot PER MODEL PIECE (all in the same
     *  tier/fade state, so they are allocated and freed together); model/sprite
     *  are mutually inclusive (crossfade); capsule is exclusive of both. */
    model?: MemberSlot[];
    sprite?: MemberSlot;
    capsule?: MemberSlot;
    /** Resolved sprite pool for (defId, team), cached on first use. Both are
     *  fixed for an entry's lifetime, so the `${defId}:${team}` template-literal
     *  key + Map lookup that resolved it was a per-member-per-frame string
     *  allocation on the hottest path in the client frame (PLAN-perf M13). */
    spritePool?: InstancePool;
}

/** M13 fix 2's legacy arm. ON restores the pre-M13 `updateMember` preamble —
 *  the handle Map lookup, the per-call `fallback` closure and the
 *  `${defId}:${team}` sprite-pool key — so the win can be A/B'd inside one
 *  session at the L-battle and flipped back to prove it is the lever and not
 *  drift. OFF in every shipping frame; measurement only. Reachable from the
 *  worker as `__perfToggles.squadBackendLegacy(on)`. */
let LEGACY_BACKEND_PLUMBING = false;

export function setLegacyBackendPlumbing(on: boolean): boolean {
    LEGACY_BACKEND_PLUMBING = !!on;
    return LEGACY_BACKEND_PLUMBING;
}

/** M21's legacy arm. ON restores the pre-M21 `flushPool` — a full
 *  `thinInstanceSetBuffer` per buffer per pool per frame, which disposes and
 *  re-creates every GPU buffer each frame. OFF (shipping) binds each buffer
 *  once per array identity and re-uploads in place. Same A/B contract as
 *  `squadBackendLegacy`: measurement only, reachable from the worker as
 *  `__perfToggles.squadRebindBuffers(on)`. */
let LEGACY_BUFFER_REBIND = false;

export function setLegacyBufferRebind(on: boolean): boolean {
    LEGACY_BUFFER_REBIND = !!on;
    return LEGACY_BUFFER_REBIND;
}

/** How many flushes a pool may skip before its thin-instance bounding info is
 *  recomputed (PLAN-perf M21). `thinInstanceRefreshBoundingInfo` transforms 8
 *  bounding vectors for EVERY slot up to the pool's capacity — at the
 *  XL-battle's two 8 192-slot sprite pools that measured 2.3 ms/frame, ~95 % of
 *  what was left of the flush and more than the buffer re-bind it sits next to.
 *
 *  Nothing on this renderer's path reads it: every pool mesh sets
 *  `alwaysSelectAsActiveMesh` (so it is never frustum-culled) and
 *  `isPickable = false`, and squad member pools are not registered as shadow
 *  casters. Refreshing on a slow cadence rather than never is deliberate
 *  insurance against a future consumer — it keeps the box correct to within a
 *  quarter second, for ~7 % of the cost. A pool that was just bound or grown
 *  refreshes immediately (see `flushPool`), so a new pool is never wrong.
 *  1 restores the pre-M21 every-flush behaviour; `__perfToggles.squadBboxEvery`. */
let BBOX_REFRESH_EVERY = 15;

export function setBboxRefreshEvery(n: number): number {
    BBOX_REFRESH_EVERY = Math.max(1, n | 0);
    return BBOX_REFRESH_EVERY;
}

const MEMBER_HEIGHT = 9;      // elmos — proxy capsule height
const MEMBER_RADIUS = 1.6;
const WRECK_SIZE = 4;         // elmos — flat debris box

/** Crossfade band width as a fraction of impostorDistance (M5). The member is
 *  drawn in both tiers across `[D·(1−FADE_FRAC), D]`; below that band it is
 *  pure model, at/above D pure sprite. A fraction (not an absolute) keeps the
 *  band proportionate for any def's switch distance. */
export const FADE_FRAC = 0.15;

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
     *  treats -1 as released, per render-backend.js).
     *
     *  M13 fix 2: this is a dense ARRAY, not a Map. `updateMember` runs once
     *  per rendered member per frame (7 200/frame at the L-battle) and M12
     *  attributed 14.2 % of the whole `entity` phase to it — most of that in
     *  its preamble, not its work. Handles are ours to hand out, so they are
     *  array indices. Freed handles are recycled through `freeHandles`, so the
     *  array is sized by PEAK live members rather than by total ever created —
     *  which matters because an icon↔full LOD flip releases and recreates
     *  every member of a squad. Index 0 is never handed out, so a falsy handle
     *  and -1 both read as "no entry".
     *
     *  A member handle and a wreck handle may now collide numerically; they
     *  never cross paths, because each kind is looked up only in its own table
     *  by a caller that knows which it holds. */
    private memberEntries: (MemberEntry | undefined)[] = [undefined];
    private freeHandles: number[] = [];
    /** Kept in step with `memberEntries` so the M13 A/B's legacy arm can read
     *  the Map form in-session. Written only on create/release, never per
     *  frame — see `LEGACY_BACKEND_PLUMBING`. */
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
        // Model tier whenever the host can supply a body at all. WITH an atlas
        // the def's declared switch distance says where the sprite tier takes
        // over; WITHOUT one there is no sprite tier to switch to, so the model
        // tier runs to Infinity (an atlas-less def that also declares a distance
        // would otherwise fall off the model tier into nothing but the capsule).
        // Cached per member; the body itself is resolved live (still loading →
        // the member falls back for that frame).
        const impostorDist = this.host.getMemberModel
            ? (atlas ? this.host.getImpostorDistance?.(v.defId) : Infinity)
            : undefined;
        const entry: MemberEntry = { defId: v.defId, team, atlas, impostorDist };
        // Slots are allocated lazily by the first updateMember once the member's
        // world position (hence its LOD tier + fade) is known.
        const handle = this.freeHandles.pop() ?? this.memberEntries.length;
        this.memberEntries[handle] = entry;
        this.memberByHandle.set(handle, entry);
        return handle;
    }

    /** handle → entry, honouring M13 fix 2's legacy arm. */
    private entryOf(handle: number): MemberEntry | undefined {
        return LEGACY_BACKEND_PLUMBING
            ? this.memberByHandle.get(handle)
            : this.memberEntries[handle];
    }

    updateMember(handle: number, x: number, y: number, z: number, headingY: number, gait: number): void {
        const entry = this.entryOf(handle);
        if (!entry) return;
        // Gait 0..1 → a subtle vertical bob so a moving squad reads as walking.
        const bob = Math.sin(gait * Math.PI * 2) * 0.4;
        const my = y + bob;

        // Decide the model/sprite fades for this member at its current distance.
        // The model tier needs a switch distance AND a loaded body; the body is
        // only fetched when the member is within D (no preloading for far
        // members — preserves the M4 lazy-load). `sprite` is only ever a
        // fallback for a def that HAS an atlas; without one the member drops to
        // the capsule instead (fallback(), below).
        let modelFade: number | undefined;
        let spriteFade: number | undefined;
        let model: MemberModel | undefined;
        // "Fall back to the sprite tier (if this def has one)". M13 fix 2: this
        // was a closure allocated per call — it captures two mutable `let`s, so
        // V8 cannot elide it — i.e. 7 200 allocations/frame at the L-battle. It
        // is now a flag, applied once after the tier decision.
        let wantFallback = false;
        const fallback = LEGACY_BACKEND_PLUMBING
            ? () => { if (entry.atlas) spriteFade = 1; }
            : null;
        const D = entry.impostorDist;
        if (D === undefined || !this.host.getMemberModel) {
            if (fallback) fallback(); else wantFallback = true;   // no 3D tier for this def
        } else {
            const cam = this.scene.activeCamera?.position;
            // D === Infinity (atlas-less def) → inner is Infinity too, so every
            // finite distance lands in the "pure model" branch and neither the
            // far-sprite nor the crossfade branch is reachable.
            const inner = D * (1 - FADE_FRAC);
            if (!cam) {
                // No camera (tests / headless) → prefer the model if it loads.
                model = this.host.getMemberModel(entry.defId, entry.team);
                if (model) modelFade = 1;
                else if (fallback) fallback(); else wantFallback = true;
            } else {
                const dx = cam.x - x, dy = cam.y - y, dz = cam.z - z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 >= D * D) {
                    spriteFade = 1;                      // far: pure sprite
                } else {
                    // Within D → the body is needed (may still be loading).
                    model = this.host.getMemberModel(entry.defId, entry.team);
                    if (!model) {
                        // still loading → sprite/capsule
                        if (fallback) fallback(); else wantFallback = true;
                    } else if (d2 <= inner * inner) {
                        modelFade = 1;                   // pure model
                    } else {
                        // Crossfade band: both tiers live, dithered complementarily.
                        const t = (Math.sqrt(d2) - inner) / (D - inner);
                        modelFade = 1 - t;
                        spriteFade = t;
                    }
                }
            }
        }

        if (wantFallback && entry.atlas) spriteFade = 1;

        // Reconcile model occupancy — one pool (and slot) per model piece, all
        // carrying the same fade so a multi-piece body dissolves as one object.
        if (modelFade !== undefined && model) {
            this.ensureModel(entry, model);
            const slots = entry.model!;
            for (let p = 0; p < slots.length; p++) {
                const { pool, index } = slots[p];
                pool.fade![index] = modelFade;
                this.writeModelMatrix(pool, index, x, my, z, headingY);
            }
        } else {
            this.freeModel(entry);
        }

        // Reconcile sprite occupancy (screen-aligned matrix + directional cell
        // are composed in flush() against the camera; here we record the pose).
        if (spriteFade !== undefined) {
            const pool = this.ensureSprite(entry);
            const i = entry.sprite!.index;
            const s = pool.sprite!;
            const base = i * 3;
            s.pos[base] = x;
            s.pos[base + 1] = my;
            s.pos[base + 2] = z;
            s.heading[i] = headingY;
            s.alive[i] = 1;
            pool.fade![i] = spriteFade;
            pool.dirty = true;
        } else {
            this.freeSprite(entry);
        }

        // Capsule = last resort. Held only when NEITHER art tier drew this
        // member: no atlas and no body (or the body is still streaming).
        if (entry.model || entry.sprite) {
            this.freeCapsule(entry);
        } else {
            const pool = this.ensureCapsule(entry);
            this.writeMatrix(pool, entry.capsule!.index,
                x, my + MEMBER_HEIGHT * 0.5, z, headingY, 1);
        }
    }

    destroyMember(handle: number, _death: unknown): void {
        // The visible "fallen" cue is the wreck the squad drops separately
        // (spawnWreck); here we just release the standing member instance.
        this.releaseMember(handle);
    }

    releaseMember(handle: number): void {
        const entry = this.entryOf(handle);
        if (!entry) return;
        this.freeModel(entry);
        this.freeSprite(entry);
        this.freeCapsule(entry);
        this.memberEntries[handle] = undefined;
        this.memberByHandle.delete(handle);
        this.freeHandles.push(handle);
    }

    // --- per-member slot reconciliation (M5 dual residency) -----------------

    /** Bring the member's model slots in line with `model`'s piece list — one
     *  slot per piece. Piece count is a property of the def's template, so it
     *  never changes once resolved; the length check only covers the first
     *  allocation and the (theoretical) template swap. */
    private ensureModel(entry: MemberEntry, model: MemberModel): void {
        const slots = entry.model;
        if (slots && slots.length === model.pieces.length
            && slots[0].pool === this.getModelPool(entry.defId, entry.team, model, 0)) {
            return;
        }
        this.freeModel(entry);
        entry.model = model.pieces.map((_, p) => {
            const pool = this.getModelPool(entry.defId, entry.team, model, p);
            return { pool, index: this.allocSlot(pool) };
        });
    }

    private ensureSprite(entry: MemberEntry): InstancePool {
        // M13 fix 2: getSpritePool builds a `${defId}:${team}` template-literal
        // key, i.e. a string allocation + hash + Map lookup, and this runs for
        // every sprite-tier member every frame (91 % of members at the L-battle
        // pose). Both components are fixed for an entry's lifetime, so resolve
        // the pool once and cache it on the entry.
        let pool = LEGACY_BACKEND_PLUMBING ? undefined : entry.spritePool;
        if (!pool) {
            pool = this.getSpritePool(entry.defId, entry.team, entry.atlas!);
            entry.spritePool = pool;
        }
        if (!entry.sprite || entry.sprite.pool !== pool) {
            if (entry.sprite) this.freeSlot(entry.sprite.pool, entry.sprite.index);
            entry.sprite = { pool, index: this.allocSlot(pool) };
        }
        return pool;
    }

    private ensureCapsule(entry: MemberEntry): InstancePool {
        const pool = this.getMemberPool(entry.team);
        if (!entry.capsule || entry.capsule.pool !== pool) {
            if (entry.capsule) this.freeSlot(entry.capsule.pool, entry.capsule.index);
            entry.capsule = { pool, index: this.allocSlot(pool) };
        }
        return pool;
    }

    private freeModel(entry: MemberEntry): void {
        if (!entry.model) return;
        for (const s of entry.model) this.freeSlot(s.pool, s.index);
        entry.model = undefined;
    }

    private freeSprite(entry: MemberEntry): void {
        if (entry.sprite) { this.freeSlot(entry.sprite.pool, entry.sprite.index); entry.sprite = undefined; }
    }

    private freeCapsule(entry: MemberEntry): void {
        if (entry.capsule) { this.freeSlot(entry.capsule.pool, entry.capsule.index); entry.capsule = undefined; }
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

    /** Test/debug accessor: a member's current LOD occupancy + per-tier fade
     *  (M5 crossfade). Both `model` and `sprite` present with fades in (0,1)
     *  means the member is mid-crossfade across the boundary band. Every model
     *  piece carries the same fade, so the first piece's is the member's. */
    getMemberFades(handle: number): { model?: number; sprite?: number; capsule?: boolean } {
        const entry = this.entryOf(handle);
        if (!entry) return {};
        return {
            model: entry.model ? entry.model[0].pool.fade![entry.model[0].index] : undefined,
            sprite: entry.sprite ? entry.sprite.pool.fade![entry.sprite.index] : undefined,
            capsule: entry.capsule ? true : undefined,
        };
    }

    /** Test/debug accessor: the per-PIECE model fades of a member (one entry
     *  per model piece). They should always agree — a multi-piece body must
     *  dissolve as one object, not piece by piece. */
    getModelFades(handle: number): number[] | undefined {
        const entry = this.entryOf(handle);
        if (!entry?.model) return undefined;
        return entry.model.map((s) => s.pool.fade![s.index]);
    }

    /** Test/debug accessor: the packed atlas cell each live slot of a sprite
     *  pool selected on the last flush (M3 directional select). */
    getSpriteCells(defId: number, team: number): Float32Array | undefined {
        const pool = this.spritePools.get(`${defId}:${team}`);
        if (!pool?.sprite) return undefined;
        return pool.sprite.cells.subarray(0, pool.highWater);
    }

    // --- per-frame flush ----------------------------------------------------

    /** Upload dirty pools. Called once per render frame after
     *  SquadManager.update() has issued this frame's member transforms.
     *  Sprite pools re-billboard against the active camera every flush — an
     *  idle member must still turn with an orbiting camera. The card rotation
     *  comes from `computeCardRotation` (impostor-renderer.ts), so this path
     *  and the entity impostor path share one convention, including whether
     *  the card tilts with camera pitch (a property of the pool's atlas
     *  layout) — hence per pool, not once for the frame. */
    flush(): void {
        for (const pool of this.memberPools.values()) this.flushPool(pool);
        const camera = this.scene.activeCamera;
        const cameraPos = camera?.position;
        for (const pool of this.spritePools.values()) {
            if (camera && cameraPos && pool.sprite) {
                this.billboardSpritePool(pool, cameraPos,
                    computeCardRotation(camera, pool.sprite.layout));
            }
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
        this.memberEntries.length = 1;
        this.freeHandles.length = 0;
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
        const mesh = createImpostorCard(
            `squadSprite_d${defId}_t${team}`, atlas.width, atlas.height, this.scene);
        // withFade: the sprite material carries DitherFadePlugin for the M5
        // model↔sprite crossfade — so this pool MUST upload a `ditherFade` buffer.
        mesh.material = createImpostorMaterial(
            `squadSpriteMat_d${defId}_t${team}`, atlas, team, this.scene, true);
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        pool = this.newPool(mesh);
        pool.fade = new Float32Array(pool.capacity).fill(1);
        pool.sprite = {
            lift: cardLift(atlas),
            layout: layoutOf(atlas),
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
        this._t.set(0, sprite.lift, 0);
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
            sprite.cells[i] = selectAtlasCell(
                cameraPos.x - x, cameraPos.y - y, cameraPos.z - z,
                sprite.heading[i], sprite.layout);
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

    /** One 3D-model member pool per (defId, team, PIECE). The mesh is BORROWED
     *  from EntityRenderer (getMemberModel) — the backend thin-instances it but
     *  does not own/dispose it. Composition data (that piece's rest pose, the
     *  model's yOffset) rides the pool so writeModelMatrix places each member as
     *  restWorld × member world, exactly as the full-unit path does per piece. */
    private getModelPool(
        defId: number, team: number, model: MemberModel, piece: number,
    ): InstancePool {
        const key = `${defId}:${team}:${piece}`;
        let pool = this.modelPools.get(key);
        if (pool) return pool;
        pool = this.newPool(model.pieces[piece].mesh, 64, false);
        pool.model = { restWorld: model.pieces[piece].restWorld, yOffset: model.yOffset };
        // The member material carries DitherFadePlugin (M5 crossfade) → this
        // pool uploads a `fade` buffer (default 1 = fully opaque body).
        pool.fade = new Float32Array(pool.capacity).fill(1);
        this.modelPools.set(key, pool);
        return pool;
    }

    private newPool(mesh: Mesh, capacity = 64, owned = true): InstancePool {
        const matrices = new Float32Array(capacity * 16);
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        mesh.thinInstanceCount = 0;
        mesh.isVisible = false;
        // `buffersBound` stays false: the caller may still attach `fade`/`sprite`
        // arrays after this returns (getSpritePool/getModelPool do), and those
        // kinds must be bound too. The first flushPool binds the full set.
        return {
            mesh, owned, matrices, capacity, highWater: 0, free: [], dirty: false,
            buffersBound: false,
        };
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
        if (pool.fade) pool.fade[index] = 1;   // reset for the next occupant
        pool.free.push(index);
        pool.dirty = true;
    }

    private growPool(pool: InstancePool): void {
        const cap = pool.capacity * 2;
        const next = new Float32Array(cap * 16);
        next.set(pool.matrices);
        pool.matrices = next;
        if (pool.fade) {
            const fade = new Float32Array(cap).fill(1);
            fade.set(pool.fade);
            pool.fade = fade;
        }
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
        // Every array above is a NEW object — the bound GPU buffers still point
        // at the old ones, so the next flush must re-bind rather than re-upload
        // (PLAN-perf M21). Missing this renders a frozen, half-length pool.
        pool.buffersBound = false;
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

    /** Bind (or re-bind) this pool's thin-instance buffers to its current typed
     *  arrays. Expensive — `thinInstanceSetBuffer` disposes the old GPU buffer,
     *  allocates a new one and, for the user kinds, re-registers the vertex
     *  attribute. Call only when an array's identity changes: pool creation and
     *  `growPool`. */
    private bindPoolBuffers(pool: InstancePool): void {
        pool.mesh.thinInstanceSetBuffer('matrix', pool.matrices, 16, false);
        // Per-member directional cell selector (ImpostorUvPlugin reads it in the
        // vertex shader). Only sprite pools carry it; capsule/wreck pools don't.
        if (pool.sprite) {
            pool.mesh.thinInstanceSetBuffer('impostorCell', pool.sprite.cells, 1, false);
        }
        // Per-instance screen-door fade (DitherFadePlugin reads it) — model and
        // sprite pools only; capsule/wreck materials don't carry the plugin.
        if (pool.fade) {
            pool.mesh.thinInstanceSetBuffer('ditherFade', pool.fade, 1, false);
        }
        pool.buffersBound = true;
    }

    private flushPool(pool: InstancePool): void {
        if (!pool.dirty) return;
        pool.dirty = false;
        // PLAN-perf M21: the steady state re-uploads into the buffers already
        // bound rather than re-creating them. The pre-M21 path re-bound all
        // three every frame for every pool, which at the XL-battle was ~45 GPU
        // buffer allocations per frame and 54 % of the per-member `entity`
        // floor. `thinInstancePartialBufferUpdate` also uploads only the live
        // prefix instead of the whole (power-of-two, up to 2× oversized)
        // capacity — instances at or past `highWater` are not drawn.
        const justBound = LEGACY_BUFFER_REBIND || !pool.buffersBound;
        if (justBound) {
            this.bindPoolBuffers(pool);
        } else {
            if (pool.highWater > 0) {
                pool.mesh.thinInstancePartialBufferUpdate('matrix', pool.highWater, 0);
            }
            // 1 float per instance each — small enough that the whole-array
            // upload is not worth a second partial-update code path.
            if (pool.sprite) pool.mesh.thinInstanceBufferUpdated('impostorCell');
            if (pool.fade) pool.mesh.thinInstanceBufferUpdated('ditherFade');
            // `thinInstanceSetBuffer` used to null this for us every frame.
            // It is the lazy read-back cache behind `thinInstanceGetWorldMatrices()`;
            // nothing on the render path consults it (culling re-reads
            // `matrixData` directly in `thinInstanceRefreshBoundingInfo`), but
            // leaving it stale would silently hand debug/test read-backs last
            // frame's poses. One null per pool per frame.
            (pool.mesh as unknown as {
                _thinInstanceDataStorage: { worldMatrices: Matrix[] | null };
            })._thinInstanceDataStorage.worldMatrices = null;
        }
        pool.mesh.thinInstanceCount = pool.highWater;
        pool.mesh.isVisible = pool.highWater > 0;
        // Bounding info on a cadence (see BBOX_REFRESH_EVERY). A pool that just
        // (re-)bound has new geometry or new arrays, so refresh that flush.
        if (pool.highWater > 0) {
            const left = justBound ? 0 : (pool.bboxCountdown ?? 0);
            if (left <= 0) {
                pool.mesh.thinInstanceRefreshBoundingInfo(false);
                pool.bboxCountdown = BBOX_REFRESH_EVERY;
            } else {
                pool.bboxCountdown = left - 1;
            }
        }
    }
}
