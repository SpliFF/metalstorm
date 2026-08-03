import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, PBRMaterial } from '@babylonjs/core';
import { ImpostorUvPlugin } from './impostor-uv-plugin.js';
import { atlasCellUv, atlasCellCount } from './impostor-atlas.js';

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

// ── V orientation ────────────────────────────────────────────────────────
//
// The shader is a hand-written copy of `atlasCellUv`, so the two can drift —
// and a V drift is silent (every cell still renders *something*). This pulls
// the two `_impOffV` expressions straight out of the emitted GLSL, evaluates
// them, and compares against the TS function for every cell of the shipped 8x3
// grid, so neither side can be "fixed" alone.
describe('ImpostorUvPlugin cell UV remap', () => {
    const layout = { yawBins: 8, pitchBins: 3, frames: 1 };

    /** Both `_impOffV` expressions as emitted: the initialiser (the bottom-up
     *  source fallback) and the `uImpostorTopDown` override. */
    function offsetExprs(): { fallback: string; topDown: string } {
        const body = makePlugin().getCustomCode('vertex')!.CUSTOM_VERTEX_UPDATE_POSITION;
        expect(body).toContain('float _impRow = floor(impostorCell / uImpostorCols);');
        const init = /float _impOffV = ([^;]+);/.exec(body);
        const override = /uImpostorTopDown > 0\.5\) \{\s*_impOffV = ([^;]+);/.exec(body);
        expect(init).not.toBeNull();
        expect(override).not.toBeNull();
        return { fallback: init![1], topDown: override![1] };
    }

    /** Evaluate one GLSL offset expression for a given row. */
    const evalOv = (expr: string, row: number, rows: number): number => {
        const js = expr
            .replace(/_impRow/g, String(row))
            .replace(/uImpostorGrid\.y/g, String(1 / rows));
        return Function(`"use strict"; return (${js});`)() as number;
    };

    it('matches atlasCellUv on every cell, both row orders', () => {
        const { fallback, topDown } = offsetExprs();
        const rows = layout.pitchBins * layout.frames;
        for (let cell = 0; cell < atlasCellCount(layout); cell++) {
            const row = Math.floor(cell / layout.yawBins);
            expect(evalOv(topDown, row, rows))
                .toBeCloseTo(atlasCellUv(cell, layout, true).ov, 9);
            expect(evalOv(fallback, row, rows))
                .toBeCloseTo(atlasCellUv(cell, layout, false).ov, 9);
        }
    });

    it('offsets a top-down atlas straight down the image, no flip', () => {
        // Row 0 is the TOP image row and the card's v = 0 is its TOP edge
        // (createImpostorCard), so the two meet at 0. The bug that shipped had
        // this at 1 - 1/rows, which both mirrored the cell and picked row 2.
        expect(atlasCellUv(0, layout, true).ov).toBe(0);
        expect(evalOv(offsetExprs().topDown, 0, 3)).toBe(0);
    });
});
