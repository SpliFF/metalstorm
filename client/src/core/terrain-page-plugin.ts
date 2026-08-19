/**
 * TerrainPageSamplePlugin — the shader half of streaming v2 (PLAN-maps.md
 * §1.2.1): page-table tap → two array taps → `mix(fallback, primary, fade)`.
 *
 * Per fragment:
 * 1. World XZ → global 0..1 map UV (the same mapping the splat plugin's
 *    distribution tap uses; the terrain mesh's own UVs are not consulted, so
 *    the plugin composes with any diffuse-texture path).
 * 2. The level-0 page under the fragment indexes the page table (RGBA8,
 *    `texelFetch`ed — two texels per entry: primary then fallback, layout
 *    `[layerLo, layerHi, level, fade] [fbLayerLo, fbLayerHi, fbLevel, 0]`,
 *    `terrain-page-cache.ts`).
 * 3. Each of the two entries names a resident array layer and its pyramid
 *    level; the fragment's payload UV inside that level's page is
 *    `fract(mapUV * baseScale / 2^level)` (`pageSampleTransform`), remapped
 *    into the 520² physical page past the 4-texel border
 *    (`physicalUvOfPayload`).
 * 4. `baseColor = mix(fallback, primary, fade)` — the cross-fade for a page
 *    that just landed and, because the pyramid IS the mip chain, the same
 *    two taps trilinear minification would want anyway.
 *
 * A primary level of 255 means "nothing resident yet" (not even the pinned
 * root has landed); the plugin then leaves the material's own diffuse sample
 * untouched rather than painting black.
 *
 * Priority 180: BEFORE TerrainSplat (190), DecalOverlay (200) and
 * WaterAbsorption (210) — this REPLACES the ground albedo, so it must run
 * before everything that composes on top of it.
 *
 * ⚠ The toggle property is `isEnabled`, NOT `enabled` (MaterialPluginBase
 * convention; M8i lost an A/B to that name). `attachTerrainPageSample`
 * asserts the setter took.
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';
import type { BaseTexture } from '@babylonjs/core';
import {
    PAGE_BORDER_TEXELS, PAGE_PAYLOAD_TEXELS, PAGE_PHYSICAL_TEXELS,
} from './terrain-page-grid.js';

/** Static geometry of the page grid the shader needs, all derivable from
 *  `PageGrid` — kept as plain numbers so the plugin has no core dependency. */
export interface PageSampleGeometry {
    /** `mapElmos / pageElmos(level 0)` per axis — level-0 page coords of a
     *  map UV are `floor(uv * baseScale)`, exactly `pageSampleTransform`. */
    baseScaleU: number;
    baseScaleV: number;
    /** Level-0 grid dimensions (the page table is `2*pagesX0 × pagesZ0`). */
    pagesX0: number;
    pagesZ0: number;
    /** Map extent in elmos — world XZ → map UV. */
    worldW: number;
    worldH: number;
}

export class TerrainPageSamplePlugin extends MaterialPluginBase {
    private _enabled = false;

    atlasTexture: BaseTexture | null = null;
    tableTexture: BaseTexture | null = null;
    geometry: PageSampleGeometry = {
        baseScaleU: 1, baseScaleV: 1, pagesX0: 1, pagesZ0: 1,
        worldW: 1, worldH: 1,
    };

    constructor(material: Material) {
        super(material, 'TerrainPageSample', 180, { TERRAIN_PAGE_SAMPLE: false });
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
        defines.TERRAIN_PAGE_SAMPLE = this._enabled;
    }

    getClassName(): string { return 'TerrainPageSamplePlugin'; }

