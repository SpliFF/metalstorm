/**
 * TerrainSplatPlugin — Recoil's near-field terrain detail shading, both halves
 * of the SMF texturing model (PLAN-maps.md §1.2, PLAN-terrain-detailtex.md).
 *
 * The source material is one function — `GetDetailTextureColor` in
 * cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl — with two mutually
 * exclusive branches selected per map, so this is one plugin with two modes
 * (`mode`, and the `TERRAIN_SPLAT` / `TERRAIN_DETAIL_PLAIN` defines are never
 * both set).
 *
 * Mode 'splat' — the `SMF_DETAIL_TEXTURE_SPLATTING` branch:
 *
 *   splatDetails = texture(splatDetailTex, uv_i)  -- channel i at texScale i
 *   splatDetails = splatDetails * 2.0 - 1.0       -- signed ±1
 *   cofac        = texture(splatDistrTex, mapUV) * splatTexMults
 *   detail       = dot(splatDetails, cofac)
 *   fragColor    = (diffuse + detail) * shade     -- ADDITIVE, pre-lighting
 *
 * Mode 'plain' — the `#ifndef` branch, one tiling texture at the fixed
 * `SMF_DETAILTEX_RES` rate (0.02 = one repeat per 50 elmos):
 *
 *   detailCol  = texture(detailTex, worldXZ * 0.02) * 2.0 - 1.0
 *   fragColor  = (diffuse + detailCol.rgb) * shade
 *
 * Both are signed-centred: mid-grey source contributes zero, so average scene
 * brightness is unchanged and the effect self-fades to nothing through the mip
 * chain — no explicit distance threshold is needed (this is why Recoil has
 * none, and why the decal KTX2s must ship a mip chain). Applied in
 * CUSTOM_FRAGMENT_BEFORE_LIGHTS so Babylon's sun/CSM light loop still runs on
 * top and supplies the `* shade`, same adaptation the WaterAbsorptionPlugin
 * makes.
 *
 * Priority 190: BEFORE DecalOverlay (200) and WaterAbsorption (210) so scars
 * darken and water tints over the detailed ground, matching Recoil's order
 * (detail composes into the ground albedo first).
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';
import type { BaseTexture } from '@babylonjs/core';

/** Recoil's `SMF_DETAILTEX_RES` (SMFFragProg.glsl:25) — the plain detail
 *  path's fixed world-XZ tiling rate, one repeat per 50 elmos. Not a knob:
 *  the mip chain, not a uniform, is the distance falloff. */
export const SMF_DETAILTEX_RES = 0.02;

/** Which branch of Recoil's `GetDetailTextureColor` this plugin runs. Mutually
 *  exclusive by construction — the shader's `#ifdef`/`#ifndef` structure. */
export type TerrainDetailMode = 'splat' | 'plain';

export class TerrainSplatPlugin extends MaterialPluginBase {
    private _enabled = false;
    private _mode: TerrainDetailMode = 'splat';

    distrTexture: BaseTexture | null = null;
    detailTexture: BaseTexture | null = null;
    /** Mode 'plain' only: the single tiling `detailTex`. */
    plainDetailTexture: BaseTexture | null = null;
    /** Per-channel world-XZ tiling rates (mapinfo splats.texScales). */
    texScales: [number, number, number, number] = [0.02, 0.02, 0.02, 0.02];
    /** Per-channel detail strength (mapinfo splats.texMults). */
    texMults: [number, number, number, number] = [1, 1, 1, 1];
    /** World extent of the map (elmos) — maps world XZ onto the distr map. */
    worldW = 1;
    worldH = 1;

