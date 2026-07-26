import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import { DitherFadePlugin } from './dither-fade-plugin.js';

// The dither behaviour itself (screen-door discard) needs a real GL context to
// observe; here we assert the wiring that a live run then relies on — the
// per-instance `fade` attribute is declared and the fragment stage carries the
// discard, so a pool that uploads a `fade` buffer will actually fade.

describe('DitherFadePlugin', () => {
    function make() {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const mat = new StandardMaterial('m', scene);
        return new DitherFadePlugin(mat);
    }

    it('registers the per-instance `fade` vertex attribute', () => {
        const attrs: string[] = [];
        make().getAttributes(attrs);
        expect(attrs).toContain('fade');
    });

    it('enables its define and injects a vertex→fragment fade varying', () => {
        const plugin = make();
        const defines: Record<string, boolean> = { DITHER_FADE: false };
        plugin.prepareDefines(defines);
        expect(defines.DITHER_FADE).toBe(true);

        const vtx = plugin.getCustomCode('vertex')!;
        expect(vtx.CUSTOM_VERTEX_DEFINITIONS).toContain('attribute float fade');
        expect(vtx.CUSTOM_VERTEX_DEFINITIONS).toContain('varying float vFade');
        expect(vtx.CUSTOM_VERTEX_MAIN_END).toContain('vFade = fade');
    });

    it('discards fragments below the per-instance fade in the fragment stage', () => {
        const frag = make().getCustomCode('fragment')!;
        expect(frag.CUSTOM_FRAGMENT_DEFINITIONS).toContain('varying float vFade');
        expect(frag.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('discard');
        // 4×4 Bayer ordered-dither threshold keyed on screen position.
        expect(frag.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('gl_FragCoord');
    });

    it('has no custom code for other shader stages', () => {
        expect(make().getCustomCode('compute')).toBeNull();
    });
});
