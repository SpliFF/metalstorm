import { describe, it, expect, vi, afterEach } from 'vitest';
import { NullEngine, Scene, Constants } from '@babylonjs/core';
import { chooseOverlayFormat } from './decal-overlay.js';
import { DecalOverlay } from './decal-overlay.js';

// PLAN-decal-tracks §3: the overlay RTTs move to float R11F_G11F_B10F
// (colour-renderable + additive-blendable under EXT_color_buffer_float) when
// available, giving a real raise channel; otherwise they fall back to RGBA8
// with depth packed R+A and no raise field. `chooseOverlayFormat` is the pure
// decision — tested directly here without a real GL context — and
// `DecalOverlay` wires it through + flags the fallback loudly.

describe('chooseOverlayFormat', () => {
    it('picks float R11F_G11F_B10F with a raise channel when EXT_color_buffer_float is available', () => {
        const choice = chooseOverlayFormat({ colorBufferFloat: true });
        expect(choice.hasRaise).toBe(true);
        expect(choice.type).toBe(Constants.TEXTURETYPE_UNSIGNED_INT_10F_11F_11F_REV);
        expect(choice.format).toBe(Constants.TEXTUREFORMAT_RGB);
    });

    it('falls back to RGBA8 with no raise channel when the extension is unavailable', () => {
        const choice = chooseOverlayFormat({ colorBufferFloat: false });
        expect(choice.hasRaise).toBe(false);
        expect(choice.type).toBe(Constants.TEXTURETYPE_UNSIGNED_BYTE);
        expect(choice.format).toBe(Constants.TEXTUREFORMAT_RGBA);
    });
});

describe('DecalOverlay format wiring (NullEngine — no colorBufferFloat)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('falls back loudly (console.warn) and reports no raise channel', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const overlay = new DecalOverlay(scene, 4096, 4096);

        expect(overlay.hasRaiseChannel).toBe(false);
        expect(overlay.fineState.hasRaise).toBe(0);
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls.flat())).toContain('EXT_color_buffer_float');

        overlay.dispose();
        scene.dispose();
        engine.dispose();
    });
});
