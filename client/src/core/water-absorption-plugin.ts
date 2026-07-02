/**
 * WaterAbsorptionPlugin — depth-graded shading of terrain BELOW the Y=0 water
 * plane, a faithful port of Recoil's SMF ground shader `SMF_WATER_ABSORPTION`
 * block (cont/base/springcontent/shaders/GLSL/SMFFragProg.glsl:220-248, gated
 * by `smfMap->HasVisibleWater()` in SMFRenderState.cpp:116).
 *
 * This is what the mapinfo.lua `water.absorb` / `water.baseColor` /
 * `water.minColor` colours actually drive in Recoil — the tint of the pool
 * FLOOR, graded by depth — not the water surface (that is `surfaceColor` /
 * `surfaceAlpha`, see the fallback water plane in game-processor.ts). Without
 * this block those colours had nowhere to go, and G1a's pools_of_ilys pools
 * (pink absorb base, authored for geothermal pools) rendered as untinted
 * seabed under a mis-coloured plane.
 *
 * Reproduced exactly from the Recoil GLSL:
 *   shade = max(minColor, baseColor - absorb * min(1023, -y))
 *   blended in over the first SMF_SHALLOW_WATER_DEPTH (10) elmos of depth.
 *
 * FIDELITY-STANDIN (adaptations for Babylon's StandardMaterial light loop,
 * which runs AFTER this hook — Recoil's SMF shader instead REPLACES its
 * ground diffuse+ambient shade term with the water shade):
 *   - the shade is applied as an albedo multiplier, so Babylon's sun/shadow
 *     lighting still modulates it (Recoil's underwater shading is flatter:
 *     waterLightInt = min(2*NdotL + 0.4, 1), saturating to 1 in lit areas,
 *     so the two agree wherever the ground is lit)
 *   - the waterShadeDecay shadow-darkening term is dropped (needs the shadow
 *     coefficient, unavailable before Babylon's light loop)
 *   - SMF_INTENSITY_MULT is dropped — Recoil applies it to the ground and
 *     water shades alike, so it cancels in this relative (multiplier) form
 */

import { MaterialPluginBase, Material } from '@babylonjs/core';
import type { MapWaterAbsorption } from './map-lighting.js';

export class WaterAbsorptionPlugin extends MaterialPluginBase {
    private _enabled = false;
    /** Shade at zero depth (mapinfo `water.baseColor`). */
    baseColor: [number, number, number] = [0, 0, 0];
    /** Absorption per elmo of depth (mapinfo `water.absorb`). */
    absorb: [number, number, number] = [0, 0, 0];
    /** Darkest shade floor (mapinfo `water.minColor`). */
    minColor: [number, number, number] = [0, 0, 0];

    constructor(material: Material) {
        // priority 210: after the DecalOverlayPlugin (200) so crater albedo
        // darkening composes under the water tint, matching draw order in
        // Recoil (decals bake into the ground before water shading applies).
        super(material, 'WaterAbsorption', 210, { WATER_ABSORPTION: false });
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
        defines.WATER_ABSORPTION = this._enabled;
    }

    getClassName(): string { return 'WaterAbsorptionPlugin'; }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'waterBaseColor', size: 3, type: 'vec3' },
                { name: 'waterAbsorbColor', size: 3, type: 'vec3' },
                { name: 'waterMinColor', size: 3, type: 'vec3' },
            ],
            fragment: `#ifdef WATER_ABSORPTION
                uniform vec3 waterBaseColor;
                uniform vec3 waterAbsorbColor;
                uniform vec3 waterMinColor;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        if (!this._enabled) return;
        uniformBuffer.updateFloat3('waterBaseColor', ...this.baseColor);
        uniformBuffer.updateFloat3('waterAbsorbColor', ...this.absorb);
        uniformBuffer.updateFloat3('waterMinColor', ...this.minColor);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType === 'fragment') {
            return {
                // Runs after baseColor is established, before the light loop.
                // Formula from SMFFragProg.glsl - vertexStepHeight caps at 1023
                // elmos and the shade blends in over the first 10 elmos of
                // depth (SMF_SHALLOW_WATER_DEPTH) so shorelines stay ground-lit
                CUSTOM_FRAGMENT_BEFORE_LIGHTS: `#ifdef WATER_ABSORPTION
                    if (vPositionW.y < 0.0) {
                        float _waDepth = min(1023.0, -vPositionW.y);
                        float _waBlend = clamp(-vPositionW.y * 0.1, 0.0, 1.0);
                        vec3 _waShade = max(waterMinColor, waterBaseColor - waterAbsorbColor * _waDepth);
                        baseColor.rgb = mix(baseColor.rgb, baseColor.rgb * _waShade, _waBlend);
                    }
                #endif`,
            };
        }
        return null;
    }
}

/** Attach the underwater-absorption plugin to a material with the map's
 *  authored colours. Callers gate on Recoil's `HasVisibleWater()` condition
 *  (map min height < 0 and not voidWater) — see SMFRenderState.cpp:116. */
export function attachWaterAbsorption(
    material: Material, colors: MapWaterAbsorption,
): WaterAbsorptionPlugin {
    const plugin = new WaterAbsorptionPlugin(material);
    plugin.baseColor = [...colors.baseColor];
    plugin.absorb = [...colors.absorb];
    plugin.minColor = [...colors.minColor];
    plugin.isEnabled = true;
    return plugin;
}
