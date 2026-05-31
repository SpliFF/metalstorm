/**
 * Muzzle-flare shader — GPU-integrated camera-facing flash billboard.
 *
 * PLAN-weapon-fx-gaps.md Phase F item 2. Recoil draws a muzzle flare on
 * weapon fire (sized by `muzzleFlareSize`, the weapon's flare texture);
 * we don't render it, so muzzles read only as a dynamic light. This is
 * the missing flare: a short-lived additive billboard at the firing
 * position, one thin instance per shot (birth-state model mirrors
 * shaders/ceg-particle.ts and shaders/distortion.ts).
 *
 * Instance attributes (3 × vec4):
 *   iPosLife = (pos.xyz, lifetime)
 *   iBirth   = (birthTime, size, _, _)
 *   iColor   = flash colour RGB + peak alpha
 *
 * A soft radial profile in the fragment makes the quad read as a round
 * flash even when no flare texture has resolved yet. Additive blend.
 *
 * GLSL-ES-1.00 style; Babylon rewrites to 300 es on WebGL2.
 */

import { Effect } from '@babylonjs/core';

export const MUZZLE_FLARE_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    attribute vec4 iPosLife;
    attribute vec4 iBirth;
    attribute vec4 iColor;
    #include<instancesDeclaration>

    uniform mat4 uViewProj;
    uniform float uNow;
    uniform vec3 uCamPos;

    varying vec2 vLocal;
    varying vec4 vColor;
    varying float vFade;

    void main() {
        float lifetime  = iPosLife.w;
        float birthTime = iBirth.x;
        float age = uNow - birthTime;

        if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vLocal = vec2(0.0); vColor = vec4(0.0); vFade = 0.0;
            return;
        }

        float t = age / lifetime;           // 0 birth → 1 death
        vec3  centre = iPosLife.xyz;
        // A flash punches out fast then fades; expand slightly over life.
        float size = iBirth.y * (1.0 + 0.6 * t);

        // Horizon-locked camera billboard (same basis as ceg-particle).
        vec3 f = normalize(uCamPos - centre);
        vec3 r = normalize(vec3(f.z, 0.0, -f.x));
        vec3 u = cross(f, r);
        vec3 worldPos = centre + (r * position.x + u * position.y) * (size * 2.0);

        mat4 finalWorld = mat4(world0, world1, world2, world3);
        gl_Position = uViewProj * finalWorld * vec4(worldPos, 1.0);

        vLocal = position.xy * 2.0;          // [-1,1]
        vColor = iColor;
        // Sharp onset, ease-out tail — reads like a flash, not a fade-in.
        vFade = (1.0 - t) * (1.0 - t);
    }
`;

export const MUZZLE_FLARE_FRAGMENT = `
    precision highp float;

    uniform sampler2D tex;
    uniform float hasTex;

    varying vec2 vLocal;
    varying vec4 vColor;
    varying float vFade;

    void main() {
        // Soft round profile so the quad never shows square corners even
        // without a texture; with a texture it modulates the sprite.
        float radial = 1.0 - smoothstep(0.0, 1.0, length(vLocal));
        vec2 uv = vLocal * 0.5 + 0.5;
        vec4 t = (hasTex > 0.5) ? texture2D(tex, uv) : vec4(1.0);
        float a = t.a * radial * vColor.a * vFade;
        // Premultiplied additive (paired with ALPHA_ONEONE).
        gl_FragColor = vec4(vColor.rgb * t.rgb * a, a);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore.
export function registerMuzzleFlareShader(): void {
    if (registered) return;
    Effect.ShadersStore['muzzleFlareVertexShader'] = MUZZLE_FLARE_VERTEX;
    Effect.ShadersStore['muzzleFlareFragmentShader'] = MUZZLE_FLARE_FRAGMENT;
    registered = true;
}
