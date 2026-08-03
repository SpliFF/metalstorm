import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import { DitherFadePlugin, DITHER_PATTERN_MAX } from './dither-fade-plugin.js';

// The dither behaviour itself (screen-door discard) needs a real GL context to
// observe; here we assert the wiring that a live run then relies on — the
// per-instance `ditherFade` attribute is declared and the fragment stage
// carries the discard, so a pool that uploads a `ditherFade` buffer really
// fades. The attribute mode is what the squad member LOD crossfade uses (M5):
// EntityRenderer's member material takes the plain pattern and the impostor
// sprite material takes the inverted half, so the two tiers interleave.

describe('DitherFadePlugin', () => {
    function make(opts: { attribute?: boolean; invert?: boolean } = {}) {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const mat = new StandardMaterial('m', scene);
        const plugin = new DitherFadePlugin(mat);
        plugin.useAttribute = opts.attribute ?? true;
        plugin.invertPattern = opts.invert ?? false;
        plugin.isEnabled = true;
        return plugin;
    }

    it('registers the per-instance `ditherFade` vertex attribute', () => {
        const attrs: string[] = [];
        make().getAttributes(attrs);
        expect(attrs).toContain('ditherFade');
    });

    it('declares no attribute in uniform mode', () => {
        const attrs: string[] = [];
        make({ attribute: false }).getAttributes(attrs);
        expect(attrs).not.toContain('ditherFade');
    });

    it('enables its defines and injects a vertex→fragment fade varying', () => {
        const plugin = make();
        const defines: Record<string, boolean> = {
            DITHER_FADE: false, DITHER_FADE_ATTR: false,
        };
        plugin.prepareDefines(defines);
        expect(defines.DITHER_FADE).toBe(true);
        expect(defines.DITHER_FADE_ATTR).toBe(true);

        const vtx = plugin.getCustomCode('vertex')!;
        expect(vtx.CUSTOM_VERTEX_DEFINITIONS).toContain('attribute float ditherFade');
        expect(vtx.CUSTOM_VERTEX_DEFINITIONS).toContain('varying float vDitherFade');
        expect(vtx.CUSTOM_VERTEX_UPDATE_POSITION).toContain('vDitherFade = ditherFade');
    });

    it('leaves the attribute define off in uniform mode', () => {
        const defines: Record<string, boolean> = {
            DITHER_FADE: false, DITHER_FADE_ATTR: false,
        };
        make({ attribute: false }).prepareDefines(defines);
        expect(defines.DITHER_FADE).toBe(true);
        expect(defines.DITHER_FADE_ATTR).toBe(false);
    });

    it('is fully off until enabled, so a stock material is untouched', () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const plugin = new DitherFadePlugin(new StandardMaterial('m', scene));
        const defines: Record<string, boolean> = {
            DITHER_FADE: true, DITHER_FADE_ATTR: true,
        };
        plugin.prepareDefines(defines);
        expect(defines.DITHER_FADE).toBe(false);
        expect(defines.DITHER_FADE_ATTR).toBe(false);
    });

    it('discards fragments below the per-instance fade in the fragment stage', () => {
        const frag = make().getCustomCode('fragment')!;
        expect(frag.CUSTOM_FRAGMENT_DEFINITIONS).toContain('varying float vDitherFade');
        expect(frag.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('discard');
        // 4×4 Bayer ordered-dither threshold keyed on screen position.
        expect(frag.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('gl_FragCoord');
    });

    it('offers a complementary pattern polarity for the opposite LOD tier', () => {
        // The two crossfading tiers must not both keep the same low-threshold
        // pixels, or the band shows double-drawn members. Inverting one side
        // mirrors the pattern about its max so the kept sets are disjoint.
        const frag = make({ invert: true }).getCustomCode('fragment')!;
        expect(frag.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('uDitherInvert');
        expect(frag.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain(DITHER_PATTERN_MAX.toFixed(4));
    });

    it('tops the pattern out below 1 so fade = 1 never discards', () => {
        // `_dfPattern >= _dfFade` with a pattern that can reach 1.0 would punch
        // holes in a fully-opaque member.
        expect(DITHER_PATTERN_MAX).toBeLessThan(1);
    });

    it('has no custom code for other shader stages', () => {
        expect(make().getCustomCode('compute')).toBeNull();
    });
});
