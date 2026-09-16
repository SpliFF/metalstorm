/**
 * atmosphere.ts — procedural sky dome + exponential fog + clear colour,
 * driven by `mapinfo.lua`'s `atmosphere` table (map-lighting.ts
 * `MapAtmosphere`, parsed but previously unapplied — see
 * PLAN-beta-presentation.md L-ATMOS) and the map's sun direction
 * (`MapLighting.sunDir`, scene-lighting.ts). See docs/lighting.md
 * "Atmosphere".
 *
 * `createAtmosphere` builds the dome once per game session (mirrors
 * `createSceneLighting`); `applyMapAtmosphere` retunes it once per map load,
 * after both `loadMapLighting`/`loadMapAtmosphere` resolve.
 */

import { Color3, Color4, Mesh, MeshBuilder, Scene } from '@babylonjs/core';
import { SkyMaterial } from '@babylonjs/materials';
import { clientSettings } from './client-settings.js';
import type { MapAtmosphere } from './map-lighting.js';

/** Recoil's `fogStart`/`fogEnd` are fractions of the view distance, not
 *  absolute elmos (CMapInfo::ReadAtmosphere). Recoil's own default draw
 *  distance is per-map, but the client has no equivalent knob — 8000 elmos
 *  is a representative RTS-camera view range (matches the CSM's practical
 *  far-cascade reach, docs/lighting.md `shadowMaxZ`), used only to turn the
 *  authored fractions into a physical distance for the fog formulas below. */
export const FOG_VIEW_RANGE_ELMOS = 8000;

/** exp(-(density*d)^2) = 0.01 solved for density at d = viewRangeElmos*fogEnd —
 *  i.e. "fully fogged" (1% transmittance) by the authored far edge. */
const FOG_LN01 = Math.sqrt(-Math.log(0.01));

export interface SkyParams {
    /** SkyMaterial.luminance, ]0,1[. */
    luminance: number;
    /** SkyMaterial.turbidity — haze amount. */
    turbidity: number;
}

/**
 * Sky luminance/turbidity from sun elevation (sine of the elevation angle:
 * 1 = zenith, 0 = horizon, negative = below). High sun → clear, bright sky
 * (low turbidity, high luminance); low/horizon sun → hazier, dimmer (the
 * "low warm sun" art-direction cue). Pure so it's testable without a Scene.
 */
export function deriveSkyParams(sunElevationSin: number): SkyParams {
    const t = Math.max(0, Math.min(1, (sunElevationSin + 0.1) / 1.1));
    return {
        luminance: 0.35 + t * 0.65,
        turbidity: 10 - t * 8,
    };
}

/**
 * EXP2 fog density such that the authored `fogEnd` fraction (of
 * FOG_VIEW_RANGE_ELMOS) reads as ~1% transmittance (effectively opaque).
 * `fogStart` has no EXP2 equivalent (no linear onset) and is only used by
 * the low-preset LINEAR fallback (`deriveLinearFog`). Pure/testable.
 */
export function deriveFogDensity(
    atmo: MapAtmosphere, viewRangeElmos = FOG_VIEW_RANGE_ELMOS,
): number {
    const fogEndDist = Math.max(1, atmo.fogEnd * viewRangeElmos);
    return FOG_LN01 / fogEndDist;
}

/** Linear-fog start/end distances for the `gfx.sky=false` cheap fallback
 *  (Scene.FOGMODE_LINEAR reads these directly, no density curve). */
export function deriveLinearFog(
    atmo: MapAtmosphere, viewRangeElmos = FOG_VIEW_RANGE_ELMOS,
): { start: number; end: number } {
    return {
        start: Math.max(0, atmo.fogStart * viewRangeElmos),
        end: Math.max(1, atmo.fogEnd * viewRangeElmos),
    };
}

/** Blend an [r,g,b] toward its own average by `amount` (0..1) — same
 *  perceptually-neutral desaturation `scene-lighting.ts` uses for ambient. */
function desaturate(rgb: readonly number[], amount: number): [number, number, number] {
    const avg = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return [
        rgb[0] + (avg - rgb[0]) * amount,
        rgb[1] + (avg - rgb[1]) * amount,
        rgb[2] + (avg - rgb[2]) * amount,
    ];
}

/**
 * Fog/clear colour: `mapinfo.lua`'s authored `skyColor` desaturated 30%,
 * standing in for a true rendered horizon sample. FIDELITY-STANDIN: sampling
 * the actual SkyMaterial's horizon pixel needs a render-to-texture readback
 * (a full extra pass just to seed one colour); `skyColor` is the closest
 * authored analogue Recoil ships in mapinfo.lua, and deep haze/scattering at
 * the horizon is genuinely closer to neutral than the zenith colour is, so
 * the same desaturation formula ambient lighting already uses applies here.
 * Pure/testable.
 */
export function deriveFogColor(atmo: MapAtmosphere): Color3 {
    const [r, g, b] = desaturate(atmo.skyColor, 0.3);
    return new Color3(r, g, b);
}

