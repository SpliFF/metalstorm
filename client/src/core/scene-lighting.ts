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
import { ShadowDepthBounds } from './shadow-depth-bounds.js';

/** gfx.shadowFiltering (0/1/2) → Babylon CSM filtering quality. */
const SHADOW_FILTERING_QUALITY = [
    ShadowGenerator.QUALITY_LOW,
    ShadowGenerator.QUALITY_MEDIUM,
    ShadowGenerator.QUALITY_HIGH,
] as const;

/** How far to pull the hemispheric ambient toward neutral grey (0 = the map's
 *  raw colour, 1 = fully grey). Keeps a hint of the map's sky/bounce cue while
 *  stopping a saturated map ambient from staining PBR-lit units.
 *
 *  FIDELITY-STANDIN: Recoil applies groundAmbient/unitAmbient VERBATIM — a
 *  deliberately tinted map ambient (e.g. lava-red) is the author's intent.
 *  This desaturation was motivated by one map (green_flat_x34_v3, saturated
 *  green groundAmbient [0.6, 0.9, 0.2] drenching every PBR-lit unit), but
 *  because the single scene HemisphericLight also lights terrain and map
 *  features, the rewrite neutralises the author's ambient tint SCENE-WIDE, not
 *  just on units. Scoping it to units would need a second hemispheric light
 *  with includedOnlyMeshes/excludedMeshes bookkeeping across every unit/feature
 *  mesh (Babylon can't desaturate one light's contribution per-material).
 *  Revisit when (a) a map whose authored ambient tint visibly matters lands, or
 *  (b) the per-material ambient split (docs/lighting.md "Sun + ambient", the
 *  L3+ groundAmbient/unitAmbient work) is built — fold this into the
 *  unit-scoped half then. */
const AMBIENT_DESATURATION = 0.8;

/** Blend an [r,g,b] toward its own average (perceptually neutral grey). Green
 *  carries the most luminance, so averaging (not luminance-weighting) is what
 *  actually removes a green cast rather than preserving it. */
function desaturateToGrey(rgb: readonly number[], amount: number): Color3 {
    const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return new Color3(
        rgb[0] + (avg - rgb[0]) * amount,
        rgb[1] + (avg - rgb[1]) * amount,
        rgb[2] + (avg - rgb[2]) * amount,
    );
}

// ── Per-game lighting style + ambient-level tuning ─────────────────────
// Successor to the retired custom unit shader's USE_HALF_LAMBERT toggle
// and `ambientLevel` uniform (deleted with the shader — units render
// through PBRMaterial now). On the PBR path the style is expressed as the
// hemispheric ambient-fill weight relative to the sun: the old 'gameplay'
// branch kept a high flat floor (0.45 vs a 0.55·halfLambert sun term) so
// silhouettes stayed readable at RTS distance; the old 'realistic' branch
// ran a low floor (ambientLevel 0.10 · (0.35..1.0) vs a full 1.0 Lambert
// sun term) for deep unlit faces and strong front/back contrast. The
// 0.10/0.45 floor ratio (≈0.2) is carried over as the realistic style's
// ambient-intensity factor. Unlike the old per-material uniform this
// scales the scene hemispheric light, so terrain/features darken with the
// units — consistent with the cinematic intent, and it makes the switch
// live (no shader recompile), but note it is scene-wide.

export type LightingStyle = 'gameplay' | 'realistic';

/** Ambient-intensity factor per style, applied to the base intensity the
 *  rig would otherwise use ('gameplay' ≡ the unmodified look). */
const STYLE_AMBIENT_FACTOR: Record<LightingStyle, number> = {
    gameplay: 1.0,
    realistic: 0.2,
};

let currentLightingStyle: LightingStyle = 'gameplay';
/** Base hemispheric intensity before the style factor: the
 *  createSceneLighting placeholder until mapinfo lighting lands, then
 *  applyMapLighting's map-authored level. */
let baseAmbientIntensity = 0.7;
/** Live-tuning override (setAmbientLevel / `__setAmbientLevel`); when set
 *  it replaces the base×style product entirely. Reset per game session. */
let ambientLevelOverride: number | null = null;
/** The rig the setters retune; registered by createSceneLighting. */
let activeLighting: SceneLighting | null = null;

function effectiveAmbientIntensity(): number {
    return ambientLevelOverride
        ?? baseAmbientIntensity * STYLE_AMBIENT_FACTOR[currentLightingStyle];
}

/**
 * Select the per-game lighting style (modinfo.lua `lighting` field,
 * plumbed via /api/games → gp:init). 'gameplay' (default) keeps the full
 * hemispheric ambient fill; 'realistic' drops it to ~20% for deep unlit
 * faces (Metalstorm's cinematic look). Applies immediately to the live
 * rig and to every later applyMapLighting. Unknown values fall back to
 * 'gameplay' so a future protocol value doesn't darken the scene.
 * NOTE: while a SunRig day-night cycle runs it owns ambient.intensity and
 * will overwrite live retunes until disabled (same as every other knob
 * the rig drives).
 */
export function setLightingStyle(style: string): LightingStyle {
    currentLightingStyle = (style === 'realistic') ? 'realistic' : 'gameplay';
    if (activeLighting) {
        activeLighting.ambient.intensity = effectiveAmbientIntensity();
    }
    return currentLightingStyle;
}

/**
 * Live-tune the hemispheric ambient fill (docs/lighting.md "live tuning";
 * exposed to the worker console as `__setAmbientLevel`). Overrides the
 * style-derived intensity outright — lower = deeper unlit faces + darker
 * shadow floors. Cleared at the next game session (createSceneLighting).
 */
