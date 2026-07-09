#version 300 es
// shockwave-composite.frag.glsl — Metalstorm distortion composite.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). Pairs with
// fullscreen-tri.vert.glsl. A full-screen post pass that samples the rendered
// scene displaced by the accumulated signed UV offset (RG of the offset
// target the shockwave emitter wrote). Where there is no live shock the offset
// is zero, so undistorted pixels pass through untouched. Modelled on the
// shipped BAR/ZK distortion composite (client/src/core/shaders/distortion.ts).

precision highp float;

uniform sampler2D uScene;      // rendered scene colour
uniform sampler2D uOffset;     // RG = accumulated signed UV offset
uniform float     uStrength;   // UV displacement scale

in vec2 vUV;
out vec4 fragColor;

void main() {
    vec2 off = texture(uOffset, vUV).rg;
    vec2 warpedUV = vUV + off * uStrength;
    fragColor = texture(uScene, warpedUV);
}
