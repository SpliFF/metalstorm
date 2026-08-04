import { describe, it, expect } from 'vitest';
import {
    NullEngine, Scene, Vector3, FreeCamera, Quaternion, Matrix, VertexBuffer,
} from '@babylonjs/core';
import {
    ImpostorRenderer, LodTier, quantizeHeading, computeCardRotation, layoutOf,
    cardLift, createImpostorCard, type ImpostorAtlas,
} from './impostor-renderer.js';
import {
    SINGLE_CELL_LAYOUT, DEFAULT_ATLAS_LAYOUT, selectAtlasCell,
    AZIMUTH_PHASE_COL0_BACK, AZIMUTH_PHASE_COL0_FRONT,
} from './impostor-atlas.js';

// PLAN-metalstorm-beta-units.md §2.1 / engine ask B1. Covers the three
// pieces of B1 logic the design doc calls out for unit coverage: heading
// quantization, LOD tier selection, and per-(defId,team) instance batching.

describe('quantizeHeading', () => {
    it('maps radians to the nearest 45° atlas column (0-7)', () => {
        expect(quantizeHeading(0)).toBe(0);
        expect(quantizeHeading(Math.PI / 4)).toBe(1);
        expect(quantizeHeading(Math.PI / 2)).toBe(2);
        expect(quantizeHeading(Math.PI)).toBe(4);
        expect(quantizeHeading(-Math.PI / 4)).toBe(7); // negative wraps
        expect(quantizeHeading(2 * Math.PI + 0.001)).toBe(0); // > 2π wraps
    });

    it('rounds to the nearest column instead of always flooring', () => {
        expect(quantizeHeading(Math.PI / 8 + 0.01)).toBe(1); // just past the col-0/1 boundary
        expect(quantizeHeading(Math.PI / 8 - 0.01)).toBe(0); // just before it
    });
});

function makeRenderer(): ImpostorRenderer {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    return new ImpostorRenderer(scene, engine);
}

describe('ImpostorRenderer.determineLodTier', () => {
    it('defaults to Full when no thresholds are registered for the def', () => {
        const r = makeRenderer();
        expect(r.determineLodTier(1, new Vector3(10000, 0, 0), Vector3.Zero())).toBe(LodTier.Full);
    });

    it('switches Full -> Impostor -> Icon at the registered distances', () => {
        const r = makeRenderer();
        r.registerLodThresholds(1, { impostorDistance: 500, iconDistance: 2000 });

        expect(r.determineLodTier(1, new Vector3(100, 0, 0), Vector3.Zero())).toBe(LodTier.Full);
        expect(r.determineLodTier(1, new Vector3(500, 0, 0), Vector3.Zero())).toBe(LodTier.Impostor);
        expect(r.determineLodTier(1, new Vector3(1000, 0, 0), Vector3.Zero())).toBe(LodTier.Impostor);
        expect(r.determineLodTier(1, new Vector3(2000, 0, 0), Vector3.Zero())).toBe(LodTier.Icon);
    });

    it('a forceTier override wins regardless of distance/thresholds', () => {
        const r = makeRenderer();
        r.registerLodThresholds(1, { impostorDistance: 500, iconDistance: 2000 });
        expect(r.determineLodTier(1, Vector3.Zero(), Vector3.Zero(), LodTier.Icon)).toBe(LodTier.Icon);
        expect(r.determineLodTier(1, new Vector3(9999, 0, 0), Vector3.Zero(), LodTier.Full))
            .toBe(LodTier.Full);
    });
});

describe('ImpostorRenderer instance batching', () => {
    it('groups instances into one thin-instanced mesh per (defId, team)', () => {
        const r = makeRenderer();
        r.registerAtlas(1, { diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 10, height: 10 });
        r.registerAtlas(2, { diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 10, height: 10 });

        r.addInstance(1, 0, 0, 0, 0, 0);
        r.addInstance(1, 0, 10, 0, 10, 0);
        r.addInstance(1, 1, 0, 0, 0, 0);   // same def, different team -> separate mesh
        r.addInstance(2, 0, 0, 0, 0, 0);

        r.render(Vector3.Zero());

        const counts = r.getDebugMeshCounts();
        expect(counts.get('impostor:1:0')).toBe(2);
        expect(counts.get('impostor:1:1')).toBe(1);
        expect(counts.get('impostor:2:0')).toBe(1);
    });

    it('skips instances for a def with no registered atlas (no mesh created)', () => {
        const r = makeRenderer();
        r.addInstance(99, 0, 0, 0, 0, 0);
        expect(() => r.render(Vector3.Zero())).not.toThrow();
        expect(r.getDebugMeshCounts().has('impostor:99:0')).toBe(false);
    });

    it('hides a mesh whose group had no instances this frame', () => {
        const r = makeRenderer();
        r.registerAtlas(1, { diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 10, height: 10 });
        r.addInstance(1, 0, 0, 0, 0, 0);
        r.render(Vector3.Zero());
        expect(r.getDebugMeshCounts().get('impostor:1:0')).toBe(1);

        // Next frame: nothing added for this def/team.
        r.render(Vector3.Zero());
        expect(r.getDebugMeshCounts().get('impostor:1:0')).toBe(0);
    });
});

