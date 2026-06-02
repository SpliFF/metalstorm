/**
 * MuzzleFlareRenderer — additive flash billboard on weapon fire.
 *
 * PLAN-weapon-fx-gaps.md Phase F item 2. Recoil draws a muzzle flare at
 * the firing point (sized by `muzzleFlareSize`, the weapon's flare
 * texture); without it a muzzle reads only as a dynamic light. This is
 * the missing visual: one short-lived, GPU-integrated, thin-instanced
 * camera-facing flash per shot — same birth-state model as CegRuntime /
 * DistortionRenderer, so the CPU only writes a slot on `emit` and uploads
 * a `uNow` clock per frame.
 *
 * The flash renders additively in the main scene's transparent pass; a
 * soft radial profile means it reads as a round burst even before the
 * flare texture resolves (the resolver is async).
 */

import {
    Camera, Constants, Mesh, MeshBuilder, Scene, ShaderMaterial,
    Texture, Matrix,
} from '@babylonjs/core';
import { stampUrl } from '../config.js';
import { registerMuzzleFlareShader } from './shaders/muzzle-flare.js';
import type { ProjectileTextureResolver } from './projectile-texture-resolver.js';

/// Pool size. Flashes are brief (~0.1s) but can be frequent in a firefight;
/// a few hundred slots covers a dense exchange. Dead slots cull in the VS.
const CAPACITY = 512;

/// Flash lifetime in seconds — punchy, gone in a few frames.
const FLARE_LIFETIME_S = 0.11;

export class MuzzleFlareRenderer {
    private scene: Scene;
    private camera: Camera;
    private mesh: Mesh;
    private material: ShaderMaterial;
    private resolver: ProjectileTextureResolver | null = null;
    private textureBound = false;

    private iPosLife = new Float32Array(CAPACITY * 4);
    private iBirth = new Float32Array(CAPACITY * 4);
    private iColor = new Float32Array(CAPACITY * 4);
    private nextSlot = 0;
    private usedCount = 0;
    private dirty = false;

    private nowS = 0;
    private tmpVP = new Matrix();

    constructor(scene: Scene, camera: Camera) {
        this.scene = scene;
        this.camera = camera;
        registerMuzzleFlareShader();

        this.material = new ShaderMaterial('muzzleFlareMat', scene, 'muzzleFlare', {
            attributes: ['position', 'uv', 'iPosLife', 'iBirth', 'iColor'],
            uniforms: ['world', 'uViewProj', 'uNow', 'uCamPos', 'hasTex'],
            samplers: ['tex'],
            defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
            needAlphaBlending: true,
        });
        // ALPHA_ONEONE (GL_ONE/GL_ONE) — premultiplied additive, matching
        // the fragment's `vec4(rgb*a, a)` output.
        this.material.alphaMode = Constants.ALPHA_ONEONE;
        this.material.backFaceCulling = false;
        this.material.disableDepthWrite = true;
        this.material.setFloat('hasTex', 0);

        this.mesh = MeshBuilder.CreatePlane('muzzleFlare',
            { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, scene);
        this.mesh.material = this.material;
        this.mesh.isPickable = false;
        this.mesh.thinInstanceEnablePicking = false;
        // Transform is computed per-vertex from birth state → the unit
        // quad's bounding box is meaningless; skip frustum cull.
        this.mesh.alwaysSelectAsActiveMesh = true;
        this.mesh.alphaIndex = 1000;

        const identity = new Float32Array(CAPACITY * 16);
        for (let i = 0; i < CAPACITY; i++) {
            identity[i * 16] = 1; identity[i * 16 + 5] = 1;
            identity[i * 16 + 10] = 1; identity[i * 16 + 15] = 1;
        }
        this.mesh.thinInstanceSetBuffer('matrix', identity, 16, /*static*/ true);
        this.mesh.thinInstanceSetBuffer('iPosLife', this.iPosLife, 4, false);
        this.mesh.thinInstanceSetBuffer('iBirth', this.iBirth, 4, false);
        this.mesh.thinInstanceSetBuffer('iColor', this.iColor, 4, false);
        this.mesh.thinInstanceCount = 0;

        // GW4-c5: globalThis so it resolves in the game-processor worker too.
        (globalThis as unknown as { __muzzleFlare: unknown }).__muzzleFlare = this;
    }

    /** Provide the texture resolver; the flare sprite binds lazily once
     *  the resolver settles (it's async). Without a texture the radial
     *  profile alone still reads as a flash. */
    setTextureResolver(resolver: ProjectileTextureResolver | null): void {
        this.resolver = resolver;
        this.tryBindTexture();
    }

    private tryBindTexture(): void {
        if (this.textureBound || !this.resolver) return;
        const url = this.resolver.resolve('flare');
        if (!url) return;
        const t = new Texture(stampUrl(url), this.scene, false, true,
            Texture.TRILINEAR_SAMPLINGMODE);
        t.hasAlpha = true;
        this.material.setTexture('tex', t);
        this.material.setFloat('hasTex', 1);
        this.textureBound = true;
    }

    /**
     * Emit a muzzle flash at a firing point. `color` is the flash tint
     * (callers bias toward white for a hot muzzle); `size` is the flare
     * half-extent in elmos (Recoil's `muzzleFlareSize`).
     */
    emit(x: number, y: number, z: number,
         color: readonly [number, number, number], size: number): void {
        const i = this.nextSlot;
        this.nextSlot = (this.nextSlot + 1) % CAPACITY;
        if (i + 1 > this.usedCount) this.usedCount = i + 1;

        const b = i * 4;
        this.iPosLife[b] = x; this.iPosLife[b + 1] = y; this.iPosLife[b + 2] = z;
        this.iPosLife[b + 3] = FLARE_LIFETIME_S;
        this.iBirth[b] = this.nowS; this.iBirth[b + 1] = Math.max(1, size);
        this.iBirth[b + 2] = 0; this.iBirth[b + 3] = 0;
        this.iColor[b] = color[0]; this.iColor[b + 1] = color[1];
        this.iColor[b + 2] = color[2]; this.iColor[b + 3] = 1;
        this.dirty = true;
    }

    /** Advance the clock and feed per-frame uniforms. Call once per frame
     *  after the fire emitters have run. */
    tick(dt: number): void {
        this.nowS += dt;
        if (!this.textureBound) this.tryBindTexture();

        if (this.dirty) {
            const n4 = this.usedCount * 4;
            this.mesh.thinInstanceSetBuffer('iPosLife', this.iPosLife.subarray(0, n4), 4, false);
            this.mesh.thinInstanceSetBuffer('iBirth', this.iBirth.subarray(0, n4), 4, false);
            this.mesh.thinInstanceSetBuffer('iColor', this.iColor.subarray(0, n4), 4, false);
            this.mesh.thinInstanceCount = this.usedCount;
            this.dirty = false;
        }

        this.camera.getViewMatrix().multiplyToRef(
            this.camera.getProjectionMatrix(), this.tmpVP);
        this.material.setMatrix('uViewProj', this.tmpVP);
        this.material.setFloat('uNow', this.nowS);
        this.material.setVector3('uCamPos', this.camera.position);
    }

    dispose(): void {
        this.mesh.dispose();
        this.material.dispose();
    }
}

/// Bias a weapon's bolt colour toward white for a hot muzzle flash.
export function muzzleFlashColor(
    c: readonly [number, number, number],
): [number, number, number] {
    return [c[0] * 0.5 + 0.5, c[1] * 0.5 + 0.5, c[2] * 0.5 + 0.5];
}
