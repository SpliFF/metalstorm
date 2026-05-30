/**
 * DecalOverlayPlugin — injects the baked decal overlay (decal-overlay.ts) into
 * the terrain's Babylon StandardMaterial via the material-plugin API, so we
 * keep Babylon's sun + CSM shadow lighting (PLAN-lighting L1–L4) intact and
 * only perturb the normal + darken the albedo before the light loop.
 *
 * Camera-centered clipmap (PLAN-decal-vt.md V1): we sample TWO textures —
 *   - COARSE: the whole map at low res (`vPositionW.xz / decalWorldSize`),
 *   - FINE: a square window around the camera focus
 *     (`(vPositionW.xz - fineOrigin) / fineExtent`), sharp near the camera.
 * Inside the window we sample fine and FEATHER to coarse toward the window
 * border; outside / at far zoom (fine disabled) we use coarse only. Constant
 * VRAM regardless of map size.
 *
 * The overlay stores a DEPTH FIELD (R = depression depth, G = albedo
 * darkening). We derive the surface normal from the depth field's GRADIENT
 * (central difference), normalised to world-space slope so coarse + fine
 * produce matching normals despite their different texel→world spacing.
 * Lighting runs after, so sun movement re-shades the relief live.
 */

import { MaterialPluginBase, Material, Texture, Color3 } from '@babylonjs/core';
import type { FineWindowState } from './decal-overlay.js';

export class DecalOverlayPlugin extends MaterialPluginBase {
    private _enabled = false;
    /** Coarse full-map overlay texture. */
    coarseTexture: Texture | null = null;
    /** Fine camera-window overlay texture. */
    fineTexture: Texture | null = null;
    /** Live fine-window placement (shared by reference with the DecalOverlay). */
    fineState: FineWindowState | null = null;
    /** 1 / coarse texture dimension (texel size in UV, for the gradient taps). */
    coarseTexel = 1 / 2048;
    /** 1 / fine texture dimension. */
    fineTexel = 1 / 4096;
    /** Map extent in elmos (world XZ → coarse UV). */
    worldW = 1;
    worldH = 1;
    /** Scales the world-space depth-field slope → normal tilt. The gradient is
     *  normalised to depth-per-elmo (resolution-independent), so one value fits
     *  both the coarse + fine layers. ~12 gives a readable pit wall. */
    normalScale = 12.0;
    /** Max albedo darkening (G=1 → this fraction darker). ~0.5 = "50% darker". */
    darken = 0.5;
    /** Strength of the world-space churned-ground detail normal. */
    detailScale = 0.55;
    /** Strength of the procedural rubble/rock bumps in disturbed ground. */
    rubbleScale = 0.5;

    constructor(material: Material) {
        // priority 200: run after the stock texture/normal setup.
        super(material, 'DecalOverlay', 200, { DECAL_OVERLAY: false });
    }

