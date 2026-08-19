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

/** The direct-write window onto one pool (PLAN-metalstorm-squad-performance.md
 *  §13a, milestone S5). Handed to the SoA kernel, which writes a member's 16
 *  matrix floats (or its sprite pose) in place instead of calling
 *  `updateMember` — no handle lookup, no tier decision, no Babylon
 *  Vector3/Quaternion/Matrix compose per member per frame.
 *
 *  A view is INVALIDATED by `growPool` (new arrays) and by `compactPool` (slots
 *  move): both bump `poolGeneration`, and a holder must re-fetch its view and
 *  re-read its slot index when that number changes. `generation` on the view is
 *  the value it was built at, so a stale view can also be detected directly.
 *
 *  `dirtyLo/dirtyHi` are the pool's OWN dirty range (not a copy) — §13a says
 *  "written back by markDirty", and `markDirty` is how a writer that holds no
 *  view reports one; a holder of the view is looking at the same numbers the
 *  flush reads, so there is nothing to write back. */
export interface PoolView {
    poolId: number;
    /** The live matrix buffer (capacity × 16, row-major, §13b layout). */
    matrices: Float32Array;
    /** Sprite pools only: the member ground pose the billboard pass composes
     *  from. A writer that sees these fields writes the POSE, not a matrix. */
    spritePos?: Float32Array;
    spriteHeading?: Float32Array;
    spriteAlive?: Uint8Array;
    /** Per-instance screen-door fade, where the pool's material carries it. */
    fade?: Float32Array;
    /** Vertical bias from the member's ground point to what this pool draws at:
     *  the capsule's half-height, a model's `yOffset`, 0 for a sprite (whose
     *  card lift is applied by the billboard pass). Carried here so a direct
     *  writer does not need a second copy of the constant. */
    yBias: number;
    /** Gait bob amplitude (elmos) — the same `sin(gait·2π)·A` the
     *  `updateMember` path applies, for the same reason. */
    bobAmp: number;
    dirty: boolean;
    /** Inclusive instance-index range touched since the last flush.
     *  `dirtyHi < dirtyLo` means nothing. */
    dirtyLo: number;
    dirtyHi: number;
    generation: number;
}

/** A grow-on-demand thin-instance pool for one visual class (members of a
 *  given team, or wrecks). Freed slots are collapsed to a zero-scale matrix so
 *  they render as nothing until the index is reused. */
interface InstancePool {
    /** Dense integer id — what a direct writer names the pool by (§13a). */
    id: number;
    /** The pool's persistent PoolView (rebuilt in place on growth). Also the
     *  pool's dirty state: `view.dirty/dirtyLo/dirtyHi`. */
    view: PoolView;
    mesh: Mesh;
    /** False for MODEL pools — the mesh is borrowed from EntityRenderer and
     *  must not be disposed here. True for the backend's own capsule/sprite/
     *  wreck meshes. */
    owned: boolean;
    matrices: Float32Array;   // capacity * 16
    capacity: number;
    highWater: number;        // count uploaded to thinInstanceCount
    free: number[];           // released indices, LIFO
    /** PLAN-perf M24: the `MemberSlot` object that currently owns each slot,
     *  indexed by slot. Every holder of a slot addresses it through one of
     *  these objects (`MemberEntry.model/sprite/capsule`, `wreckByHandle`), so
     *  compaction can move a slot down and rewrite `ref.index` in place —
     *  nothing outside the backend stores a raw pool index. `undefined` for a
     *  free slot. */
    refs: (MemberSlot | undefined)[];
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
        /** Camera position + card rotation the pool was last billboarded
         *  against. Unchanged ⇒ only the slots whose pose moved need
         *  recomposing (S5 §13c). NaN-initialised so the first flush always
         *  recomposes everything. */
        lastCamX: number; lastCamY: number; lastCamZ: number;
        lastRotX: number; lastRotY: number; lastRotZ: number; lastRotW: number;
    };
    /** Present on MODEL pools only — the transform data to compose members
     *  against the borrowed body geometry. */
    model?: {
        restWorld: Matrix; yOffset: number;
        /** `restWorld.updateFlag` the cache below was taken at. */
        restFlag?: number;
        /** Rest pose as plain floats, or null when it is the identity. */
        restCache?: Float32Array | null;
    };
    /** Vertical bias this pool draws its instances at, above the member's
     *  ground point: the capsule's half-height, a model's `yOffset`, 0 for a
     *  sprite (its card lift is applied by the billboard pass) and 0 for the
     *  wreck pool (spawnWreck passes the debris lift itself). Published on the
     *  view so a direct writer needs no second copy of it. */
    yBias: number;
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
    /** S5: this member's slot is PINNED — its owner (the SoA kernel) writes the
     *  transform straight into the pool view, so the tier must not be re-decided
     *  per frame. Only set for a member whose def has exactly ONE reachable
     *  visual tier and therefore exactly one slot for life (see `acquireSlot`). */
    direct?: boolean;
    /** Resolved sprite pool for (defId, team), cached on first use. Both are
     *  fixed for an entry's lifetime, so the `${defId}:${team}` template-literal
     *  key + Map lookup that resolved it was a per-member-per-frame string
     *  allocation on the hottest path in the client frame (PLAN-perf M13). */
    spritePool?: InstancePool;
    /** Resolved capsule pool for (defId, team), cached for the same reason —
     *  the capsule key is now a `${defId}:${team}` string too. */
    capsulePool?: InstancePool;
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

