#version 300 es
// shockwave.vert.glsl — Metalstorm explosion shockwave / heat-haze emitter.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). The screen-space warp
// of a big kinetic blast (howitzer / cruise-missile / dreadnought-rail
// detonation): a GPU-integrated, camera-facing billboard, one instance per
// shock source, that writes a SIGNED radial UV offset (an expanding ring) into
// an RGBA16F offset target. A full-screen composite (shockwave-composite.*)
// then samples the scene displaced by that offset. Modelled on the shipped
// BAR/ZK distortion shader (client/src/core/shaders/distortion.ts), whose GL4
// imageStore accumulation is replaced by additive blending here.
//
// Birth-state model: the shock front expands to maxRadius over the lifetime.
//
// -- Per-instance attribute packing (2 × vec4; divisor 1) --------------------
//   iPosLife = (centre.xyz, lifetime)        lifetime<=0 → free slot (culled)
//   iParams  = (birthTime, maxRadius, strength, _)
//
// Blend into the offset target: additive, blendFunc(ONE, ONE) on RGBA16F so
// overlapping shocks sum. Depth test OFF (screen-space effect).

precision highp float;

layout(location = 0) in vec2 aCorner;   // [-0.5, 0.5]

layout(location = 1) in vec4 iPosLife;
layout(location = 2) in vec4 iParams;

uniform mat4  uViewProj;
uniform float uNow;
uniform vec3  uCamPos;

out vec2 vLocal;   // quad-local coord in [-1, 1]
out vec2 vShape;   // (t, strength)

void main() {
    float lifetime  = iPosLife.w;
    float birthTime = iParams.x;
    float age = uNow - birthTime;

    if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vLocal = vec2(0.0); vShape = vec2(0.0);
        return;
    }

    float t        = age / lifetime;         // 0 birth → 1 death
    vec3  centre   = iPosLife.xyz;
    float maxR     = iParams.y;
    float strength = iParams.z;

    // Shock front expands to maxR over life; small floor so age-0 isn't
    // degenerate.
    float curR = max(maxR * t, maxR * 0.05);

    // Horizon-locked camera billboard (same basis as particle.vert.glsl).
    vec3 f = normalize(uCamPos - centre);
    vec3 r = normalize(vec3(f.z, 0.0, -f.x));
    vec3 u = cross(f, r);
    vec3 worldPos = centre + (r * aCorner.x + u * aCorner.y) * (curR * 2.0);

    gl_Position = uViewProj * vec4(worldPos, 1.0);

    vLocal = aCorner * 2.0;
    vShape = vec2(t, strength);
}