// PLAN-metalstorm-impostors.md §Card orientation. The rotation is shared by
// the whole batch (kills the radial fan-out), and it only tilts with the
// camera pitch when the atlas has elevation rows to present.
describe('computeCardRotation', () => {
    function pitchedCamera(pitchDown: number): FreeCamera {
        const scene = new Scene(new NullEngine());
        const cam = new FreeCamera('cam', new Vector3(0, 300, -300), scene);
        cam.rotation.x = pitchDown;
        return cam;
    }

    /** The card's local up, in world space, under this rotation. */
    function cardUp(pitchDown: number, layout = DEFAULT_ATLAS_LAYOUT): Vector3 {
        const q = computeCardRotation(pitchedCamera(pitchDown), layout);
        const up = new Vector3(0, 1, 0);
        up.rotateByQuaternionToRef(q, up);
        return up;
    }

    it('is identity when there is no active camera', () => {
        expect(computeCardRotation(null, DEFAULT_ATLAS_LAYOUT).equals(
            computeCardRotation(undefined, DEFAULT_ATLAS_LAYOUT))).toBe(true);
    });

    it('keeps a single-row atlas card upright at any camera pitch', () => {
        for (const pitch of [0, 0.5, 1.0, 1.4]) {
            const up = cardUp(pitch, SINGLE_CELL_LAYOUT);
            expect(up.y).toBeCloseTo(1, 6);
        }
    });

    it('leans a pitch-row atlas card further as the camera steepens', () => {
        // A steeper camera ⇒ the card lies flatter ⇒ its local up tips away
        // from world up, which is what lets the top-down row be seen.
        const shallow = cardUp(0.2).y;
        const steep = cardUp(1.3).y;
        expect(shallow).toBeGreaterThan(steep);
        expect(steep).toBeLessThan(0.8);
    });

    it('does not roll the card', () => {
        // No roll ⇒ the card's local up has no sideways (X) component for a
        // camera that is only yawed/pitched, so sprites never appear canted.
        const q = computeCardRotation(pitchedCamera(0.9), DEFAULT_ATLAS_LAYOUT);
        const right = new Vector3(1, 0, 0);
        right.rotateByQuaternionToRef(q, right);
        expect(right.y).toBeCloseTo(0, 6);
    });

    it('treats an atlas with no layout as a legacy single-view sheet', () => {
        expect(layoutOf(undefined)).toEqual(SINGLE_CELL_LAYOUT);
        expect(layoutOf({ diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 1, height: 1 }))
            .toEqual(SINGLE_CELL_LAYOUT);
    });
});

// The ground anchor. `height/2` is only right when the baker put the model's
// ground point on the cell's BOTTOM edge; the `infantry_v2` sheets keep a
// margin and share one scale across 24 views, so their feet sit ~18% of a cell
// above it and a half-height lift hovers them ~2 elmos. Hence a declared lift.
describe('cardLift', () => {
    const atlas = (extra: Partial<ImpostorAtlas> = {}): ImpostorAtlas => ({
        diffuseUri: '', walkFrames: 1, idleFrames: 1, width: 12, height: 12, ...extra,
    });

    it('falls back to half the card height when the atlas declares nothing', () => {
        expect(cardLift(atlas())).toBe(6);
    });

    it('uses the atlas\'s own declared lift when present', () => {
        expect(cardLift(atlas({ centreY: 3.8457 }))).toBeCloseTo(3.8457, 6);
    });

    it('ignores a nonsensical declaration rather than sinking the card', () => {
        for (const centreY of [0, -1, NaN]) {
            expect(cardLift(atlas({ centreY }))).toBe(6);
        }
    });

    it('is 0 for a missing atlas', () => {
        expect(cardLift(undefined)).toBe(0);
    });

    it('places the declared ground point on the terrain, not the card centre', () => {
        // A card of height h whose baked ground point is a fraction f of the
        // sheet above its bottom edge needs a lift of h*(0.5 − f). Check the
        // measured infantry number lands the feet at y = 0 for an upright card.
        const a = atlas({ centreY: 3.8457 });
        const groundFractionOfCell = 0.17953;   // measured off the M2 bake
        const feetLocalY = -a.height / 2 + groundFractionOfCell * a.height;
        expect(cardLift(a) + feetLocalY).toBeCloseTo(0, 3);
    });
});

