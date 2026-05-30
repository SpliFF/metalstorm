/**
 * Laser-bolt shaft shader — additive textured quad with a per-instance
 * intensity (PLAN-weapon-fx-gaps.md Phase F item 3).
 *
 * The laser shaft/core/cap quads are thin-instanced (one+ instance per
 * live bolt). A plain `StandardMaterial` shares one emissive colour
 * across every bolt, so a bolt can't dim independently — which is why the
 * renderer used to fake the death animation by contracting `curLength`
 * for *all* bolts. This material adds a per-instance `iIntensity`
 * attribute the fragment folds into the output alpha, so each bolt fades
 * on its own (Recoil's non-hardstop `intensity` decay) over the one
 * shared draw path.
 *
 * `baseColor` is the raw shaft/core tint (NOT pre-multiplied by the
 * weapon's `intensity`); the per-instance `iIntensity` carries the
 * weapon-def intensity *and* the per-bolt fade, so a full-strength bolt
 * renders at `baseColor * intensity` exactly as the old emissive did.
 *
 * Additive (`ALPHA_ADD`): the texture alpha × intensity weights the
 * colour contribution, matching the old `StandardMaterial` additive path.
 *
 * GLSL-ES-1.00 style; Babylon rewrites to 300 es on WebGL2.
 */

import { Effect } from '@babylonjs/core';

export const PROJECTILE_LASER_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    attribute float iIntensity;
    #include<instancesDeclaration>

    uniform mat4 viewProjection;

    varying vec2 vUV;
    varying float vIntensity;

    void main() {
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
        vUV = uv;
        vIntensity = iIntensity;
    }
`;

export const PROJECTILE_LASER_FRAGMENT = `
    precision highp float;

    uniform vec3 baseColor;
    uniform sampler2D tex;
    uniform float hasTex;

    varying vec2 vUV;
    varying float vIntensity;

    void main() {
        vec4 t = (hasTex > 0.5) ? texture2D(tex, vUV) : vec4(1.0);
        // Additive: rgb carries the tint, alpha weights the contribution.
        gl_FragColor = vec4(baseColor * t.rgb, t.a * vIntensity);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore.
export function registerProjectileLaserShader(): void {
    if (registered) return;
    Effect.ShadersStore['projectileLaserVertexShader'] = PROJECTILE_LASER_VERTEX;
    Effect.ShadersStore['projectileLaserFragmentShader'] = PROJECTILE_LASER_FRAGMENT;
    registered = true;
}