    get isEnabled(): boolean { return this._enabled; }
    set isEnabled(v: boolean) {
        if (this._enabled === v) return;
        this._enabled = v;
        this.markAllDefinesAsDirty();
        this._enable(v);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareDefines(defines: any): void {
        defines.DECAL_OVERLAY = this._enabled;
    }

    getClassName(): string { return 'DecalOverlayPlugin'; }

    getSamplers(samplers: string[]): void {
        samplers.push('decalCoarse', 'decalFine');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'decalWorldSize', size: 2, type: 'vec2' },
                { name: 'decalFineOrigin', size: 2, type: 'vec2' },
                { name: 'decalFineExtent', size: 1, type: 'float' },
                { name: 'decalFineEnabled', size: 1, type: 'float' },
                { name: 'decalCoarseTexel', size: 1, type: 'float' },
                { name: 'decalFineTexel', size: 1, type: 'float' },
                { name: 'decalNormalScale', size: 1, type: 'float' },
                { name: 'decalDarken', size: 1, type: 'float' },
                { name: 'decalDetailScale', size: 1, type: 'float' },
                { name: 'decalRubbleScale', size: 1, type: 'float' },
            ],
            fragment: `#ifdef DECAL_OVERLAY
                uniform vec2 decalWorldSize;
                uniform vec2 decalFineOrigin;
                uniform float decalFineExtent;
                uniform float decalFineEnabled;
                uniform float decalCoarseTexel;
                uniform float decalFineTexel;
                uniform float decalNormalScale;
                uniform float decalDarken;
                uniform float decalDetailScale;
                uniform float decalRubbleScale;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        uniformBuffer.updateFloat2('decalWorldSize', this.worldW, this.worldH);
        const fs = this.fineState;
        uniformBuffer.updateFloat2('decalFineOrigin', fs ? fs.originX : 0, fs ? fs.originZ : 0);
        uniformBuffer.updateFloat('decalFineExtent', fs && fs.extent > 0 ? fs.extent : 1);
        uniformBuffer.updateFloat('decalFineEnabled', fs ? fs.enabled : 0);
        uniformBuffer.updateFloat('decalCoarseTexel', this.coarseTexel);
        uniformBuffer.updateFloat('decalFineTexel', this.fineTexel);
        uniformBuffer.updateFloat('decalNormalScale', this.normalScale);
        uniformBuffer.updateFloat('decalDarken', this.darken);
        uniformBuffer.updateFloat('decalDetailScale', this.detailScale);
        uniformBuffer.updateFloat('decalRubbleScale', this.rubbleScale);
        if (this.coarseTexture) uniformBuffer.setTexture('decalCoarse', this.coarseTexture);
        if (this.fineTexture) uniformBuffer.setTexture('decalFine', this.fineTexture);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType === 'fragment') {
            return {
                CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef DECAL_OVERLAY
                    uniform sampler2D decalCoarse;
                    uniform sampler2D decalFine;
                    // Sample the depth field at uv + its 4-tap central-difference
                    // gradient. Returns (depth, darkening, dDepth_x, dDepth_z) —
                    // the raw per-texel differences; the caller divides by the
                    // world-per-texel spacing to get a resolution-independent
                    // world-space slope.
                    vec4 dDecSample(sampler2D tex, vec2 uv, float texel) {
                        vec2 base = texture2D(tex, uv).rg;
                        float dxp = texture2D(tex, uv + vec2(texel, 0.0)).r;
                        float dxm = texture2D(tex, uv - vec2(texel, 0.0)).r;
                        float dzp = texture2D(tex, uv + vec2(0.0, texel)).r;
                        float dzm = texture2D(tex, uv - vec2(0.0, texel)).r;
                        return vec4(base.x, base.y, dxp - dxm, dzp - dzm);
                    }
                    // --- world-space procedural detail (crisp, resolution-independent) ---
                    float dDecHash(vec2 p) {
                        p = fract(p * vec2(127.1, 311.7));
                        p += dot(p, p + 34.5);
                        return fract(p.x * p.y);
                    }
                    float dDecNoise(vec2 p) {
                        vec2 i = floor(p), f = fract(p);
                        f = f * f * (3.0 - 2.0 * f);
                        float a = dDecHash(i);
                        float b = dDecHash(i + vec2(1.0, 0.0));
                        float c = dDecHash(i + vec2(0.0, 1.0));
                        float d = dDecHash(i + vec2(1.0, 1.0));
                        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
                    }
                    vec2 dDecGrad(vec2 p) {
                        float e = 0.45;
                        float nx = dDecNoise(p + vec2(e, 0.0)) - dDecNoise(p - vec2(e, 0.0));
                        float nz = dDecNoise(p + vec2(0.0, e)) - dDecNoise(p - vec2(0.0, e));
                        return vec2(nx, nz) / (2.0 * e);
                    }
                    // Rounded-boulder normal: gradient of a PEAKED noise (noise^k),
                    // which sparsifies the field into rounded mounds (rocks).
                    vec2 dDecBoulder(vec2 p, float k) {
                        float e = 0.5;
                        float gx = pow(dDecNoise(p + vec2(e, 0.0)), k) - pow(dDecNoise(p - vec2(e, 0.0)), k);
                        float gz = pow(dDecNoise(p + vec2(0.0, e)), k) - pow(dDecNoise(p - vec2(0.0, e)), k);
                        return vec2(gx, gz) / (2.0 * e);
                    }
                #endif`,
                // Runs after normalW + baseColor are established, before lights.
                CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef DECAL_OVERLAY
                    // --- COARSE (whole map) ---
                    vec2 _cuv = vPositionW.xz / decalWorldSize;
                    vec4 _cs = dDecSample(decalCoarse, _cuv, decalCoarseTexel);
                    vec2 _coarseWPT = decalWorldSize * decalCoarseTexel;   // elmos/texel (x,z)
                    vec2 _grad = _cs.zw / (2.0 * _coarseWPT);              // d(depth)/d(world)
                    float _depth = _cs.x;
                    float _dark  = _cs.y;

