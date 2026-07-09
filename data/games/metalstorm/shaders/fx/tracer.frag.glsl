#version 300 es
// tracer.frag.glsl — Metalstorm kinetic tracer / rail streak fragment.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). Pairs with
// tracer.vert.glsl. A hot solid core down the centre-line that softens toward
// the edges (across) and tapers from head to tail (along). Pure additive — a
// tracer only ADDS light, so it can never darken the scene; the HDR core
// (coreBoost, colour >1) lets bloom blow the head to white for the rail look.

precision highp float;

uniform vec3      uColorScale;    // optional global tint mult (default 1,1,1)
uniform sampler2D uTex;           // optional soft-dot texture across the streak
uniform float     uHasTex;

in float vAlong;     // 0 head → 1 tail
in float vAcross;    // -1 .. 1
in vec4  vColor;
in float vFade;
in float vCoreBoost; // per-instance HDR core mult (railgun high, MG low)
in float vTaper;     // per-instance tail taper exponent

out vec4 fragColor;

void main() {
    // Across profile: solid bright core, soft edge. Optional texture refines it.
    float dx    = abs(vAcross);
    float core  = 1.0 - smoothstep(0.15, 1.0, dx);
    float edgeA = (uHasTex > 0.5) ? texture(uTex, vec2(0.5, dx * 0.5 + 0.5)).a : core;

    // Along taper: head bright, tail fades out.
    float tail  = pow(1.0 - vAlong, max(vTaper, 0.5));

    float intensity = edgeA * tail * vFade * vColor.a;
    vec3  rgb = vColor.rgb * uColorScale * (1.0 + vCoreBoost * core);

    // Premultiplied additive (blendFunc ONE, ONE).
    fragColor = vec4(rgb * intensity, intensity);
}
