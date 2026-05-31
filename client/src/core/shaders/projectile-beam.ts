/**
 * Projectile beam shader — textured stretched-quad with optional UV
 * scroll for Laser / BeamLaser / LargeBeamLaser projectiles.
 *
 * Geometry: a unit quad (1×1, centred on origin) thin-instanced once
 * per live beam. Per-instance world matrix encodes the beam axis and
 * birth time:
 *
 *   m[0]..m[2]   = unused
 *   m[3]         = halfWidth        (across-axis thickness)
 *   m[4]..m[6]   = alongVec.xyz     (end - start, magnitude = length)
 *   m[7]         = birthSec         (performance.now() / 1000 at spawn)
 *   m[8]..m[11]  = unused
 *   m[12]..m[14] = midpoint.xyz     (start + end) / 2
 *   m[15]        = 1
 *
 * The vertex shader rebuilds the camera-facing across-axis per frame
 * (perpendicular to both beam axis and view direction) so the quad
 * stays edge-on regardless of viewer position. The fragment shader
 * tiles the middle texture along the beam length and scrolls UVs by
 * `time * scrollRate / tileLength`. scrollRate is set to zero in the
 * builder for non-largeBeamLaser weapons (per Recoil semantics — only
 * LargeBeamLaserProjectile applies the scroll).
 *
 * One ShaderMaterial per weapon def: each carries its own beamTex,
 * baseColor, scrollRate, tileLength, and duration uniforms. Time is
 * the only per-frame uniform update.
 */

import { Effect } from '@babylonjs/core';

export const PROJECTILE_BEAM_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    #include<instancesDeclaration>
    uniform mat4 viewProjection;
    uniform vec3 cameraPosition;

    varying vec2 vUV;
    varying float vBirth;
    varying float vLength;

    void main() {
        vec3 alongVec = vec3(world1.x, world1.y, world1.z);
        vec3 mid      = vec3(world3.x, world3.y, world3.z);
        float halfW = world0.w;
        vBirth = world1.w;
        vLength = length(alongVec);

        // Camera-facing across-axis: perpendicular to both beam axis
        // and the view direction. Falls back to a stable axis if the
        // beam is staring straight at the camera (cross product would
        // be near zero) — we just lock to world up in that edge case
        // to avoid a NaN.
        vec3 viewDir = normalize(mid - cameraPosition);
        vec3 across  = cross(alongVec, viewDir);
        float acrossLen = length(across);
        if (acrossLen < 1e-3) {
            across = vec3(0.0, 1.0, 0.0);
        } else {
            across /= acrossLen;
        }
        across *= halfW;

        // position.x ∈ [-0.5, 0.5] across, position.y ∈ [-0.5, 0.5] along.
        vec3 worldPos = mid + across * (position.x * 2.0)
                            + alongVec * position.y;

        vUV = uv;
        gl_Position = viewProjection * vec4(worldPos, 1.0);
    }
`;

export const PROJECTILE_BEAM_FRAGMENT = `
    precision highp float;

    uniform sampler2D beamTex;
    uniform vec3 baseColor;
    /// Sim-time seconds, combined with vBirth for the fade and with
    /// scrollRate for the texture/noise pan (advances with game speed).
    uniform float time;
    /// elmos/sec the texture pattern scrolls along the beam axis.
    /// Builder zeroes this for non-largeBeamLaser weapons so plain
    /// BeamLaser renders as a static stripe (Recoil parity).
    uniform float scrollRate;
    /// Texture footprint in elmos — one tile spans this much beam
    /// length before the pattern repeats. Tunable per def.
    uniform float tileLength;
    /// Lifetime in seconds. Fade-out is linear from full intensity at
    /// birth to zero at birth + duration.
    uniform float duration;

    varying vec2 vUV;
    varying float vBirth;
    varying float vLength;

    // Cheap value noise (1-D) for the energy crackle along the beam.
    float hash1(float n) { return fract(sin(n) * 43758.5453123); }
    float vnoise(float x) {
        float i = floor(x);
        float f = fract(x);
        return mix(hash1(i), hash1(i + 1.0), smoothstep(0.0, 1.0, f));
    }

    void main() {
        float age = time - vBirth;
        float fade = clamp(1.0 - age / duration, 0.0, 1.0);

        // Noise phase along the beam length, scrolling with sim-time so
        // the turbulence flows along the beam. Two octaves.
        float lu = vUV.y * max(vLength, 1.0) * 0.06;
        float scroll = time * (scrollRate > 0.0 ? scrollRate * 0.02 : 1.0);
        float n1 = vnoise(lu * 3.0 + scroll * 3.0);
        float n2 = vnoise(lu * 9.0 - scroll * 5.0);

        // FIDELITY-STANDIN: this procedural crackle noise is NOT from Recoil —
        // Recoil's beam roughness comes from the authored beam TEXTURE
        // (laserfalloff / largebeam), not a shader noise function. PLAN.md
        // drift #4 / Stage D2: justify as an explicit allowance or remove in
        // favour of the authored texture pattern.
        // Now jitter the cross-position along the length so the glow EDGE
        // wobbles like a flame — a silhouette change reads through bloom.
        // Kept as a small +/- jitter around a SOLID base width so the beam
        // stays thick and bright (the over-wide version wisped it away).
        float dx = abs(vUV.x - 0.5) * 2.0;
        float dxJit = dx + (n1 - 0.5) * 0.16 + (n2 - 0.5) * 0.07;
        float crossA = 1.0 - smoothstep(0.22, 1.0, dxJit);

        // Gentle density flicker on top, clamped so it never darkens.
        float rough = mix(0.82, 1.0, n2);

        // Authored texture (largebeam etc.) adds extra structure where it
        // is opaque — additive only, so a dark texel can never subtract.
        float tileCount = max(vLength / max(tileLength, 1.0), 1.0);
        float scrollOffset = time * scrollRate / max(tileLength, 1.0);
        vec4 texel = texture2D(beamTex, vec2(vUV.x, fract(vUV.y * tileCount - scrollOffset)));
        float texAdd = texel.a * 0.35;

        float intensity = crossA * fade * (rough + texAdd);

        // PURE ADDITIVE output (paired with alphaMode = ONE_ONE in the
        // material): a beam only ever ADDS light to the scene, so it can
        // never darken the background — fixes the dark-band blend bug. The
        // HDR baseColor (>1) lets the bloom pass blow the core to white.
        gl_FragColor = vec4(baseColor * intensity, intensity);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore. Called
/// from the projectile renderer's beam builder; no-op after the first
/// invocation in a session.
export function registerProjectileBeamShader(): void {
    if (registered) return;
    Effect.ShadersStore['projectileBeamVertexShader'] = PROJECTILE_BEAM_VERTEX;
    Effect.ShadersStore['projectileBeamFragmentShader'] = PROJECTILE_BEAM_FRAGMENT;
    registered = true;
}
