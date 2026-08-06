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
 * §M5 PROTOTYPE SCOPE — one kit, one hull.
 *
 * `ms_dress_order` on `fable_tank`, covering the three kit pieces that are
 * cleanly mountable as authored: `staff` (+ its `flag` child, which carries
 * the kit's `idle` clip), `lightbar`, `stowage`. Offsets are verbatim from
 * `art/dressing-kits/ms_dress_order-mounts.txt`.
 *
 * `applique` is deliberately absent: that single mesh bakes all THREE armour
 * plates (side / glacis / ID panel) into one piece spanning x -2.55..2.55, and
 * the mount table asks for them at three different hull locations with
 * different rotations. Mounting it whole reads as a floating fence. Splitting
 * it is a forge-side change, not a client one — see the §M5 decision note.
 */
const KITS: Readonly<Record<string, DressingKit>> = {
    order: {
        model: 'ms_dress_order',
        mounts: {
            fable_tank: [
                // Rear-deck corner; pennant tip reaches +0.98 local X.
                { piece: 'staff', parent: 'body', offset: [-1.45, 1.86, 3.90] },
                // Hull deck behind the turret, lenses facing -Z.
                { piece: 'lightbar', parent: 'body', offset: [0, 1.86, 2.05] },
                // Engine deck; clears the exhausts at z 3.92.
                { piece: 'stowage', parent: 'body', offset: [0, 1.86, 3.20] },
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
