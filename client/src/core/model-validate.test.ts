import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
    parseGlb,
    countTriangles,
    checkTriBudget,
    checkPieceNaming,
    checkTeamColorMask,
    checkClipNames,
    checkEngineGeometry,
    type GltfDocument,
} from './model-validate';

describe('checkTriBudget / countTriangles (pure, hand-built documents)', () => {
    const doc = (indexed: boolean, count: number): GltfDocument => ({
        meshes: [{ primitives: [indexed
            ? { attributes: { POSITION: 0 }, indices: 1 }
            : { attributes: { POSITION: 0 } }] }],
        accessors: indexed
            ? [{ count: 999, type: 'VEC3' }, { count: count * 3, type: 'SCALAR' }]
            : [{ count: count * 3, type: 'VEC3' }],
    });

    it('counts non-indexed triangles from POSITION count / 3', () => {
        expect(countTriangles(doc(false, 500))).toBe(500);
    });

    it('counts indexed triangles from the indices accessor count / 3', () => {
        expect(countTriangles(doc(true, 700))).toBe(700);
    });

    it('passes within budget, fails over budget', () => {
        expect(checkTriBudget(doc(false, 1500), 2000).ok).toBe(true);
        expect(checkTriBudget(doc(false, 2500), 2000).ok).toBe(false);
    });
});

describe('checkPieceNaming', () => {
    const doc: GltfDocument = { nodes: [{ name: 'hull' }, { name: 'Turret' }, { name: 'barrel' }] };

    it('is case-insensitive and passes when all required pieces exist', () => {
        const r = checkPieceNaming(doc, ['hull', 'turret', 'barrel']);
        expect(r.ok).toBe(true);
        expect(r.missing).toEqual([]);
    });

    it('fails loudly and names what is missing', () => {
        const r = checkPieceNaming(doc, ['hull', 'turret', 'muzzle']);
        expect(r.ok).toBe(false);
        expect(r.missing).toEqual(['muzzle']);
    });
});

describe('checkTeamColorMask', () => {
    it('passes when materials[0] carries the SPRINGRTS_team_color mask', () => {
        const doc: GltfDocument = { materials: [{ extensions: { SPRINGRTS_team_color: { maskTexture: { index: 2 } } } }] };
        expect(checkTeamColorMask(doc).ok).toBe(true);
    });

    it('fails when materials[0] has no mask (engine reads material[0] only)', () => {
        const doc: GltfDocument = {
            materials: [
                {},
                { extensions: { SPRINGRTS_team_color: { maskTexture: { index: 2 } } } },
            ],
        };
        expect(checkTeamColorMask(doc).ok).toBe(false);
    });

    it('fails when there are no materials at all', () => {
        expect(checkTeamColorMask({}).ok).toBe(false);
    });
});

describe('checkClipNames', () => {
    it('passes for walk/idle/death', () => {
        const doc: GltfDocument = { animations: [{ name: 'walk' }, { name: 'idle' }, { name: 'death' }] };
        expect(checkClipNames(doc).ok).toBe(true);
    });

    it('fails loudly on an unrecognised clip name', () => {
        const doc: GltfDocument = { animations: [{ name: 'walk' }, { name: 'Take 001' }] };
        const r = checkClipNames(doc);
        expect(r.ok).toBe(false);
        expect(r.bad).toEqual(['Take 001']);
    });

    it('an empty clip list passes (clips are optional per class, §2)', () => {
        expect(checkClipNames({}).ok).toBe(true);
    });
});

describe('checkEngineGeometry', () => {
    it('fails before modelimporter has run', () => {
        expect(checkEngineGeometry({}).ok).toBe(false);
    });

    it('passes once SPRINGRTS_geometry is embedded', () => {
        const doc: GltfDocument = {
            extensions: { SPRINGRTS_geometry: { radius: 1 } },
            extensionsUsed: ['SPRINGRTS_geometry'],
        };
        expect(checkEngineGeometry(doc).ok).toBe(true);
    });
});

// ── real binary .glb round-trip + engine-load smoke ─────────────────────

