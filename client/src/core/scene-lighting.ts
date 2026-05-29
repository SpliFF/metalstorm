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
import { clientSettings } from './client-settings.js';

/** gfx.shadowFiltering (0/1/2) → Babylon CSM filtering quality. */
const SHADOW_FILTERING_QUALITY = [
    ShadowGenerator.QUALITY_LOW,
    ShadowGenerator.QUALITY_MEDIUM,
    ShadowGenerator.QUALITY_HIGH,
] as const;

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
    // Anti-aliasing from ClientSettings (PLAN-settings.md §5). MSAA
    // samples and FXAA apply live; the panel/menu can flip them without a
    // restart. Default is the 'medium' preset (samples=2, fxaa on).
    renderPipeline.samples = clientSettings.getInt('gfx.msaaSamples', 2);
    renderPipeline.imageProcessing.toneMappingEnabled = true;
    renderPipeline.imageProcessing.toneMappingType =
        ImageProcessingConfiguration.TONEMAPPING_ACES;
    renderPipeline.imageProcessing.exposure = 1.0;
    renderPipeline.imageProcessing.contrast = 1.0;
    renderPipeline.fxaaEnabled = clientSettings.getBool('gfx.fxaa', true);
    clientSettings.subscribe('gfx.msaaSamples', v => { renderPipeline.samples = Number(v); });
    clientSettings.subscribe('gfx.fxaa', v => { renderPipeline.fxaaEnabled = Boolean(v); });

    // HDR bloom (PLAN-weapon-fx-gaps L1). The pipeline is HDR (RGBA16F)
    // and ACES-tonemapped, so emissive FX — weapon bolts, explosion CEGs,
    // and the dynamic FxLightPool lights — push values above 1.0. Bloom
    // is what makes those read as glowing rather than merely bright. The
    // threshold is high so only genuinely HDR pixels bloom (the lit
    // terrain stays crisp); weight/kernel are conservative. All four are
    // live-tunable via window.__renderPipeline.
    renderPipeline.bloomEnabled = clientSettings.getBool('gfx.bloom', true);
    renderPipeline.bloomThreshold = 0.85;
    renderPipeline.bloomWeight = 0.35;
    renderPipeline.bloomKernel = 64;
    renderPipeline.bloomScale = 0.5;
    clientSettings.subscribe('gfx.bloom', v => { renderPipeline.bloomEnabled = Boolean(v); });
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
    // Shadow-map resolution from ClientSettings (PLAN-settings.md §5).
    // The CSM map size is fixed at construction — changing it needs a
    // scene-lighting rebuild (the setting is flagged requiresRestart), so
    // we read it here but don't subscribe for live changes. Default is the
    // 'medium' preset (2048).
    const shadowMapSize = clientSettings.getInt('gfx.shadowMapSize', 2048);
    const csm = new CascadedShadowGenerator(shadowMapSize, sun);
    csm.numCascades = 4;
    csm.lambda = 0.85;
    csm.stabilizeCascades = true;
    csm.cascadeBlendPercentage = 0.05;
    csm.shadowMaxZ = 8000;
    csm.usePercentageCloserFiltering = true;
    // Filtering quality applies live (no rebuild needed).
    const filtering = clientSettings.getInt('gfx.shadowFiltering', 1);
    csm.filteringQuality = SHADOW_FILTERING_QUALITY[filtering]
        ?? ShadowGenerator.QUALITY_MEDIUM;
    clientSettings.subscribe('gfx.shadowFiltering', v => {
        csm.filteringQuality = SHADOW_FILTERING_QUALITY[Number(v)]
            ?? ShadowGenerator.QUALITY_MEDIUM;
    });
    // See PLAN-shadow-zoom-fix.md. Without autoCalcDepthBounds the four
    // cascades are spread across the full camera.minZ..shadowMaxZ slab
    // (1..8000) every frame, regardless of where the units actually are.
    // The RTS camera zooms out to ~6000 elmos, dropping units into the
    // coarse far cascade (a ~6000-elmo slab in one 2048² map → texels
    // several elmos across). The fixed normalBias then offsets the
    // receiver sample far enough along its normal to skip past the
    // caster's base → the contact band of the shadow detaches
    // (peter-panning). Fitting the cascades to the visible depth slab
    // each frame keeps texels tight at every zoom, so a smaller
    // normalBias both kills the gap and still suppresses acne.
    csm.autoCalcDepthBounds = true;
    csm.bias = 0.01;
    csm.normalBias = 0.008;

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
