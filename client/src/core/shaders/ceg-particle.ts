/**
 * CEG particle shader — billboard sprite with per-instance tint+alpha.
 *
 * Geometry: a unit quad (1×1, centred on origin) thin-instanced once
 * per live particle. The CPU side composes a camera-facing world
 * matrix (with the per-particle current size baked into the scale)
 * and a per-instance `tint` vec4 carrying the current RGB colour and
 * lifetime-derived alpha — both interpolated CPU-side from the
 * spawn's start/end values so the shader stays texture-agnostic.
 *
 * Output is premultiplied-alpha additive (paired with alphaMode = 7
 * in the material, same convention as the trail and beam shaders),
 * so faded particles contribute nothing to the framebuffer once
 * alpha hits zero — keeps the rendering correct under heavy overdraw
 * during cluster impacts.
 */

import { Effect } from '@babylonjs/core';

export const CEG_PARTICLE_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    attribute vec4 tint;
    #include<instancesDeclaration>
    uniform mat4 viewProjection;

    varying vec2 vUV;
    varying vec4 vTint;

    void main() {
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        vUV = uv;
        vTint = tint;
        gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
    }
`;

export const CEG_PARTICLE_FRAGMENT = `
    precision highp float;

    uniform sampler2D particleTex;

    varying vec2 vUV;
    varying vec4 vTint;

    void main() {
        vec4 t = texture2D(particleTex, vUV);
        float a = t.a * vTint.a;
        gl_FragColor = vec4(t.rgb * vTint.rgb * a, a);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore. Called
/// from the runtime when the first particle class is materialised; no-op
/// after the first invocation in a session.
export function registerCegParticleShader(): void {
    if (registered) return;
    Effect.ShadersStore['cegParticleVertexShader'] = CEG_PARTICLE_VERTEX;
    Effect.ShadersStore['cegParticleFragmentShader'] = CEG_PARTICLE_FRAGMENT;
    registered = true;
}
