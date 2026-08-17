/**
 * dressing-kits — client-side accessory attachment for the ms_dress_* kits
 * (PLAN-metalstorm-model-integration §M5).
 *
 * The four forge dressing kits (`ms_dress_{order,dynasty,resistance,anarchic}`)
 * are multi-root accessory glTFs: each root node is one self-contained
 * accessory (banner, lightbar, jerrycan rack…) authored about its own mount
 * point, with a DISPLAY FAN-OUT translation on X so the pieces don't overlap
 * when the whole kit is previewed as one model. The intended mounts on the
 * tank/heavy hulls are recorded in `data/games/metalstorm/art/dressing-kits/
 * ms_dress_<faction>-mounts.txt` — this module is those tables in code.
 *
 * There is NO engine attachment mechanism (the objects3d/README "scale-4 named
 * attachment points" line describes an authoring convention for cosmetic
 * turrets, not a runtime feature — nothing reads it). None is needed: a mount
 * is exactly a piece with a parent index and a local matrix, which is what
 * `EntityRenderer`'s piece machinery already consumes. Attaching a kit is
 * therefore "append pieces to the model template", and every downstream
 * consumer (thin-instance grouping, `computePieceWorldMatrices`, clip poses,
 * squad member models, shadows) inherits it for free.
 *
 * Two properties make this safe rather than clever:
 *
 *  - Appended pieces land at indices >= `config.pieceNames.length`, and the
 *    server's 0x05 piece-state envelope only ever names canonical indices, so
 *    a dressed unit can never collide with streamed piece state.
 *  - Kits are cosmetic-only. The server keeps the bare hull's radius,
 *    footprint and collision volume; nothing about the sim changes.
 *
 * Selection is per-DEF via `customparams.ms_dress = '<faction>'`, read from
 * the def table the client already receives. This deliberately does NOT hook
 * team→faction: the client has no faction concept (faction lives in the
 * scenario/gadget layer), and per-def dressing is what a faction-flavoured
 * unit roster wants anyway.
 */

import { Matrix, Quaternion, Vector3 } from '@babylonjs/core';

/** One accessory placement: kit piece → hull piece, at a hull-local offset. */
export interface DressMount {
    /** Root node name in the kit glTF (e.g. `staff`, `lightbar`). */
    piece: string;
    /** Piece name in the hull model to parent to (`body`, `turret`, …). */
    parent: string;
    /** Mount offset in the PARENT piece's local frame, metres (x, y, z).
     *  Straight from the kit's `-mounts.txt`; the kit's display fan-out
     *  translation is discarded, never added to this. */
    offset: readonly [number, number, number];
    /** Yaw about +Y in degrees, applied before the offset. */
    yaw?: number;
    /** Uniform scale (the anarchic prow wants 1.30 on the heavy hull). */
    scale?: number;
}

export interface DressingKit {
    /** Model stem in `models/` — `<stem>.gltf` + textures. */
    model: string;
    /** Mounts per hull model stem. A hull with no entry stays undressed. */
    mounts: Readonly<Record<string, readonly DressMount[]>>;
}

/**
 * Mount tables for all four faction kits × {fable_tank, fable_heavy}.
 *
 * Transcribed from `data/games/metalstorm/art/dressing-kits/ms_dress_*-mounts.txt`.
 * Offsets are verbatim hull-local (x, y, z) in metres, Spring frame (-Z forward,
 * +Y up). The kit glTFs have display fan-out root translations on X that are
 * discarded — each piece is re-rooted to its mount point.
 *
 * NOTE: `order` kit's `applique` remains absent until the forge splits that mesh
 * (currently bakes all 3 plates into one piece spanning x -2.55..2.55; the mount
 * table wants them at three different locations with different rotations).
 */
