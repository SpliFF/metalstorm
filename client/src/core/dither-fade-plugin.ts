/**
 * DitherFadePlugin — screen-door (ordered-dither) opacity fade driven by a
 * per-instance `fade` attribute (1 = fully opaque, 0 = fully gone), for the
 * squad-member LOD crossfade (PLAN-metalstorm-impostors.md M5, §2.1 "no pop"
 * gate).
 *
 * Across the model↔impostor boundary a member is drawn in BOTH tiers over a
 * distance band: the 3D body fades out (fade 1→0) as the baked sprite fades in
 * (fade 0→1). A 4×4 Bayer ordered-dither threshold — sampled from screen
 * position, `gl_FragCoord` — discards fragments so the two tiers interleave
 * per-pixel. That gives a smooth crossfade with:
 *  - no double-brightness (each screen pixel shows exactly one tier), and
 *  - no depth-sort / alpha-blend artefacts — both materials stay alpha-test /
 *    opaque and keep writing depth (the sprite path deliberately avoids
 *    blending; see createImpostorMaterial). Screen-door is the standard LOD
 *    dissolve technique for exactly this reason.
 *
 * Applied to the impostor-sprite material (createImpostorMaterial `withFade`)
 * AND to a DEDICATED member-model material (EntityRenderer.getMemberModel) —
 * NEVER the shared full-unit material: full units set no `fade` thin-instance
 * attribute, so the default generic-attribute value (0) would read fade=0 and
 * discard every full unit. The renderers therefore always upload a `fade`
 * buffer (default 1.0) on any pool whose mesh carries this plugin.
 *
 * At fade=1 the threshold compare (`fade < threshold`, threshold ∈ (0,1))
 * never discards, so a member sitting fully in one tier renders unchanged —
 * the plugin is a no-op outside the transition band.
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefines = any;

export class DitherFadePlugin extends MaterialPluginBase {
    constructor(material: Material) {
        // priority 90: after ImpostorUv (95) / TeamColor (100); the injections
        // don't overlap, so ordering is cosmetic.
        super(material, 'DitherFade', 90, { DITHER_FADE: false });
        this._enable(true);
    }

    prepareDefines(defines: AnyDefines): void {
        defines.DITHER_FADE = true;
    }

    getClassName(): string { return 'DitherFadePlugin'; }

    getAttributes(attributes: string[]): void {
        // Per-instance fade selector, uploaded via thinInstanceSetBuffer('fade', …, 1).
        attributes.push('fade');
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType === 'vertex') {
            return {
                CUSTOM_VERTEX_DEFINITIONS: `#ifdef DITHER_FADE
                    attribute float fade;
                    varying float vFade;
                #endif`,
                CUSTOM_VERTEX_MAIN_END: `#ifdef DITHER_FADE
                    vFade = fade;
                #endif`,
            };
        }
        if (shaderType === 'fragment') {
            return {
                CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef DITHER_FADE
                    varying float vFade;
                #endif`,
                // Early screen-door discard: compare the per-instance fade to a
                // 4×4 Bayer threshold keyed on screen position. threshold =
                // (bayer+0.5)/16 ∈ (0.03,0.97) so fade=1 keeps every pixel and
                // fade=0 discards every pixel. WebGL2 (GLSL ES 3.0) — local
                // const array with a dynamic index is allowed.
                CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef DITHER_FADE
                    if (vFade < 0.999) {
                        float _bayer[16];
                        _bayer[0]=0.0;  _bayer[1]=8.0;  _bayer[2]=2.0;  _bayer[3]=10.0;
                        _bayer[4]=12.0; _bayer[5]=4.0;  _bayer[6]=14.0; _bayer[7]=6.0;
                        _bayer[8]=3.0;  _bayer[9]=11.0; _bayer[10]=1.0; _bayer[11]=9.0;
                        _bayer[12]=15.0;_bayer[13]=7.0; _bayer[14]=13.0;_bayer[15]=5.0;
                        int _bx = int(mod(gl_FragCoord.x, 4.0));
                        int _by = int(mod(gl_FragCoord.y, 4.0));
                        float _thr = (_bayer[_bx + _by * 4] + 0.5) / 16.0;
                        if (vFade < _thr) discard;
                    }
                #endif`,
            };
        }
        return null;
    }
}