/** S5's legacy arm. ON restores the pre-S5 upload shape: every flush uploads the
 *  whole live prefix, and a sprite pool re-billboards every live slot even when
 *  neither the camera nor its cards moved. OFF (shipping) uploads only the
 *  tracked dirty range and recomposes only the slots whose pose changed while the
 *  camera is still. Same A/B contract as `squadBackendLegacy`/`squadRebindBuffers`
 *  — measurement only, one session, both arms; `__perfToggles.squadFullUpload(on)`.
 *
 *  It does NOT restore the per-member Babylon compose (§13b's inline write) or
 *  the direct-write path: those are correctness-equivalent rewrites pinned by
 *  tests against `Matrix.ComposeToRef`, not a policy with two defensible
 *  settings, and a second matrix-writing code path kept alive for an A/B is the
 *  shape that drifts. */
let LEGACY_FULL_UPLOAD = false;

export function setLegacyFullUpload(on: boolean): boolean {
    LEGACY_FULL_UPLOAD = !!on;
    return LEGACY_FULL_UPLOAD;
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

/** PLAN-perf M24. `freeSlot()` returns an index to the free list but cannot
 *  lower `highWater`, so a pool that has churned keeps uploading and drawing
 *  its dead slots: the billboard recompose loops to `highWater`,
 *  `thinInstancePartialBufferUpdate` re-uploads the whole prefix, and
 *  `thinInstanceCount = highWater` submits the degenerate instances. At the
 *  XL-battle with the M23 `icon` tier engaged that measured 4 550 dead slots
 *  against 10 508 live ones (one sprite pool at 1 074 live / 4 896 drawn).
 *
 *  Compaction moves live slots down into the holes and drops `highWater` to
 *  the live count. It is gated (not every frame): a pool compacts only once
 *  its dead fraction crosses `COMPACT_MIN_FRACTION` and it holds at least
 *  `COMPACT_MIN_DEAD` dead slots, which also gives it hysteresis — a compaction
 *  empties the free list, so the next one cannot fire until that much churn has
 *  accumulated again. OFF restores the pre-M24 never-shrink behaviour for the
 *  A/B; `__perfToggles.squadPoolCompact(on)`.
 *
 *  ⚠️ **This is not a frame-time optimisation, and M24 measured that
 *  directly.** Removing 2 198 dead slots (17.3 % of everything the backend
 *  drew) from the upload and draw path moved `entity` by +0.029 ms, inside a
 *  same-arm window-to-window drift of 0.35 ms; four brackets straddled zero
 *  with no relation to how many slots were recovered. A dead slot is a
 *  zero-scale matrix: the billboard loop skips it on `alive[i]`, it emits no
 *  fragments, and the extra upload bytes are a memcpy. What a *live* member
 *  costs (M21: 0.35 µs; M23: 0.26–0.43 µs) is work a dead slot never does.
 *  What compaction is for is the **high-water ratchet**: `highWater` is a
 *  session maximum, so without it a pool that peaked can never shrink and
 *  `growPool` keeps doubling capacity against a flat live count. */
let POOL_COMPACTION = true;
let COMPACT_MIN_FRACTION = 0.10;
let COMPACT_MIN_DEAD = 32;

export function setPoolCompaction(on: boolean): boolean {
    POOL_COMPACTION = !!on;
    return POOL_COMPACTION;
}

/** A/B knob for the gate itself: how dead a pool must be before it compacts. */
export function setPoolCompactionGate(fraction: number, minDead?: number): {
    fraction: number; minDead: number;
} {
    if (Number.isFinite(fraction)) COMPACT_MIN_FRACTION = Math.max(0, fraction);
    if (Number.isFinite(minDead as number)) COMPACT_MIN_DEAD = Math.max(1, minDead! | 0);
    return { fraction: COMPACT_MIN_FRACTION, minDead: COMPACT_MIN_DEAD };
}

/** Legacy proxy-capsule height (elmos) — the fallback when the host supplies
 *  no `getMemberStats` for a def. Defs with stats are sized per member by
 *  `memberCapsuleHeight` instead. */
const MEMBER_HEIGHT = 9;
const MEMBER_RADIUS = 1.6;
/** Aspect of the sized capsule: radius as a fraction of height. 1.6/9 ≈ a
 *  standing humanoid's proportions (0.32-elmo radius on a 1.8-elmo body). */
const MEMBER_RADIUS_FRAC = MEMBER_RADIUS / MEMBER_HEIGHT;
/** Clamp band for `memberCapsuleHeight` (elmos). The floor keeps a degenerate
 *  def visible at all; the ceiling is above `ms_habitat` (25.5) so no real def
 *  saturates it today. */
const MEMBER_HEIGHT_MIN = 1.2;
const MEMBER_HEIGHT_MAX = 30;
const WRECK_SIZE = 4;         // elmos — flat debris box
/** Gait bob amplitude (elmos). Published on every PoolView so a direct writer
 *  applies the same walk cue as `updateMember` without a second constant. */
const MEMBER_BOB = 0.4;
/** Empty dirty range: `dirtyHi < dirtyLo` (S5 §13c). */
const DIRTY_NONE_LO = 0x7fffffff;
const DIRTY_NONE_HI = -1;

/** Crossfade band width as a fraction of impostorDistance (M5). The member is
 *  drawn in both tiers across `[D·(1−FADE_FRAC), D]`; below that band it is
 *  pure model, at/above D pure sprite. A fraction (not an absolute) keeps the
 *  band proportionate for any def's switch distance. */
export const FADE_FRAC = 0.15;

/** §13b's layout table, written by hand into `out` at `base`: yaw-only rotation
 *  (column-vector convention, translation at [12..14]), uniform scale, and a
 *  CLEAN W-row. Exported so the SoA kernel writes the identical 16 floats
 *  through the pool view rather than carrying its own copy of the layout. */
export function writeYawMatrix(
    out: Float32Array, base: number,
    x: number, y: number, z: number, headingY: number, scale: number,
): void {
    const c = Math.cos(headingY) * scale, s = Math.sin(headingY) * scale;
    out[base] = c; out[base + 1] = 0; out[base + 2] = -s; out[base + 3] = 0;
    out[base + 4] = 0; out[base + 5] = scale; out[base + 6] = 0; out[base + 7] = 0;
    out[base + 8] = s; out[base + 9] = 0; out[base + 10] = c; out[base + 11] = 0;
    out[base + 12] = x; out[base + 13] = y; out[base + 14] = z; out[base + 15] = 1;
}

/** `out[base..] = a × b` for two row-major 4×4s, Babylon's `multiplyToRef`
 *  convention (row-vector: `a` is the local, `b` the parent). */
function multiply4x4(a: Float32Array, b: Float32Array, out: Float32Array, base: number): void {
    for (let r = 0; r < 4; r++) {
        const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
        for (let c = 0; c < 4; c++) {
            out[base + r * 4 + c] =
                a0 * b[c] + a1 * b[4 + c] + a2 * b[8 + c] + a3 * b[12 + c];
        }
    }
}

/** Scratch for the member half of a MODEL member's composition. Module scope,
 *  never escapes, so the write path stays allocation-free. */
const _mem = new Float32Array(16);

const IDENTITY16 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function isIdentity16(m: Float32Array | ArrayLike<number>): boolean {
    for (let i = 0; i < 16; i++) if (m[i] !== IDENTITY16[i]) return false;
    return true;
}

/** The piece's rest pose as plain floats, or `null` when it is the identity (the
 *  common single-piece body — then the member matrix IS the answer). Re-read
 *  whenever the Matrix's `updateFlag` moves, so this caches without pinning a
 *  stale rest pose. */
function restFloatsOf(m: {
    restWorld: Matrix; restFlag?: number; restCache?: Float32Array | null;
}): Float32Array | null {
    if (m.restFlag !== m.restWorld.updateFlag) {
        const src = m.restWorld.m;
        if (isIdentity16(src)) {
            m.restCache = null;
        } else {
            const cache = m.restCache ?? new Float32Array(16);
            for (let i = 0; i < 16; i++) cache[i] = src[i];
            m.restCache = cache;
        }
        m.restFlag = m.restWorld.updateFlag;
    }
    return m.restCache ?? null;
}

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
    /** Raw def stats for sizing the proxy capsule (`memberCapsuleHeight`):
     *  the def's aggregate mass and its `squad_size` fan-out hint. Undefined
     *  (or a host without the method) keeps the legacy fixed-size capsule. */
    getMemberStats?(defId: number): MemberStats | undefined;
}

