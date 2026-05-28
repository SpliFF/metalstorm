/**
 * Scene lighting + HDR pipeline. Owns the sun + ambient + tonemapping +
 * cascaded shadows. Constructed once per game session by
 * `createSceneLighting`, mutated per map by `applyMapLighting` when
 * `mapinfo.lua` lighting data lands. See docs/lighting.md for the
 * full picture (pipeline, gotchas, live-tuning hooks).
 */

import {
    Camera, CascadedShadowGenerator, Color3, DefaultRenderingPipeline,
    DirectionalLight, HemisphericLight, ImageProcessingConfiguration,
    Scene, ShadowGenerator, Vector3,
} from '@babylonjs/core';
import { normaliseSunDir, type MapLighting } from './map-lighting.js';

export interface SceneLighting {
    ambient: HemisphericLight;
    sun: DirectionalLight;
    renderPipeline: DefaultRenderingPipeline;
    /** PLAN-lighting L3 — directional sun shadows via 4-cascade CSM. */
    csm: CascadedShadowGenerator;
}

/**
 * Install the default sun + ambient + HDR pipeline on a fresh scene.
 * Sun + ambient values are placeholders until `applyMapLighting`
 * rewrites them with the map's authored data. See docs/lighting.md
 * "HDR pipeline" and "sun + ambient".
 */
export function createSceneLighting(scene: Scene, camera: Camera): SceneLighting {
    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
    ambient.intensity = 0.7;
    ambient.diffuse = new Color3(0.8, 0.85, 1.0);
    ambient.groundColor = new Color3(0.3, 0.25, 0.2);

    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, 0.3).normalize(), scene);
    sun.intensity = 1.5;
    sun.diffuse = new Color3(1.0, 0.95, 0.85);

    const renderPipeline = new DefaultRenderingPipeline('default', true, scene, [camera]);
    renderPipeline.samples = 4;
    renderPipeline.imageProcessing.toneMappingEnabled = true;
    renderPipeline.imageProcessing.toneMappingType =
        ImageProcessingConfiguration.TONEMAPPING_ACES;
    renderPipeline.imageProcessing.exposure = 1.0;
    renderPipeline.imageProcessing.contrast = 1.0;
    renderPipeline.fxaaEnabled = true;
    (window as unknown as { __renderPipeline: unknown }).__renderPipeline = renderPipeline;

    const csm = createCsm(sun);

    return { ambient, sun, renderPipeline, csm };
}

/**
 * 4-cascade directional shadow generator. See docs/lighting.md
 * "Cascaded shadow maps" for parameter rationale, the caster
 * registration flow, and the customAllowRendering trap.
 */
function createCsm(sun: DirectionalLight): CascadedShadowGenerator {
    const csm = new CascadedShadowGenerator(2048, sun);
    csm.numCascades = 4;
    csm.lambda = 0.85;
    csm.stabilizeCascades = true;
    csm.cascadeBlendPercentage = 0.05;
    csm.shadowMaxZ = 8000;
    csm.usePercentageCloserFiltering = true;
    csm.filteringQuality = ShadowGenerator.QUALITY_HIGH;
    csm.bias = 0.01;
    csm.normalBias = 0.02;

    // See docs/lighting.md "customAllowRendering" — without this every
    // empty thin-instance template would project a unit-sized blob from
    // the world origin into the depth pass during boot.
    csm.customAllowRendering = (subMesh) => {
        const mesh = subMesh.getRenderingMesh();
        if (mesh.hasThinInstances && mesh.thinInstanceCount === 0) return false;
        return true;
    };

    (window as unknown as { __csm: unknown }).__csm = csm;
    return csm;
}

/**
 * Apply parsed `mapinfo.lua → lighting` to the scene's ambient + sun +
 * pipeline. Runs once per map load, after `loadMapLighting()` resolves.
 * See docs/lighting.md "sun + ambient" for the coord-system handling
 * (Recoil's FROM-world-TO-sun convention, legacy-LH Z flip) and the
 * groundAmbient/unitAmbient hemisphere approximation.
 */
export function applyMapLighting(lighting: MapLighting, scene: SceneLighting): void {
    const { ambient, sun, renderPipeline, csm } = scene;
    const [sx, sy, sz0] = normaliseSunDir(lighting.sunDir);
    const sz = lighting.legacyCoordSystem ? -sz0 : sz0;
    sun.direction = new Vector3(-sx, -sy, -sz);
    sun.diffuse = new Color3(
        lighting.unitDiffuse[0], lighting.unitDiffuse[1], lighting.unitDiffuse[2],
    );
    sun.specular = new Color3(
        lighting.unitSpecular[0], lighting.unitSpecular[1], lighting.unitSpecular[2],
    );
    sun.intensity = 1.0;

    ambient.diffuse = new Color3(
        lighting.groundAmbient[0], lighting.groundAmbient[1], lighting.groundAmbient[2],
    );
    ambient.groundColor = new Color3(
        lighting.unitAmbient[0], lighting.unitAmbient[1], lighting.unitAmbient[2],
    );
    ambient.intensity = 1.0;

    // Average ground + unit density and invert Recoil's "1.0 = fully
    // black" convention into Babylon's "0 = fully black". One knob
    // because CSM emits a single shadow map.
    const meanDensity = (lighting.groundShadowDensity + lighting.unitShadowDensity) * 0.5;
    csm.setDarkness(Math.max(0, Math.min(1, 1 - meanDensity)));

    (window as unknown as { __mapLighting: MapLighting }).__mapLighting = lighting;

    console.log(
        `[lighting] applied: sunDir=${sx.toFixed(2)},${sy.toFixed(2)},${sz.toFixed(2)} ` +
        `unitDiffuse=[${lighting.unitDiffuse.map(n => n.toFixed(2)).join(',')}] ` +
        `groundAmbient=[${lighting.groundAmbient.map(n => n.toFixed(2)).join(',')}] ` +
        `legacyCoord=${lighting.legacyCoordSystem}`,
    );

    void renderPipeline;
}
