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