/** What `memberCapsuleHeight` derives a proxy size from. Both numbers are
 *  SQUAD-level (the sim atom): `mass` is the def's aggregate mass, `squadSize`
 *  the cosmetic member fan-out it is split across. */
export interface MemberStats {
    mass?: number;
    squadSize?: number;
}

/** Proxy-capsule height (elmos) for ONE member of a squad def.
 *
 *  The def's footprint is useless here: it is the SQUAD's pathing reservation
 *  (32 elmos across for 16 soldiers), so any per-member share of it is still
 *  4–8× a body. The per-member MASS share is the datum that actually tracks
 *  the authored art: Metalstorm units are ~1 elmo per metre and masses are
 *  authored on a tonnes-like curve, so at ~unit density `cbrt(mass/members)`
 *  lands on the art — soldiers 90/16 → 1.78 (model 1.85), engineers 80/8 →
 *  2.15 (measured impostorSize 2.31), tanks-s2 1000/4 → 6.3 (model 9.0).
 *  Clamped so a degenerate def can neither vanish nor tower; no stats at all
 *  (host without the callback, unknown def) keeps the legacy constant. */
export function memberCapsuleHeight(stats?: MemberStats): number {
    const mass = stats?.mass ?? 0;
    if (!(mass > 0)) return MEMBER_HEIGHT;
    const members = Math.max(1, Math.floor(stats?.squadSize ?? 1));
    const h = Math.cbrt(mass / members);
    return Math.min(MEMBER_HEIGHT_MAX, Math.max(MEMBER_HEIGHT_MIN, h));
}

export class SquadRenderBackend {
    private scene: Scene;
    private host: SquadHost;

    /** squadId → team, so createMember can colour a member by its owning
     *  squad's team (the RenderBackend member-create call carries only the
     *  squad id + a cosmetic visual, not the team). Set by the adapter driver
     *  (game-processor) as squads are routed. */
    private squadTeam = new Map<number, number>();

    /** One proxy-capsule member pool per "defId:team" (lazily created) — the
     *  capsule is sized from the def (`memberCapsuleHeight`), so it cannot be
     *  shared team-wide the way the old fixed-size capsule was. */
    private memberPools = new Map<string, InstancePool>();
    /** One sprite member pool per "defId:team" (lazily created). */
    private spritePools = new Map<string, InstancePool>();
    /** One 3D-model member pool per "defId:team" (lazily created; mesh borrowed
     *  from EntityRenderer). */
    private modelPools = new Map<string, InstancePool>();
    /** Single shared wreck pool. */
    private wreckPool: InstancePool | null = null;

