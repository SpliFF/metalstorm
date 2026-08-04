/**
 * TerrainSplatPlugin — Recoil's splat-detail terrain shading, the near-field
 * half of the SMF texturing model (PLAN-maps.md §1.2).
 *
 * Faithful port of cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl's
 * SMF_DETAIL_TEXTURE_SPLATTING block:
 *
 *   splatDetails = texture(splatDetailTex, uv_i)  -- channel i at texScale i
 *   splatDetails = splatDetails * 2.0 - 1.0       -- signed ±1
 *   cofac        = texture(splatDistrTex, mapUV) * splatTexMults
 *   detail       = dot(splatDetails, cofac)
 *   fragColor    = (diffuse + detail) * shade     -- ADDITIVE, pre-lighting
 *
 * The signed detail centres on 0 so it self-fades to nothing through the mip
 * chain — no explicit distance threshold is needed (this is why Recoil has
 * none). Applied in CUSTOM_FRAGMENT_BEFORE_LIGHTS so Babylon's sun/CSM light
 * loop still runs on top, same adaptation the WaterAbsorptionPlugin makes.
 *
 * Priority 190: BEFORE DecalOverlay (200) and WaterAbsorption (210) so scars
 * darken and water tints over the detailed ground, matching Recoil's order
 * (detail composes into the ground albedo first).
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';
import type { BaseTexture } from '@babylonjs/core';

export class TerrainSplatPlugin extends MaterialPluginBase {
    private _enabled = false;

    distrTexture: BaseTexture | null = null;
    detailTexture: BaseTexture | null = null;
    /** Per-channel world-XZ tiling rates (mapinfo splats.texScales). */
    texScales: [number, number, number, number] = [0.02, 0.02, 0.02, 0.02];
    /** Per-channel detail strength (mapinfo splats.texMults). */
    texMults: [number, number, number, number] = [1, 1, 1, 1];
    /** World extent of the map (elmos) — maps world XZ onto the distr map. */
    worldW = 1;
    worldH = 1;

    constructor(material: Material) {
        super(material, 'TerrainSplat', 190, { TERRAIN_SPLAT: false });
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
        defines.TERRAIN_SPLAT = this._enabled;
    }

    getClassName(): string { return 'TerrainSplatPlugin'; }

    getSamplers(samplers: string[]): void {
        samplers.push('splatDistrTex', 'splatDetailTex');
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
    plugin.isEnabled = true;
    return plugin;
}
