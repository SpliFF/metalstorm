/**
 * TeamColorPlugin — replaces the per-piece albedo with the owning team's colour
 * where a team-mask texture says so, injected into Babylon's stock `PBRMaterial`.
 *
 * This is the ONE thing a plain PBR material can't express on its own, and it
 * was the only real reason unit rendering used a hand-rolled `ShaderMaterial`
 * (which then had to re-implement sun + ambient + CSM shadows manually — the
 * source of the weak self-shadow / sun-independent-grey bugs). By moving team
 * colour to a MaterialPlugin we get correct PBR + Babylon's real shadow system
 * for free (identical to how feature-renderer.ts already draws map features),
 * and the model matches the authored glTF/three.js look.
 *
 * Recoil/ZK express the team-colour step as a straight replace of the diffuse
 * with the team tint where the mask is full (`mix(albedo, teamColor, mask)`),
 * NOT a modulate — see ModelFragProg.glsl / ModelFragProgGL4_CUS.glsl. We do the
 * same, in the CUSTOM_FRAGMENT_UPDATE_ALBEDO hook so the tint feeds the full PBR
 * light loop (shadows, roughness, metallic) exactly like the base albedo.
 */

import { MaterialPluginBase, Material, Color3, Texture } from '@babylonjs/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDefines = any;

export class TeamColorPlugin extends MaterialPluginBase {
    /** The owning team's colour (per (defId, team) material bucket). */
    teamColor: Color3 = new Color3(1, 1, 1);
    /** R8 mask: R = team-colour blend amount. Null → no tint when the albedo
     *  is a real authored texture: a missing mask must keep the texture rather
     *  than flood the piece with team colour (that regression turned the
     *  maskless wz_* baseline solid lavender).
     *
     *  FIDELITY: this is a deliberate deviation from Recoil. Recoil's S3O
     *  convention treats tex1 alpha = 1 as "full team tint" — a maskless model
     *  there floods with team colour. Our texture pipeline splits the mask into
     *  a dedicated R8 KTX2; when that sidecar is absent we deliberately keep
     *  the authored albedo instead (see `syntheticAlbedo` for the one case
     *  that still wants the flood). */
    teamMask: Texture | null = null;
    /** Flip the mask interpretation (modinfo `invertteamcolor`). Only
     *  meaningful when a mask is bound — maskless materials ignore it
     *  (there is no mask to invert; letting it flip the implicit 0 would
     *  re-introduce the full-tint flood on maskless models in
     *  `invertteamcolor` mods). */
    invertMask = false;
    /** True when the bound albedo is the synthesized 1×1 white fallback
     *  (model has geometry but no texture config — e.g. ZK's `factoryveh`).
     *  Restores the "flat team-coloured shape" look for those models: with a
     *  white albedo and no mask, the maskless-no-tint rule above would render
     *  them flat white with zero team identification, so this flag forces a
     *  full team tint instead. Never set for real authored albedos. */
    syntheticAlbedo = false;

    constructor(material: Material) {
        // priority 100: albedo tweak, well before the water (210) / decal (200)
        // terrain plugins (which never coexist on a unit material anyway).
        super(material, 'TeamColor', 100,
            { TEAM_COLOR: false, TEAM_MASK: false, TEAM_FULL_TINT: false });
        this._enable(true);
    }

    prepareDefines(defines: AnyDefines): void {
        defines.TEAM_COLOR = true;
        defines.TEAM_MASK = this.teamMask != null;
        defines.TEAM_FULL_TINT = this.teamMask == null && this.syntheticAlbedo;
    }

    getClassName(): string { return 'TeamColorPlugin'; }

    getSamplers(samplers: string[]): void {
        samplers.push('teamMaskTex');
    }

    getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
        return {
            ubo: [
                { name: 'uTeamColor', size: 3, type: 'vec3' },
                { name: 'uInvertMask', size: 1, type: 'float' },
            ],
            fragment: `#ifdef TEAM_COLOR
                uniform vec3 uTeamColor;
                uniform float uInvertMask;
            #endif`,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bindForSubMesh(uniformBuffer: any): void {
        uniformBuffer.updateColor3('uTeamColor', this.teamColor);
        uniformBuffer.updateFloat('uInvertMask', this.invertMask ? 1.0 : 0.0);
        if (this.teamMask) uniformBuffer.setTexture('teamMaskTex', this.teamMask);
    }

    getCustomCode(shaderType: string): { [k: string]: string } | null {
        if (shaderType !== 'fragment') return null;
        return {
            CUSTOM_FRAGMENT_DEFINITIONS: `#ifdef TEAM_MASK
                uniform sampler2D teamMaskTex;
            #endif`,
            // surfaceAlbedo is live here (right after the albedo texture sample,
            // before the PBR light loop). vMainUV1 is the shared UV0 varying —
            // all unit textures use one UV set, so PBRMaterial emits vMainUV1.
            // The invert lives INSIDE the TEAM_MASK branch: it flips a mask
            // sample, not the maskless/full-tint constants (a maskless model
            // in an `invertteamcolor` mod must not flood with team colour).
            CUSTOM_FRAGMENT_UPDATE_ALBEDO: `#ifdef TEAM_COLOR
                #ifdef TEAM_MASK
                    float _tcMask = texture2D(teamMaskTex, vMainUV1).r;
                    if (uInvertMask > 0.5) _tcMask = 1.0 - _tcMask;
                #elif defined(TEAM_FULL_TINT)
                    float _tcMask = 1.0;
                #else
                    float _tcMask = 0.0;
                #endif
                surfaceAlbedo = mix(surfaceAlbedo, uTeamColor, _tcMask);
            #endif`,
        };
    }
}
