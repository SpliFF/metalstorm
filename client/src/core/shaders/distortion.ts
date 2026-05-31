/**
 * Distortion shaders — screen-space heat-haze / shockwave warp.
 *
 * PLAN-weapon-fx-gaps.md Phase D. ZK's distortion classes
 * (`ShockWave`, `SphereDistortion`, `UnitJitter`, `UnitCloaker`) render
 * signed-UV offsets into an FBO that a post-process samples to warp the
 * scene. On GL4 the offset accumulation uses `imageStore`; the chosen
 * WebGL2 substitute is additive blending (`ALPHA_ONEONE`) into an
 * `RGBA16F` target — see PLAN row "G3 distortion".
 *
 * Two programs live here:
 *
 *  - **Offset emitter** (`distortionEmitter`) — a GPU-integrated,
 *    thin-instanced billboard, one instance per distortion source. Birth
 *    state is uploaded once per source (mirrors the CEG-particle model in
 *    shaders/ceg-particle.ts); the vertex shader expands the quad from a
 *    single `uNow` clock and the fragment writes a *signed radial UV
 *    offset* (RG) shaped as an expanding ring. Rendered additively into
 *    the offset target so overlapping shocks sum.
 *
 *  - **Composite** (`distortionComposite`) — a full-screen post-process
 *    that samples the rendered scene at `vUV + offset.rg * uStrength`,
 *    producing the warp. `offset` is zero everywhere there's no live
 *    distortion, so undistorted pixels pass through untouched.
 *
 * Written GLSL-ES-1.00 style (`attribute`/`varying`/`texture2D`);
 * Babylon's shader processor rewrites to 300 es on WebGL2.
 */

import { Effect } from '@babylonjs/core';

/// Offset-emitter vertex shader. Instance attributes:
///   iPosLife = (centre.xyz, lifetime)        lifetime<=0 → free slot
///   iVelTime = (_, _, _, birthTime)
///   iParams  = (maxRadius, strength, _, _)
export const DISTORTION_EMITTER_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec4 iPosLife;
    attribute vec4 iVelTime;
    attribute vec4 iParams;
    #include<instancesDeclaration>

    uniform mat4 uViewProj;
    uniform float uNow;
    uniform vec3 uCamPos;

    varying vec2 vLocal;   // quad-local coord in [-1,1]
    varying vec2 vShape;   // (t, strength)

    void main() {
        float lifetime  = iPosLife.w;
        float birthTime = iVelTime.w;
        float age = uNow - birthTime;

        if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // cull off-screen
            vLocal = vec2(0.0);
            vShape = vec2(0.0);
            return;
        }

        float t        = age / lifetime;            // 0 birth → 1 death
        vec3  centre   = iPosLife.xyz;
        float maxR     = iParams.x;
        float strength = iParams.y;

        // The shock front expands to maxR over the lifetime; the quad
        // tracks it (with a small floor so age-0 isn't degenerate).
        float curR = max(maxR * t, maxR * 0.05);

        // Horizon-locked camera billboard (same basis as ceg-particle).
        vec3 f = normalize(uCamPos - centre);
        vec3 r = normalize(vec3(f.z, 0.0, -f.x));
        vec3 u = cross(f, r);
        // position spans +/-0.5 → multiply by 2*curR to cover +/-curR.
        vec3 worldPos = centre + (r * position.x + u * position.y) * (curR * 2.0);

        // Static identity instance matrix keeps Babylon's thin-instance
        // draw path standard; the real transform is computed above.
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        gl_Position = uViewProj * finalWorld * vec4(worldPos, 1.0);

        vLocal = position.xy * 2.0;
        vShape = vec2(t, strength);
    }
`;

/// Offset-emitter fragment shader. Writes signed radial offset into RG;
/// B unused; A carries the (positive) magnitude for debugging/inspection.
export const DISTORTION_EMITTER_FRAGMENT = `
    precision highp float;

    varying vec2 vLocal;
    varying vec2 vShape;

    void main() {
        float t        = vShape.x;
        float strength = vShape.y;
        float rr = length(vLocal);

        // Thin ring profile near the quad edge (the shock front), killed
        // outside the quad so the billiard quad's square corners don't leak.
        float band  = exp(-pow((rr - 0.8) / 0.18, 2.0));
        float clip  = smoothstep(1.05, 0.95, rr);
        float ring  = band * clip;

        float mag = ring * (1.0 - t) * strength;
        vec2  dir = rr > 1e-3 ? vLocal / rr : vec2(0.0);

        // Signed radial offset (outward). Additive blend sums overlaps.
        gl_FragColor = vec4(dir * mag, 0.0, mag);
    }
`;

/// Full-screen composite. `textureSampler` + `vUV` are supplied by
/// Babylon's default post-process vertex shader.
export const DISTORTION_COMPOSITE_FRAGMENT = `
    precision highp float;

    uniform sampler2D textureSampler;   // rendered scene
    uniform sampler2D offsetSampler;     // RG = accumulated signed UV offset
    uniform float uStrength;             // UV displacement scale

    varying vec2 vUV;

    void main() {
        vec2 off = texture2D(offsetSampler, vUV).rg;
        vec2 warpedUV = vUV + off * uStrength;
        gl_FragColor = texture2D(textureSampler, warpedUV);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore. The
/// emitter is a named material program; the composite is a post-process
/// fragment (Babylon pairs it with the built-in `postprocess` vertex).
export function registerDistortionShaders(): void {
    if (registered) return;
    Effect.ShadersStore['distortionEmitterVertexShader'] = DISTORTION_EMITTER_VERTEX;
    Effect.ShadersStore['distortionEmitterFragmentShader'] = DISTORTION_EMITTER_FRAGMENT;
    Effect.ShadersStore['distortionCompositeFragmentShader'] = DISTORTION_COMPOSITE_FRAGMENT;
    registered = true;
}
