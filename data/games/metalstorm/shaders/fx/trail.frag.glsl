#version 300 es
// trail.frag.glsl — Metalstorm projectile trail fragment.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). Pairs with
// trail.vert.glsl. Samples the smoketrail strip from the FX atlas, applies the
// per-def tint (grey rocket smoke, dark bomb exhaust, pale-blue torpedo
// bubbles), and weights by the interpolated per-end alpha. Premultiplied
// additive so the fading tail contributes nothing.

precision highp float;

uniform sampler2D uTrailTex;
uniform vec3      uTint;

in vec2  vUV;
in float vAlpha;

out vec4 fragColor;

void main() {
    vec4 t = texture(uTrailTex, vUV);
    float a = t.a * vAlpha;
    fragColor = vec4(t.rgb * uTint * a, a);
}