    /** S5 §13a: every pool by dense integer id — what a direct writer names a
     *  pool by, so the kernel holds two ints per member (`mDirectPool`,
     *  `mPoolIdx`) and never a string key or a Map. */
    private poolsById: InstancePool[] = [];
    /** Bumped whenever a pool's arrays are replaced (`growPool`) or its slot
     *  indices move (`compactPool`). A direct writer re-fetches its view and
     *  re-reads its slot index when this number changes — it is the ONE thing
     *  that makes a copied-out slot index safe (PLAN-perf M24's rule was "never
     *  copy an index out"; a generation is how the copy is invalidated). */
    poolGeneration = 0;

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

        // S5: a member whose slot is PINNED (acquireSlot) is written directly by
        // its owner through the pool view, and its tier must not be re-decided
        // here — re-deciding could migrate it to another pool and leave the
        // owner's (poolId, index) pointing at a slot it no longer holds. This
        // arm exists so a pinned member is still correct if something does call
        // the interface method (a test, a tool, a second driver): it performs
        // exactly the write the direct path would.
        if (entry.direct) {
            this.writePinned(entry, x, my, z, headingY);
            return;
        }

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
            this.touch(pool, i);
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
                x, my + pool.yBias, z, headingY, 1);
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
        entry.direct = false;
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
        entry.model = model.pieces.map((_, p) =>
            this.allocRef(this.getModelPool(entry.defId, entry.team, model, p)));
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
            entry.sprite = this.allocRef(pool);
        }
        return pool;
    }

    private ensureCapsule(entry: MemberEntry): InstancePool {
        // Same caching rationale as ensureSprite: the pool key is a
        // `${defId}:${team}` string and both parts are fixed for the entry's
        // lifetime, so resolve once (this runs per capsule member per frame).
        let pool = LEGACY_BACKEND_PLUMBING ? undefined : entry.capsulePool;
        if (!pool) {
            pool = this.getMemberPool(entry.defId, entry.team);
            entry.capsulePool = pool;
        }
        if (!entry.capsule || entry.capsule.pool !== pool) {
            if (entry.capsule) this.freeSlot(entry.capsule.pool, entry.capsule.index);
            entry.capsule = this.allocRef(pool);
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
        const slot = this.allocRef(pool);
        this.writeMatrix(pool, slot.index, x, y + WRECK_SIZE * 0.15, z, headingY, 1);
        const handle = this.nextHandle++;
        this.wreckByHandle.set(handle, slot);
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
        this.touch(slot.pool, slot.index);
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

    /** Test/debug accessor (PLAN-perf M24): what every pool actually uploads
     *  and draws, against what is live in it. `drawn` is the term the backend
     *  pays per frame — before M24 it only ever went up. */
    poolOccupancy(): {
        pools: number; drawn: number; live: number; dead: number; capacity: number;
        worst: { key: string; drawn: number; live: number } | null;
    } {
        let pools = 0, drawn = 0, live = 0, capacity = 0;
        let worst: { key: string; drawn: number; live: number } | null = null;
        const visit = (key: string, pool: InstancePool): void => {
            pools++;
            drawn += pool.highWater;
            capacity += pool.capacity;
            const l = pool.highWater - pool.free.length;
            live += l;
            const waste = pool.highWater - l;
            if (!worst || waste > worst.drawn - worst.live) {
                worst = { key, drawn: pool.highWater, live: l };
            }
        };
        for (const [k, p] of this.memberPools) visit(`capsule:${k}`, p);
        for (const [k, p] of this.spritePools) visit(`sprite:${k}`, p);
        for (const [k, p] of this.modelPools) visit(`model:${k}`, p);
        if (this.wreckPool) visit('wreck', this.wreckPool);
        return { pools, drawn, live, dead: drawn - live, capacity, worst };
    }

    // --- S5 direct-write API (§13a) -----------------------------------------

    /** Pin this member's slot so its owner can write the transform straight into
     *  the pool buffer, and return the (poolId, index) to write at — or `null`
     *  when the member is not eligible and must keep using `updateMember`.
     *
     *  **Eligibility is "exactly one reachable visual tier, exactly one slot".**
     *  A direct writer holds a slot index; a member whose tier is re-decided
     *  every frame from the camera (M4/M5: a def with BOTH a body and an atlas,
     *  or one whose body has not finished loading) migrates between pools, and
     *  an index that migrates is an index the writer cannot hold. So:
     *    - atlas, no model tier  → its sprite pool, for life        ✔
     *    - no atlas, no body     → its capsule pool, for life       ✔
     *    - a loaded single-piece body with no atlas (D = Infinity)  ✔
     *    - anything else (crossfading def, multi-piece body, body still
     *      streaming)                                              ✘ → null
     *  This is a scope rule, not a fidelity change: a member that cannot be
     *  pinned keeps the full per-frame tier path it has today.
     *
     *  **DEVIATION from §13a, stated rather than taken silently:** the plan
     *  writes `acquireSlot(defId, team)`. It takes a HANDLE here, because the
     *  tier decision (atlas, `impostorDist`, whether the body has loaded) lives
     *  in the member's own `MemberEntry`, and re-deriving it from (defId, team)
     *  would be a second copy of that rule — the failure shape this project has
     *  filed repeatedly. For the same reason there is no `releaseSlot(poolId,
     *  index)`: the slot is already owned by the entry and freed by
     *  `releaseMember`/`destroyMember`, and a second raw free path would make
     *  two owners of one slot. */
    acquireSlot(handle: number): { poolId: number; index: number } | null {
        const entry = this.entryOf(handle);
        if (!entry) return null;
        let slot: MemberSlot | undefined;
        const D = entry.impostorDist;
        if (D === undefined || !this.host.getMemberModel) {
            // No model tier at all → sprite if the def has an atlas, else capsule.
            slot = entry.atlas ? (this.ensureSprite(entry), entry.sprite) : (this.ensureCapsule(entry), entry.capsule);
        } else if (D === Infinity && !entry.atlas) {
            // Atlas-less def with a body: the model tier holds at every range, so
            // the only migration left is capsule→model when the body finishes
            // loading. Pin only once it HAS loaded, only if it is one piece, and
            // only if that piece's rest pose is the identity — a non-identity
            // rest pose means the drawn matrix is `restWorld × member`, i.e. per
            // piece composition data the backend owns, and handing it to an
            // outside writer would be a second implementation of it.
            const model = this.host.getMemberModel(entry.defId, entry.team);
            if (!model || model.pieces.length !== 1) return null;
            this.ensureModel(entry, model);
            const ms = entry.model![0];
            if (restFloatsOf(ms.pool.model!) !== null) return null;
            ms.pool.fade![ms.index] = 1;
            slot = ms;
        } else {
            return null;    // camera-decided tier — cannot hold an index
        }
        if (!slot) return null;
        entry.direct = true;
        return { poolId: slot.pool.id, index: slot.index };
    }

    /** The pool id a pinned member currently sits in, or -1. Int-returning (no
     *  allocation) because this is what a holder calls for EVERY member it owns
     *  after a `poolGeneration` bump. */
    slotPoolId(handle: number): number {
        const slot = this.pinnedSlotOf(handle);
        return slot ? slot.pool.id : -1;
    }

    /** The instance index a pinned member currently sits at, or -1. */
    slotIndex(handle: number): number {
        const slot = this.pinnedSlotOf(handle);
        return slot ? slot.index : -1;
    }

    private pinnedSlotOf(handle: number): MemberSlot | undefined {
        const entry = this.entryOf(handle);
        if (!entry?.direct) return undefined;
        return entry.sprite ?? entry.capsule ?? entry.model?.[0];
    }

    /** The live direct-write window onto a pool, or undefined for an unknown id.
     *  Re-fetch whenever `poolGeneration` changes. */
    getPoolView(poolId: number): PoolView | undefined {
        return this.poolsById[poolId]?.view;
    }

    /** Report that instances `[lo, hi]` of a pool were written by an outside
     *  holder. A holder of the view can equally widen `view.dirtyLo/dirtyHi`
     *  itself — they are the same numbers — but a batched call once per squad is
     *  cheaper than two compares per member and is what the kernel does. */
    markDirty(poolId: number, lo: number, hi: number): void {
        const pool = this.poolsById[poolId];
        if (!pool) return;
        const v = pool.view;
        v.dirty = true;
        if (lo < v.dirtyLo) v.dirtyLo = lo;
        if (hi > v.dirtyHi) v.dirtyHi = hi;
    }

    /** Write a PINNED member's transform in the shape its own pool wants. The
     *  direct writer does this itself through the view; this is the same write
     *  reached through the `updateMember` interface (see the guard there). */
    private writePinned(
        entry: MemberEntry, x: number, my: number, z: number, headingY: number,
    ): void {
        if (entry.sprite) {
            const pool = entry.sprite.pool;
            const i = entry.sprite.index;
            const s = pool.sprite!;
            const base = i * 3;
            s.pos[base] = x; s.pos[base + 1] = my; s.pos[base + 2] = z;
            s.heading[i] = headingY;
            s.alive[i] = 1;
            this.touch(pool, i);
        } else if (entry.capsule) {
            this.writeMatrix(entry.capsule.pool, entry.capsule.index,
                x, my + entry.capsule.pool.yBias, z, headingY, 1);
        } else if (entry.model) {
            const slot = entry.model[0];
            this.writeModelMatrix(slot.pool, slot.index, x, my, z, headingY);
        }
    }

    /** Test/debug scanner for §13b's packing trap: any instance in any pool
     *  whose W-row is not (0, 0, 0, 1). The failure mode is SHADOW-ONLY — the
     *  CSM depth shader computes `viewProjection * (world * vec4(pos,1))`
     *  without reconstructing `w`, so a polluted W-row streaks or collapses the
     *  caster silhouette while the main pass looks perfect — which is why this
     *  is asserted rather than eyeballed. Returns the offending slots (bounded,
     *  so a broken pool does not print 8 192 lines). */
    auditWRows(limit = 8): { poolId: number; index: number; w: number[] }[] {
        const bad: { poolId: number; index: number; w: number[] }[] = [];
        for (const pool of this.poolsById) {
            const m = pool.matrices;
            for (let i = 0; i < pool.highWater; i++) {
                const b = i * 16;
                // A FREED slot is all zeros by construction (freeSlot collapses
                // it to zero scale, m[15] included) — that is not a packing bug.
                if (pool.refs[i] === undefined) continue;
                if (m[b + 3] !== 0 || m[b + 7] !== 0 || m[b + 11] !== 0 || m[b + 15] !== 1) {
                    bad.push({
                        poolId: pool.id, index: i,
                        w: [m[b + 3], m[b + 7], m[b + 11], m[b + 15]],
                    });
                    if (bad.length >= limit) return bad;
                }
            }
        }
        return bad;
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
        if (POOL_COMPACTION) {
            for (const pool of this.memberPools.values()) {
                if (this.shouldCompact(pool)) this.compactPool(pool);
            }
            for (const pool of this.spritePools.values()) {
                if (this.shouldCompact(pool)) this.compactPool(pool);
            }
            for (const pool of this.modelPools.values()) {
                if (this.shouldCompact(pool)) this.compactPool(pool);
            }
            if (this.wreckPool && this.shouldCompact(this.wreckPool)) {
                this.compactPool(this.wreckPool);
            }
        }
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
        this.poolsById.length = 0;
        this.memberEntries.length = 1;
        this.freeHandles.length = 0;
        this.memberByHandle.clear();
        this.wreckByHandle.clear();
        this.squadTeam.clear();
    }

    // --- internals ----------------------------------------------------------

    private getMemberPool(defId: number, team: number): InstancePool {
        const key = `${defId}:${team}`;
        let pool = this.memberPools.get(key);
        if (pool) return pool;
        // Size the capsule to the def it stands in for (memberCapsuleHeight) —
        // the old one-size-per-team capsule was 9 elmos against 1.8-elmo
        // infantry, so a model-less squad dwarfed every real unit beside it.
        const height = memberCapsuleHeight(this.host.getMemberStats?.(defId));
        const mesh = MeshBuilder.CreateCapsule(`squadMember_d${defId}_t${team}`, {
            height, radius: height * MEMBER_RADIUS_FRAC, tessellation: 6, subdivisions: 1,
        }, this.scene);
        const mat = new StandardMaterial(`squadMemberMat_d${defId}_t${team}`, this.scene);
        const c = this.host.getTeamColor(team);
        mat.diffuseColor = c;
        mat.specularColor = new Color3(0.1, 0.1, 0.1);
        mat.emissiveColor = c.scale(0.25);
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.doNotSyncBoundingInfo = true;
        pool = this.newPool(mesh);
        pool.yBias = height * 0.5;   // capsule is centre-anchored
        this.refreshView(pool);
        this.memberPools.set(key, pool);
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
            lastCamX: NaN, lastCamY: NaN, lastCamZ: NaN,
            lastRotX: NaN, lastRotY: NaN, lastRotZ: NaN, lastRotW: NaN,
        };
        this.refreshView(pool);
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
        // S5 §13c: the card rotation is shared by the whole pool, so the 3×3
        // rotation block is built ONCE here and each slot writes 12 floats plus
        // its translation — no per-member Matrix.ComposeToRef + copyToArray.
        // (The quaternion→matrix expansion is Babylon's, taken from the
        // quaternion it hands us, so the convention still has one owner.)
        Matrix.FromQuaternionToRef(cardRot, this._m);
        const r = this._m.m;
        const r00 = r[0], r01 = r[1], r02 = r[2];
        const r10 = r[4], r11 = r[5], r12 = r[6];
        const r20 = r[8], r21 = r[9], r22 = r[10];
        // The camera decides every card's rotation AND its atlas cell, so when
        // neither the camera nor the card rotation moved, only the slots whose
        // POSE changed this frame need recomposing — the dirty range the writer
        // already reported. An idle camera over a moving battle is the common
        // case, and the whole-prefix rewrite was the reason a sprite pool could
        // never have a small dirty range (§13c's "no writes → no upload").
        const v = pool.view;
        const camStill = !LEGACY_FULL_UPLOAD
            && sprite.lastCamX === cameraPos.x && sprite.lastCamY === cameraPos.y
            && sprite.lastCamZ === cameraPos.z
            && sprite.lastRotX === cardRot.x && sprite.lastRotY === cardRot.y
            && sprite.lastRotZ === cardRot.z && sprite.lastRotW === cardRot.w;
        let lo = 0, hi = pool.highWater - 1;
        if (camStill) {
            if (v.dirtyHi < v.dirtyLo) return;      // nothing moved at all
            lo = v.dirtyLo;
            hi = Math.min(v.dirtyHi, pool.highWater - 1);
        }
        sprite.lastCamX = cameraPos.x; sprite.lastCamY = cameraPos.y; sprite.lastCamZ = cameraPos.z;
        sprite.lastRotX = cardRot.x; sprite.lastRotY = cardRot.y;
        sprite.lastRotZ = cardRot.z; sprite.lastRotW = cardRot.w;
        const mat = pool.matrices;
        for (let i = lo; i <= hi; i++) {
            if (!sprite.alive[i]) continue;
            const base = i * 3;
            const x = sprite.pos[base], y = sprite.pos[base + 1], z = sprite.pos[base + 2];
            const b = i * 16;
            mat[b] = r00; mat[b + 1] = r01; mat[b + 2] = r02; mat[b + 3] = 0;
            mat[b + 4] = r10; mat[b + 5] = r11; mat[b + 6] = r12; mat[b + 7] = 0;
            mat[b + 8] = r20; mat[b + 9] = r21; mat[b + 10] = r22; mat[b + 11] = 0;
            mat[b + 12] = x + upx; mat[b + 13] = y + upy; mat[b + 14] = z + upz;
            mat[b + 15] = 1;
            sprite.cells[i] = selectAtlasCell(
                cameraPos.x - x, cameraPos.y - y, cameraPos.z - z,
                sprite.heading[i], sprite.layout);
        }
        v.dirty = true;
        if (lo < v.dirtyLo) v.dirtyLo = lo;
        if (hi > v.dirtyHi) v.dirtyHi = hi;
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
        this.refreshView(this.wreckPool);
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
        this.refreshView(pool);
        this.modelPools.set(key, pool);
        return pool;
    }

    private newPool(mesh: Mesh, capacity = 64, owned = true): InstancePool {
        const matrices = new Float32Array(capacity * 16);
        mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
        mesh.thinInstanceCount = 0;
        mesh.isVisible = false;
        const id = this.poolsById.length;
        // `buffersBound` stays false: the caller may still attach `fade`/`sprite`
        // arrays after this returns (getSpritePool/getModelPool do), and those
        // kinds must be bound too. The first flushPool binds the full set.
        const pool: InstancePool = {
            id, mesh, owned, matrices, capacity, highWater: 0, free: [],
            refs: [], buffersBound: false, yBias: 0,
            view: {
                poolId: id, matrices, yBias: 0, bobAmp: MEMBER_BOB,
                dirty: false, dirtyLo: DIRTY_NONE_LO, dirtyHi: DIRTY_NONE_HI,
                generation: this.poolGeneration,
            },
        };
        this.poolsById.push(pool);
        return pool;
    }

    /** Rebuild a pool's view against its current arrays. Called after any change
     *  that a view holder cannot see: `growPool` (every array is a new object)
     *  and `compactPool` (slot indices moved). Both bump `poolGeneration`, which
     *  is the holder's signal to re-fetch. */
    private refreshView(pool: InstancePool): void {
        const v = pool.view;
        v.matrices = pool.matrices;
        v.fade = pool.fade;
        v.spritePos = pool.sprite?.pos;
        v.spriteHeading = pool.sprite?.heading;
        v.spriteAlive = pool.sprite?.alive;
        v.yBias = pool.model ? pool.model.yOffset : pool.yBias;
        v.generation = ++this.poolGeneration;
    }

    /** Record that instance `index` of this pool was written. */
    private touch(pool: InstancePool, index: number): void {
        const v = pool.view;
        v.dirty = true;
        if (index < v.dirtyLo) v.dirtyLo = index;
        if (index > v.dirtyHi) v.dirtyHi = index;
    }

    /** Record that the whole live prefix was written (or reshaped). */
    private touchAll(pool: InstancePool): void {
        const v = pool.view;
        v.dirty = true;
        v.dirtyLo = 0;
        v.dirtyHi = pool.highWater - 1;
    }

    /** Allocate a slot AND the `MemberSlot` its holder will address it through.
     *  Every allocation goes through here so the pool can always map a slot
     *  index back to the object that must be rewritten if the slot moves
     *  (PLAN-perf M24 compaction). */
    private allocRef(pool: InstancePool): MemberSlot {
        const slot = { pool, index: this.allocSlot(pool) };
        pool.refs[slot.index] = slot;
        return slot;
    }

    private allocSlot(pool: InstancePool): number {
        let index: number;
        if (pool.free.length) {
            index = pool.free.pop()!;
        } else {
            if (pool.highWater >= pool.capacity) this.growPool(pool);
            index = pool.highWater++;
        }
        this.touch(pool, index);
        return index;
    }

    private freeSlot(pool: InstancePool, index: number): void {
        // Collapse to zero scale so the freed slot renders as nothing.
        const base = index * 16;
        pool.matrices.fill(0, base, base + 16);
        if (pool.sprite) pool.sprite.alive[index] = 0;
        if (pool.fade) pool.fade[index] = 1;   // reset for the next occupant
        pool.refs[index] = undefined;
        pool.free.push(index);
        this.touch(pool, index);
    }

    /** PLAN-perf M24: move the live slots above the live-count line down into
     *  the holes below it, then drop `highWater` to the live count. Everything
     *  the pool uploads and draws is a prefix of `highWater`, so this is the
     *  only way a churned pool stops paying for its dead slots.
     *
     *  Slot data moves with the slot (matrix, fade, and the sprite pose/cell
     *  arrays), and the owning `MemberSlot` is rewritten in place, so no holder
     *  outside the backend observes the move. Costs one move per hole below the
     *  line; the gate keeps that rare. */
    private compactPool(pool: InstancePool): void {
        const dead = pool.free.length;
        if (dead === 0) return;
        const live = pool.highWater - dead;
        // Fully-drained pool: nothing to move, just reset it.
        if (live === 0) {
            pool.free.length = 0;
            pool.highWater = 0;
            this.touchAll(pool);
            // Nothing is drawn, but every index a direct writer held is gone.
            this.refreshView(pool);
            return;
        }
        // Sorted ascending, the free indices BELOW `live` are the holes to fill
        // (a prefix) and those at or above it are the slots to skip while
        // scanning down for movers (a suffix). Both counts are the same number,
        // so the two cursors meet exactly.
        pool.free.sort((a, b) => a - b);
        let hole = 0;
        let tail = dead - 1;
        for (let src = pool.highWater - 1; src >= live; src--) {
            if (tail >= 0 && pool.free[tail] === src) { tail--; continue; }
            this.moveSlot(pool, src, pool.free[hole++]);
        }
        pool.free.length = 0;
        pool.highWater = live;
        this.touchAll(pool);
        // The occupied range changed shape — do not sit on a stale box for the
        // rest of the cadence.
        pool.bboxCountdown = 0;
        // Slots MOVED: every (poolId, index) a direct writer copied out is now
        // one frame stale. The generation bump is what makes it re-read.
        this.refreshView(pool);
    }

    private moveSlot(pool: InstancePool, src: number, dst: number): void {
        pool.matrices.copyWithin(dst * 16, src * 16, src * 16 + 16);
        if (pool.fade) pool.fade[dst] = pool.fade[src];
        const sprite = pool.sprite;
        if (sprite) {
            sprite.pos.copyWithin(dst * 3, src * 3, src * 3 + 3);
            sprite.heading[dst] = sprite.heading[src];
            sprite.alive[dst] = sprite.alive[src];
            sprite.cells[dst] = sprite.cells[src];
        }
        const ref = pool.refs[src];
        pool.refs[dst] = ref;
        pool.refs[src] = undefined;
        if (ref) ref.index = dst;
    }

    /** Should this pool compact this frame? Gated on the dead fraction so an
     *  ordinary frame pays one integer compare per pool. */
    private shouldCompact(pool: InstancePool): boolean {
        const dead = pool.free.length;
        return dead >= COMPACT_MIN_DEAD
            && dead >= pool.highWater * COMPACT_MIN_FRACTION;
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
        // ... and so does every direct writer holding a view onto the old arrays
        // (S5 §13a). Growth is the case the plan calls out explicitly.
        this.refreshView(pool);
    }

    /** Compose scale·yaw·translate into the pool's matrix buffer at `index`.
     *  Alloc-free, and now Babylon-object-free: this is §13b's layout table
     *  written by hand, which is the same 16 floats
     *  `Compose(scale, RotationYawPitchRoll(yaw,0,0), t)` produces (pinned by a
     *  test against `Matrix.ComposeToRef` — the convention is Babylon's, not
     *  ours to restate). It replaces a Vector3 set + a quaternion build + a
     *  4×4 compose + a `copyToArray`, per member per frame.
     *
     *  ⚠ The W-row (`m[3]/m[7]/m[11]` = 0, `m[15]` = 1) is not decoration: the
     *  CSM depth shader does not reconstruct `w`, so anything packed there
     *  collapses caster silhouettes in the shadow map while the main pass looks
     *  fine (docs/lighting.md; §13b). `auditWRows()` is the test-only scanner. */
    private writeMatrix(
        pool: InstancePool, index: number,
        x: number, y: number, z: number, headingY: number, scale: number,
    ): void {
        writeYawMatrix(pool.matrices, index * 16, x, y, z, headingY, scale);
        this.touch(pool, index);
    }

    /** Compose a MODEL member: `restWorld × (yaw · translate(x, y+yOffset, z))`,
     *  matching EntityRenderer's per-piece placement so a member reads exactly
     *  like a full unit of the same def. Babylon multiplies row-vector local ×
     *  parent, so member-world is the left operand. Alloc-free.
     *
     *  The member half is written inline (§13b) and multiplied by the piece's
     *  rest pose by hand — the rest pose is re-read from the Matrix whenever its
     *  `updateFlag` moves, so a piece whose rest transform is re-authored is
     *  still picked up, exactly as re-reading it every frame did. */
    private writeModelMatrix(
        pool: InstancePool, index: number,
        x: number, y: number, z: number, headingY: number,
    ): void {
        const m = pool.model!;
        writeYawMatrix(_mem, 0, x, y + m.yOffset, z, headingY, 1);
        const rest = restFloatsOf(m);
        if (rest === null) {
            // Identity rest pose (the single-piece, feet-at-origin case) — the
            // multiply is the member matrix itself.
            pool.matrices.set(_mem, index * 16);
        } else {
            multiply4x4(rest, _mem, pool.matrices, index * 16);
        }
        this.touch(pool, index);
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
        const v = pool.view;
        if (!v.dirty) return;
        v.dirty = false;
        // The range every writer this frame reported (S5 §13c). Clamped to the
        // live prefix — a slot freed above `highWater` after a compaction is not
        // uploaded and not drawn.
        const lo = v.dirtyLo;
        const hi = Math.min(v.dirtyHi, pool.highWater - 1);
        v.dirtyLo = DIRTY_NONE_LO;
        v.dirtyHi = DIRTY_NONE_HI;
        const touched = hi >= lo ? hi - lo + 1 : 0;
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
            // §13c: upload the tracked range when it is a small part of the live
            // prefix, else the prefix in one go. The threshold is the plan's
            // (~⅓) — below it the saved bytes are worth the extra call, above it
            // one contiguous upload of everything beats a nearly-as-long one.
            // A pool nothing touched this frame is not reached at all: `dirty`
            // was false, which is the whole point of tracking the range.
            if (touched > 0) {
                const partial = !LEGACY_FULL_UPLOAD && touched * 3 < pool.highWater;
                const from = partial ? lo : 0;
                const count = partial ? touched : pool.highWater;
                pool.mesh.thinInstancePartialBufferUpdate('matrix', count, from);
                // 1 float per instance each, and the same range applies.
                if (pool.sprite) {
                    pool.mesh.thinInstancePartialBufferUpdate('impostorCell', count, from);
                }
                if (pool.fade) {
                    pool.mesh.thinInstancePartialBufferUpdate('ditherFade', count, from);
                }
            }
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
