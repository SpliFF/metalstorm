/**
 * TerrainKnowledge — the client half of "terrain knowledge is LOS".
 *
 * Design: ./DESIGN-TERRAIN-KNOWLEDGE.md (binding for this arc). Short version:
 * a player's knowledge of the terrain is limited to what their side has seen.
 * Unknown ground is not rendered at all, and the reveal frontier hides under a
 * fog curtain.
 *
 * ## The contract
 *
 *   **A chunk that is built is known. A chunk that is absent is unknown.
 *   There is no third state.**
 *
 * K0 realises "absent" as `mesh.setEnabled(false)`, which is a stand-in: the
 * geometry still exists, it just isn't drawn. K1 makes absence real (unknown
 * chunks are never constructed, and a reveal *creates* the mesh). So nothing
 * outside this module is allowed to ask "is this chunk enabled?" — callers ask
 * {@link TerrainKnowledgeGate.isChunkKnown}, which K1 re-implements over mesh
 * existence without touching any caller.
 *
 * ## Why the mask, and not an event
 *
 * The entity lane is newest-wins: it carries no one-shot signal. So the server
 * does not send "chunk (3,4) was revealed" — it sends the ENTIRE mask, every
 * second, and this module ORs it in. That makes a reveal idempotent,
 * reorder-tolerant (the mask is monotone, so a late *older* mask is a no-op),
 * replay-tolerant, and self-healing after a drop. The mask is <= 8 bytes, so
 * there is nothing to save by being cleverer. See design §4.2.
 *
 * ## Perf
 *
 * `entity` is the binding client phase, so this module does **no per-frame and
 * no per-entity work at all**. It reacts only to a mask message whose bits
 * actually changed — a few times per game — and then toggles up to 64 meshes
 * and rebuilds one ribbon. Every other frame it costs nothing.
 *
 * ## Default
 *
 * The gate is inert until the first mask message arrives. A stock game emits
 * none (the server's `terrainknowledge` modoption is off), so the terrain path
 * is byte-for-byte what it is today. There is deliberately no client-side
 * default to get wrong, and no ordering hazard against modoption arrival.
 */

import { Mesh, VertexData, StandardMaterial, Color3 } from '@babylonjs/core';
import type { Scene } from '@babylonjs/core';
import type { TerrainMeshGroup } from './terrain.js';

/** Envelope byte of the terrain knowledge mask. Mirrors
 *  `Protocol::ENVELOPE_TERRAIN_KNOWLEDGE` (rts/Server/Protocol.h). */
export const ENVELOPE_TERRAIN_KNOWLEDGE = 0x0a;

/** `allyTeam` value the server uses for a Global-mode spectator, which knows
 *  everything and is handed an all-ones mask rather than nothing. */
export const KNOWLEDGE_ALLY_GLOBAL = 255;

/** One decoded mask message. */
export interface TerrainKnowledgeMask {
    allyTeam: number;
    chunksX: number;
    chunksZ: number;
    frame: number;
    /** One byte per chunk, row-major (z outer, x inner): 1 = known. Unpacked
     *  from the wire's MSB-first bit plane — 64 bytes is not worth the shift
     *  arithmetic on every read. */
    known: Uint8Array;
}

/**
 * Parse the payload of envelope 0x0A (the envelope byte already stripped).
 *
 *   u8  allyTeam
 *   u8  chunksX
 *   u8  chunksZ
 *   u32 frame                             (little-endian)
 *   u8  bits[ceil(chunksX*chunksZ/8)]     MSB-first, row-major (z outer)
 *
 * Returns null on any malformed input rather than a partial mask — a mask that
 * is confidently wrong is worse than no mask, because it hides real ground.
 */
export function parseTerrainKnowledge(
    input: Uint8Array,
): TerrainKnowledgeMask | null {
    if (input.byteLength < 7) return null;

    const allyTeam = input[0];
    const chunksX = input[1];
    const chunksZ = input[2];
    if (chunksX === 0 || chunksZ === 0) return null;

    const frame = input[3] | (input[4] << 8) | (input[5] << 16)
        | (input[6] << 24);

    const count = chunksX * chunksZ;
    const planeBytes = (count + 7) >> 3;
    if (input.byteLength < 7 + planeBytes) return null;

    const known = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const byte = input[7 + (i >> 3)];
        known[i] = (byte & (1 << (7 - (i & 7)))) !== 0 ? 1 : 0;
    }

    return { allyTeam, chunksX, chunksZ, frame, known: known };
}

/** Name of the placeholder fog-curtain mesh. */
const FOG_CURTAIN_NAME = 'terrainFogCurtain';

