import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, PBRMaterial } from '@babylonjs/core';
import { ImpostorUvPlugin } from './impostor-uv-plugin.js';

function makePlugin(): ImpostorUvPlugin {
    const scene = new Scene(new NullEngine());
    return new ImpostorUvPlugin(new PBRMaterial('m', scene));
}

describe('ImpostorUvPlugin billboard ground anchor', () => {
    // The ground-anchor lift MUST be applied before the billboard rotation so
    // it rotates with the card. Applied after, it is a world-up translation,
    // which leaves a pitched (near-horizontal) card hovering half its height
    // above the terrain — PLAN-metalstorm-impostors.md §Card orientation.
    it('lifts before rotating, so the lift rides the card local up', () => {
        const code = makePlugin().getCustomCode('vertex')!;
        const body = code.CUSTOM_VERTEX_UPDATE_POSITION;
        const lift = body.indexOf('positionUpdated.y += uImpostorLift');
        const rotate = body.indexOf('uBillboardRot * vec4(positionUpdated');
        expect(lift).toBeGreaterThanOrEqual(0);
        expect(rotate).toBeGreaterThanOrEqual(0);
        expect(lift).toBeLessThan(rotate);
    });

    it('rotates the normal with the card too', () => {
        const body = makePlugin().getCustomCode('vertex')!.CUSTOM_VERTEX_UPDATE_POSITION;
        expect(body).toContain('uBillboardRot * vec4(normalUpdated');
    });

    it('only emits vertex-stage code', () => {
        expect(makePlugin().getCustomCode('fragment')).toBeNull();
    });
});

describe('ImpostorUvPlugin atlas v axis', () => {
    // The atlases are KTX2. Babylon cannot apply invertY to a compressed
    // texture, so v=0 is the image's TOP row — the opposite of the
    // uncompressed path this shader would otherwise assume. The remap must
    // therefore flip the quad's own v AND count rows down from the top.
    //
    // Getting this wrong is silent and doubly wrong: every sprite draws upside
    // down AND row 0 samples the far end of the sheet, so a shallow camera is
    // served the top-down elevation row. Both were live on main until the
    // 2026-08-03 Meridian pass; no test caught it, hence this one.
    it('flips the quad v before scaling it into the cell', () => {
        const body = makePlugin().getCustomCode('vertex')!.CUSTOM_VERTEX_UPDATE_POSITION;
        expect(body).toContain('float _impV = 1.0 - uvUpdated.y');
        expect(body).toContain('vec2(uvUpdated.x, _impV) * uImpostorGrid');
        // ...and NOT the un-flipped form, which is what shipped.
        expect(body).not.toContain('uvUpdated = uvUpdated * uImpostorGrid');
    });

    it('puts row 0 at the image top when topDown, at the bottom otherwise', () => {
        const body = makePlugin().getCustomCode('vertex')!.CUSTOM_VERTEX_UPDATE_POSITION;
        // topDown → offset counts down from v=0 (image top): row * gridY.
        expect(body).toContain('? _impRow * uImpostorGrid.y');
        expect(body).toContain(': 1.0 - (_impRow + 1.0) * uImpostorGrid.y');
    });
});