// The zero point of the atlas azimuth phase, pinned against Babylon's REAL
// placement transform rather than asserted in prose. This is the fact that a
// stale docstring got backwards (it claimed column 0 was "dead-front"), letting
// two self-consistent conventions drift 180deg apart unnoticed — so it is worth
// a test that would fail if the engine's handedness ever changed under us.
describe('azimuth phase zero point (vs Babylon placement)', () => {
    /** World-space forward of a `-Z`-forward model placed at `heading`. */
    const worldForward = (heading: number): Vector3 => {
        const m = Matrix.Identity();
        Matrix.ComposeToRef(
            Vector3.One(), Quaternion.RotationAxis(Vector3.UpReadOnly, heading),
            Vector3.Zero(), m);
        return Vector3.TransformNormal(new Vector3(0, 0, -1), m);
    };

    it('sends a -Z forward to (-sin h, ., -cos h)', () => {
        for (const h of [0, Math.PI / 2, Math.PI, 2.3, -0.7]) {
            const f = worldForward(h);
            expect(f.x).toBeCloseTo(-Math.sin(h), 6);
            expect(f.z).toBeCloseTo(-Math.cos(h), 6);
        }
    });

    it('puts relative yaw 0 directly BEHIND the instance, not in front', () => {
        for (const h of [0, Math.PI / 2, Math.PI, 2.3, -0.7]) {
            // Relative yaw 0 means viewYaw == heading, i.e. toCam = (sin h, ., cos h).
            const toCam = new Vector3(Math.sin(h), 0, Math.cos(h));
            // That is exactly the anti-forward direction => we see the BACK.
            expect(Vector3.Dot(toCam, worldForward(h))).toBeCloseTo(-1, 6);
        }
    });

    it('so the default phase reads a behind-camera as column 0, and PI reads it as the far column', () => {
        const h = 1.2;
        const toCam = new Vector3(Math.sin(h), 0.5, Math.cos(h));
        const back = { ...DEFAULT_ATLAS_LAYOUT, azimuthPhase: AZIMUTH_PHASE_COL0_BACK };
        const front = { ...DEFAULT_ATLAS_LAYOUT, azimuthPhase: AZIMUTH_PHASE_COL0_FRONT };
        expect(selectAtlasCell(toCam.x, toCam.y, toCam.z, h, back) % 8).toBe(0);
        expect(selectAtlasCell(toCam.x, toCam.y, toCam.z, h, front) % 8).toBe(4);
    });
});

// ── Card UV space ────────────────────────────────────────────────────────
//
// The other half of the "upside-down units" fix (2026-08-03). `atlasCellUv`
// offsets a cell in IMAGE space; that is only correct if the card it is
// offsetting samples in image space too. `MeshBuilder.CreatePlane` does NOT —
// it hands back Babylon's bottom-up procedural-mesh UVs (v = 1 at the top) —
// while every atlas we ship is a KTX2, which Babylon cannot invertY (compressed
// data, and its KTX2 path sets no `_invertVScale` either) and which therefore
// always arrives with its TOP image row at v = 0. Bottom-up card UVs mirror the
// whole sheet vertically, which is what shipped.
describe('createImpostorCard', () => {
    const cardUvs = (): { y: number; v: number }[] => {
        const scene = new Scene(new NullEngine());
        const mesh = createImpostorCard('card', 4, 10, scene);
        const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
        const uv = mesh.getVerticesData(VertexBuffer.UVKind)!;
        const out: { y: number; v: number }[] = [];
        for (let i = 0; i < uv.length / 2; i++) out.push({ y: pos[i * 3 + 1], v: uv[i * 2 + 1] });
        return out;
    };

    it('puts v = 0 at the card TOP edge (image space, matching KTX2)', () => {
        const verts = cardUvs();
        const top = Math.max(...verts.map((p) => p.y));
        const bottom = Math.min(...verts.map((p) => p.y));
        expect(top).toBeGreaterThan(bottom);
        for (const p of verts) {
            expect(p.v).toBeCloseTo(p.y === top ? 0 : 1, 6);
        }
    });

    it('flips BOTH faces of the double-sided quad', () => {
        // sideOrientation: DOUBLESIDE duplicates the vertices; a flip applied to
        // only the front half leaves the back face mirrored against it.
        const verts = cardUvs();
        expect(verts.length).toBe(8);
        expect(verts.filter((p) => p.v === 0).length).toBe(4);
    });
});
