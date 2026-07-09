#version 300 es
// particle.frag.glsl — Metalstorm FX particle fragment.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). Pairs with
// particle.vert.glsl. Samples a sub-rect of the FX sprite atlas
// (resources.lua groundfx/smoke atlas), applies the vertex tint, and fades
// against the opaque-scene depth pre-pass so particles never show a hard
// "cardboard" seam where they intersect terrain / units (soft particles).
//
// Output is PREMULTIPLIED additive: rgb already carries * a, and the material
// blends with blendFunc(ONE, ONE). A fully-faded particle contributes nothing.

precision highp float;

uniform sampler2D uParticleTex;   // FX sprite atlas
uniform vec2      uAtlasDimsInv;  // (1/atlasCols, 1/atlasRows) — one cell size

// Soft-particle depth fade. uDepthTex is a pre-pass of the opaque scene
// storing hardware depth (gl_FragCoord.z); uSoftRange<=0 disables the fade
// (e.g. before a depth target exists).
uniform sampler2D uDepthTex;
uniform vec2      uCamNearFar;    // (near, far) in elmos
uniform vec2      uScreenSize;    // render-target size in px
uniform float     uSoftRange;     // elmos over which to fade (<=0 = off)

in vec2 vUV;
in vec2 vFrameOffset;
in vec4 vTint;

out vec4 fragColor;

float linearizeDepth(float d) {
    // d is window depth 0..1 (WebGL NDC z = d*2-1).
    float ndc = d * 2.0 - 1.0;
    float n = uCamNearFar.x, f = uCamNearFar.y;
    return (2.0 * n * f) / (f + n - ndc * (f - n));
}

void main() {
    vec2 sampleUV = vFrameOffset + vUV * uAtlasDimsInv;
    vec4 tex = texture(uParticleTex, sampleUV);
    float a = tex.a * vTint.a;

    if (uSoftRange > 0.0) {
        vec2  suv    = gl_FragCoord.xy / uScreenSize;
        float sceneD = texture(uDepthTex, suv).r;
        float sceneZ = linearizeDepth(sceneD);
        float fragZ  = linearizeDepth(gl_FragCoord.z);
        // Fade as the particle nears the surface behind it. Background
        // (sceneD≈1 → huge sceneZ) leaves the term at 1 → no fade.
        a *= clamp((sceneZ - fragZ) / uSoftRange, 0.0, 1.0);
    }

    // Premultiplied additive (blendFunc ONE, ONE). HDR tints (>1) let the
    // bloom pass blow explosion cores to white (PLAN-lighting L1).
    fragColor = vec4(tex.rgb * vTint.rgb * a, a);
}
