/**
 * TerrainSplatPlugin — Recoil's near-field terrain detail shading, both halves
 * of the SMF texturing model (PLAN-maps.md §1.2, PLAN-terrain-detailtex.md).
 *
 * The source material is `GetDetailTextureColor` in
 * cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl plus the
 * `SMF_DETAIL_NORMAL_TEXTURE_SPLATTING` block that *bypasses* it — three
 * mutually exclusive branches selected per map, so this is one plugin with
 * three modes (`mode`; the `TERRAIN_SPLAT` / `TERRAIN_DETAIL_PLAIN` /
 * `TERRAIN_SPLAT_NORMAL` defines are never set together).
 *
 * Recoil's precedence, which callers must reproduce (SMFFragProg.glsl:311 —
 * the splat-normal block is an `#ifdef` around the whole detail section, so
 * where it applies `GetDetailTextureColor` is never called at all):
 *
 *   splatDistrTex + any splatDetailNormalTexN  ->  'splatNormal'
 *   splatDistrTex + splatDetailTex             ->  'splat'
 *   detailTex                                  ->  'plain'
 *
 * Getting that order wrong is not cosmetic: a map that ships both a
 * `splatDetailTex` and the normal set (scorched_crossing, pools_of_ilys) has
 * no reason to keep the former's alpha channel meaningful, and
 * scorched_crossing's is a constant 1.0 — which through mode 'splat' adds a
 * flat +0.93 to the ground albedo and renders the whole map as a white void
 * (endtoend D48).
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
 * Mode 'splatNormal' — `GetSplatDetailTextureNormal`, the
 * `SMF_DETAIL_NORMAL_TEXTURE_SPLATTING` branch. Four `_dnts` textures
 * (detail-normal + tangent-space) are blended by the same distribution
 * weights, and the blend does double duty:
 *
 *   cofac    = texture(splatDistrTex, mapUV) * splatTexMults
 *   strength = min(1.0, dot(cofac, vec4(1.0)))
 *   n        = sum_i (texture(splatNormalTex_i, uv_i) * 2.0 - 1.0) * cofac[i]
 *   n.y      = max(n.y, 0.01)                -- all-zero cofacs point up
 *   detail   = clamp(n.a, -1.0, 1.0)         -- only if diffuseAlpha
 *   normal   = normalize(mix(normal, normalize(stn * n.xyz), strength))
 *
 * `diffuseAlpha` is the map's `SMF_DETAIL_NORMAL_DIFFUSE_ALPHA`; with it
 * clear this branch contributes **no albedo detail at all** (Recoil leaves
 * `splatDetailStrength.y` at 0) and only perturbs the normal. The STN frame
 * is derived from the fragment normal alone, exactly as Recoil does it
 * (SMFFragProg.glsl:276) — no vertex tangents are needed.
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

/** Which branch of Recoil's SMF detail shading this plugin runs. Mutually
 *  exclusive by construction — the shader's `#ifdef`/`#ifndef` structure. */
export type TerrainDetailMode = 'splat' | 'plain' | 'splatNormal';

export class TerrainSplatPlugin extends MaterialPluginBase {
    private _enabled = false;
    private _mode: TerrainDetailMode = 'splat';

    distrTexture: BaseTexture | null = null;
    detailTexture: BaseTexture | null = null;
    /** Mode 'plain' only: the single tiling `detailTex`. */
    plainDetailTexture: BaseTexture | null = null;
    /** Mode 'splatNormal' only: the four `_dnts` detail-normal textures, in
     *  mapinfo order (`splatDetailNormalTex1..4`). A null slot contributes
     *  nothing — Recoil simply has fewer entries in its name vector. */
    normalTextures: (BaseTexture | null)[] = [null, null, null, null];
    /** Mode 'splatNormal' only: Recoil `SMF_DETAIL_NORMAL_DIFFUSE_ALPHA`. */
    diffuseAlpha = false;
    /** Per-channel world-XZ tiling rates (mapinfo splats.texScales). */
    texScales: [number, number, number, number] = [0.02, 0.02, 0.02, 0.02];
    /** Per-channel detail strength (mapinfo splats.texMults). */
    texMults: [number, number, number, number] = [1, 1, 1, 1];
    /** World extent of the map (elmos) — maps world XZ onto the distr map. */
    worldW = 1;
    worldH = 1;

