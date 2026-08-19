import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial, Color3 } from '@babylonjs/core';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { configureFogMaterial } from './minimap.js';

// A DynamicTexture would be the real type, but its constructor reaches for
// OffscreenCanvas, which node has not got. Nothing under test touches the
// canvas — only the material's colour inputs and which slot the bitmap is
// bound to — so a bare BaseTexture stands in.

// PLAN-endtoend D48 (minimap half): the minimap rendered as a near-white void
// with the unit blips painted on top. The backdrop was never at fault —
// `minimap.ktx2` decodes correctly and, with the overlay hidden, the map drew
// at mean luminance 26.8 — the fog-of-war overlay was painting the white, on
// its own, over a fully-explored-or-not map (measured: overlay alone 227.1
// with 85.5 % of pixels >= 240).
//
// (That 26.8 was itself wrong, by a second and unrelated defect in the backdrop
// material — see minimap-backdrop.test.ts, PLAN-maps M8e. It reads 69.7 now.)
//
// The cause was `emissiveColor = (1,1,1)` chosen as a "neutral" multiplicand
// for a black bitmap. StandardMaterial's emissive texture is ADDITIVE
// (`emissiveColor += texture(...).rgb`), so (1,1,1) saturates the output white
// whatever the texture holds. These tests pin the invariant that survives
// either contract: no colour input to the overlay may be non-black, and the
// bitmap must reach it only through alpha.

function make() {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mat = new StandardMaterial('minimapFogMat', scene);
    const tex = new BaseTexture(scene);
    tex.hasAlpha = true;
    configureFogMaterial(mat, tex);
    return { mat, tex, scene };
}

describe('minimap fog-of-war overlay material', () => {
    it('drives the overlay from the bitmap alpha only', () => {
        const { mat, tex } = make();
        expect(mat.opacityTexture).toBe(tex);
        // Babylon reads opacity from .a unless getAlphaFromRGB is set; the
        // bitmap's RGB is a constant 0, so an RGB read would be all-or-nothing.
        expect(tex.getAlphaFromRGB).toBe(false);
    });

    it('leaves every colour input black, so the tint can only darken', () => {
        const { mat } = make();
        expect(mat.diffuseColor.equals(Color3.Black())).toBe(true);
        expect(mat.emissiveColor.equals(Color3.Black())).toBe(true);
        expect(mat.ambientColor.equals(Color3.Black())).toBe(true);
    });

    it('binds no emissive texture — its RGB is 0 and the sampler is additive', () => {
        const { mat } = make();
        expect(mat.emissiveTexture).toBeNull();
    });

    it('blends rather than drawing opaque over the backdrop', () => {
        const { mat } = make();
        expect(mat.needAlphaBlending()).toBe(true);
    });

    it('reconfigures an already-built material (the texture-realloc path)', () => {
        const { mat, scene } = make();
        // Simulate the regression sneaking back in on the reuse branch.
        mat.emissiveColor = new Color3(1, 1, 1);
        const tex2 = new BaseTexture(scene);
        configureFogMaterial(mat, tex2);
        expect(mat.emissiveColor.equals(Color3.Black())).toBe(true);
        expect(mat.opacityTexture).toBe(tex2);
    });
});
