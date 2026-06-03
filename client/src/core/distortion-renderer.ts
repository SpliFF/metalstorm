/**
 * DistortionRenderer — screen-space heat-haze / shockwave warp composite.
 *
 * PLAN-weapon-fx-gaps.md Phase D. Weapon explosions warp the scene behind
 * them: a brief expanding ring of refraction, ZK's `ShockWave` look.
 *
 * Architecture note (why this is main-thread, not the worker LUPS class):
 * ZK authors distortion as LUPS particle classes, but those run in the
 * LuaUI Web Worker. As of GW4-c6, that worker renders world-space Lua GL
 * directly onto the shared Babylon GL context (`DrawWorld`/`DrawWorldPreUnit`
 * via the in-worker gl-bridge), not via a main-thread command buffer.
 * Every FX subsystem that actually reaches the screen — CegRuntime,
 * FxLightPool, CombatFX — is main-thread. So Phase D's "preferred design"
 * on this architecture is a main-thread composite fed by main-thread
 * emitters, mirroring FxLightPool: emitters call `emitShockwave` from the
 * same explosion code paths that drive `FxLightPool.emitExplosion`.
 *
 * Pipeline (all WebGL2-native):
 *   1. `offsetRT` — RGBA16F screen-sized target, cleared to 0 each frame.
 *      A thin-instanced billboard pool draws *signed radial UV offsets*
 *      into it with additive blend (the WebGL2 substitute for GL4's
 *      `imageStore` accumulation — see PLAN row "G3 distortion").
 *   2. `composite` — a full-screen post-process on the main camera samples
 *      the rendered scene at `uv + offset * uStrength` → warped output.
 *
 * The emitter mesh is kept out of the main camera pass via a private
 * layer-mask bit and rendered only by `offsetRT` (its own throwaway
 * camera carries the matching mask; the real view-projection is fed as a
 * uniform from the main camera, so that camera's pose is irrelevant).
 *
 * Gating: `gfx.distortion` (Phase G registry key). When off, the offset
 * target and composite are detached entirely — no full-screen pass runs.
 */

import {
    Camera, Color4, Constants, Mesh, MeshBuilder, PostProcess,
    RenderTargetTexture, Scene, ShaderMaterial, Texture, UniversalCamera,
    Vector3, Matrix,
} from '@babylonjs/core';
import { registerDistortionShaders } from './shaders/distortion.js';

/// Private render layer for the offset emitter — excluded from the main
/// camera (default mask 0x0FFFFFFF) and visible only to the offset RTT's
/// camera. Any bit above the default 28-bit range works.
const DISTORTION_LAYER = 0x40000000;

/// Pool size. Shockwaves are short-lived and far less frequent than
/// particles, so a small ring buffer is ample; dead slots are culled in
/// the vertex shader.
const CAPACITY = 256;

/// UV displacement scale applied in the composite. Tuned small — a few
/// percent of screen — so the warp reads as heat-shimmer, not a fisheye.
const DEFAULT_STRENGTH = 0.025;

export class DistortionRenderer {
    private scene: Scene;
    private camera: Camera;

    private offsetRT: RenderTargetTexture;
    private rtCam: UniversalCamera;
    private emitterMesh: Mesh;
    private emitterMat: ShaderMaterial;
    private composite: PostProcess;

    // Birth-state thin-instance buffers (3 × vec4 per source).
    private iPosLife = new Float32Array(CAPACITY * 4);
    private iVelTime = new Float32Array(CAPACITY * 4);
    private iParams = new Float32Array(CAPACITY * 4);
    private nextSlot = 0;
    private usedCount = 0;
    private dirty = false;

    private nowS = 0;
    private enabled = false;
    private attached = false;
    private strength = DEFAULT_STRENGTH;

    private tmpVP = new Matrix();
    private resizeObs: { remove(): void } | null = null;

