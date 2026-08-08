import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial, Color3 } from '@babylonjs/core';
import { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import { configureBackdropMaterial } from './minimap.js';

// PLAN-maps M8e: the minimap backdrop rendered ~2.6x too dark — 26.76 mean
// luminance on `scorched_crossing_v2.4` against an asset that decodes to 69.94
// (minimap.png through a 2D canvas) / 70.29 (minimap.ktx2 transcoded to the
// same ASTC 4x4 the browser uses). It was first written up as a missing sRGB
// encode; it is not. The texture was bound as BOTH `diffuseTexture` and
// `emissiveTexture`, and StandardMaterial's unlit reduction multiplies the
// emissive term by the diffuse base, so the quad rendered texel², whose curve
// is near enough to x^2.2 to pass for a gamma decode.
//
// These tests pin the reduction itself rather than the slot assignment, so any
// future re-binding that squares (or halves, or saturates) the backdrop fails
// here with the number it would have shipped.

/**
 * The compiled `default.fragment` reduction for an unlit StandardMaterial,
 * transcribed from the effect this scene actually compiles (read back live via
 * `mat.getEffect()._fragmentSourceCode`):
 *
 *     vec3 emissiveColor = vEmissiveColor;
 *     emissiveColor += texture(emissiveSampler, ...).rgb * vEmissiveInfos.y;
 *     vec3 finalDiffuse = clamp(diffuseBase*diffuseColor + emissiveColor + vAmbientColor, 0.0, 1.0)
 *                       * baseColor.rgb;
 *
 * `diffuseBase` is 0 with no lights (the minimap scene has none and every
 * material sets `disableLighting`), and `baseColor` is (1,1,1) when no diffuse
 * texture is bound.
 */
function renderUnlit(mat: StandardMaterial, texel: number,
                     diffuseTexBound: boolean, emissiveTexBound: boolean): number {
    const emissive = mat.emissiveColor.r + (emissiveTexBound ? texel : 0);
    const base = diffuseTexBound ? texel : 1;
    const ambient = mat.ambientColor.r;
    return Math.min(1, Math.max(0, emissive + ambient)) * base;
}

function make() {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mat = new StandardMaterial('minimapMat', scene);
    const tex = new BaseTexture(scene);
    configureBackdropMaterial(mat, tex);
    return { mat, tex, scene };
}

describe('minimap backdrop material', () => {
    it('binds the thumbnail exactly once, as the diffuse slot', () => {
        const { mat, tex } = make();
        expect(mat.diffuseTexture).toBe(tex);
        expect(mat.emissiveTexture).toBeNull();
    });

    it('renders the texel unchanged — not squared', () => {
        const { mat } = make();
        // 0.277 is the measured mean of the scorched_crossing thumbnail
        // (70.6/255); 0.5 and 0.1 bracket it.
        for (const texel of [0.1, 0.277, 0.5, 1.0]) {
            expect(renderUnlit(mat, texel, true, false)).toBeCloseTo(texel, 6);
        }
    });

    it('positive control: the old both-slots binding squares the texel', () => {
        const { mat, tex } = make();
        // Exactly what `loadBackground` used to do.
        mat.emissiveTexture = tex;
        mat.emissiveColor = new Color3(0, 0, 0);
        expect(renderUnlit(mat, 0.277, true, true)).toBeCloseTo(0.277 * 0.277, 6);
        // …i.e. 0.0767, which at 255 is the 19.6 that put the frame at 26.76.
        expect(renderUnlit(mat, 0.277, true, true)).toBeLessThan(0.277 / 2);
    });

    it('keeps the quad unlit — the minimap scene ships no lights', () => {
        const { mat } = make();
        expect(mat.disableLighting).toBe(true);
        // With lighting on and no light in the scene the reduction above would
        // collapse to black, not to the texture.
        expect(mat.emissiveColor.equals(new Color3(1, 1, 1))).toBe(true);
    });

    it('adds no ambient term that would lift the blacks', () => {
        const { mat } = make();
        expect(mat.ambientColor.equals(Color3.Black())).toBe(true);
        expect(renderUnlit(mat, 0, true, false)).toBe(0);
    });

    it('reconfigures an already-built material', () => {
        const { mat, scene } = make();
        // Simulate the regression sneaking back in on a reload path.
        const tex2 = new BaseTexture(scene);
        mat.emissiveTexture = tex2;
        mat.emissiveColor = Color3.Black();
        configureBackdropMaterial(mat, tex2);
        expect(mat.emissiveTexture).toBeNull();
        expect(renderUnlit(mat, 0.277, true, false)).toBeCloseTo(0.277, 6);
    });
});
