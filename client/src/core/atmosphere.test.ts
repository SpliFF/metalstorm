import { describe, it, expect } from 'vitest';
import {
    deriveSkyParams, deriveFogDensity, deriveFogColor, deriveLinearFog,
    FOG_VIEW_RANGE_ELMOS,
} from './atmosphere.js';
import { defaultMapAtmosphere, type MapAtmosphere } from './map-lighting.js';

function atmo(overrides: Partial<MapAtmosphere> = {}): MapAtmosphere {
    return { ...defaultMapAtmosphere(), ...overrides };
}

describe('deriveSkyParams', () => {
    it('is bright and clear at high sun elevation', () => {
        const { luminance, turbidity } = deriveSkyParams(1.0);
        expect(luminance).toBeCloseTo(1.0, 5);
        expect(turbidity).toBeCloseTo(2.0, 5);
    });

    it('is dim and hazy at/below the horizon', () => {
        const horizon = deriveSkyParams(0);
        const below = deriveSkyParams(-1);
        expect(horizon.luminance).toBeGreaterThan(below.luminance);
        expect(horizon.turbidity).toBeLessThan(below.turbidity);
        // Below-horizon clamps rather than going negative/out of Babylon's
        // documented ]0,1[ luminance range.
        expect(below.luminance).toBeGreaterThanOrEqual(0.35);
        expect(below.turbidity).toBeLessThanOrEqual(10);
    });

    it('increases monotonically with elevation', () => {
        const lo = deriveSkyParams(-0.5);
        const mid = deriveSkyParams(0.2);
        const hi = deriveSkyParams(0.9);
        expect(lo.luminance).toBeLessThan(mid.luminance);
        expect(mid.luminance).toBeLessThan(hi.luminance);
        expect(lo.turbidity).toBeGreaterThan(mid.turbidity);
        expect(mid.turbidity).toBeGreaterThan(hi.turbidity);
    });
});

describe('deriveFogDensity', () => {
    it('gives a smaller density for a farther fogEnd (less fog per elmo)', () => {
        const near = deriveFogDensity(atmo({ fogEnd: 0.2 }));
        const far = deriveFogDensity(atmo({ fogEnd: 1.0 }));
        expect(far).toBeLessThan(near);
    });

    it('reaches ~1% transmittance at the authored fogEnd distance', () => {
        const a = atmo({ fogEnd: 0.5 });
        const density = deriveFogDensity(a);
        const dist = a.fogEnd * FOG_VIEW_RANGE_ELMOS;
        const transmittance = Math.exp(-((density * dist) ** 2));
        expect(transmittance).toBeCloseTo(0.01, 3);
    });

    it('never divides by zero for fogEnd = 0', () => {
        expect(Number.isFinite(deriveFogDensity(atmo({ fogEnd: 0 })))).toBe(true);
    });
});

describe('deriveLinearFog', () => {
    it('scales start/end by the authored fractions', () => {
        const { start, end } = deriveLinearFog(atmo({ fogStart: 0.1, fogEnd: 0.5 }), 1000);
        expect(start).toBeCloseTo(100, 5);
        expect(end).toBeCloseTo(500, 5);
    });
});

describe('deriveFogColor', () => {
    it('desaturates the authored skyColor toward its own average', () => {
        const color = deriveFogColor(atmo({ skyColor: [0.1, 0.15, 0.7] }));
        const avg = (0.1 + 0.15 + 0.7) / 3;
        // 30% of the way from the raw colour to neutral grey.
        expect(color.r).toBeCloseTo(0.1 + (avg - 0.1) * 0.3, 5);
        expect(color.g).toBeCloseTo(0.15 + (avg - 0.15) * 0.3, 5);
        expect(color.b).toBeCloseTo(0.7 + (avg - 0.7) * 0.3, 5);
    });

    it('leaves an already-neutral colour unchanged', () => {
        const color = deriveFogColor(atmo({ skyColor: [0.5, 0.5, 0.5] }));
        expect(color.r).toBeCloseTo(0.5, 5);
        expect(color.g).toBeCloseTo(0.5, 5);
        expect(color.b).toBeCloseTo(0.5, 5);
    });
});
