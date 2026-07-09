#version 300 es
// muzzle-flash.vert.glsl — Metalstorm weapon muzzle flash.
//
// NATIVE WebGL2 / GLSL ES 3.00 (PLAN-metalstorm.md §9). A short-lived additive
// camera-facing billboard punched out at the barrel on `weapon_fired`
// (effects/weapon-fx.json `muzzle`, driven by the fx-offload §2 onEvent
// binding). Modelled on the shipped BAR/ZK muzzle-flare shader
// (client/src/core/shaders/muzzle-flare.ts).
//
// One instance per shot; birth-state model (age = uNow - birthTime). The flash
// punches on instantly, expands slightly, and eases out — reads as a flash,
// not a fade-in. Kinetic guns (autocannon/railgun/howitzer) author a bigger,
// warmer flash than small arms (MG); the size + colour come from the effect
// library entry, not the shader.
//
// -- Per-instance attribute packing (3 × vec4; divisor 1) --------------------
//   iPosLife = (pos.xyz, lifetime)
//   iBirth   = (birthTime, size, spin, seed)
//   iColor   = flash colour RGB + peak alpha
//
// Blend: additive, blendFunc(ONE, ONE). Depth test ON, write OFF.

precision highp float;

layout(location = 0) in vec2 aCorner;   // [-0.5, 0.5]
layout(location = 1) in vec2 aUV;       // [0, 1]  (unused shape; radial in frag)

layout(location = 2) in vec4 iPosLife;
layout(location = 3) in vec4 iBirth;
layout(location = 4) in vec4 iColor;

uniform mat4  uViewProj;
uniform float uNow;
uniform vec3  uCamPos;

out vec2  vLocal;
out vec4  vColor;
out float vFade;

void main() {
    float lifetime  = iPosLife.w;
    float birthTime = iBirth.x;
    float age = uNow - birthTime;

    if (lifetime <= 0.0 || age < 0.0 || age >= lifetime) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vLocal = vec2(0.0); vColor = vec4(0.0); vFade = 0.0;
        return;
    }

    float t      = age / lifetime;          // 0 birth → 1 death
    vec3  centre = iPosLife.xyz;
    // A flash punches out fast then fades; expand slightly over life.
    float size   = iBirth.y * (1.0 + 0.6 * t);
    float spin   = iBirth.z * age + iBirth.w;  // per-shot rotation + seed jitter

    // Horizon-locked camera billboard (same basis as particle.vert.glsl),
    // rotated by `spin` so repeated shots don't strobe an identical sprite.
    vec3 f = normalize(uCamPos - centre);
    vec3 r = normalize(vec3(f.z, 0.0, -f.x));
    vec3 u = cross(f, r);
    float c = cos(spin), s = sin(spin);
    vec3 rr = r * c + u * s;
    vec3 uu = u * c - r * s;
    vec3 worldPos = centre + (rr * aCorner.x + uu * aCorner.y) * (size * 2.0);

    gl_Position = uViewProj * vec4(worldPos, 1.0);

    vLocal = aCorner * 2.0;                  // [-1, 1]
    vColor = iColor;
    // Sharp onset, ease-out tail — reads like a flash, not a fade-in.
    vFade = (1.0 - t) * (1.0 - t);
}
