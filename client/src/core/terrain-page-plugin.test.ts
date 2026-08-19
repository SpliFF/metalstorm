import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import type { BaseTexture } from '@babylonjs/core';
import {
    TerrainPageSamplePlugin, attachTerrainPageSample,
} from './terrain-page-plugin.js';

// The sampling itself needs a real GL context to observe; asserted here is
// the wiring a live run depends on — the define toggles with `isEnabled`
// (NOT `enabled`: M8i lost an A/B to a dead expando), the attach helper
// verifies the setter took, the shader declares both samplers it reads, and
// the fragment body implements the §1.2.1 contract: table tap → two array
// taps → mix by fade, leaving baseColor alone when nothing is resident.

describe('TerrainPageSamplePlugin', () => {
    function make(): { plugin: TerrainPageSamplePlugin; mat: StandardMaterial } {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const mat = new StandardMaterial('m', scene);
        return { plugin: new TerrainPageSamplePlugin(mat), mat };
    }
    const tex = (name: string): BaseTexture =>
        ({ name } as unknown as BaseTexture);
    const defines = (plugin: TerrainPageSamplePlugin): Record<string, boolean> => {
        const d = { TERRAIN_PAGE_SAMPLE: false };
        plugin.prepareDefines(d);
        return d;
    };

    it('defaults to disabled with the define clear', () => {
        const { plugin } = make();
        expect(plugin.isEnabled).toBe(false);
        expect(defines(plugin)).toEqual({ TERRAIN_PAGE_SAMPLE: false });
    });

    it('sets the define through isEnabled, both directions', () => {
        const { plugin } = make();
        plugin.isEnabled = true;
        expect(defines(plugin)).toEqual({ TERRAIN_PAGE_SAMPLE: true });
        plugin.isEnabled = false;
        expect(defines(plugin)).toEqual({ TERRAIN_PAGE_SAMPLE: false });
    });

    it('declares both samplers the shader reads', () => {
        const samplers: string[] = [];
        make().plugin.getSamplers(samplers);
        expect(samplers).toContain('terrainPageAtlas');
        expect(samplers).toContain('terrainPageTable');
    });

    it('runs BEFORE the splat plugin (albedo replacement precedes detail)', () => {
        const { plugin } = make();
        expect(plugin.priority).toBeLessThan(190);
    });

    it('guards the fragment body behind the define and implements the '
        + 'two-tap mix', () => {
        const code = make().plugin.getCustomCode('fragment');
        expect(code).not.toBeNull();
        const defs = code!.CUSTOM_FRAGMENT_DEFINITIONS;
        const body = code!.CUSTOM_FRAGMENT_BEFORE_LIGHTS;
        expect(defs).toContain('#ifdef TERRAIN_PAGE_SAMPLE');
        expect(defs).toContain('sampler2DArray terrainPageAtlas');
        expect(defs).toContain('sampler2D terrainPageTable');
        expect(body).toContain('#ifdef TERRAIN_PAGE_SAMPLE');
        expect(body).toContain('texelFetch(terrainPageTable');
        // The cross-fade: mix(fallback, primary, fade-from-the-table).
        expect(body).toContain('mix(_tpFbCol, _tpPrimCol, _tpPrim.a)');
        // Level 255 = nothing resident — baseColor must be left alone.
        expect(body).toContain('_tpPrimLevel < 255.0');
        expect(code!.CUSTOM_FRAGMENT_VERTEX ?? null).toBeNull();
        expect(make().plugin.getCustomCode('vertex')).toBeNull();
    });

    it('remaps payload UV past the 4-texel border in the shared helper', () => {
        const defs = make().plugin.getCustomCode('fragment')!
            .CUSTOM_FRAGMENT_DEFINITIONS;
        expect(defs).toContain('vec2(4.0)');
        expect(defs).toContain('512.0');
        expect(defs).toContain('520.0');
        expect(defs).toContain('exp2(-level)');
    });

    it('attachTerrainPageSample enables and configures, and would throw on a '
        + 'setter that did not take', () => {
        const { mat } = make();
        const plugin = attachTerrainPageSample(mat, tex('atlas'), tex('table'), {
            baseScaleU: 32, baseScaleV: 32, pagesX0: 32, pagesZ0: 32,
            worldW: 16384, worldH: 16384,
        });
        expect(plugin.isEnabled).toBe(true);
        expect(plugin.atlasTexture).toEqual(tex('atlas'));
        expect(plugin.geometry.pagesX0).toBe(32);
        expect(defines(plugin)).toEqual({ TERRAIN_PAGE_SAMPLE: true });
    });
});
