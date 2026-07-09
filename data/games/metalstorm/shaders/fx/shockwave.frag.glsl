#version 300 es
// shockwave.frag.glsl — Metalstorm shockwave emitter fragment.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). Pairs with
// shockwave.vert.glsl. Writes a thin expanding RING of signed radial UV offset
// into RG of the RGBA16F offset target (B unused; A carries the positive
// magnitude for debug inspection). The ring sits near the quad edge (the shock
// front) and is clipped inside the quad so its square corners never leak.
// Additive blend sums overlapping shocks.

precision highp float;

in vec2 vLocal;    // [-1, 1]
in vec2 vShape;    // (t, strength)

out vec4 fragColor;

void main() {
    float t        = vShape.x;
    float strength = vShape.y;
    float rr       = length(vLocal);

    // Thin ring profile near the front; killed outside the quad.
    float band = exp(-pow((rr - 0.8) / 0.18, 2.0));
    float clip = smoothstep(1.05, 0.95, rr);
    float ring = band * clip;

    // Fade the displacement out over life so the warp relaxes as it expands.
    float mag = ring * (1.0 - t) * strength;
    vec2  dir = rr > 1e-3 ? vLocal / rr : vec2(0.0);

    // Signed radial (outward) offset in RG.
    fragColor = vec4(dir * mag, 0.0, mag);
}