const KITS: Readonly<Record<string, DressingKit>> = {
    order: {
        model: 'ms_dress_order',
        mounts: {
            fable_tank: [
                { piece: 'staff', parent: 'body', offset: [-1.45, 1.86, 3.90] },
                { piece: 'lightbar', parent: 'body', offset: [0, 1.86, 2.05] },
                { piece: 'stowage', parent: 'body', offset: [0, 1.86, 3.20] },
                // applique deferred: needs forge split (side/glacis/ID plates)
            ],
            fable_heavy: [
                { piece: 'staff', parent: 'body', offset: [-2.00, 3.02, 7.60] },
                { piece: 'lightbar', parent: 'body', offset: [0, 3.02, 3.40] },
                { piece: 'stowage', parent: 'body', offset: [0, 3.02, 5.60] },
            ],
        },
    },
    dynasty: {
        model: 'ms_dress_dynasty',
        mounts: {
            fable_tank: [
                { piece: 'banner', parent: 'body', offset: [0, 1.86, 3.90] },
                { piece: 'rail_l', parent: 'body', offset: [-1.55, 1.86, 0.30] },
                { piece: 'rail_r', parent: 'body', offset: [1.55, 1.86, 0.30] },
                // crest yaw 180° so face shows forward (back plane mounts on hull nose)
                { piece: 'crest', parent: 'body', offset: [0, 0.95, -4.42], yaw: 180 },
                { piece: 'lantern_l', parent: 'body', offset: [-1.45, 1.86, -3.60] },
                { piece: 'lantern_r', parent: 'body', offset: [1.45, 1.86, -3.60] },
                { piece: 'cowl_l', parent: 'body', offset: [-1.15, 1.86, 3.40] },
                { piece: 'cowl_r', parent: 'body', offset: [1.15, 1.86, 3.40] },
            ],
            fable_heavy: [
                { piece: 'banner', parent: 'body', offset: [0, 3.02, 7.40] },
                { piece: 'rail_l', parent: 'body', offset: [-2.10, 3.02, 0.50] },
                { piece: 'rail_r', parent: 'body', offset: [2.10, 3.02, 0.50] },
                // Second rail pair for the long heavy hull (16.2 m)
                { piece: 'rail_l', parent: 'body', offset: [-2.10, 3.02, -4.20] },
                { piece: 'rail_r', parent: 'body', offset: [2.10, 3.02, 4.20] },
                { piece: 'crest', parent: 'body', offset: [0, 1.60, -8.12], yaw: 180 },
                { piece: 'lantern_l', parent: 'body', offset: [-2.00, 3.02, -6.90] },
                { piece: 'lantern_r', parent: 'body', offset: [2.00, 3.02, -6.90] },
                { piece: 'cowl_l', parent: 'body', offset: [-1.55, 3.02, 5.35] },
                { piece: 'cowl_r', parent: 'body', offset: [1.55, 3.02, 5.35] },
            ],
        },
    },
    resistance: {
        model: 'ms_dress_resistance',
        mounts: {
            fable_tank: [
                { piece: 'net', parent: 'body', offset: [0, 1.86, 1.00] },
                { piece: 'stow', parent: 'body', offset: [0.90, 1.86, 3.10] },
                { piece: 'rack', parent: 'body', offset: [-1.20, 1.86, 3.60] },
                { piece: 'flag', parent: 'body', offset: [1.45, 1.86, 4.05] },
                // smoke is turret-local; deferred until turret-parenting supported
                // { piece: 'smoke', parent: 'turret', offset: [0.95, 0.55, -0.90], yaw: 25 },
            ],
            fable_heavy: [
                { piece: 'net', parent: 'body', offset: [0, 3.02, -0.60] },
                { piece: 'stow', parent: 'body', offset: [1.40, 3.02, 5.60] },
                { piece: 'rack', parent: 'body', offset: [-1.70, 3.02, 6.40] },
                { piece: 'flag', parent: 'body', offset: [2.00, 3.02, 7.60] },
                // { piece: 'smoke', parent: 'turret', offset: [1.60, 0.70, -1.60], yaw: 25 },
            ],
        },
    },
    anarchic: {
        model: 'ms_dress_anarchic',
        mounts: {
            fable_tank: [
                // Side skirts: yaw ±90° (parallel to hull sides)
                { piece: 'plates', parent: 'body', offset: [-1.87, 0.10, 0], yaw: -90 },
                { piece: 'plates', parent: 'body', offset: [1.87, 0.10, 0], yaw: 90 },
                // Rear skirt: no yaw
                { piece: 'plates', parent: 'body', offset: [0, 0.10, 4.46] },
                { piece: 'prow', parent: 'body', offset: [0, 0.15, -3.40] },
                { piece: 'trophies', parent: 'body', offset: [0, 1.86, 2.6] },
                { piece: 'totem', parent: 'body', offset: [-0.9, 1.86, 3.4] },
                { piece: 'totem', parent: 'body', offset: [0.9, 1.86, 3.4] },
                { piece: 'streamer', parent: 'body', offset: [-1.5, 1.86, 3.9] },
                { piece: 'streamer', parent: 'body', offset: [1.5, 1.86, 3.9] },
            ],
            fable_heavy: [
                // Four side skirts (16.2 m hull needs fore/aft pairs)
                { piece: 'plates', parent: 'body', offset: [-2.47, 0.30, -2.0], yaw: -90 },
                { piece: 'plates', parent: 'body', offset: [-2.47, 0.30, 1.9], yaw: -90 },
                { piece: 'plates', parent: 'body', offset: [2.47, 0.30, -2.0], yaw: 90 },
                { piece: 'plates', parent: 'body', offset: [2.47, 0.30, 1.9], yaw: 90 },
                // Rear skirt
                { piece: 'plates', parent: 'body', offset: [0, 0.30, 8.16] },
                { piece: 'prow', parent: 'body', offset: [0, 0.30, -6.95], scale: 1.30 },
                { piece: 'trophies', parent: 'body', offset: [0, 3.02, 5.5] },
                { piece: 'totem', parent: 'body', offset: [-1.3, 3.02, 6.8] },
                { piece: 'totem', parent: 'body', offset: [1.3, 3.02, 6.8] },
                { piece: 'brazier', parent: 'body', offset: [0, 3.02, 7.2] },
                { piece: 'streamer', parent: 'body', offset: [-2.1, 3.02, 7.6] },
                { piece: 'streamer', parent: 'body', offset: [2.1, 3.02, 7.6] },
            ],
        },
    },
};

/** Kit for a `customparams.ms_dress` value, or null when unknown. */
export function dressingKit(name: string | undefined): DressingKit | null {
    if (!name) return null;
    return KITS[name] ?? null;
}

/** Mounts for one (kit, hull model stem) pair; empty when the pair has none. */
export function dressingMounts(
    kit: DressingKit, hullStem: string,
): readonly DressMount[] {
    return kit.mounts[hullStem] ?? [];
}

/**
 * Parent-relative local matrix for a mount.
 *
 * The hull's own piece chain keeps parent-relative offsets in Spring-aligned
 * axes with the basis change carried on the root (see
 * `computePieceWorldMatrices`), and the mount tables are authored in that same
 * hull frame (metres, -Z forward, +Y up) — so a mount composes exactly like an
 * authored piece offset, with no basis conversion.
 */
export function mountLocalMatrix(mount: DressMount): Matrix {
    const s = mount.scale ?? 1;
    const rot = mount.yaw
        ? Quaternion.RotationAxis(new Vector3(0, 1, 0), (mount.yaw * Math.PI) / 180)
        : Quaternion.Identity();
    return Matrix.Compose(
        new Vector3(s, s, s),
        rot,
        new Vector3(mount.offset[0], mount.offset[1], mount.offset[2]),
    );
}