    constructor(scene: Scene, camera: Camera) {
        this.scene = scene;
        this.camera = camera;
        registerDistortionShaders();

        const engine = scene.getEngine();
        const w = engine.getRenderWidth();
        const h = engine.getRenderHeight();

        // RGBA16F offset target — no depth buffer (the emitters always
        // draw; ordering is irrelevant under additive blend), no mipmaps,
        // nearest sampling (the composite reads it 1:1).
        this.offsetRT = new RenderTargetTexture('distortionOffset',
            { width: w, height: h }, scene, {
                generateDepthBuffer: false,
                generateMipMaps: false,
                type: Constants.TEXTURETYPE_HALF_FLOAT,
                format: Constants.TEXTUREFORMAT_RGBA,
                samplingMode: Texture.NEAREST_SAMPLINGMODE,
            });
        this.offsetRT.clearColor = new Color4(0, 0, 0, 0);

        // Throwaway camera whose only job is to carry the layer mask so
        // the RTT draws the emitter mesh; never the scene's active camera,
        // so it never renders to screen.
        this.rtCam = new UniversalCamera('distortionRTCam', Vector3.Zero(), scene);
        this.rtCam.layerMask = DISTORTION_LAYER;
        this.offsetRT.activeCamera = this.rtCam;

        this.emitterMat = this.buildEmitterMaterial();
        this.emitterMesh = this.buildEmitterMesh();
        this.offsetRT.renderList = [this.emitterMesh];

        this.composite = this.buildComposite();
        // The PostProcess ctor auto-attaches to the camera; detach so the
        // pass is dormant until `setEnabled(true)` (gfx.distortion).
        this.camera.detachPostProcess(this.composite);

        this.resizeObs = engine.onResizeObservable.add(() => {
            this.offsetRT.resize({
                width: engine.getRenderWidth(),
                height: engine.getRenderHeight(),
            });
        });

        // GW4-c5: globalThis so it resolves in the game-processor worker too.
        (globalThis as unknown as { __distortion: unknown }).__distortion = this;
    }

    private buildEmitterMaterial(): ShaderMaterial {
        const mat = new ShaderMaterial('distortionEmitterMat', this.scene,
            'distortionEmitter', {
                attributes: ['position', 'iPosLife', 'iVelTime', 'iParams'],
                uniforms: ['world', 'uViewProj', 'uNow', 'uCamPos'],
                defines: ['#define INSTANCES', '#define THIN_INSTANCES'],
                // Without this the alphaMode below is silently ignored and
                // the mesh draws opaque (see project_trail_alpha_blending).
                needAlphaBlending: true,
            });
        // ALPHA_ONEONE (GL_ONE/GL_ONE) — straight additive so signed
        // offsets accumulate correctly across overlapping shocks.
        mat.alphaMode = Constants.ALPHA_ONEONE;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        return mat;
    }

    private buildEmitterMesh(): Mesh {
        const mesh = MeshBuilder.CreatePlane('distortionEmitter',
            { width: 1, height: 1, sideOrientation: Mesh.DOUBLESIDE }, this.scene);
        mesh.material = this.emitterMat;
        mesh.isPickable = false;
        mesh.thinInstanceEnablePicking = false;
        mesh.layerMask = DISTORTION_LAYER;          // hidden from main camera
        // Transform is computed per-vertex from birth state, so the unit
        // quad's bounding box is meaningless — skip frustum cull.
        mesh.alwaysSelectAsActiveMesh = true;

        const identity = new Float32Array(CAPACITY * 16);
        for (let i = 0; i < CAPACITY; i++) {
            identity[i * 16 + 0] = 1;
            identity[i * 16 + 5] = 1;
            identity[i * 16 + 10] = 1;
            identity[i * 16 + 15] = 1;
        }
        mesh.thinInstanceSetBuffer('matrix', identity, 16, /*staticBuffer*/ true);
        mesh.thinInstanceSetBuffer('iPosLife', this.iPosLife, 4, false);
        mesh.thinInstanceSetBuffer('iVelTime', this.iVelTime, 4, false);
        mesh.thinInstanceSetBuffer('iParams', this.iParams, 4, false);
        mesh.thinInstanceCount = 0;
        return mesh;
    }