/** Set `scene.fogMode`/density/start/end for the current `gfx.sky` state —
 *  shared by `applyMapAtmosphere` and the live `gfx.sky` toggle below, so
 *  flipping the setting mid-session doesn't wait for the next map load to
 *  drop EXP2 for the cheaper LINEAR mode. */
function applyFogMode(scene: Scene, atmo: MapAtmosphere, skyOn: boolean): void {
    if (skyOn) {
        scene.fogMode = Scene.FOGMODE_EXP2;
        scene.fogDensity = deriveFogDensity(atmo);
    } else {
        scene.fogMode = Scene.FOGMODE_LINEAR;
        const linear = deriveLinearFog(atmo);
        scene.fogStart = linear.start;
        scene.fogEnd = linear.end;
    }
}

export interface Atmosphere {
    dome: Mesh;
    skyMaterial: SkyMaterial;
    /** Last `MapAtmosphere` applied (null before the first map load) — kept
     *  so a live `gfx.sky` toggle can re-derive fog mode immediately. */
    lastAtmo: MapAtmosphere | null;
    dispose(): void;
}

/** Diameter of the sky dome — inside `camera.maxZ` (50000, game-processor.ts)
 *  so it never clips, big enough the camera is always well inside it at any
 *  RTS zoom. Fixed (not camera-derived) so this can build before the camera
 *  exists in the worker's scene-setup sequence. */
const SKY_DOME_DIAMETER = 40000;

/**
 * Build the sky dome + SkyMaterial for a fresh scene. Rendering group 0
 * (with the terrain — a skybox needs no group trick as long as it's the
 * farthest opaque geometry; standard depth test resolves terrain in front
 * of it regardless of draw order), no shadows, no fog self-application
 * (the dome IS the fog/sky backdrop). Visibility gated on `gfx.sky` — low
 * preset disables it (bare clearColor stands in for the sky).
 */
export function createAtmosphere(scene: Scene): Atmosphere {
    const dome = MeshBuilder.CreateSphere('skyDome', {
        diameter: SKY_DOME_DIAMETER, segments: 16, sideOrientation: Mesh.BACKSIDE,
    }, scene);
    dome.infiniteDistance = true;   // always surrounds the camera
    dome.isPickable = false;
    dome.applyFog = false;
    dome.renderingGroupId = 0;
    dome.receiveShadows = false;

    const skyMaterial = new SkyMaterial('skyMat', scene);
    skyMaterial.useSunPosition = true;
    skyMaterial.backFaceCulling = false;
    dome.material = skyMaterial;

    scene.fogEnabled = true;
    scene.fogMode = Scene.FOGMODE_EXP2;

    const atmosphere: Atmosphere = {
        dome,
        skyMaterial,
        lastAtmo: null,
        dispose(): void {
            unsubscribe();
            skyMaterial.dispose();
            dome.dispose();
        },
    };

    const setSkyOn = (on: boolean): void => {
        dome.setEnabled(on);
        if (atmosphere.lastAtmo) applyFogMode(scene, atmosphere.lastAtmo, on);
    };
    setSkyOn(clientSettings.getBool('gfx.sky', true));
    const unsubscribe = clientSettings.subscribe('gfx.sky', v => setSkyOn(Boolean(v)));
    (globalThis as Record<string, unknown>).__atmosphere = atmosphere;
    return atmosphere;
}

/**
 * Apply one map's `MapAtmosphere` + sun direction to the live atmosphere:
 * sky luminance/turbidity from sun elevation, fog density/colour from
 * `fogStart`/`fogEnd`/`skyColor`, `clearColor` = fog colour. Runs once per
 * map load (game-processor.ts `gpLoadMap`), after `loadMapLighting` has
 * placed the sun (so `sunDirToSun` reflects the map's authored direction,
 * not the createSceneLighting placeholder).
 *
 * `gfx.sky=false` (low preset) switches fog to the cheaper LINEAR mode
 * instead of EXP2 — no density curve to evaluate per fragment — and leaves
 * the dome hidden (createAtmosphere already gates its visibility).
 */
export function applyMapAtmosphere(
    atmosphere: Atmosphere,
    scene: Scene,
    atmo: MapAtmosphere,
    sunDirToSun: readonly [number, number, number],
): void {
    const { luminance, turbidity } = deriveSkyParams(sunDirToSun[1]);
    atmosphere.skyMaterial.luminance = luminance;
    atmosphere.skyMaterial.turbidity = turbidity;
    // SkyMaterial's Preetham model wants the sun FAR away in its direction —
    // sunDirToSun is already unit-length (world → sun), so a large scale
    // gives a stable "infinitely distant" sun position.
    atmosphere.skyMaterial.sunPosition.set(
        sunDirToSun[0] * 10000, sunDirToSun[1] * 10000, sunDirToSun[2] * 10000);

    atmosphere.lastAtmo = atmo;
    applyFogMode(scene, atmo, clientSettings.getBool('gfx.sky', true));
    const fogColor = deriveFogColor(atmo);
    scene.fogColor = fogColor;
    scene.clearColor = new Color4(fogColor.r, fogColor.g, fogColor.b, 1);
}
