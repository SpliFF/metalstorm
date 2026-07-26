import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { ImpostorRenderer, LodTier, quantizeHeading } from './impostor-renderer.js';

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
