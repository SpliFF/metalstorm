/**
 * CEG particle shader — billboard sprite with per-instance tint+alpha
 * and per-instance sub-rect sampling for sprite-atlas animation.
 *
 * Geometry: a unit quad (1×1, centred on origin) thin-instanced once
 * per live particle. The CPU side composes a camera-facing world
 * matrix (with the per-particle current size baked into the scale)
 * and a per-instance `tint` vec4 carrying the current RGB colour and
 * lifetime-derived alpha — both interpolated CPU-side from the
 * spawn's start/end values so the shader stays texture-agnostic.
 *
 * Atlas animation (Phase 5b): textures with an `_NxM` filename suffix
 * are sprite atlases. The runtime materialises one ParticleClass per
 * unique texture name and stores the dims as `atlasDimsInv = (1/N, 1/M)`
 * on the material. Each particle's current frame is computed CPU-side
 * (`floor(age * fps) mod frameCount`) and packed into a per-instance
 * `frameOffset = vec2(col/N, row/M)`. The fragment sampler reads
 * `frameOffset + uv * atlasDimsInv`, giving the sub-rect of the atlas
 * for the current frame. For non-atlas textures, `atlasDimsInv = (1,1)`
 * and `frameOffset = (0,0)` degrade the path to identity sampling at
 * zero extra cost.
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
    attribute vec2 frameOffset;
    #include<instancesDeclaration>
    uniform mat4 viewProjection;

    varying vec2 vUV;
    varying vec4 vTint;
    varying vec2 vFrameOffset;

    void main() {
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        vUV = uv;
        vTint = tint;
        vFrameOffset = frameOffset;
        gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
    }
`;

export const CEG_PARTICLE_FRAGMENT = `
    precision highp float;

    uniform sampler2D particleTex;
    uniform vec2 atlasDimsInv;

    varying vec2 vUV;
    varying vec4 vTint;
    varying vec2 vFrameOffset;

    void main() {
        // Sub-rect sampling: vFrameOffset selects the top-left of the
        // current atlas tile (in normalised UV space, already pre-
        // divided CPU-side), atlasDimsInv scales the unit-quad UV down
        // into one tile's worth. Non-atlas textures pass (1, 1) for
        // dimsInv and (0, 0) for offset → identity path.
        vec2 sampleUV = vFrameOffset + vUV * atlasDimsInv;
        vec4 t = texture2D(particleTex, sampleUV);

        // Untextured-class fallback: when the resolver couldn't find a
        // .ktx2 for this class's authored name, no particleTex was
        // bound and the WebGL default sampler returns transparent
        // black. With the material's premul-alpha additive blend
        // (alphaMode 7), an opaque-but-black RGBA would darken the
        // framebuffer to a hard black quad. Substitute a flat soft-
        // disc — same edge taper the projectile-beam shader uses for
        // missing texture1 — so the per-instance tint colour shows
        // through as a clean billboard.
        if (t.a < 0.004) {
            float dx = vUV.x - 0.5;
            float dy = vUV.y - 0.5;
            float r = sqrt(dx * dx + dy * dy) * 2.0;
            float disc = 1.0 - smoothstep(0.4, 1.0, r);
            t = vec4(1.0, 1.0, 1.0, disc);
        }

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
