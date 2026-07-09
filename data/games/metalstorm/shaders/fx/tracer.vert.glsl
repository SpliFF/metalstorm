#version 300 es
// tracer.vert.glsl — Metalstorm kinetic projectile tracer / rail streak.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). The bright travelling
// streak of a kinetic round: autocannon / MG tracers (short, warm) and the
// railgun / dreadnought-rail slug (long, thin, white-blue, intense HDR core).
// PLAN-metalstorm.md §6 — "most small/medium kinetic fire resolves
// statistically with cosmetic tracers"; this is that cosmetic.
//
// Modelled on the shipped BAR/ZK beam + laser shaders
// (client/src/core/shaders/projectile-beam.ts + projectile-laser.ts): a quad
// stretched along the travel axis, camera-billboarded around it (STRETCH mode),
// with the head bright and the tail tapering. The renderer updates `headPos`
// each frame for a projectile-following tracer (JS owns the lifecycle); a
// fire-and-forget impact spark can instead let the lifetime fade carry it.
//
// -- Per-instance attribute packing (4 × vec4; divisor 1) --------------------
//   iHeadLife = (headPos.xyz, lifetime)      lifetime<=0 → free slot (culled)
//   iVelTime  = (vel.xyz, birthTime)         vel → axis + length direction
//   iShape    = (length, width, coreBoost, taper)
//   iColor    = tracer colour RGB + peak alpha
//
// Blend: additive, blendFunc(ONE, ONE). Depth test ON, write OFF.

precision highp float;

layout(location = 0) in vec2 aCorner;   // [-0.5, 0.5]
layout(location = 1) in vec2 aUV;       // [0, 1]

layout(location = 2) in vec4 iHeadLife;
layout(location = 3) in vec4 iVelTime;
layout(location = 4) in vec4 iShape;
layout(location = 5) in vec4 iColor;

uniform mat4  uViewProj;
uniform float uNow;
uniform vec3  uCamPos;

out float vAlong;      // 0 head → 1 tail
out float vAcross;     // -1 .. 1 across the streak
out vec4  vColor;
out float vFade;       // lifetime fade
out float vCoreBoost;  // per-instance HDR core mult (railgun high, MG low)
out float vTaper;      // per-instance tail taper exponent

void main() {
    float lifetime  = iHeadLife.w;
    float birthTime = iVelTime.w;
    float age = uNow - birthTime;

    if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAlong = 0.0; vAcross = 0.0; vColor = vec4(0.0); vFade = 0.0;
        return;
    }

    vec3  head      = iHeadLife.xyz;
    float streakLen = iShape.x;              // named to avoid shadowing length()
    float width     = iShape.y;

    // Travel axis; fall back to a stable axis if velocity is ~0.
    vec3  vel = iVelTime.xyz;
    float vl  = length(vel);
    vec3  axis = (vl < 1e-3) ? vec3(0.0, 0.0, 1.0) : vel / vl;

    // Across = camera-perpendicular to the travel axis so the streak stays
    // edge-on (STRETCH billboard). Degenerate when staring down the axis →
    // lock to a stable perpendicular to avoid a NaN.
    vec3  view   = normalize(uCamPos - head);
    vec3  across = cross(axis, view);
    float al     = length(across);
    across = (al < 1e-3) ? normalize(vec3(axis.z, 0.0, -axis.x)) : across / al;

    float along  = aCorner.y + 0.5;          // 0 head → 1 tail
    // Head at `head`, tail trailing back along -axis by `streakLen`.
    vec3 worldPos = head
                  - axis   * (along * streakLen)
                  + across * (aCorner.x * width);

    gl_Position = uViewProj * vec4(worldPos, 1.0);

    vAlong     = along;
    vAcross    = aCorner.x * 2.0;             // -1 .. 1
    vColor     = iColor;
    vFade      = clamp(1.0 - age / lifetime, 0.0, 1.0);
    vCoreBoost = iShape.z;
    vTaper     = iShape.w;
}
