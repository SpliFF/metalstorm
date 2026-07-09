#version 300 es
// region-overlay.frag.glsl — Metalstorm strategic region-control tint. STUB.
//
// NATIVE WebGL2 / GLSL ES 3.00 — authored directly for this engine
// (PLAN-metalstorm.md §9). No GL4 features, no translator dependency.
// Tints terrain by region control (game_regions.lua grid) at strategic zoom
// (PLAN-macro-map.md T2/T3 tiers).
//
// Feeding plan: uRegionTex is a small RGBA8 texture (one texel per region)
// uploaded from the client's region-control mirror; alpha ramps in with
// camera height (zoom tier cross-fade).

precision mediump float;

uniform sampler2D uRegionTex;     // texel per region: team colour, a = control strength
uniform vec2  uMapSizeElmos;      // map extent in elmos
uniform float uOverlayStrength;   // 0..1 — zoom-tier fade

in vec2 vWorldXZ;                 // fragment world position (x, z)
out vec4 fragColor;

void main() {
    vec2 uv = vWorldXZ / uMapSizeElmos;
    vec4 region = texture(uRegionTex, uv);
    // Soft tint only — the strategic map stays readable (chart style).
    fragColor = vec4(region.rgb, region.a * 0.25 * uOverlayStrength);
}