export function setAmbientLevel(value: number): number {
    ambientLevelOverride = value;
    if (activeLighting) {
        activeLighting.ambient.intensity = effectiveAmbientIntensity();
    }
    return value;
}

(globalThis as Record<string, unknown>).__setLightingStyle = setLightingStyle;
(globalThis as Record<string, unknown>).__setAmbientLevel = setAmbientLevel;

export interface SceneLighting {
    ambient: HemisphericLight;
    sun: DirectionalLight;
    renderPipeline: DefaultRenderingPipeline;
    /** PLAN-lighting L3 — directional sun shadows via 4-cascade CSM. */
    csm: CascadedShadowGenerator;
    /** PLAN-perf M8 — analytic replacement for `csm.autoCalcDepthBounds`. */
    shadowDepthBounds: ShadowDepthBounds;
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
    (globalThis as unknown as { __renderPipeline: unknown }).__renderPipeline = renderPipeline;

    const csm = createCsm(sun);
    const shadowDepthBounds = new ShadowDepthBounds(csm);
    (globalThis as Record<string, unknown>).__shadowDepthBounds = shadowDepthBounds;

    const lighting: SceneLighting = { ambient, sun, renderPipeline, csm, shadowDepthBounds };
    // Register as the rig setLightingStyle/setAmbientLevel retune, and
    // reset the per-session tuning state (a DevTools ambient override or a
    // previous game's style must not leak into a new session — gp:init
    // re-applies the style right after this).
    activeLighting = lighting;
    ambientLevelOverride = null;
    baseAmbientIntensity = ambient.intensity;
    return lighting;
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
    // Cascade depth-slab fitting. Without ANY fitting the four cascades are
    // spread across the full camera.minZ..shadowMaxZ slab (1..8000) every
    // frame, regardless of where the units actually are. The RTS camera zooms
    // out to ~6000 elmos, dropping units into the coarse far cascade (a
    // ~6000-elmo slab in one 2048² map → texels several elmos across). The
    // fixed normalBias then offsets the receiver sample far enough along its
    // normal to skip past the caster's base → the contact band of the shadow
    // detaches (peter-panning). Fitting the cascades to the visible depth slab
    // each frame keeps texels tight at every zoom, so a smaller normalBias both
    // kills the gap and still suppresses acne.
    //
    // Babylon's own fitting (`autoCalcDepthBounds`) *measures* the slab with a
    // second full-resolution depth pass, a 12-step min/max reduction and a
    // per-frame GPU→CPU readback — PLAN-perf M4 measured that at 27.7 ms of a
    // 31.1 ms render phase, almost all of it the readback stalling the
    // pipeline. `ShadowDepthBounds` derives the same slab analytically from the
    // camera pose and the map's bounds instead (PLAN-perf M8); the reducer
    // stays one `setMode('reduce')` away for A/B.
    csm.autoCalcDepthBounds = false;
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

    (globalThis as unknown as { __csm: unknown }).__csm = csm;
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

    // Pull the ambient toward neutral grey. Units now read the scene
    // hemispheric ambient DIRECTLY through their PBRMaterial (the old custom
    // unit shader used a hardcoded neutral floor and never saw this), so a
    // vividly-coloured map ambient — e.g. this map's saturated green
    // [0.6,0.9,0.2] — would drench every unit in that tint. Desaturating keeps
    // the sky/bounce colour cue without staining the models; terrain stays
    // coloured from its own diffuse texture, so it barely shifts.
    ambient.diffuse = desaturateToGrey(lighting.groundAmbient, AMBIENT_DESATURATION);
    ambient.groundColor = desaturateToGrey(lighting.unitAmbient, AMBIENT_DESATURATION);
    // Map-authored ambient level, weighted by the per-game lighting style
    // ('gameplay' factor is 1.0 ⇒ identical to the old fixed 1.0 here);
    // a live setAmbientLevel override wins outright.
    baseAmbientIntensity = 1.0;
    ambient.intensity = effectiveAmbientIntensity();

    // Average ground + unit density and invert Recoil's "1.0 = fully
    // black" convention into Babylon's "0 = fully black". One knob
    // because CSM emits a single shadow map.
    const meanDensity = (lighting.groundShadowDensity + lighting.unitShadowDensity) * 0.5;
    csm.setDarkness(Math.max(0, Math.min(1, 1 - meanDensity)));

    (globalThis as unknown as { __mapLighting: MapLighting }).__mapLighting = lighting;

    // Log only when the applied values actually changed. Widget
    // read-modify-write cycles (ZK gfx_sun_and_atmosphere FullSunUpdate)
    // legitimately re-apply the same state several times per burst; the
    // apply itself stays unconditional (faithful — Recoil SetSunLighting
    // never dedups), but one log line per *real* change is the useful signal
    // (PLAN-playable G1c).
    const logLine =
        `[lighting] applied: sunDir=${sx.toFixed(2)},${sy.toFixed(2)},${sz.toFixed(2)} ` +
        `unitDiffuse=[${lighting.unitDiffuse.map(n => n.toFixed(2)).join(',')}] ` +
        `groundAmbient=[${lighting.groundAmbient.map(n => n.toFixed(2)).join(',')}] ` +
        `legacyCoord=${lighting.legacyCoordSystem}`;
    if (logLine !== lastAppliedLogLine) {
        lastAppliedLogLine = logLine;
        console.log(logLine);
    }

    void renderPipeline;
}

/** Last `[lighting] applied` line emitted — identical re-applies stay silent. */
let lastAppliedLogLine = '';
