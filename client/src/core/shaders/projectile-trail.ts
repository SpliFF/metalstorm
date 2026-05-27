/**
 * Projectile trail shader — ribbon segment with per-instance UV range
 * and per-end alpha gradient.
 *
 * Geometry: a unit XY plane thin-instanced once per ribbon segment
 * (i.e. once per pair of consecutive trail nodes). The CPU composes
 * a per-segment matrix whose X-axis is the (pos2 − pos1) edge vector
 * and Y-axis is the ribbon "out" direction (camera × travel),
 * matching Recoil's `CSmokeTrailProjectile::Draw` quad layout.
 *
 * Per-instance attributes:
 *  - `uvRange.xy` (uMin, uMax) — sub-rect of the texture sampled
 *    across the segment's long axis. Successive segments tile the
 *    texture so the smoketrail strip appears continuous along the
 *    trail; the U coordinate advances by `segLength / TILE_LEN`.
 *  - `alphaRange.xy` (a1, a2) — alpha at pos1 / pos2 ends, lerped
 *    across the segment so older end fades while younger end stays
 *    bright. Without per-end alpha the segment would be uniformly
 *    coloured and the visible boundary between live + dead puffs
 *    would pop in/out.
 *
 * Output uses premultiplied-alpha additive (paired with alphaMode = 7
 * in the material), so faded ends contribute nothing.
 */

import { Effect } from '@babylonjs/core';

export const PROJECTILE_TRAIL_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    attribute vec2 uvRange;
    attribute vec2 alphaRange;
    #include<instancesDeclaration>
    uniform mat4 viewProjection;

    varying vec2 vUV;
    varying float vAlpha;

    void main() {
        mat4 finalWorld = mat4(world0, world1, world2, world3);
        vUV = vec2(uvRange.x + uv.x * (uvRange.y - uvRange.x), uv.y);
        vAlpha = mix(alphaRange.x, alphaRange.y, uv.x);
        gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
    }
`;

export const PROJECTILE_TRAIL_FRAGMENT = `
    precision highp float;

    uniform sampler2D trailTex;
    uniform vec3 tint;

    varying vec2 vUV;
    varying float vAlpha;

    void main() {
        vec4 t = texture2D(trailTex, vUV);
        float a = t.a * vAlpha;
        gl_FragColor = vec4(t.rgb * tint * a, a);
    }
`;

let registered = false;

/// Idempotent registration into Babylon's global ShaderStore. Called
/// from the trail builder; no-op after the first invocation.
export function registerProjectileTrailShader(): void {
    if (registered) return;
    Effect.ShadersStore['projectileTrailVertexShader'] = PROJECTILE_TRAIL_VERTEX;
    Effect.ShadersStore['projectileTrailFragmentShader'] = PROJECTILE_TRAIL_FRAGMENT;
    registered = true;
}
