import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, Vector3, FreeCamera } from '@babylonjs/core';
import {
    ImpostorRenderer, LodTier, quantizeHeading, computeCardRotation, layoutOf,
} from './impostor-renderer.js';
import { SINGLE_CELL_LAYOUT, DEFAULT_ATLAS_LAYOUT } from './impostor-atlas.js';

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
