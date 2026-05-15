import { describe, it, expect, vi } from 'vitest';
import { parseExpr, parseVec3Expr, constExpr, parseAtlasDims } from './ceg-translator';

const ctx = (damage: number) => ({ damage });

describe('parseExpr', () => {
    it('parses bare numbers', () => {
        expect(parseExpr('42')!(ctx(0))).toBe(42);
        expect(parseExpr('-3.5')!(ctx(0))).toBe(-3.5);
    });

    it('strips Lua long-string wrapper', () => {
        expect(parseExpr('[[42]]')!(ctx(0))).toBe(42);
    });

    it('evaluates damage-scaled int (i<n>)', () => {
        // i1 = floor(damage * 1 / 1024)
        expect(parseExpr('i1')!(ctx(1024))).toBe(1);
        expect(parseExpr('i1')!(ctx(2048))).toBe(2);
        expect(parseExpr('i1')!(ctx(500))).toBe(0);
    });

    it('evaluates damage-linear (d<n>)', () => {
        // d0.5 = damage * 0.5
        expect(parseExpr('d0.5')!(ctx(100))).toBe(50);
        expect(parseExpr('d2')!(ctx(50))).toBe(100);
    });

    it('evaluates random magnitudes (r<n>) with Math.random captured', () => {
        const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(parseExpr('r10')!(ctx(0))).toBe(5);
        expect(parseExpr('r60')!(ctx(0))).toBe(30);
        spy.mockRestore();
    });

    it('evaluates signed-random (~n) symmetric around 0', () => {
        const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
        // (rng() * 2 - 1) * n = (1 - 1) * n = 0 at rng=0.5
        expect(parseExpr('~3')!(ctx(0))).toBe(0);
        spy.mockReturnValue(0);
        expect(parseExpr('~3')!(ctx(0))).toBe(-3);
        spy.mockReturnValue(1);
        expect(parseExpr('~3')!(ctx(0))).toBe(3);
        spy.mockRestore();
    });

    it('sums compound expressions', () => {
        // "0 i1" → 0 + floor(damage / 1024)
        expect(parseExpr('0 i1')!(ctx(2048))).toBe(2);
        // "24 i8" → 24 + floor(damage * 8 / 1024) = 24 + damage/128
        expect(parseExpr('24 i8')!(ctx(1024))).toBe(24 + 8);
    });

    it('handles signed token prefixes', () => {
        expect(parseExpr('-5')!(ctx(0))).toBe(-5);
        expect(parseExpr('+3')!(ctx(0))).toBe(3);
    });

    it('returns null for empty/unparsable input', () => {
        expect(parseExpr('')).toBeNull();
        expect(parseExpr('   ')).toBeNull();
        // Commas in scalar context are a soft error → null.
        expect(parseExpr('1,2,3')).toBeNull();
    });
});

describe('parseVec3Expr', () => {
    it('splits comma-separated vec3', () => {
        const [x, y, z] = parseVec3Expr('1, 2, 3', 0, 0, 0);
        expect(x(ctx(0))).toBe(1);
        expect(y(ctx(0))).toBe(2);
        expect(z(ctx(0))).toBe(3);
    });

    it('splits space-separated vec3', () => {
        const [x, y, z] = parseVec3Expr('1 2 3', 0, 0, 0);
        expect(x(ctx(0))).toBe(1);
        expect(y(ctx(0))).toBe(2);
        expect(z(ctx(0))).toBe(3);
    });

    it('handles compound per-component with commas', () => {
        // pos = "0, 24 i8, 0" with damage 1024 → y = 24 + 8 = 32
        const [x, y, z] = parseVec3Expr('0, 24 i8, 0', 0, 0, 0);
        expect(x(ctx(1024))).toBe(0);
        expect(y(ctx(1024))).toBe(32);
        expect(z(ctx(1024))).toBe(0);
    });

    it('falls back to defaults for missing components', () => {
        const [x, y, z] = parseVec3Expr('1', 9, 8, 7);
        expect(x(ctx(0))).toBe(1);
        expect(y(ctx(0))).toBe(8);
        expect(z(ctx(0))).toBe(7);
    });
});

describe('constExpr', () => {
    it('returns the captured constant regardless of context', () => {
        const e = constExpr(42);
        expect(e(ctx(0))).toBe(42);
        expect(e(ctx(9999))).toBe(42);
    });
});

describe('parseAtlasDims', () => {
    it('parses the _NxM suffix into cols/rows', () => {
        expect(parseAtlasDims('FireBall02_8x8')).toEqual({ cols: 8, rows: 8 });
        expect(parseAtlasDims('smokepuff_4x2')).toEqual({ cols: 4, rows: 2 });
    });

    it('accepts capital X separator', () => {
        expect(parseAtlasDims('sprite_3X5')).toEqual({ cols: 3, rows: 5 });
    });

    it('returns null for plain names', () => {
        expect(parseAtlasDims('flare')).toBeNull();
        expect(parseAtlasDims('smoketrail')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(parseAtlasDims('')).toBeNull();
    });

    it('rejects absurd dimensions', () => {
        // Common false positive: hex-encoded names that look dimension-like.
        expect(parseAtlasDims('abcdef_999x999')).toBeNull();
    });

    it('requires the suffix at end of string', () => {
        // Mid-string dimension is not the trailing token; rejected.
        expect(parseAtlasDims('foo_8x8_bar')).toBeNull();
    });
});
