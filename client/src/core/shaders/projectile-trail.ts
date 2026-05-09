/**
 * Projectile trail shader — billboard sprite with per-instance alpha.
 *
 * Geometry: a unit quad (1×1, centred on origin) thin-instanced once
 * per live trail puff. The CPU side composes a camera-facing world
 * matrix per puff and fills the standard `world0..3` thin-instance
 * attribute (same as the cannon billboard pass). A custom per-
 * instance attribute `alpha` carries each puff's age-derived fade,
 * computed CPU-side as `1 - age / lifetime` so the shader stays
 * stateless w.r.t. spawn time.
 *
 * Output uses premultiplied-alpha additive (paired with alphaMode = 7
 * in the material, same convention as the beam and build-beam
 * shaders), so faded puffs contribute nothing to the framebuffer
 * once alpha hits zero.
 */

import { Effect } from '@babylonjs/core';

export const PROJECTILE_TRAIL_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    attribute float alpha;
    #include<instancesDeclaration>
    uniform mat4 viewProjection;

    varying vec2 vUV;
    varying float vAlpha;

    void main() {
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        vUV = uv;
        vAlpha = alpha;
        gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
    }
`;

export const PROJECTILE_TRAIL_FRAGMENT = `
    precision highp float;

    uniform sampler2D trailTex;
    uniform vec3 tint;

    varying vec2 vUV;
    varying float vAlpha;

    void main() {
        vec4 t = texture2D(trailTex, vUV);
        float a = t.a * vAlpha;
        gl_FragColor = vec4(t.rgb * tint * a, a);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore. Called
/// from the trail builder; no-op after the first invocation.
export function registerProjectileTrailShader(): void {
    if (registered) return;
    Effect.ShadersStore['projectileTrailVertexShader'] = PROJECTILE_TRAIL_VERTEX;
    Effect.ShadersStore['projectileTrailFragmentShader'] = PROJECTILE_TRAIL_FRAGMENT;
    registered = true;
}