/** How far the placeholder curtain rises above / sinks below the frontier
 *  edge, in elmos. Generous on purpose — K0's job is to prove the frontier is
 *  opaque from a playing camera, not to look good. K2 owns the real one. */
const CURTAIN_UP = 900;
const CURTAIN_DOWN = 600;

export interface TerrainKnowledgeStats {
    /** True once a mask message has arrived — i.e. the gate is live. */
    active: boolean;
    chunksX: number;
    chunksZ: number;
    knownChunks: number;
    totalChunks: number;
    /** Frame of the most recently applied mask. */
    frame: number;
    /** How many times the held mask actually changed (not how many messages
     *  arrived — the common case is an unchanged repeat). */
    revisions: number;
}

/**
 * Holds the client's copy of the mask and projects it onto a
 * {@link TerrainMeshGroup}.
 *
 * Created inert. `apply()` is the only entry point; the first call activates
 * the gate, and from then on unknown chunks are not drawn and the frontier
 * carries a curtain.
 */
export class TerrainKnowledgeGate {
    private known: Uint8Array | null = null;
    private chunksX = 0;
    private chunksZ = 0;
    private frame = 0;
    private revisions = 0;
    private curtain: Mesh | null = null;
    private curtainMat: StandardMaterial | null = null;

    constructor(
        private readonly scene: Scene,
        private readonly group: TerrainMeshGroup,
    ) {}

    get active(): boolean { return this.known !== null; }

    /** The contract's only public question. K1 re-implements this over mesh
     *  existence; every caller keeps working unchanged. */
    isChunkKnown(cx: number, cz: number): boolean {
        if (this.known === null) return true;   // inert: the whole map is known
        if (cx < 0 || cx >= this.chunksX || cz < 0 || cz >= this.chunksZ)
            return false;
        return this.known[cz * this.chunksX + cx] !== 0;
    }

    /** Is the world point (x, z) on ground this side has seen? The null-query
     *  rule (design §7) answers from here. */
    isPointKnown(x: number, z: number): boolean {
        if (this.known === null) return true;
        const plan = this.group.plan;
        const chunkWorld = plan.chunkQuads * 8;   // SQUARE_SIZE
        return this.isChunkKnown(
            Math.floor(x / chunkWorld), Math.floor(z / chunkWorld));
    }

    stats(): TerrainKnowledgeStats {
        const total = this.chunksX * this.chunksZ;
        let n = 0;
        if (this.known) for (let i = 0; i < this.known.length; i++)
            if (this.known[i]) n++;
        return {
            active: this.active,
            chunksX: this.chunksX,
            chunksZ: this.chunksZ,
            knownChunks: n,
            totalChunks: total,
            frame: this.frame,
            revisions: this.revisions,
        };
    }

    /**
     * Apply one mask message. Returns true when the held mask actually
     * changed and the scene was rebuilt — false for the common case of an
     * unchanged repeat, which costs one array compare and nothing else.
     *
     * The mask is OR'd, never assigned: bits only go 0 -> 1, so a message that
     * arrives out of order (or is replayed) can never un-reveal a chunk.
     */
    apply(mask: TerrainKnowledgeMask): boolean {
        // A mask for a different grid than the terrain we built is not a
        // resize — it is confidently wrong, so it is refused outright.
        const plan = this.group.plan;
        if (mask.chunksX !== plan.chunksX || mask.chunksZ !== plan.chunksZ) {
            console.warn(
                `[terrain-knowledge] refused mask ${mask.chunksX}x${mask.chunksZ}` +
                ` — terrain is ${plan.chunksX}x${plan.chunksZ}`);
            return false;
        }

        this.frame = mask.frame;
        let changed = false;
        if (this.known === null || this.known.length !== mask.known.length) {
            this.known = new Uint8Array(mask.known);
            this.chunksX = mask.chunksX;
            this.chunksZ = mask.chunksZ;
            changed = true;
        } else {
            for (let i = 0; i < mask.known.length; i++) {
                if (mask.known[i] && !this.known[i]) {
                    this.known[i] = 1;
                    changed = true;
                }
            }
        }
        if (!changed) return false;

        this.revisions++;
        this.refresh();
        return true;
    }

