/**
 * DecalOverlayPlugin — injects the baked decal overlay (decal-overlay.ts) into
 * the terrain's Babylon StandardMaterial via the material-plugin API, so we
 * keep Babylon's sun + CSM shadow lighting (PLAN-lighting L1–L4) intact and
 * only perturb the normal + darken the albedo before the light loop.
 *
 * The overlay UV is derived from WORLD position (`vPositionW.xz / worldSize`),
 * NOT the mesh UV — the flat ZK maps render terrain with an untextured
 * StandardMaterial that has no `uv` attribute, so a uv-based varying would
 * break the terrain shader. World-XZ also matches exactly how DecalOverlay
 * places marks (centre = worldXZ / worldSize), so they align with no flips.
 *
 * Decode:
 *   N += (overlay.rg - 0.5) * 2 * normalScale   (tangent xz, renormalised)
 *   albedo *= 1 - overlay.b * darken
 * Lighting runs after, so sun movement re-shades the relief live.
 */

import { MaterialPluginBase, Material, Texture, Color3 } from '@babylonjs/core';

export class DecalOverlayPlugin extends MaterialPluginBase {
    private _enabled = false;
    texture: Texture | null = null;
    /** Map extent in elmos (world XZ → overlay UV). */
    worldW = 1;
    worldH = 1;
    /** Scales the depth-field gradient → normal tilt. Folds in the depth→world
     *  height scale + the central-difference texel spacing; ~9 gives a readable
     *  pit wall for a typical crater. */
    normalScale = 9.0;
    /** Max albedo darkening (G=1 → this fraction darker). ~0.5 = "50% darker"
     *  cap the user asked for. */
    darken = 0.5;
    /** Strength of the world-space churned-ground detail normal (crisp, full
     *  resolution — independent of the overlay texel size). */
    detailScale = 0.55;
    /** Strength of the procedural rubble/rock bumps scattered in disturbed
     *  ground. */
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
        samplers.push('decalOverlay');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'decalWorldSize', size: 2, type: 'vec2' },
                { name: 'decalNormalScale', size: 1, type: 'float' },
                { name: 'decalDarken', size: 1, type: 'float' },
                { name: 'decalDetailScale', size: 1, type: 'float' },
                { name: 'decalRubbleScale', size: 1, type: 'float' },
                { name: 'decalTexel', size: 1, type: 'float' },
            ],
            fragment: `#ifdef DECAL_OVERLAY
                uniform vec2 decalWorldSize;
                uniform float decalNormalScale;
                uniform float decalDarken;
                uniform float decalDetailScale;
                uniform float decalRubbleScale;
                uniform float decalTexel;     // 1 / overlay dimension (texel size in UV)
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        uniformBuffer.updateFloat2('decalWorldSize', this.worldW, this.worldH);
        uniformBuffer.updateFloat('decalNormalScale', this.normalScale);
        uniformBuffer.updateFloat('decalDarken', this.darken);
        uniformBuffer.updateFloat('decalDetailScale', this.detailScale);
        uniformBuffer.updateFloat('decalRubbleScale', this.rubbleScale);
        // Texel size for the depth-gradient → normal sampling. Read live from
        // the overlay RTT so it tracks OVERLAY_MAX_DIM without extra wiring.
        const dim = this.texture ? (this.texture.getSize().width || 4096) : 4096;
        uniformBuffer.updateFloat('decalTexel', 1.0 / dim);
        if (this.texture) uniformBuffer.setTexture('decalOverlay', this.texture);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType === 'fragment') {
            return {
                CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef DECAL_OVERLAY
                    uniform sampler2D decalOverlay;
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
                    // central-difference gradient of the noise → tangent normal offset
                    vec2 dDecGrad(vec2 p) {
                        float e = 0.45;
                        float nx = dDecNoise(p + vec2(e, 0.0)) - dDecNoise(p - vec2(e, 0.0));
                        float nz = dDecNoise(p + vec2(0.0, e)) - dDecNoise(p - vec2(0.0, e));
                        return vec2(nx, nz) / (2.0 * e);
                    }
                    // Rounded-boulder normal: gradient of a PEAKED noise (noise^k),
                    // which sparsifies the field into rounded mounds (rocks),
                    // not angular faces. Bigger k → rarer, rounder boulders.
                    vec2 dDecBoulder(vec2 p, float k) {
                        float e = 0.5;
                        float gx = pow(dDecNoise(p + vec2(e, 0.0)), k) - pow(dDecNoise(p - vec2(e, 0.0)), k);
                        float gz = pow(dDecNoise(p + vec2(0.0, e)), k) - pow(dDecNoise(p - vec2(0.0, e)), k);
                        return vec2(gx, gz) / (2.0 * e);
                    }
                #endif`,
                // Runs after normalW + baseColor are established, before lights.
                // vPositionW is the world-space surface position (a standard
                // StandardMaterial varying when lighting is on).
                CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef DECAL_OVERLAY
                    vec2 _duv = vPositionW.xz / decalWorldSize;
                    // Depth-field overlay: R = depression depth, G = darkening.
                    float _depth = texture2D(decalOverlay, _duv).r;
                    float _dark  = texture2D(decalOverlay, _duv).g;

                    // Derive the surface normal from the depth field's GRADIENT
                    // (central difference across neighbour texels). The ground is
                    // pushed DOWN by _depth, so height h = -depth and the tangent
                    // normal tilt is +grad(depth): pit walls face inward + up, and
                    // overlapping (summed) craters give one deeper, correctly-lit
                    // pit. decalNormalScale folds in the depth→world-height scale.
                    float _dxp = texture2D(decalOverlay, _duv + vec2(decalTexel, 0.0)).r;
                    float _dxm = texture2D(decalOverlay, _duv - vec2(decalTexel, 0.0)).r;
                    float _dzp = texture2D(decalOverlay, _duv + vec2(0.0, decalTexel)).r;
                    float _dzm = texture2D(decalOverlay, _duv - vec2(0.0, decalTexel)).r;
                    vec2 _dgrad = vec2(_dxp - _dxm, _dzp - _dzm) * decalNormalScale;
                    _dgrad = clamp(_dgrad, -1.0, 1.0);
                    normalW = normalize(normalW + vec3(_dgrad.x, 0.0, _dgrad.y));

                    // Crater-detail mask keyed on DEPTH: craters (deep) get the
                    // churn + rubble; vehicle/foot tracks (shallow, even when
                    // accumulated) stay below the threshold and read clean — no
                    // diagonal hatching / blur on smooth grooves.
                    float _mask = smoothstep(0.40, 0.70, _depth);
                    float _reliefMag = _depth;
                    if (_mask > 0.02) {
                        vec2 _wp = vPositionW.xz;
                        // strong multi-octave churn to break up smooth walls
                        vec2 _churn = dDecGrad(_wp * 0.045)
                                    + 0.6 * dDecGrad(_wp * 0.11)
                                    + 0.3 * dDecGrad(_wp * 0.26);
                        // ROUNDED boulders at two sizes, CLUSTERED via a low-freq
                        // mask so they sit in patches, not a uniform field.
                        float _clump = smoothstep(0.42, 0.80, dDecNoise(_wp * 0.012));
                        vec2 _bigRock   = dDecBoulder(_wp * 0.045, 4.0) * 1.3;
                        vec2 _smallRock = dDecBoulder(_wp * 0.110, 3.0) * 0.6;
                        vec2 _rocks = (_bigRock + _smallRock) * _clump;
                        // Bias rubble toward real relief and AWAY from flat dark
                        // soot streaks — ejecta channels are scoured, so debris
                        // would have been blasted off them.
                        float _bias = mix(0.35, 1.0, smoothstep(0.0, 0.22, _reliefMag));
                        // Also bias the churn (gentler) so flat soot streaks stay
                        // CLEAN dark lines instead of being broken up by bumps —
                        // walls/rim (relief) still get full roughening.
                        float _churnBias = mix(0.45, 1.0, smoothstep(0.0, 0.18, _reliefMag));
                        vec2 _det = (_churn * decalDetailScale * _churnBias
                                   + _rocks * decalRubbleScale * _bias) * _mask;
                        normalW = normalize(normalW + vec3(_det.x, 0.0, _det.y));
                        // (Scorched ground should be matte; the broken-up normal
                        // above already scatters the highlight. Specular is muted
                        // globally on the terrain material — see attachDecalOverlay.)
                        // subtle albedo grit so the churn reads even on flat-lit faces
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

/** Attach the overlay plugin to a material and bind the overlay texture +
 *  map extent. Returns the plugin so callers can tweak scale/darken live. */
export function attachDecalOverlay(
    material: Material, overlayTex: Texture, worldW: number, worldH: number,
): DecalOverlayPlugin {
    const plugin = new DecalOverlayPlugin(material);
    plugin.texture = overlayTex;
    plugin.worldW = worldW;
    plugin.worldH = worldH;
    plugin.isEnabled = true;

    // Mute the terrain's specular: a grass/dirt field shouldn't be glossy, and
    // a glossy surface makes the perturbed crater-wall normals catch a broad,
    // wet-looking highlight (the "shiny smooth walls"). The in-shader
    // `specularColor` isn't reachable from CUSTOM_FRAGMENT_BEFORE_LIGHTS, so we
    // damp it on the material itself. Guarded so it only touches StandardMaterial.
    const std = material as unknown as { specularColor?: Color3; specularPower?: number };
    if (std.specularColor instanceof Color3) {
        std.specularColor = new Color3(0.04, 0.04, 0.04);
        std.specularPower = 8;
    }
    return plugin;
}