    getSamplers(samplers: string[]): void {
        samplers.push('terrainPageAtlas', 'terrainPageTable');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'pageGridParams', size: 4, type: 'vec4' },
                { name: 'pageMapInvSize', size: 2, type: 'vec2' },
            ],
            fragment: `#ifdef TERRAIN_PAGE_SAMPLE
                uniform vec4 pageGridParams;
                uniform vec2 pageMapInvSize;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        const g = this.geometry;
        uniformBuffer.updateFloat4('pageGridParams',
            g.baseScaleU, g.baseScaleV, g.pagesX0, g.pagesZ0);
        uniformBuffer.updateFloat2('pageMapInvSize', 1 / g.worldW, 1 / g.worldH);
        if (this.atlasTexture)
            uniformBuffer.setTexture('terrainPageAtlas', this.atlasTexture);
        if (this.tableTexture)
            uniformBuffer.setTexture('terrainPageTable', this.tableTexture);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType !== 'fragment') return null;
        const border = PAGE_BORDER_TEXELS.toFixed(1);
        const payload = PAGE_PAYLOAD_TEXELS.toFixed(1);
        const physical = PAGE_PHYSICAL_TEXELS.toFixed(1);
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef TERRAIN_PAGE_SAMPLE
                uniform highp sampler2DArray terrainPageAtlas;
                uniform highp sampler2D terrainPageTable;
                vec3 samplePageLayer(vec2 mapUV, float level, float layer) {
                    vec2 pageCoord = mapUV * pageGridParams.xy * exp2(-level);
                    vec2 payloadUV = pageCoord - floor(pageCoord);
                    vec2 physUV = (vec2(${border}) + payloadUV * ${payload})
                        / ${physical};
                    return texture(terrainPageAtlas, vec3(physUV, layer)).rgb;
                }
            #endif`,
            CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef TERRAIN_PAGE_SAMPLE
                {
                    vec2 _tpMapUV = clamp(vPositionW.xz * pageMapInvSize,
                        vec2(0.0), vec2(0.9999999));
                    ivec2 _tpP0 = ivec2(clamp(
                        floor(_tpMapUV * pageGridParams.xy),
                        vec2(0.0), pageGridParams.zw - 1.0));
                    vec4 _tpPrim = texelFetch(terrainPageTable,
                        ivec2(_tpP0.x * 2, _tpP0.y), 0);
                    float _tpPrimLevel = floor(_tpPrim.b * 255.0 + 0.5);
                    if (_tpPrimLevel < 255.0) {
                        vec4 _tpFb = texelFetch(terrainPageTable,
                            ivec2(_tpP0.x * 2 + 1, _tpP0.y), 0);
                        float _tpPrimLayer = floor(_tpPrim.r * 255.0 + 0.5)
                            + floor(_tpPrim.g * 255.0 + 0.5) * 256.0;
                        float _tpFbLayer = floor(_tpFb.r * 255.0 + 0.5)
                            + floor(_tpFb.g * 255.0 + 0.5) * 256.0;
                        float _tpFbLevel = floor(_tpFb.b * 255.0 + 0.5);
                        vec3 _tpPrimCol = samplePageLayer(
                            _tpMapUV, _tpPrimLevel, _tpPrimLayer);
                        vec3 _tpFbCol = samplePageLayer(
                            _tpMapUV, _tpFbLevel, _tpFbLayer);
                        baseColor.rgb = mix(_tpFbCol, _tpPrimCol, _tpPrim.a);
                    }
                }
            #endif`,
        };
    }
}

/** Attach + configure + enable, asserting the `isEnabled` setter took (the
 *  M8i lesson: `plugin.enabled = true` assigns a dead expando and reads back
 *  as a zero-delta A/B). */
export function attachTerrainPageSample(
    material: Material,
    atlas: BaseTexture,
    table: BaseTexture,
    geometry: PageSampleGeometry,
): TerrainPageSamplePlugin {
    const plugin = new TerrainPageSamplePlugin(material);
    plugin.atlasTexture = atlas;
    plugin.tableTexture = table;
    plugin.geometry = geometry;
    plugin.isEnabled = true;
    if (!plugin.isEnabled) {
        throw new Error('[terrain-pages] TerrainPageSamplePlugin.isEnabled '
            + 'setter did not take');
    }
    return plugin;
}