/** Build a minimal but spec-valid .glb: one triangle, one named node, one
 * material (optionally carrying the team-colour mask extension). Real
 * bytes, not a mock — used to prove parseGlb/gltf-validator/modelimporter
 * all actually function against this harness, not just against hand-built
 * JS objects. */
function buildTestGlb(nodeName: string, withTeamMask: boolean): Uint8Array {
    const positions = new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
    ]);
    const posBytes = new Uint8Array(positions.buffer);

    const json: Record<string, unknown> = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: nodeName, mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        accessors: [{
            bufferView: 0, componentType: 5126, count: 3, type: 'VEC3',
            min: [0, 0, 0], max: [1, 1, 0],
        }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength }],
        buffers: [{ byteLength: posBytes.byteLength }],
        materials: [withTeamMask
            ? { name: 'mat0', extensions: { SPRINGRTS_team_color: { maskTexture: { index: 0 } } } }
            : { name: 'mat0' }],
    };
    if (withTeamMask) {
        json.extensionsUsed = ['SPRINGRTS_team_color'];
        // A texture is required for the mask index to resolve — minimal 1x1 stand-in image ref.
        json.images = [{ mimeType: 'image/png', bufferView: 0 }];
        json.textures = [{ source: 0 }];
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPadded = padTo4(jsonBytes, 0x20);
    const binPadded = padTo4(posBytes, 0x00);

    const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
    const out = new Uint8Array(totalLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true); // magic 'glTF'
    view.setUint32(4, 2, true);          // version
    view.setUint32(8, totalLength, true);

    let off = 12;
    view.setUint32(off, jsonPadded.length, true); off += 4;
    view.setUint32(off, 0x4e4f534a, true); off += 4; // 'JSON'
    out.set(jsonPadded, off); off += jsonPadded.length;

    view.setUint32(off, binPadded.length, true); off += 4;
    view.setUint32(off, 0x004e4942, true); off += 4; // 'BIN\0'
    out.set(binPadded, off); off += binPadded.length;

    return out;
}

function padTo4(bytes: Uint8Array, fill: number): Uint8Array {
    const rem = bytes.length % 4;
    if (rem === 0) return bytes;
    const pad = 4 - rem;
    const out = new Uint8Array(bytes.length + pad);
    out.set(bytes, 0);
    out.fill(fill, bytes.length);
    return out;
}

describe('parseGlb — real binary round-trip', () => {
    it('round-trips a hand-built .glb and the checks agree with it', () => {
        const bytes = buildTestGlb('turret', true);
        const { json, bin } = parseGlb(bytes);
        expect(json.asset?.version).toBe('2.0');
        expect(bin).not.toBeNull();
        expect(bin!.byteLength).toBe(36); // 3 verts * 3 floats * 4 bytes
        expect(checkPieceNaming(json, ['turret']).ok).toBe(true);
        expect(checkTeamColorMask(json).ok).toBe(true);
        expect(countTriangles(json)).toBe(1);
    });

    it('throws on a corrupt magic number', () => {
        const bytes = buildTestGlb('turret', false);
        bytes[0] = 0; // corrupt the magic
        expect(() => parseGlb(bytes)).toThrow();
    });
});

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MODELIMPORTER_BIN = path.join(REPO_ROOT, 'build/debug/tools/modelimporter/modelimporter');
const hasModelimporter = fs.existsSync(MODELIMPORTER_BIN);

describe.skipIf(!hasModelimporter)('engine-load smoke via the real modelimporter binary', () => {
    it('embeds SPRINGRTS_geometry and preserves the piece name through Assimp re-export', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-model-validate-'));
        try {
            const inputPath = path.join(tmpDir, 'ms_test_s1.glb');
            const outputPath = path.join(tmpDir, 'out', 'ms_test_s1.glb');
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(inputPath, buildTestGlb('turret', false));

            execFileSync(MODELIMPORTER_BIN, [inputPath, outputPath], { stdio: 'pipe' });

            const outBytes = new Uint8Array(fs.readFileSync(outputPath));
            const { json } = parseGlb(outBytes);
            expect(checkEngineGeometry(json).ok).toBe(true);
            expect(checkPieceNaming(json, ['turret']).ok).toBe(true);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
