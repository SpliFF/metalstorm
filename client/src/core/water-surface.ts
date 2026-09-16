/**
 * water-surface.ts — the map's Y=0 water plane material. FIDELITY-STANDIN
 * for Recoil's BumpWater (reflection/refraction RTT): two scrolling
 * analytic bump fields (no normal-map asset yet), Fresnel darkening, and
 * shore foam reusing water-absorption-plugin.ts's depth-blend curve. NOT
 * Babylon's `WaterMaterial` — its reflection pass is a second full scene
 * render, too costly at XL900 scale (PLAN-beta-presentation.md L-ATMOS
 * step 4). See docs/lighting.md "Atmosphere" and shaders/water-surface.ts
 * for the GLSL.
 */

import { Color3, Mesh, RawTexture, Scene, ShaderMaterial, Texture } from '@babylonjs/core';
import { registerWaterSurfaceShader } from './shaders/water-surface.js';

export interface HeightmapSource {
    /** Heightmap corner grid, Recoil convention: (mapx+1) x (mapy+1) uint16,
     *  0..65535 mapped linearly to [minHeight, maxHeight]. Same source
     *  buffer buildTerrainMesh/TerrainFog read (map.heightmap). */
    heightmap: Uint16Array;
    mapx: number;
    mapy: number;
    minHeight: number;
    maxHeight: number;
}

export interface WaterSurfaceOptions extends HeightmapSource {
    surfaceColor: [number, number, number];
    surfaceAlpha: number;
}

export interface WaterSurface {
    material: ShaderMaterial;
    dispose(): void;
}

/** Depth-below-water headroom the shore-depth texture encodes into [0,1]
 *  (must match the `* 64.0` decode in shaders/water-surface.ts). Foam
 *  itself only extends 10 elmos (SMF_SHALLOW_WATER_DEPTH) — the extra
 *  headroom just keeps the encoding away from 8-bit banding near the edge. */
export const SHORE_DEPTH_RANGE_ELMOS = 64;
/** Texture resolution for the shore-depth bake — independent of map size
 *  (foam is a coarse near-shore cue, not a precision terrain sample). */
export const DEPTH_TEX_SIZE = 256;

/**
 * Downsample the map heightmap into a single-channel "depth below Y=0"
 * byte buffer, reusing the exact depth-blend formula water-absorption-
 * plugin.ts applies to the underwater terrain shade (0 = at/above the
 * waterline, 255 = SHORE_DEPTH_RANGE_ELMOS or deeper). Pure — no Babylon
 * dependency — so it's testable without a Scene; `buildShoreDepthTexture`
 * wraps this into a RawTexture for the material to sample.
 *
 * NOTE: this maps the plane's (u,v) to the same fractional (x,z) position
 * the heightmap traversal below uses; a mismatched UV winding vs.
 * `MeshBuilder.CreateGround`'s convention would mirror the foam pattern,
 * not break it — foam is a cosmetic cue, not gameplay-relevant.
 */
export function buildShoreDepthData(src: HeightmapSource, size = DEPTH_TEX_SIZE): Uint8Array {
    const hmW = src.mapx + 1;
    const hmH = src.mapy + 1;
    const hRange = (src.maxHeight - src.minHeight) || 1;
    const data = new Uint8Array(size * size);
    for (let ty = 0; ty < size; ty++) {
        const srcZ = Math.min(hmH - 1, Math.round((ty / (size - 1)) * (hmH - 1)));
        for (let tx = 0; tx < size; tx++) {
            const srcX = Math.min(hmW - 1, Math.round((tx / (size - 1)) * (hmW - 1)));
            const raw = src.heightmap[srcZ * hmW + srcX];
            const worldY = src.minHeight + (raw / 65535) * hRange;
            const depth = Math.max(0, -worldY);
            data[ty * size + tx] = Math.min(255, Math.round((depth / SHORE_DEPTH_RANGE_ELMOS) * 255));
        }
    }
    return data;
}

function buildShoreDepthTexture(scene: Scene, opts: WaterSurfaceOptions): RawTexture {
    const data = buildShoreDepthData(opts);
    const tex = RawTexture.CreateLuminanceTexture(
        data, DEPTH_TEX_SIZE, DEPTH_TEX_SIZE, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    return tex;
}

/**
 * Build the water surface material and attach it to `mesh` (the existing
 * Y=0 ground plane game-processor.ts already builds). Registers a
 * self-contained `onBeforeRenderObservable` tick for the scroll-time
 * uniform — no per-frame hook needed from the caller.
 */
export function createWaterSurface(
    scene: Scene, mesh: Mesh, opts: WaterSurfaceOptions,
): WaterSurface {
    registerWaterSurfaceShader();
    const depthTex = buildShoreDepthTexture(scene, opts);

    const material = new ShaderMaterial('waterSurfaceMat', scene, 'waterSurface', {
        attributes: ['position', 'uv'],
        uniforms: ['world', 'worldViewProjection', 'cameraPosition',
                   'uSurfaceColor', 'uSurfaceAlpha', 'uTime'],
        samplers: ['uShoreDepthTex'],
        needAlphaBlending: true,
    });
    material.setColor3('uSurfaceColor', new Color3(...opts.surfaceColor));
    material.setFloat('uSurfaceAlpha', opts.surfaceAlpha);
    material.setFloat('uTime', 0);
    material.setTexture('uShoreDepthTex', depthTex);
    material.backFaceCulling = false;
    mesh.material = material;

    const startMs = performance.now();
    const observer = scene.onBeforeRenderObservable.add(() => {
        material.setFloat('uTime', (performance.now() - startMs) / 1000);
    });

    return {
        material,
        dispose(): void {
            scene.onBeforeRenderObservable.remove(observer);
            depthTex.dispose();
            material.dispose();
        },
    };
}
