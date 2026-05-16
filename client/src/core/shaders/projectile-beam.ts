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
    /// Wall-clock seconds; combined with vBirth for the fade and
    /// with scrollRate for the UV pan.
    uniform float time;
    /// elmos/sec the texture pattern scrolls along the beam axis.
    /// Builder zeroes this for non-largeBeamLaser weapons so plain
    /// BeamLaser renders as a static stripe (Recoil parity).
    uniform float scrollRate;
    /// Texture footprint in elmos — one tile spans this much beam
    /// length before the pattern repeats. Tunable per def; 200 is a
    /// reasonable default for the standard largebeam texture.
    uniform float tileLength;
    /// Lifetime in seconds. Fade-out is linear from full alpha at
    /// birth to zero at birth + duration.
    uniform float duration;

    varying vec2 vUV;
    varying float vBirth;
    varying float vLength;

    void main() {
        float age = time - vBirth;
        float fade = clamp(1.0 - age / duration, 0.0, 1.0);

        // Tile the texture along the length axis. tileCount ≥ 1 so a
        // very short beam still shows the full pattern once.
        float tileCount = max(vLength / max(tileLength, 1.0), 1.0);
        // Scroll outward from the muzzle: as time advances, the same
        // world position samples a lower texture coordinate, which
        // reads as the pattern flowing toward the target.
        float scrollOffset = time * scrollRate / max(tileLength, 1.0);
        vec2 uvSampled = vec2(vUV.x, fract(vUV.y * tileCount - scrollOffset));
        vec4 texel = texture2D(beamTex, uvSampled);

        // Procedural cross-section: opaque centre, smooth shoulder
        // taper to the edges. Always drives the beam's primary alpha
        // so the stretched-quad reads as a coherent stripe regardless
        // of how the authored texture is patterned. ZK BeamLaser defs
        // typically ship with a "falloff" sprite — round halo with
        // alpha mostly zero — that, if used as the primary alpha,
        // would render the beam as scattered halo dots tiled along
        // the length instead of a connected line. The texture instead
        // brightens / colours the beam where it has alpha, on top of
        // the procedural shape.
        float dx = abs(vUV.x - 0.5) * 2.0;
        float crossA = 1.0 - smoothstep(0.6, 1.0, dx);

        float alpha = crossA * fade;
        // Texture contribution: where the texel is opaque, lerp from
        // the flat base colour toward the texture-tinted colour.
        // Where the texel is transparent (between halo dots, etc.)
        // the beam stays at baseColor. The procedural alpha keeps
        // the stripe visible end-to-end either way.
        vec3 col = mix(baseColor, baseColor * texel.rgb, texel.a);
        // Premultiplied alpha — paired with alphaMode = 7 in the
        // material (same convention as the build-beam shader).
        gl_FragColor = vec4(col * alpha, alpha);
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
