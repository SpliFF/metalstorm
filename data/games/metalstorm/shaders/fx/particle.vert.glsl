#version 300 es
// particle.vert.glsl — Metalstorm GPU-integrated FX particle (billboard /
// ground / stretch sprite).
//
// NATIVE WebGL2 / GLSL ES 3.00 — authored directly for this engine
// (PLAN-metalstorm.md §9). No GL4 features, no Babylon shader-processor
// includes, no translator dependency. The kinetic-explosion / smoke / spark /
// dirt workhorse for every weapon family (weapons/weapons.lua).
//
// Modelled on the shipped BAR/ZK client particle shader
// (client/src/core/shaders/ceg-particle.ts): each live particle's BIRTH STATE
// is uploaded once (on spawn) as seven per-instance vec4 attributes; the CPU
// never touches a particle again. The vertex shader does all per-frame work
// from a single `uNow` clock — age = uNow - birthTime; dead / unborn / free
// slots self-cull by emitting an off-screen clip vertex. This is the
// GPU-resident, JS-lifecycle-only model PLAN-fx-offload.md §5 mandates.
//
// -- Draw setup (JS side, engine ask FX-1; see shaders/fx/README.md) ---------
//   * One base quad (aCorner in [-0.5,0.5], aUV in [0,1]) — 4 verts, 6 idx.
//   * Seven per-instance vec4 streams below, each vertexAttribDivisor(…, 1).
//   * gl.drawElementsInstanced(TRIANGLES, 6, …, liveCount).
//   * Blend: premultiplied additive — blendFunc(ONE, ONE) with the frag's
//     premultiplied output (see particle.frag.glsl). Depth test ON, write OFF.
//
// -- Per-instance attribute packing (mirrors ceg-particle.ts exactly) --------
//   iPosLife  = (birthPos.xyz, lifetime)     lifetime<=0 → free slot (culled)
//   iVelTime  = (birthVel.xyz, birthTime)    seconds, same clock as uNow
//   iSize     = (sizeStart, sizeEnd, gravity, stretch)
//   iRot      = (rotBase, rotSpeed, orient, animFps)   orient: 0 BB /1 GND /2 STR
//   iAnim     = (animFrameStart, animFrameCount, _, _)
//   iColStart = colourStart RGBA   (a is peak alpha; lifetime fade applied here)
//   iColEnd   = colourEnd   RGBA

precision highp float;

// Base quad geometry (non-instanced).
layout(location = 0) in vec2 aCorner;   // [-0.5, 0.5]
layout(location = 1) in vec2 aUV;       // [0, 1]

// Per-instance birth state (vertexAttribDivisor = 1).
layout(location = 2) in vec4 iPosLife;
layout(location = 3) in vec4 iVelTime;
layout(location = 4) in vec4 iSize;
layout(location = 5) in vec4 iRot;
layout(location = 6) in vec4 iAnim;
layout(location = 7) in vec4 iColStart;
layout(location = 8) in vec4 iColEnd;

uniform mat4  uViewProj;
uniform float uNow;        // seconds, same clock as birthTime
uniform vec3  uCamPos;
uniform float uAtlasCols;
uniform float uAtlasRows;

out vec2 vUV;
out vec2 vFrameOffset;
out vec4 vTint;

void main() {
    float lifetime  = iPosLife.w;
    float birthTime = iVelTime.w;
    float age = uNow - birthTime;

    // Cull free slots (lifetime<=0), unborn (age<0), expired (age>=lifetime)
    // by pushing the whole quad outside clip space — cheaper than a per-frame
    // CPU compaction of the instance buffer.
    if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
        gl_Position  = vec4(2.0, 2.0, 2.0, 1.0);
        vUV = aUV; vFrameOffset = vec2(0.0); vTint = vec4(0.0);
        return;
    }

    float t       = age / lifetime;          // 0 at birth → 1 at death
    vec3  vel     = iVelTime.xyz;
    float gravity = iSize.z;

    // Analytic integration (matches semi-implicit Euler closely) — no
    // transform feedback needed for the birth-state model.
    vec3 center = iPosLife.xyz + vel * age;
    center.y   -= 0.5 * gravity * age * age;

    float size    = mix(iSize.x, iSize.y, t);
    float stretch = iSize.w;
    float orient  = iRot.z;
    float rot     = iRot.x + iRot.y * age;

    // World-space right / up basis for the quad, per orientation mode.
    vec3 right, up;
    if (orient > 1.5) {
        // STRETCH — length axis along velocity, cylindrically billboarded
        // around it; width tracks the camera. Used for spark streaks / debris.
        vec3  axis = vel;
        float vl   = length(axis);
        if (vl < 1e-3) {
            vec3 f = normalize(uCamPos - center);
            vec3 r = normalize(vec3(f.z, 0.0, -f.x));
            right = r * size;
            up    = normalize(cross(f, r)) * size;
        } else {
            axis /= vl;
            vec3  view = normalize(uCamPos - center);
            vec3  r    = cross(axis, view);
            float rl   = length(r);
            r = (rl < 1e-3) ? vec3(1.0, 0.0, 0.0) : r / rl;
            right = r * size;
            up    = axis * (size * stretch);
        }
    } else if (orient > 0.5) {
        // GROUND — flat on the XZ plane, rotated by rot. Groundflash / scorch.
        float c = cos(rot), s = sin(rot);
        right = vec3(c, 0.0, s) * size;
        up    = vec3(-s, 0.0, c) * size;
    } else {
        // BILLBOARD — camera-facing, rotated around the view axis. Fireballs,
        // smoke puffs, muzzle heat.
        vec3 f = normalize(uCamPos - center);
        vec3 r = normalize(vec3(f.z, 0.0, -f.x));
        vec3 u = cross(f, r);
        float c = cos(rot), s = sin(rot);
        right = (r * c + u * s) * size;
        up    = (u * c - r * s) * size;
    }

    // Base quad spans +/-0.5; the basis already carries the size scale.
    vec3 worldPos = center + right * aCorner.x + up * aCorner.y;
    gl_Position = uViewProj * vec4(worldPos, 1.0);

    vUV = aUV;

    // Atlas frame → sub-rect offset (flipbook animation over life).
    float animFps    = iRot.w;
    float frameStart = iAnim.x;
    float frameCount = iAnim.y;
    float frameIdx   = frameStart;
    if (animFps > 0.0 && frameCount > 0.0) {
        frameIdx = frameStart + mod(floor(age * animFps), frameCount);
    }
    float col = mod(frameIdx, uAtlasCols);
    float row = mod(floor(frameIdx / uAtlasCols), uAtlasRows);
    vFrameOffset = vec2(col / uAtlasCols, row / uAtlasRows);

    // Colour ramp + lifetime fade (alpha tails off even for constant ramps).
    vec3  rgb = mix(iColStart.rgb, iColEnd.rgb, t);
    float a   = mix(iColStart.a, iColEnd.a, t) * (1.0 - t);
    vTint = vec4(rgb, a);
}