    private buildComposite(): PostProcess {
        const pp = new PostProcess('distortionComposite', 'distortionComposite',
            ['uStrength'], ['offsetSampler'], 1.0, this.camera,
            Texture.BILINEAR_SAMPLINGMODE, this.scene.getEngine());
        pp.onApply = (effect) => {
            effect.setTexture('offsetSampler', this.offsetRT);
            effect.setFloat('uStrength', this.strength);
        };
        return pp;
    }

    /** Master on/off, driven by the `gfx.distortion` setting. */
    setEnabled(on: boolean): void {
        this.enabled = on;
        if (on) this.attach();
        else this.detach();
    }

    private attach(): void {
        if (this.attached) return;
        if (this.scene.customRenderTargets.indexOf(this.offsetRT) < 0) {
            this.scene.customRenderTargets.push(this.offsetRT);
        }
        this.camera.attachPostProcess(this.composite);
        this.attached = true;
    }

    private detach(): void {
        if (!this.attached) return;
        const idx = this.scene.customRenderTargets.indexOf(this.offsetRT);
        if (idx >= 0) this.scene.customRenderTargets.splice(idx, 1);
        this.camera.detachPostProcess(this.composite);
        this.attached = false;
    }

    /**
     * Emit an expanding shockwave warp centred at a world point. `radius`
     * is the explosion's blast radius in elmos; strength + lifetime scale
     * with it (a small airburst barely ripples; a big kill warps hard).
     * No-op when distortion is disabled.
     */
    emitShockwave(x: number, y: number, z: number, radius: number): void {
        if (!this.enabled) return;
        const r = Math.max(40, radius);
        const strength = Math.min(1.6, 0.4 + r * 0.006);
        const lifetime = 0.3 + Math.min(0.4, r * 0.0015);

        const i = this.nextSlot;
        this.nextSlot = (this.nextSlot + 1) % CAPACITY;
        if (i + 1 > this.usedCount) this.usedCount = i + 1;

        const b = i * 4;
        this.iPosLife[b] = x; this.iPosLife[b + 1] = y; this.iPosLife[b + 2] = z;
        this.iPosLife[b + 3] = lifetime;
        this.iVelTime[b] = 0; this.iVelTime[b + 1] = 0; this.iVelTime[b + 2] = 0;
        this.iVelTime[b + 3] = this.nowS;
        this.iParams[b] = r; this.iParams[b + 1] = strength;
        this.iParams[b + 2] = 0; this.iParams[b + 3] = 0;
        this.dirty = true;
    }

    /**
     * Advance the clock and feed the emitter its per-frame uniforms. Call
     * once per render frame *after* the explosion emitters have run, so a
     * shock emitted this frame is uploaded before the offset RTT renders.
     */
    tick(dt: number): void {
        this.nowS += dt;
        if (!this.enabled) return;

        if (this.dirty) {
            const n4 = this.usedCount * 4;
            this.emitterMesh.thinInstanceSetBuffer('iPosLife', this.iPosLife.subarray(0, n4), 4, false);
            this.emitterMesh.thinInstanceSetBuffer('iVelTime', this.iVelTime.subarray(0, n4), 4, false);
            this.emitterMesh.thinInstanceSetBuffer('iParams', this.iParams.subarray(0, n4), 4, false);
            this.emitterMesh.thinInstanceCount = this.usedCount;
            this.dirty = false;
        }

        // Feed the main camera's view-projection (the RTT's own camera is
        // a placeholder) + clock + camera position for the billboard basis.
        this.camera.getViewMatrix().multiplyToRef(
            this.camera.getProjectionMatrix(), this.tmpVP);
        this.emitterMat.setMatrix('uViewProj', this.tmpVP);
        this.emitterMat.setFloat('uNow', this.nowS);
        this.emitterMat.setVector3('uCamPos', this.camera.position);
    }

    dispose(): void {
        this.detach();
        this.resizeObs?.remove();
        this.resizeObs = null;
        this.composite.dispose(this.camera);
        this.offsetRT.dispose();
        this.emitterMesh.dispose();
        this.emitterMat.dispose();
        this.rtCam.dispose();
    }
}
