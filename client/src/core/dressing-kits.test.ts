import { describe, expect, it } from 'vitest';
import { Matrix, Vector3 } from '@babylonjs/core';
import { dressingKit, dressingMounts, mountLocalMatrix } from './dressing-kits.js';

describe('dressingKit', () => {
    it('resolves the order kit and ignores unknown/absent names', () => {
        expect(dressingKit('order')?.model).toBe('ms_dress_order');
        expect(dressingKit('dynasty')).toBeNull();   // §M5 prototype scope
        expect(dressingKit(undefined)).toBeNull();
    });

    it('only has mounts for hulls it was authored against', () => {
        const kit = dressingKit('order')!;
        expect(dressingMounts(kit, 'fable_tank').length).toBe(3);
        expect(dressingMounts(kit, 'fable_heavy')).toEqual([]);
        expect(dressingMounts(kit, 'ms_technical')).toEqual([]);
    });

    it('mounts the kit pieces on the deck, not at the display fan-out', () => {
        // The kit glTF fans its roots out along X (staff at -1.6, lightbar at
        // +0.9, stowage at +3.4) purely so a preview of the whole kit does not
        // overlap. Mount offsets must come from the table, never the file.
        const mounts = dressingMounts(dressingKit('order')!, 'fable_tank');
        for (const m of mounts) {
            expect(m.parent).toBe('body');
            expect(m.offset[1]).toBeCloseTo(1.86);   // fable_tank deck height
        }
        expect(mounts.map((m) => m.piece)).toEqual(['staff', 'lightbar', 'stowage']);
    });
});

describe('mountLocalMatrix', () => {
    it('places the piece origin at the mount offset', () => {
        const m = mountLocalMatrix({ piece: 'p', parent: 'body', offset: [-1.45, 1.86, 3.9] });
        const origin = Vector3.TransformCoordinates(Vector3.Zero(), m);
        expect(origin.x).toBeCloseTo(-1.45);
        expect(origin.y).toBeCloseTo(1.86);
        expect(origin.z).toBeCloseTo(3.9);
    });

    it('yaws about the mount point, then offsets', () => {
        // 180° yaw (the dynasty crest, which must face forward off the bow):
        // a point 1 m ahead of the piece origin ends up 1 m BEHIND the mount.
        const m = mountLocalMatrix({
            piece: 'crest', parent: 'body', offset: [0, 0.95, -4.42], yaw: 180,
        });
        const ahead = Vector3.TransformCoordinates(new Vector3(0, 0, -1), m);
        expect(ahead.x).toBeCloseTo(0);
        expect(ahead.z).toBeCloseTo(-3.42);
    });

    it('applies uniform scale (heavy-hull prow is 1.30)', () => {
        const m = mountLocalMatrix({
            piece: 'prow', parent: 'body', offset: [0, 0.3, -6.95], scale: 1.3,
        });
        const tip = Vector3.TransformCoordinates(new Vector3(0, 0, -1), m);
        expect(tip.z).toBeCloseTo(-6.95 - 1.3);
    });

    it('composes onto a parent piece the way the renderer chains it', () => {
        // The renderer computes restWorld = mountLocal × parentRestWorld, so a
        // mount on a hull piece that is itself offset lands additively.
        const parentRest = Matrix.Translation(0, 0, 0.3);       // e.g. turret ring
        const mount = mountLocalMatrix({
            piece: 'smoke', parent: 'turret', offset: [0.95, 0.55, -0.9], yaw: 25,
        });
        const world = mount.multiply(parentRest);
        const origin = Vector3.TransformCoordinates(Vector3.Zero(), world);
        expect(origin.x).toBeCloseTo(0.95);
        expect(origin.y).toBeCloseTo(0.55);
        expect(origin.z).toBeCloseTo(-0.6);
    });
});
