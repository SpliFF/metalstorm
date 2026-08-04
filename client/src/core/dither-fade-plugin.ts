/**
 * DitherFadePlugin — screen-door (ordered-dither) crossfade for LOD tier
 * swaps, injected into any stock Babylon material (Standard or PBR).
 *
 * A hard pop when a 2 km-wide tile of trees swaps from full mesh to impostor
 * card is very visible; alpha blending it is not an option (the foliage is
 * alpha-TESTED, and blending 30k overlapping quads means depth sorting). The
 * standard fix is a screen-door fade: discard a Bayer-patterned subset of
 * fragments, growing/shrinking the surviving subset over the crossfade. The
 * material stays opaque, so no sorting, no blend state, no depth writes lost.
 *
 * Two fade sources:
 *  - UNIFORM (`useAttribute = false`) — one fade for the whole material.
 *  - PER-INSTANCE ATTRIBUTE (`useAttribute = true`) — a `ditherFade` float
 *    thin-instance buffer. This is what the feature-LOD path uses: every tile
 *    of a feature type shares ONE material (so one draw state, one UBO) while
 *    each tile crossfades independently, and a tier flip costs a
 *    1-float-per-instance buffer update instead of a material clone.
 *
 * `invertPattern` samples the complementary half of the pattern. Point the
 * outgoing tier's material at one polarity and the incoming tier's at the
 * other and the two halves are exactly complementary through the crossfade —
 * no double-drawn pixels, no holes to the terrain.
 *
 * NOTE: when `useAttribute` is on, EVERY mesh drawn with this material must
 * bind a `ditherFade` buffer. An unbound float attribute reads 0, which means
 * "discard everything" — the mesh silently disappears.
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefines = any;

/** The 4x4 Bayer chain tops out just below 1, so fade = 1 never discards. */
export const DITHER_PATTERN_MAX = 0.9375;

export class DitherFadePlugin extends MaterialPluginBase {
    private _enabled = false;
    private _useAttribute = false;

    /** Uniform-mode fade, 0 (fully dissolved) .. 1 (fully solid). */
    fade = 1;
    /** Sample the complementary half of the dither pattern. */
    invertPattern = false;

    constructor(material: Material) {
        // priority 120: after TeamColor (100) — this only discards, so it does
        // not matter what shades the surviving fragments, but keeping it late
        // means the discard is decided against the final defines set.
        super(material, 'DitherFade', 120, { DITHER_FADE: false, DITHER_FADE_ATTR: false });
    }

    get isEnabled(): boolean { return this._enabled; }
    set isEnabled(v: boolean) {
        if (this._enabled === v) return;
        this._enabled = v;
        this.markAllDefinesAsDirty();
        this._enable(v);
    }

    /** Read the fade from a per-thin-instance `ditherFade` attribute instead
     *  of the material uniform. Changing this recompiles the effect. */
    get useAttribute(): boolean { return this._useAttribute; }
    set useAttribute(v: boolean) {
        if (this._useAttribute === v) return;
        this._useAttribute = v;
        this.markAllDefinesAsDirty();
    }

    getClassName(): string { return 'DitherFadePlugin'; }

    prepareDefines(defines: AnyDefines): void {
        defines.DITHER_FADE = this._enabled;
        defines.DITHER_FADE_ATTR = this._enabled && this._useAttribute;
    }

    getAttributes(attributes: string[]): void {
        if (this._enabled && this._useAttribute) attributes.push('ditherFade');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; vertex: string; fragment: string } {
        return {
            ubo: [
                { name: 'uDitherFade', size: 1, type: 'float' },
                { name: 'uDitherInvert', size: 1, type: 'float' },
            ],
            vertex: `#ifdef DITHER_FADE
                uniform float uDitherFade;
                uniform float uDitherInvert;
            #endif`,
            fragment: `#ifdef DITHER_FADE
                uniform float uDitherFade;
                uniform float uDitherInvert;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        uniformBuffer.updateFloat('uDitherFade', this.fade);
        uniformBuffer.updateFloat('uDitherInvert', this.invertPattern ? 1.0 : 0.0);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType === 'vertex') {
            return {
                CUSTOM_VERTEX_DEFINITIONS: `#ifdef DITHER_FADE_ATTR
                    attribute float ditherFade;
                    varying float vDitherFade;
                #endif`,
                CUSTOM_VERTEX_UPDATE_POSITION: `#ifdef DITHER_FADE_ATTR
                    vDitherFade = ditherFade;
                #endif`,
            };
        }
        if (shaderType !== 'fragment') return null;
        return {
            // Classic 2x2 -> 4x4 Bayer chain. Written arithmetically rather
            // than as a const array so it compiles under GLSL ES 1.0 too
            // (dynamic indexing of const arrays is not portable there).
            CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef DITHER_FADE
                #ifdef DITHER_FADE_ATTR
                    varying float vDitherFade;
                #endif
                float _dfBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
                float _dfBayer4(vec2 a) { return _dfBayer2(0.5 * a) * 0.25 + _dfBayer2(a); }
            #endif`,
            CUSTOM_FRAGMENT_MAIN_BEGIN: `#ifdef DITHER_FADE
                float _dfFade = uDitherFade;
                #ifdef DITHER_FADE_ATTR
                    _dfFade = vDitherFade;
                #endif
                float _dfPattern = _dfBayer4(gl_FragCoord.xy);
                if (uDitherInvert > 0.5) _dfPattern = ${DITHER_PATTERN_MAX.toFixed(4)} - _dfPattern;
                if (_dfPattern >= _dfFade) discard;
            #endif`,
        };
    }
}