    constructor(material: Material) {
        super(material, 'TerrainSplat', 190,
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false });
    }

    get isEnabled(): boolean { return this._enabled; }
    set isEnabled(v: boolean) {
        if (this._enabled === v) return;
        this._enabled = v;
        this.markAllDefinesAsDirty();
        this._enable(v);
    }

    get mode(): TerrainDetailMode { return this._mode; }
    set mode(v: TerrainDetailMode) {
        if (this._mode === v) return;
        this._mode = v;
        this.markAllDefinesAsDirty();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prepareDefines(defines: any): void {
        defines.TERRAIN_SPLAT = this._enabled && this._mode === 'splat';
        defines.TERRAIN_DETAIL_PLAIN = this._enabled && this._mode === 'plain';
    }

    getClassName(): string { return 'TerrainSplatPlugin'; }

    getSamplers(samplers: string[]): void {
        samplers.push('splatDistrTex', 'splatDetailTex', 'plainDetailTex');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'splatTexScales', size: 4, type: 'vec4' },
                { name: 'splatTexMults', size: 4, type: 'vec4' },
                { name: 'splatMapInvSize', size: 2, type: 'vec2' },
            ],
            fragment: `#ifdef TERRAIN_SPLAT
                uniform vec4 splatTexScales;
                uniform vec4 splatTexMults;
                uniform vec2 splatMapInvSize;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        if (this._mode === 'plain') {
            // No uniforms — the plain path's rate is Recoil's fixed constant.
            if (this.plainDetailTexture)
                uniformBuffer.setTexture('plainDetailTex', this.plainDetailTexture);
            return;
        }
        uniformBuffer.updateFloat4('splatTexScales', ...this.texScales);
        uniformBuffer.updateFloat4('splatTexMults', ...this.texMults);
        uniformBuffer.updateFloat2('splatMapInvSize', 1 / this.worldW, 1 / this.worldH);
        if (this.distrTexture) uniformBuffer.setTexture('splatDistrTex', this.distrTexture);
        if (this.detailTexture) uniformBuffer.setTexture('splatDetailTex', this.detailTexture);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType !== 'fragment') return null;
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef TERRAIN_SPLAT
                uniform sampler2D splatDistrTex;
                uniform sampler2D splatDetailTex;
            #endif
            #ifdef TERRAIN_DETAIL_PLAIN
                uniform sampler2D plainDetailTex;
            #endif`,
            // Runs on baseColor before the light loop; the light loop then
            // multiplies by shade, giving Recoil's (diffuse+detail)*shade.
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef TERRAIN_SPLAT
                {
                    vec2 _spWorld = vPositionW.xz;
                    vec4 _spDetails = vec4(
                        texture(splatDetailTex, _spWorld * splatTexScales.x).r,
                        texture(splatDetailTex, _spWorld * splatTexScales.y).g,
                        texture(splatDetailTex, _spWorld * splatTexScales.z).b,
                        texture(splatDetailTex, _spWorld * splatTexScales.w).a);
                    _spDetails = _spDetails * 2.0 - 1.0;
                    vec4 _spCofac = texture(splatDistrTex, _spWorld * splatMapInvSize) * splatTexMults;
                    baseColor.rgb += vec3(dot(_spDetails, _spCofac));
                }
            #endif
            #ifdef TERRAIN_DETAIL_PLAIN
                {
                    vec2 _pdUV = vPositionW.xz * vec2(${SMF_DETAILTEX_RES});
                    vec3 _pdCol = texture(plainDetailTex, _pdUV).rgb * 2.0 - 1.0;
                    baseColor.rgb += _pdCol;
                }
            #endif`,
        };
    }
}

/** Attach + configure the splat plugin. `distrUrl`/`detailUrl` must already
 *  be resolved textures (caller owns loading + wrapS/T = wrap for detail). */
export function attachTerrainSplat(
    material: Material,
    distr: BaseTexture,
    detail: BaseTexture,
    scales: [number, number, number, number],
    mults: [number, number, number, number],
    worldW: number,
    worldH: number,
): TerrainSplatPlugin {
    const plugin = new TerrainSplatPlugin(material);
    plugin.distrTexture = distr;
    plugin.detailTexture = detail;
    plugin.texScales = scales;
    plugin.texMults = mults;
    plugin.worldW = worldW;
    plugin.worldH = worldH;
    plugin.mode = 'splat';
    plugin.isEnabled = true;
    return plugin;
}

/** Attach + configure the plain-detail mode (`detailTex`). `detail` must
 *  already be a resolved texture with wrapS/T = wrap; the tiling rate is
 *  Recoil's fixed `SMF_DETAILTEX_RES`, so there is nothing else to configure.
 *  Precedence (PLAN-terrain-detailtex.md §2.1): callers try the splat pair
 *  first and only fall back here — never both on one material. */
export function attachTerrainDetailPlain(
    material: Material,
    detail: BaseTexture,
): TerrainSplatPlugin {
    const plugin = new TerrainSplatPlugin(material);
    plugin.plainDetailTexture = detail;
    plugin.mode = 'plain';
    plugin.isEnabled = true;
    return plugin;
}
