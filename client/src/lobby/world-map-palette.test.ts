/**
 * world-map-palette.test.ts — the faction colour helper is deterministic,
 * distinct while the palette lasts, and safe to hand to a canvas.
 */

import { describe, it, expect } from 'vitest';
import {
    SAFE_PALETTE, hashId, paletteColour, assignFactionColours,
    hexToRgb, withAlpha, relativeLuminance, contrastText,
} from './world-map-palette';

describe('the safe palette', () => {
    it('is ten valid, distinct #rrggbb colours', () => {
        expect(SAFE_PALETTE).toHaveLength(10);
        for (const c of SAFE_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
        expect(new Set(SAFE_PALETTE).size).toBe(SAFE_PALETTE.length);
    });

    it('opens with Okabe–Ito, in its published order', () => {
        expect(SAFE_PALETTE.slice(0, 7)).toEqual([
            '#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7',
        ]);
    });
});

describe('hashing', () => {
    it('is stable and spreads ids', () => {
        expect(hashId('third-armoured')).toBe(hashId('third-armoured'));
        expect(hashId('')).toBe(0x811c9dc5);
        expect(hashId('a')).not.toBe(hashId('b'));
        expect(paletteColour('x')).toBe(SAFE_PALETTE[hashId('x') % SAFE_PALETTE.length]);
    });
});

describe('assignFactionColours', () => {
    it('gives every faction its own colour while the palette lasts', () => {
        const ids = ['third-armoured', 'house-verendi', 'the-14th-of-ash', 'warhounds', 'ghosts', 'a', 'b', 'c', 'd', 'e'];
        const out = assignFactionColours(ids);
        expect(Object.keys(out).sort()).toEqual([...ids].sort());
        expect(new Set(Object.values(out)).size).toBe(ids.length);
        for (const c of Object.values(out)) expect(SAFE_PALETTE).toContain(c);
    });

    it('is independent of input order and duplicates', () => {
        const a = assignFactionColours(['x', 'y', 'z']);
        const b = assignFactionColours(['z', 'x', 'y', 'x']);
        expect(a).toEqual(b);
    });

    it('keeps its hash slot when nothing collides, so a faction\'s colour survives a newcomer', () => {
        const alone = assignFactionColours(['third-armoured']);
        expect(alone['third-armoured']).toBe(paletteColour('third-armoured'));
        // Any id whose hash slot differs cannot move it.
        const other = ['q', 'r', 's', 't'].find(id =>
            hashId(id) % SAFE_PALETTE.length !== hashId('third-armoured') % SAFE_PALETTE.length)!;
        expect(assignFactionColours(['third-armoured', other])['third-armoured'])
            .toBe(alone['third-armoured']);
    });

    it('wraps past the palette rather than throwing', () => {
        const ids = Array.from({ length: 14 }, (_, i) => `f${i}`);
        const out = assignFactionColours(ids);
        expect(Object.keys(out)).toHaveLength(14);
        for (const c of Object.values(out)) expect(SAFE_PALETTE).toContain(c);
    });

    it('honours a custom palette', () => {
        expect(assignFactionColours(['a', 'b'], ['#111111', '#222222'])).toEqual(
            expect.objectContaining({ a: expect.stringMatching(/^#(111111|222222)$/) }),
        );
    });
});

describe('colour arithmetic', () => {
    it('parses hex and refuses anything else', () => {
        expect(hexToRgb('#5b9bd5')).toEqual([91, 155, 213]);
        expect(hexToRgb('#FFFFFF')).toEqual([255, 255, 255]);
        expect(hexToRgb('red')).toBeNull();
        expect(hexToRgb('#fff')).toBeNull();
        expect(hexToRgb('#5b9bd5; background:url(x)')).toBeNull();
    });

    it('spells out a translucent colour for the canvas', () => {
        expect(withAlpha('#5b9bd5', 0.16)).toBe('rgba(91, 155, 213, 0.16)');
        expect(withAlpha('#5b9bd5', 7)).toBe('rgba(91, 155, 213, 1)');
        expect(withAlpha('#5b9bd5', -1)).toBe('rgba(91, 155, 213, 0)');
        // A non-hex input passes through untouched rather than becoming
        // "rgba(undefined…": the caller validated it, or it is already rgba.
        expect(withAlpha('rgba(1, 2, 3, 0.5)', 0.2)).toBe('rgba(1, 2, 3, 0.5)');
    });

    it('picks text that reads on the swatch', () => {
        expect(relativeLuminance('#000000')).toBe(0);
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
        expect(contrastText('#f0e442')).toBe('#000000');   // Okabe–Ito yellow
        expect(contrastText('#0072b2')).toBe('#ffffff');   // Okabe–Ito blue
        expect(contrastText('#5b9bd5')).toBe('#ffffff');   // mid blue, L ≈ 0.31
    });
});