    /** Re-project the held mask onto the scene. Safe to call at any time (a
     *  material swap or a chunk rebuild may need it); costs one pass over <= 64
     *  chunks. */
    refresh(): void {
        if (this.known === null) return;
        for (const c of this.group.chunks) {
            const on = this.isChunkKnown(c.cx, c.cz);
            // K0 stand-in for "absent": hidden, unpickable, and out of the
            // shadow/active-mesh passes. K1 stops building it at all.
            c.lod0.mesh.setEnabled(on);
            c.lod0.mesh.isPickable = on;
            if (c.lod1) c.lod1.mesh.setEnabled(on);
        }
        this.rebuildCurtain();
    }

    dispose(): void {
        this.curtain?.dispose();
        this.curtain = null;
        this.curtainMat?.dispose();
        this.curtainMat = null;
    }

    /**
     * Placeholder fog curtain: one mesh carrying a vertical quad on every
     * known-side edge that faces an unknown chunk (or the map's own rim where
     * the neighbour would be off-grid but the rim is a frontier).
     *
     * One mesh for the whole frontier, rebuilt only on a mask change. A 64-chunk
     * grid has at most 112 internal edges, so this is a <= 112-quad ribbon —
     * free to rebuild, and it costs nothing per frame.
     *
     * It is NOT the LOS fog overlay: that one darkens *known* ground the side
     * cannot currently see. These are different layers answering different
     * questions and they compose.
     */
    private rebuildCurtain(): void {
        this.curtain?.dispose();
        this.curtain = null;
        if (this.known === null) return;

        const plan = this.group.plan;
        const chunkWorld = plan.chunkQuads * 8;   // SQUARE_SIZE
        const positions: number[] = [];
        const indices: number[] = [];

        const quad = (
            ax: number, az: number, bx: number, bz: number, yTop: number,
        ): void => {
            const base = positions.length / 3;
            const yBot = yTop - (CURTAIN_UP + CURTAIN_DOWN);
            positions.push(ax, yTop, az, bx, yTop, bz, bx, yBot, bz, ax, yBot, az);
            // Both windings — the curtain must be opaque from either side,
            // and a single-sided frontier is exactly the bug that would only
            // show up in a screenshot from the wrong angle.
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
        };

        for (let cz = 0; cz < this.chunksZ; cz++) {
            for (let cx = 0; cx < this.chunksX; cx++) {
                if (!this.isChunkKnown(cx, cz)) continue;
                const x0 = cx * chunkWorld;
                const z0 = cz * chunkWorld;
                const x1 = Math.min(x0 + chunkWorld, this.group.dims.mapx * 8);
                const z1 = Math.min(z0 + chunkWorld, this.group.dims.mapy * 8);
                // Curtain height from this chunk's own corners, so it stands
                // on the ground rather than at a global altitude.
                const c = this.group.chunks[cz * this.chunksX + cx];
                let maxY = -Infinity;
                const g = c.lod0.geo;
                for (let i = 1; i < g.positions.length; i += 3)
                    if (g.positions[i] > maxY) maxY = g.positions[i];
                const yTop = (maxY === -Infinity ? 0 : maxY) + CURTAIN_UP;

                // A neighbour that is off-grid is the map rim, which is
                // allowed to be open — it always was. Only an in-grid unknown
                // neighbour is a knowledge frontier.
                const unknownNeighbour = (nx: number, nz: number): boolean =>
                    nx >= 0 && nx < this.chunksX && nz >= 0 && nz < this.chunksZ
                    && !this.isChunkKnown(nx, nz);

                if (unknownNeighbour(cx - 1, cz)) quad(x0, z0, x0, z1, yTop);
                if (unknownNeighbour(cx + 1, cz)) quad(x1, z0, x1, z1, yTop);
                if (unknownNeighbour(cx, cz - 1)) quad(x0, z0, x1, z0, yTop);
                if (unknownNeighbour(cx, cz + 1)) quad(x0, z1, x1, z1, yTop);
            }
        }

        if (indices.length === 0) return;

        const mesh = new Mesh(FOG_CURTAIN_NAME, this.scene);
        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.applyToMesh(mesh, false);
        mesh.isPickable = false;
        mesh.receiveShadows = false;

        if (this.curtainMat === null) {
            const mat = new StandardMaterial('terrainFogCurtainMat', this.scene);
            // Unlit + fully opaque: the curtain's whole job in K0 is to prove
            // the frontier is not see-through. K2 owns the art.
            mat.disableLighting = true;
            mat.emissiveColor = new Color3(0.40, 0.43, 0.48);
            mat.diffuseColor = new Color3(0, 0, 0);
            mat.specularColor = new Color3(0, 0, 0);
            mat.backFaceCulling = false;
            this.curtainMat = mat;
        }
        mesh.material = this.curtainMat;
        this.curtain = mesh;
    }
}
