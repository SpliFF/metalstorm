/**
 * CEG particle shader — GPU-integrated billboard/ground/stretch sprite
 * with per-instance sub-rect atlas sampling and depth-based soft fade.
 *
 * Phase T2/T3 rewrite. Each live particle's *birth state* is uploaded
 * once (on spawn) as seven per-instance vec4 attributes; the CPU never
 * touches a particle again. The vertex shader does all per-frame work
 * from a single `uNow` clock uniform:
 *   - age = uNow - birthTime; dead / unborn / free slots are culled by
 *     emitting an off-screen clip position (the quad is discarded).
 *   - integrates position (birthPos + vel·age, with analytic gravity),
 *     lerps size + colour, derives the atlas frame, and composes the
 *     quad's world basis for one of three orientation modes
 *     (BILLBOARD / GROUND / STRETCH) — the work that used to live in the
 *     CPU `stepClass` + `compose*Matrix` helpers.
 *
 * A static identity thin-instance matrix buffer (written once at class
 * creation) drives Babylon's instanced draw + instance count; the shader
 * applies it as a no-op so instancing follows Babylon's standard path
 * while the real transform is computed here from the birth attributes.
 *
 * Instance attribute packing (7 × vec4):
 *   iPosLife  = (birthPos.xyz, lifetime)
 *   iVelTime  = (birthVel.xyz, birthTime)
 *   iSize     = (sizeStart, sizeEnd, gravity, stretch)
 *   iRot      = (rotBase, rotSpeed, orient, animFps)
 *   iAnim     = (animFrameStart, animFrameCount, _, _)
 *   iColStart = colourStart RGBA
 *   iColEnd   = colourEnd RGBA
 *
 * Soft particles (T3): the fragment samples a depth pre-pass of the
 * opaque scene and fades alpha as the quad approaches the surface behind
 * it, killing the hard "cardboard" intersection seam. `softRange <= 0`
 * (no depth target yet) leaves alpha untouched.
 *
 * Output is premultiplied-alpha additive (paired with alphaMode = 7),
 * so faded particles contribute nothing once alpha hits zero.
 *
 * Written in GLSL-ES-1.00 style (`attribute`/`varying`/`texture2D`);
 * Babylon's shader processor rewrites it to 300 es on WebGL2.
 */

import { Effect } from '@babylonjs/core';