    constructor(material: Material) {
        super(material, 'TerrainSplat', 190, {
            TERRAIN_SPLAT: false,
            TERRAIN_DETAIL_PLAIN: false,
            TERRAIN_SPLAT_NORMAL: false,
            TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false,
        });
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
        defines.TERRAIN_SPLAT_NORMAL = this._enabled && this._mode === 'splatNormal';
        defines.TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA =
            defines.TERRAIN_SPLAT_NORMAL && this.diffuseAlpha;
    }

    getClassName(): string { return 'TerrainSplatPlugin'; }

    getSamplers(samplers: string[]): void {
        samplers.push('splatDistrTex', 'splatDetailTex', 'plainDetailTex',
            'splatNormalTex0', 'splatNormalTex1', 'splatNormalTex2', 'splatNormalTex3');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'splatTexScales', size: 4, type: 'vec4' },
                { name: 'splatTexMults', size: 4, type: 'vec4' },
                { name: 'splatMapInvSize', size: 2, type: 'vec2' },
            ],
            fragment: `#if defined(TERRAIN_SPLAT) || defined(TERRAIN_SPLAT_NORMAL)
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
        if (this._mode === 'splatNormal') {
            for (let i = 0; i < 4; i++) {
                const tex = this.normalTextures[i];
                if (tex) uniformBuffer.setTexture(`splatNormalTex${i}`, tex);
            }
            return;
        }
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
            #endif
            #ifdef TERRAIN_SPLAT_NORMAL
                uniform sampler2D splatDistrTex;
                uniform sampler2D splatNormalTex0;
                uniform sampler2D splatNormalTex1;
                uniform sampler2D splatNormalTex2;
                uniform sampler2D splatNormalTex3;
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
            #endif
            #ifdef TERRAIN_SPLAT_NORMAL
                {
                    vec2 _snWorld = vPositionW.xz;
                    vec4 _snCofac = texture(splatDistrTex, _snWorld * splatMapInvSize) * splatTexMults;
                    float _snStrength = min(1.0, dot(_snCofac, vec4(1.0)));
                    vec4 _snN =
                        (texture(splatNormalTex0, _snWorld * splatTexScales.x) * 2.0 - 1.0) * _snCofac.x
                      + (texture(splatNormalTex1, _snWorld * splatTexScales.y) * 2.0 - 1.0) * _snCofac.y
                      + (texture(splatNormalTex2, _snWorld * splatTexScales.z) * 2.0 - 1.0) * _snCofac.z
                      + (texture(splatNormalTex3, _snWorld * splatTexScales.w) * 2.0 - 1.0) * _snCofac.w;
                    _snN.y = max(_snN.y, 0.01);
                    #ifdef TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA
                        baseColor.rgb += vec3(clamp(_snN.a, -1.0, 1.0));
                    #endif
                    // STN frame from the fragment normal alone, exactly as
                    // SMFFragProg.glsl:276 builds it. For a flat normal this
                    // gives sTangent = +X and tTangent = +Z.
                    vec3 _snT = normalize(cross(normalW, vec3(-1.0, 0.0, 0.0)));
                    vec3 _snS = cross(normalW, _snT);
                    mat3 _snSTN = mat3(_snS, _snT, normalW);
                    normalW = normalize(mix(normalW, normalize(_snSTN * _snN.xyz), _snStrength));
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

/** Attach + configure the splat-detail-*normal* mode
 *  (`SMF_DETAIL_NORMAL_TEXTURE_SPLATTING`). `normals` is the four
 *  `splatDetailNormalTex1..4` textures in mapinfo order; a null slot must be
 *  filled by the caller with a neutral mid-grey so it contributes nothing
 *  (Recoil leaves the sampler unbound, which reads black and would push the
 *  channel to −1 — we do not reproduce that). */
export function attachTerrainSplatNormal(
    material: Material,
    distr: BaseTexture,
    normals: (BaseTexture | null)[],
    scales: [number, number, number, number],
    mults: [number, number, number, number],
    diffuseAlpha: boolean,
    worldW: number,
    worldH: number,
): TerrainSplatPlugin {
    const plugin = new TerrainSplatPlugin(material);
    plugin.distrTexture = distr;
    plugin.normalTextures = [normals[0] ?? null, normals[1] ?? null,
        normals[2] ?? null, normals[3] ?? null];
    plugin.texScales = scales;
    plugin.texMults = mults;
    plugin.diffuseAlpha = diffuseAlpha;
    plugin.worldW = worldW;
    plugin.worldH = worldH;
    plugin.mode = 'splatNormal';
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
