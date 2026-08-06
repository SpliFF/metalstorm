/**
 * Render-sanity classifier tests.
 *
 * The numbers in `healthy()` / the dark-scene case are measured, not
 * invented — see the reference table in render-sanity.ts. The point of
 * the dark-scene test in particular is that this gate must NOT fire on a
 * legitimately dim game (`lighting = 'realistic'`), only on one that drew
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import {
    evaluateRenderSanity, RENDER_SANITY_LIMITS, type RenderSample,
} from './render-sanity.js';

function healthy(over: Partial<RenderSample> = {}): RenderSample {
    return {
        renderFramesAdvanced: 24,
        sampleWindowMs: 400,
        meshCount: 62,
        terrainMeshCount: 40,
        luminance: { min: 4, max: 100, mean: 45 },
        ...over,
    };
}

describe('evaluateRenderSanity', () => {
    it('passes a normally-lit scene', () => {
        const v = evaluateRenderSanity(healthy());
        expect(v.ok).toBe(true);
        expect(v.reason).toBe('ok');
    });

    it('passes a dark-but-rendered scene (realistic lighting + full fog)', () => {
        // The actual "black map" frame, measured on green_flat_x34_v3
        // under ZK (`lighting = 'realistic'`, 20% ambient) with zero LOS
        // (fog at the 0.72 unscouted darkening). 2% mean luminance —
        // indistinguishable from black to a human, 50 terrain meshes
        // present, nothing broken. This is the case the gate must NOT
        // fire on, and it is the tightest margin we have.
        const v = evaluateRenderSanity(healthy({
            luminance: { min: 1.8, max: 10.4, mean: 6.4 },
        }));
        expect(v.ok).toBe(true);
    });

    it('reports the sampling failure verbatim when the sample failed', () => {
        const v = evaluateRenderSanity(healthy({ error: 'window.__gp is not wired' }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('sample-failed');
        expect(v.detail).toContain('window.__gp is not wired');
    });

    it('fails a stalled render loop even when the last frame looks fine', () => {
        const v = evaluateRenderSanity(healthy({ renderFramesAdvanced: 0 }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('render-loop-stalled');
    });

    it('fails an empty scene', () => {
        const v = evaluateRenderSanity(healthy({ meshCount: 0, terrainMeshCount: 0 }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('empty-scene');
    });

    it('fails when the map built no terrain, and points at the map load', () => {
        // The real 2026-08-04 failure: metadata.json 404s, FX/HUD meshes
        // still exist, the world is empty.
        const v = evaluateRenderSanity(healthy({ meshCount: 12, terrainMeshCount: 0 }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('no-terrain');
        expect(v.detail).toContain('metadata.json');
    });

    it('fails a black viewport', () => {
        const v = evaluateRenderSanity(healthy({
            luminance: { min: 0, max: 0, mean: 0 },
        }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('black-viewport');
    });

    it('fails a flat non-black fill (clear colour only)', () => {
        const v = evaluateRenderSanity(healthy({
            luminance: { min: 19.5, max: 20.1, mean: 19.8 },
        }));
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('flat-viewport');
    });

    it('checks the render loop before the pixels, so the cause is upstream', () => {
        const v = evaluateRenderSanity(healthy({
            renderFramesAdvanced: 0,
            luminance: { min: 0, max: 0, mean: 0 },
        }));
        expect(v.reason).toBe('render-loop-stalled');
    });

    it('accepts a scene sitting exactly on the thresholds', () => {
        const v = evaluateRenderSanity(healthy({
            renderFramesAdvanced: RENDER_SANITY_LIMITS.minRenderFrames,
            luminance: {
                min: 0,
                max: Math.max(
                    RENDER_SANITY_LIMITS.minPeakLuminance,
                    RENDER_SANITY_LIMITS.minLuminanceSpread),
                mean: 3,
            },
        }));
        expect(v.ok).toBe(true);
    });

    it('always carries the raw numbers, pass or fail', () => {
        for (const s of [healthy(), healthy({ terrainMeshCount: 0 })]) {
            expect(evaluateRenderSanity(s).detail).toMatch(/meshes=\d+/);
        }
    });
});
