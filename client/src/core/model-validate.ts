/**
 * model-validate — pure glTF/.glb checks shared by the normalisation
 * validation harness (tools/scripts/validate_model.mjs, PLAN-metalstorm-
 * beta-units.md §7 task 4 / §8 Tests): tri budget, required piece names,
 * team-colour mask presence, animation clip naming.
 *
 * Kept dependency-free and pure (no fs/child_process) so it's usable both
 * from the Node CLI harness and from vitest with synthetic fixtures.
 */

export interface GlbParseResult {
    json: GltfDocument;
    bin: Uint8Array | null;
}

/** Minimal glTF 2.0 document shape — only the fields these checks read. */
export interface GltfDocument {
    asset?: { version?: string };
    nodes?: Array<{ name?: string; mesh?: number; children?: number[] }>;
    meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>;
    accessors?: Array<{ count: number; type: string }>;
    materials?: Array<{
        name?: string;
        extensions?: { SPRINGRTS_team_color?: { maskTexture?: { index: number }; invertMask?: boolean } };
    }>;
    animations?: Array<{ name?: string }>;
    extensionsUsed?: string[];
    extensions?: { SPRINGRTS_geometry?: unknown };
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** Parse a binary .glb buffer into its JSON + BIN chunks. Throws on a
 * malformed container (wrong magic, truncated chunk) rather than
 * returning a partial result — a corrupt export should fail loudly. */
export function parseGlb(buf: Uint8Array): GlbParseResult {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== GLB_MAGIC) throw new Error('not a .glb file (bad magic)');
    const length = view.getUint32(8, true);
    if (length > buf.byteLength) throw new Error('.glb declared length exceeds file size');

    let offset = 12;
    let json: GltfDocument | null = null;
    let bin: Uint8Array | null = null;
    while (offset < length) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        if (chunkStart + chunkLength > buf.byteLength) throw new Error('.glb chunk exceeds file size');
        const chunkData = buf.subarray(chunkStart, chunkStart + chunkLength);
        if (chunkType === CHUNK_JSON) {
            json = JSON.parse(new TextDecoder('utf-8').decode(chunkData));
        } else if (chunkType === CHUNK_BIN) {
            bin = chunkData;
        }
        offset = chunkStart + chunkLength;
    }
    if (!json) throw new Error('.glb has no JSON chunk');
    return { json, bin };
}

export interface CheckResult {
    ok: boolean;
    message: string;
}

/** Sum triangle counts across every mesh primitive. Indexed primitives:
 * indices accessor count / 3. Non-indexed: POSITION accessor count / 3
 * (matches how a triangle-list primitive's vertex count maps to tris —
 * the same primitives Blender's glTF exporter emits, always triangulated
 * on export in this pipeline). */
export function countTriangles(doc: GltfDocument): number {
    let total = 0;
    for (const mesh of doc.meshes ?? []) {
        for (const prim of mesh.primitives) {
            const accessors = doc.accessors ?? [];
            if (prim.indices !== undefined) {
                total += Math.floor((accessors[prim.indices]?.count ?? 0) / 3);
            } else {
                const posIdx = prim.attributes.POSITION;
                total += Math.floor((accessors[posIdx]?.count ?? 0) / 3);
            }
        }
    }
    return total;
}

export function checkTriBudget(doc: GltfDocument, budget: number): CheckResult & { tris: number } {
    const tris = countTriangles(doc);
    return {
        ok: tris <= budget,
        tris,
        message: tris <= budget
            ? `${tris} tris (budget ${budget})`
            : `${tris} tris EXCEEDS budget ${budget} (art/STYLE.md)`,
    };
}

/** Every name in `required` must appear as a node name (exact match,
 * case-insensitive — art/STYLE.md's piece conventions are lowercase but
 * source rigs vary). */
export function checkPieceNaming(doc: GltfDocument, required: string[]): CheckResult & { missing: string[] } {
    const names = new Set((doc.nodes ?? []).map((n) => (n.name ?? '').toLowerCase()));
    const missing = required.filter((r) => !names.has(r.toLowerCase()));
    return {
        ok: missing.length === 0,
        missing,
        message: missing.length === 0
            ? `all required pieces present: ${required.join(', ')}`
            : `missing required piece(s): ${missing.join(', ')}`,
    };
}

/** Engine team-colour path reads material[0] only
 * (client/src/core/entity-renderer.ts: `materials[0].extensions.SPRINGRTS_team_color.maskTexture`). */
export function checkTeamColorMask(doc: GltfDocument): CheckResult {
    const mat0 = doc.materials?.[0];
    const maskIdx = mat0?.extensions?.SPRINGRTS_team_color?.maskTexture?.index;
    const ok = typeof maskIdx === 'number';
    return {
        ok,
        message: ok
            ? 'materials[0] has a SPRINGRTS_team_color mask texture'
            : 'materials[0] is missing the SPRINGRTS_team_color mask texture (art/STYLE.md team-colour convention; entity-renderer.ts)',
    };
}

/** Every animation clip's name must be one of the allowed convention names
 * (art/STYLE.md / objects3d/README.md: walk, idle, death). Unnamed
 * animations or extras fail loudly rather than shipping silently. */
export function checkClipNames(doc: GltfDocument, allowed: string[] = ['walk', 'idle', 'death']): CheckResult & { bad: string[] } {
    const allowedSet = new Set(allowed);
    const anims = doc.animations ?? [];
    const bad = anims.map((a) => a.name ?? '<unnamed>').filter((n) => !allowedSet.has(n));
    return {
        ok: bad.length === 0,
        bad,
        message: bad.length === 0
            ? `clips OK: ${anims.map((a) => a.name).join(', ') || '(none)'}`
            : `unrecognised clip name(s): ${bad.join(', ')} (allowed: ${allowed.join(', ')})`,
    };
}

/** True once modelimporter has embedded the SPRINGRTS_geometry document
 * extension (rts/Sim/Objects/ModelConfigLoader.h) — the engine-load smoke
 * gate. */
export function checkEngineGeometry(doc: GltfDocument): CheckResult {
    const ok = !!doc.extensions?.SPRINGRTS_geometry
        && !!doc.extensionsUsed?.includes('SPRINGRTS_geometry');
    return {
        ok,
        message: ok
            ? 'SPRINGRTS_geometry extension present (engine-loadable)'
            : 'no SPRINGRTS_geometry extension — run tools/modelimporter on this .glb first',
    };
}
