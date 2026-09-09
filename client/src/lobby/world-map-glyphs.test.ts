/**
 * world-map-glyphs.test.ts — the canvas trace and the legend SVG read the
 * same point table, and every POI kind lands on a glyph.
 */

import { describe, it, expect } from 'vitest';
import {
    GLYPH_KINDS, GLYPH_LABELS, glyphKindFor, glyphPoints, glyphRadiusScale,
    traceGlyph, traceClaimFlag, traceCommanderStar,
    glyphSvg, stateRingSvg, claimFlagSvg, commanderStarSvg,
    type GlyphPathCtx,
} from './world-map-glyphs';

function recorder() {
    const ops: { op: string; args: number[] }[] = [];
    const ctx: GlyphPathCtx = {
        beginPath: () => ops.push({ op: 'beginPath', args: [] }),
        moveTo: (x, y) => ops.push({ op: 'moveTo', args: [x, y] }),
        lineTo: (x, y) => ops.push({ op: 'lineTo', args: [x, y] }),
        arc: (x, y, r, a0, a1) => ops.push({ op: 'arc', args: [x, y, r, a0, a1] }),
        closePath: () => ops.push({ op: 'closePath', args: [] }),
    };
    return { ctx, ops };
}

describe('kind → glyph', () => {
    it('splits on the one distinction that matters when the kind is unknown', () => {
        expect(glyphKindFor({ kind: 'battleground', mapId: 'm' })).toBe('battleground');
        expect(glyphKindFor({ kind: 'region', mapId: null })).toBe('region');
        expect(glyphKindFor({ kind: '', mapId: 'm' })).toBe('battleground');
        expect(glyphKindFor({ kind: '', mapId: null })).toBe('region');
        expect(glyphKindFor({ kind: 'volcano', mapId: 'm' })).toBe('battleground');
        expect(glyphKindFor({ kind: 'volcano', mapId: null })).toBe('region');
        // A seeder calling a playable place a "region" still gets the
        // battleground glyph — mapId is the fact, the word is a label.
        expect(glyphKindFor({ kind: 'region', mapId: 'm' })).toBe('battleground');
    });

    it('maps the richer kinds and their synonyms', () => {
        expect(glyphKindFor({ kind: 'outpost', mapId: null })).toBe('outpost');
        expect(glyphKindFor({ kind: 'depot', mapId: 'm' })).toBe('depot');
        expect(glyphKindFor({ kind: 'foundry', mapId: 'm' })).toBe('foundry');
        expect(glyphKindFor({ kind: 'relay', mapId: null })).toBe('relay');
        expect(glyphKindFor({ kind: 'waystation', mapId: null })).toBe('relay');
        expect(glyphKindFor({ kind: 'port', mapId: 'm' })).toBe('port');
        expect(glyphKindFor({ kind: 'harbour', mapId: 'm' })).toBe('port');
    });

    it('has a label and a shape for every kind', () => {
        for (const k of GLYPH_KINDS) {
            expect(GLYPH_LABELS[k]).toBeTruthy();
            const pts = glyphPoints(k);
            if (pts) {
                expect(pts.length).toBeGreaterThanOrEqual(3);
                for (const [x, y] of pts) expect(x * x + y * y).toBeCloseTo(1, 2);   // unit radius
            }
        }
        expect(glyphPoints('battleground')).toBeNull();
        expect(glyphPoints('outpost')!.length).toBe(3);
        expect(glyphPoints('depot')!.length).toBe(4);
        expect(glyphPoints('foundry')!.length).toBe(6);
        expect(glyphRadiusScale('region')).toBeLessThan(1);
        expect(glyphRadiusScale('battleground')).toBe(1);
    });
});

describe('traceGlyph', () => {
    it('traces a circle for a circle kind and a closed polygon otherwise', () => {
        const c = recorder();
        traceGlyph(c.ctx, 'battleground', 10, 20, 5);
        expect(c.ops.map(o => o.op)).toEqual(['beginPath', 'arc']);
        expect(c.ops[1].args.slice(0, 3)).toEqual([10, 20, 5]);

        const t = recorder();
        traceGlyph(t.ctx, 'outpost', 10, 20, 5);
        expect(t.ops.map(o => o.op)).toEqual(['beginPath', 'moveTo', 'lineTo', 'lineTo', 'closePath']);
        // First vertex points up: (10, 15).
        expect(t.ops[1].args).toEqual([10, 15]);
        // Every vertex is on the radius-5 circle about (10, 20).
        for (const o of t.ops.filter(o => o.op === 'moveTo' || o.op === 'lineTo')) {
            const dx = o.args[0] - 10, dy = o.args[1] - 20;
            expect(Math.sqrt(dx * dx + dy * dy)).toBeCloseTo(5, 1);
        }
    });

    it('traces the pennant and the star as single closed paths', () => {
        const f = recorder();
        traceClaimFlag(f.ctx, 0, 0, 5);
        expect(f.ops[0].op).toBe('beginPath');
        expect(f.ops[f.ops.length - 1].op).toBe('closePath');
        expect(f.ops.filter(o => o.op === 'lineTo')).toHaveLength(3);
        // Planted above and to the right of the marker.
        for (const o of f.ops.filter(o => o.op === 'moveTo' || o.op === 'lineTo')) {
            expect(o.args[0]).toBeGreaterThan(0);
            expect(o.args[1]).toBeLessThan(0);
        }
        const s = recorder();
        traceCommanderStar(s.ctx, 0, 0, 5);
        expect(s.ops.filter(o => o.op === 'lineTo')).toHaveLength(9);
        expect(s.ops[s.ops.length - 1].op).toBe('closePath');
    });
});

describe('legend SVG', () => {
    it('draws the same shape the canvas does', () => {
        const svg = glyphSvg('foundry', '#5b9bd5', 14);
        expect(svg).toContain('<polygon');
        expect(svg.match(/points="([^"]+)"/)![1].split(' ')).toHaveLength(6);
        expect(svg).toContain('fill="#5b9bd5"');
        expect(glyphSvg('battleground', '#fff')).toContain('<circle');
        expect(glyphSvg('region', '#fff')).toContain('<circle');
        expect(glyphSvg('battleground', '#fff')).toContain('aria-hidden="true"');
    });

    it('escapes the colour attribute rather than trusting it', () => {
        const svg = glyphSvg('depot', '"><script>alert(1)</script>');
        expect(svg).not.toContain('<script>');
        expect(svg).toContain('&lt;script');
    });

    it('rings the three states differently', () => {
        expect(stateRingSvg('quiet', '#fff')).not.toContain('stroke-dasharray');
        expect(stateRingSvg('quiet', '#fff').match(/<circle/g)).toHaveLength(1);
        expect(stateRingSvg('staging', '#ffd479')).toContain('stroke-dasharray');
        expect(stateRingSvg('active', '#ff5c5c')).not.toContain('stroke-dasharray');
        expect(stateRingSvg('active', '#ff5c5c').match(/<circle/g)).toHaveLength(2);
        expect(claimFlagSvg('#e69f00')).toContain('<polygon');
        expect(commanderStarSvg('#fff').match(/points="([^"]+)"/)![1].split(' ')).toHaveLength(10);
    });
});
