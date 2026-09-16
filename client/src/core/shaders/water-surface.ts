/**
 * Water surface shader — flat plane, analytic scroll-bump + Fresnel + shore
 * foam. See ../water-surface.ts for the factory and the shore-depth-texture
 * bake. No normal-map texture exists yet (L-IMAGEGEN deferred), so the "two
 * scrolling normal tiles" the brief asks for are two independently-scrolling
 * analytic sine fields, summed, with their gradient used as the perturbed
 * normal — cheap (no texture fetch) and tileable by construction.
 */

import { Effect } from '@babylonjs/core';

export const WATER_SURFACE_VERTEX = `
    precision highp float;

    attribute vec3 position;
    attribute vec2 uv;
    uniform mat4 world;
    uniform mat4 worldViewProjection;

    varying vec3 vPositionW;
    varying vec2 vUV;

    void main() {
        vec4 p = vec4(position, 1.0);
        gl_Position = worldViewProjection * p;
        vPositionW = (world * p).xyz;
        vUV = uv;
    }
`;

export const WATER_SURFACE_FRAGMENT = `
    precision highp float;

    varying vec3 vPositionW;
    varying vec2 vUV;

    uniform vec3 uSurfaceColor;
    uniform float uSurfaceAlpha;
    uniform float uTime;
    uniform vec3 cameraPosition;
    uniform sampler2D uShoreDepthTex;

    // Gradient of sin(x')*cos(z') w.r.t. world XZ, where x'/z' fold in a
    // per-tile scale + time-scrolled phase. Used as a perturbed-normal
    // slope, not an actual heightfield — cheap stand-in for a scrolling
    // normal-map tile.
    vec2 bumpGradient(vec2 posXZ, float scale, vec2 dir, float speed, float amp) {
        vec2 q = posXZ * scale + dir * uTime * speed;
        float dfdx =  cos(q.x) * cos(q.y) * scale * amp;
        float dfdz = -sin(q.x) * sin(q.y) * scale * amp;
        return vec2(dfdx, dfdz);
    }

    void main() {
        // Two scrolling tiles at different scale/direction/speed, summed.
        vec2 g = bumpGradient(vPositionW.xz, 0.015, vec2(1.0, 0.35), 0.05, 1.0)
               + bumpGradient(vPositionW.xz, 0.041, vec2(-0.5, 1.0), 0.035, 0.5);
        vec3 normalW = normalize(vec3(-g.x, 1.0, -g.y));

        vec3 viewDir = normalize(cameraPosition - vPositionW);
        float fresnel = pow(clamp(1.0 - dot(normalW, viewDir), 0.0, 1.0), 5.0);

        // Fresnel darkening: a near-vertical view reads the tinted depth
        // colour; a grazing view lightens toward a pale sky-reflection
        // stand-in (no reflection RTT — WaterMaterial's is too costly at
        // XL900 scale, PLAN-beta-presentation.md L-ATMOS step 4).
        vec3 deep = uSurfaceColor * 0.55;
        vec3 grazing = mix(uSurfaceColor, vec3(0.85, 0.88, 0.9), 0.6);
        vec3 base = mix(deep, grazing, fresnel);

        // Shore foam: the SAME depth-blend curve water-absorption-plugin.ts
        // uses for the underwater terrain shade (SMF_SHALLOW_WATER_DEPTH =
        // 10 elmos) — strongest right at the waterline, fading out over the
        // first 10 elmos of depth. uShoreDepthTex encodes 0..64 elmos of
        // depth-below-water into [0,1] (see buildShoreDepthTexture).
        float depth01 = texture2D(uShoreDepthTex, vUV).r;
        float depthElmos = depth01 * 64.0;
        float waBlend = clamp(depthElmos * 0.1, 0.0, 1.0);
        float foam = (1.0 - waBlend) * step(0.0005, depth01);

        vec3 color = mix(base, vec3(0.92, 0.95, 0.93), foam * 0.8);
        gl_FragColor = vec4(color, uSurfaceAlpha);
    }
`;

let registered = false;

/** Idempotent registration into Babylon's global ShaderStore. */
export function registerWaterSurfaceShader(): void {
    if (registered) return;
    Effect.ShadersStore['waterSurfaceVertexShader'] = WATER_SURFACE_VERTEX;
    Effect.ShadersStore['waterSurfaceFragmentShader'] = WATER_SURFACE_FRAGMENT;
    registered = true;
}
