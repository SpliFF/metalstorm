#version 300 es
// trail.vert.glsl — Metalstorm projectile smoke / exhaust trail ribbon.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). One camera-facing
// ribbon segment per pair of consecutive trail nodes, thin-instanced — the
// smoke plume behind guided missiles (AA / cruise), the exhaust of bombs, and
// (tinted + rising) the bubble wake of torpedoes / depth charges. Modelled on
// the shipped BAR/ZK trail shader (client/src/core/shaders/projectile-trail.ts),
// but self-contained: endpoints are passed as attributes and the quad is built
// in-shader (no Babylon per-segment matrix / instancesDeclaration).
//
// The JS trail system pushes a node per few frames behind each live projectile
// and emits one segment instance per node pair; older nodes fade via the
// per-end alpha. Continuous smoke plumes with zero per-frame CPU per particle.
//
// -- Per-instance attribute packing (3 × vec4; divisor 1) --------------------
//   iP1      = (pos1.xyz, width1)     younger node (nearer projectile)
//   iP2      = (pos2.xyz, width2)     older node
//   iUVAlpha = (uMin, uMax, a1, a2)   U sub-rect along length + per-end alpha
//
// Blend: premultiplied additive, blendFunc(ONE, ONE). Depth test ON, write OFF.

precision highp float;

layout(location = 0) in vec2 aCorner;   // x across [-0.5,0.5]; y selects end
layout(location = 1) in vec2 aUV;       // unused (kept for a shared quad VBO)

layout(location = 2) in vec4 iP1;
layout(location = 3) in vec4 iP2;
layout(location = 4) in vec4 iUVAlpha;

uniform mat4 uViewProj;
uniform vec3 uCamPos;

out vec2  vUV;
out float vAlpha;

void main() {
    float along = aCorner.y + 0.5;           // 0 → p1 (young), 1 → p2 (old)
    vec3  pos   = mix(iP1.xyz, iP2.xyz, along);
    float width = mix(iP1.w,   iP2.w,   along);

    // Camera-facing ribbon "out" axis: perpendicular to both the segment edge
    // and the view direction. Degenerate (edge staring at camera) → world up.
    vec3  edge = iP2.xyz - iP1.xyz;
    float el   = length(edge);
    edge = (el < 1e-4) ? vec3(0.0, 0.0, 1.0) : edge / el;
    vec3  view = normalize(uCamPos - pos);
    vec3  out_ = cross(edge, view);
    float ol   = length(out_);
    out_ = (ol < 1e-4) ? vec3(0.0, 1.0, 0.0) : out_ / ol;

    vec3 worldPos = pos + out_ * (aCorner.x * width);
    gl_Position = uViewProj * vec4(worldPos, 1.0);

    // U tiles along the ribbon length; V runs across it.
    vUV    = vec2(mix(iUVAlpha.x, iUVAlpha.y, along), aCorner.x + 0.5);
    vAlpha = mix(iUVAlpha.z, iUVAlpha.w, along);
}