                    // --- FINE window (sharp near camera), feathered to coarse ---
                    if (decalFineEnabled > 0.5) {
                        vec2 _fuv = (vPositionW.xz - decalFineOrigin) / decalFineExtent;
                        vec2 _fd = abs(_fuv - 0.5);
                        float _edge = max(_fd.x, _fd.y);
                        // 1 well inside the window, fading to 0 at the border so
                        // the fine→coarse transition isn't a visible seam.
                        float _fw = (1.0 - smoothstep(0.42, 0.5, _edge));
                        if (_fw > 0.0) {
                            vec4 _fs = dDecSample(decalFine, _fuv, decalFineTexel);
                            float _fineWPT = decalFineExtent * decalFineTexel;
                            vec2 _fgrad = _fs.zw / (2.0 * _fineWPT);
                            _depth = mix(_depth, _fs.x, _fw);
                            _dark  = mix(_dark,  _fs.y, _fw);
                            _grad  = mix(_grad,  _fgrad, _fw);
                        }
                    }

                    // Depth-field normal: ground pushed DOWN by _depth, so the
                    // tangent tilt is +slope (pit walls face inward + up). Summed
                    // (overlapping) craters give one deeper, correctly-lit pit.
                    vec2 _tilt = clamp(_grad * decalNormalScale, -1.0, 1.0);
                    normalW = normalize(normalW + vec3(_tilt.x, 0.0, _tilt.y));

                    // Crater-detail mask keyed on DEPTH: craters (deep) get the
                    // churn + rubble; vehicle/foot tracks (shallow) stay below the
                    // threshold and read clean.
                    float _mask = smoothstep(0.40, 0.70, _depth);
                    float _reliefMag = _depth;
                    if (_mask > 0.02) {
                        vec2 _wp = vPositionW.xz;
                        vec2 _churn = dDecGrad(_wp * 0.045)
                                    + 0.6 * dDecGrad(_wp * 0.11)
                                    + 0.3 * dDecGrad(_wp * 0.26);
                        float _clump = smoothstep(0.42, 0.80, dDecNoise(_wp * 0.012));
                        vec2 _bigRock   = dDecBoulder(_wp * 0.045, 4.0) * 1.3;
                        vec2 _smallRock = dDecBoulder(_wp * 0.110, 3.0) * 0.6;
                        vec2 _rocks = (_bigRock + _smallRock) * _clump;
                        float _bias = mix(0.35, 1.0, smoothstep(0.0, 0.22, _reliefMag));
                        float _churnBias = mix(0.45, 1.0, smoothstep(0.0, 0.18, _reliefMag));
                        vec2 _det = (_churn * decalDetailScale * _churnBias
                                   + _rocks * decalRubbleScale * _bias) * _mask;
                        normalW = normalize(normalW + vec3(_det.x, 0.0, _det.y));
                        baseColor.rgb *= (1.0 - 0.12 * _mask * (dDecNoise(_wp * 0.06) - 0.35));
                    }

                    // Darkening (G), capped by decalDarken (~0.5 = max 50%).
                    baseColor.rgb *= (1.0 - min(_dark, 1.0) * decalDarken);
                #endif`,
            };
        }
        return null;
    }
}

/** Attach the overlay plugin to a material and bind both overlay textures +
 *  the fine-window state. Returns the plugin so callers can tweak scale/darken
 *  live. */
export function attachDecalOverlay(
    material: Material,
    coarseTex: Texture, fineTex: Texture, fineState: FineWindowState,
    coarseTexel: number, fineTexel: number,
    worldW: number, worldH: number,
): DecalOverlayPlugin {
    const plugin = new DecalOverlayPlugin(material);
    plugin.coarseTexture = coarseTex;
    plugin.fineTexture = fineTex;
    plugin.fineState = fineState;
    plugin.coarseTexel = coarseTexel;
    plugin.fineTexel = fineTexel;
    plugin.worldW = worldW;
    plugin.worldH = worldH;
    plugin.isEnabled = true;

    // Mute the terrain's specular: a grass/dirt field shouldn't be glossy, and
    // a glossy surface makes the perturbed crater-wall normals catch a broad,
    // wet-looking highlight. The in-shader `specularColor` isn't reachable from
    // CUSTOM_FRAGMENT_BEFORE_LIGHTS, so we damp it on the material itself.
    const std = material as unknown as { specularColor?: Color3; specularPower?: number };
    if (std.specularColor instanceof Color3) {
        std.specularColor = new Color3(0.04, 0.04, 0.04);
        std.specularPower = 8;
    }
    return plugin;
}
