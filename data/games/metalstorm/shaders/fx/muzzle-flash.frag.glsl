#version 300 es
// muzzle-flash.frag.glsl — Metalstorm weapon muzzle flash fragment.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). Pairs with
// muzzle-flash.vert.glsl. A soft radial star profile makes the quad read as a
// round flash with a hot core even before any flare texture resolves; with a
// texture (uHasTex>0.5) it modulates the authored sprite. Additive output so a
// muzzle only ever adds light (its glow rides the bloom pass, faithful to ZK —
// no muzzle point-light, see client/src/core/fx-light-pool.ts).

precision highp float;

uniform sampler2D uTex;
uniform float     uHasTex;

in vec2  vLocal;
in vec4  vColor;
in float vFade;

out vec4 fragColor;

void main() {
    float rr = length(vLocal);

    // Soft round core so the quad never shows square corners untextured.
    float radial = 1.0 - smoothstep(0.0, 1.0, rr);
    // A few star spikes on top of the core — cheap, reads as a gun flash.
    float ang    = atan(vLocal.y, vLocal.x);
    float spikes = 0.35 * pow(max(0.0, cos(ang * 4.0)), 8.0) * (1.0 - smoothstep(0.0, 1.2, rr));
    float shape  = radial + spikes;

    vec2 uv = vLocal * 0.5 + 0.5;
    vec4 t  = (uHasTex > 0.5) ? texture(uTex, uv) : vec4(1.0);
    float a = t.a * shape * vColor.a * vFade;

    // Premultiplied additive (blendFunc ONE, ONE). HDR colour (>1) blooms.
    fragColor = vec4(vColor.rgb * t.rgb * a, a);
}