export const CEG_PARTICLE_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    attribute vec4 iPosLife;   // xyz birthPos, w lifetime  (<=0 = free slot)
    attribute vec4 iVelTime;   // xyz birthVel, w birthTime
    attribute vec4 iSize;      // sizeStart, sizeEnd, gravity, stretch
    attribute vec4 iRot;       // rotBase, rotSpeed, orient, animFps
    attribute vec4 iAnim;      // animFrameStart, animFrameCount, _, _
    attribute vec4 iColStart;
    attribute vec4 iColEnd;
    #include<instancesDeclaration>

    uniform mat4 viewProjection;
    uniform float uNow;        // seconds, same clock as birthTime
    uniform vec3 camPos;
    uniform float atlasCols;
    uniform float atlasRows;

    varying vec2 vUV;
    varying vec2 vFrameOffset;
    varying vec4 vTint;

    void main() {
        float lifetime  = iPosLife.w;
        float birthTime = iVelTime.w;
        float age = uNow - birthTime;

        // Cull free slots (lifetime<=0), unborn (age<0), and expired
        // (age>=lifetime) by pushing the whole quad outside clip space.
        if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vUV = uv; vFrameOffset = vec2(0.0); vTint = vec4(0.0);
            return;
        }

        float t = age / lifetime;            // 0 at birth → 1 at death
        vec3  vel     = iVelTime.xyz;
        float gravity = iSize.z;

        // Analytic integration (matches the old semi-implicit Euler closely).
        vec3 center = iPosLife.xyz + vel * age;
        center.y -= 0.5 * gravity * age * age;

        float size    = mix(iSize.x, iSize.y, t);
        float stretch = iSize.w;
        float orient  = iRot.z;
        float rot     = iRot.x + iRot.y * age;

        // World-space right / up basis for the quad, per orientation mode.
        vec3 right, up;
        if (orient > 1.5) {
            // STRETCH — length axis along velocity, cylindrically
            // billboarded around it; width tracks the camera.
            vec3  axis = vel;
            float vl   = length(axis);
            if (vl < 1e-3) {
                vec3 f = normalize(camPos - center);
                vec3 r = normalize(vec3(f.z, 0.0, -f.x));
                right = r * size;
                up    = normalize(cross(f, r)) * size;
            } else {
                axis /= vl;
                vec3  view = normalize(camPos - center);
                vec3  r    = cross(axis, view);
                float rl   = length(r);
                r = (rl < 1e-3) ? vec3(1.0, 0.0, 0.0) : r / rl;
                right = r * size;
                up    = axis * (size * stretch);
            }
        } else if (orient > 0.5) {
            // GROUND — flat on the XZ plane, rotated by rot.
            float c = cos(rot), s = sin(rot);
            right = vec3(c, 0.0, s) * size;
            up    = vec3(-s, 0.0, c) * size;
        } else {
            // BILLBOARD — camera-facing, rotated around the view axis.
            vec3 f = normalize(camPos - center);
            vec3 r = normalize(vec3(f.z, 0.0, -f.x));
            vec3 u = cross(f, r);
            float c = cos(rot), s = sin(rot);
            right = (r * c + u * s) * size;
            up    = (u * c - r * s) * size;
        }

        // Unit quad spans +/-0.5; basis already carries the size scale.
        vec3 worldPos = center + right * position.x + up * position.y;

        // Static identity instance matrix — no-op, keeps Babylon's
        // thin-instance draw path standard.
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        gl_Position = viewProjection * finalWorld * vec4(worldPos, 1.0);

        vUV = uv;

        // Atlas frame → sub-rect offset.
        float animFps    = iRot.w;
        float frameStart = iAnim.x;
        float frameCount = iAnim.y;
        float frameIdx = frameStart;
        if (animFps > 0.0 && frameCount > 0.0) {
            frameIdx = frameStart + mod(floor(age * animFps), frameCount);
        }
        float col = mod(frameIdx, atlasCols);
        float row = mod(floor(frameIdx / atlasCols), atlasRows);
        vFrameOffset = vec2(col / atlasCols, row / atlasRows);

        // Colour ramp + lifetime fade (alpha tails off even for constant ramps).
        vec3  rgb = mix(iColStart.rgb, iColEnd.rgb, t);
        float a   = mix(iColStart.a, iColEnd.a, t) * (1.0 - t);
        vTint = vec4(rgb, a);
    }
`;

export const CEG_PARTICLE_FRAGMENT = `
    precision highp float;

    uniform sampler2D particleTex;
    uniform vec2 atlasDimsInv;

    // Soft-particle depth fade (T3). depthTex is a pre-pass of the opaque
    // scene storing hardware depth (gl_FragCoord.z); softRange<=0 disables.
    uniform sampler2D depthTex;
    uniform vec2 camNearFar;   // (near, far)
    uniform vec2 screenSize;   // render-target px
    uniform float softRange;   // elmos over which to fade (0 or less = off)

    varying vec2 vUV;
    varying vec2 vFrameOffset;
    varying vec4 vTint;

    float linearizeDepth(float d) {
        // d is window depth in 0..1 (WebGL NDC z = d*2-1).
        float ndc = d * 2.0 - 1.0;
        float n = camNearFar.x, f = camNearFar.y;
        return (2.0 * n * f) / (f + n - ndc * (f - n));
    }

    void main() {
        vec2 sampleUV = vFrameOffset + vUV * atlasDimsInv;
        vec4 tex = texture2D(particleTex, sampleUV);
        float a = tex.a * vTint.a;

        if (softRange > 0.0) {
            vec2  suv    = gl_FragCoord.xy / screenSize;
            float sceneD = texture2D(depthTex, suv).r;
            float sceneZ = linearizeDepth(sceneD);
            float fragZ  = linearizeDepth(gl_FragCoord.z);
            // Fade as the particle nears the surface behind it. Background
            // (sceneD≈1 → huge sceneZ) leaves the term at 1 → no fade.
            a *= clamp((sceneZ - fragZ) / softRange, 0.0, 1.0);
        }

        gl_FragColor = vec4(tex.rgb * vTint.rgb * a, a);
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
