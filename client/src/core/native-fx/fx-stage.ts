/**
 * FX stage — the isolated pedestal the fx-viewer scenario renders effects on.
 *
 * A full-window overlay canvas on the MAIN thread with its own WebGL2
 * context, orbit camera, procedural ground/sky, and a small ballistic
 * projectile simulation, driving NativeFxRenderer + effect-compiler against
 * the REAL authored GLSL and library.json (both injected as strings/objects
 * by the scenario — the stage does no I/O).
 *
 * Why an overlay and not the game scene: the Babylon scene and all game
 * renderers live in the game-processor WORKER (gpCtx), so main-thread
 * scenario code cannot touch that GL context, and the worker has no native-FX
 * loader until the Stage-7 engine ask lands (shaders/fx/README.md "Wiring").
 * The stage is the same isolated-pedestal philosophy as model-viewer — the
 * game keeps running underneath; `setVisible(false)` reveals it. When the
 * worker adapter lands, fx-viewer can grow a "world mode" that drives the
 * same renderer inside the worker; the stage remains the isolated mode.
 *
 * Placeholder art: the authored fx_atlas.ktx2 / trail strips don't exist yet
 * (PLAN-metalstorm.md §11 — unittextures/ empty), so the stage bakes
 * procedural canvas stand-ins for every frame named in library.json.atlas.
 * Swap-in of real .ktx2 assets replaces buildPlaceholderAtlas only.
 *
 * Modes (the ?mode= URL param / panel select):
 *   impact     — effect detonates at the target marker (dir = up)
 *   muzzle     — effect fires from the gun muzzle along the barrel
 *   projectile — a simulated round flies gun → target; tracer emitters
 *                follow its head, trail emitters stream ribbon segments,
 *                and a linked impact effect fires on landing
 *   loop       — impact-style, retriggered continuously at the fire interval
 */

import {
    compileEffect,
    compileEmitter,
    packTracer,
    packTrailSegment,
    resolveEffect,
    type CompiledBatch,
    type FxLibrary,
    type TracerSpec,
    type TrailSpec,
} from './effect-compiler.js';
import {
    NativeFxRenderer,
    mat4LookAt,
    mat4Perspective,
    type NativeFxSources,
    type PoolCounts,
    type ShaderSolo,
    type TracerHandle,
    type TrailSegmentHandle,
} from './native-fx-renderer.js';

export type FxStageMode = 'impact' | 'muzzle' | 'projectile' | 'loop';

export interface FxStageOptions {
    sources: NativeFxSources;
    library: FxLibrary;
    /** Overlay z-index — must sit under the F8 panel (9998). */
    zIndex?: number;
}

export interface FxStageStats extends PoolCounts {
    fired: number;
    liveProjectiles: number;
    distortionAvailable: boolean;
}

// Stage geometry (elmos). Gun west, target east — same axis as the
// weapon-fx bench (shooter/target 400 apart, camera side-on).
const GUN = { x: -200, y: 14, z: 0 };
const TARGET = { x: 200, y: 0, z: 0 };
const BARREL_ELEV_DEG = 14;
const PROJECTILE_SPEED = 480;
const GRAVITY = 235;                 // lands the arc near the target marker
const NEAR = 2, FAR = 6000;

interface LiveProjectile {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    tracers: { h: TracerHandle }[];
    trails: {
        spec: TrailSpec;
        lastNode: [number, number, number] | null;
        lastNodeAt: number;
        distAlong: number;
        segments: { h: TrailSegmentHandle; born: number; a1: number; a2: number }[];
    }[];
    impactEffect: string | null;
}

interface Delayed { at: number; run: () => void; }

export class FxStage {
    readonly canvas: HTMLCanvasElement;
    private gl: WebGL2RenderingContext;
    private renderer: NativeFxRenderer;
    private lib: FxLibrary;

    // Orbit camera around the gun↔target midline.
    private camYaw = 0.6;
    private camPitch = 0.35;          // rad above horizon, clamped
    private camDist = 520;
    private camTarget: [number, number, number] = [0, 30, 0];

    private t0 = performance.now();
    private last = this.t0;
    private raf = 0;
    private disposed = false;

    private projectiles: LiveProjectile[] = [];
    private delayed: Delayed[] = [];
    private firedCount = 0;

    /** Live trail style for the shared trail draw (harness simplification —
     *  one effect under test at a time; see NativeFxFrame.trailSprite). */
    private trailSprite = 'smoketrail';
    private trailTint: [number, number, number] = [0.6, 0.58, 0.55];

    mode: FxStageMode = 'impact';
    solo: ShaderSolo | null = null;
    softRange = 10;
    distortionStrength = 0.06;
    /** Fire the linked impact effect when a projectile lands. */
    linkedImpact = true;
    /** Ground grid + markers on/off (pure-black void isolates additive FX). */
    drawStageDressing = true;
    /** Detonation height above ground for impact/loop mode — raise it to
     *  judge airburst effects (flak) at altitude. */
    burstHeight = 2;

    // Stage-owned mini programs (sky/ground/markers) — inline, NOT under
    // test; only shaders/fx/* go through NativeFxRenderer.
    private groundProg: WebGLProgram;
    private groundVao: WebGLVertexArrayObject;
    private markerProg: WebGLProgram;
    private markerVao: WebGLVertexArrayObject;
    private markerVerts: number;

    constructor(opts: FxStageOptions) {
        this.lib = opts.library;

        this.canvas = document.createElement('canvas');
        this.canvas.id = 'fx-stage-canvas';
        this.canvas.style.cssText =
            `position:fixed; inset:0; width:100vw; height:100vh; z-index:${opts.zIndex ?? 9000};`
            + 'background:#000; cursor:grab;';
        document.body.appendChild(this.canvas);

        const gl = this.canvas.getContext('webgl2', {
            antialias: false, alpha: false, premultipliedAlpha: true,
        });
        if (!gl) throw new Error('[fx-stage] WebGL2 unavailable');
        this.gl = gl;

        this.renderer = new NativeFxRenderer(gl, opts.sources, {
            atlas: buildPlaceholderAtlas(gl, this.lib),
            atlasCols: this.lib.atlas.cols,
            atlasRows: this.lib.atlas.rows,
            trailStrips: buildTrailStrips(gl),
        });

        [this.groundProg, this.groundVao] = buildGround(gl);
        [this.markerProg, this.markerVao, this.markerVerts] = buildMarkers(gl);

        this.bindInput();
        this.resize();
        window.addEventListener('resize', this.resize);
        this.raf = requestAnimationFrame(this.tick);
    }

    // ── public API (scenario/panel) ─────────────────────────────────────────

    setVisible(on: boolean): void {
        this.canvas.style.display = on ? 'block' : 'none';
    }

    get visible(): boolean {
        return this.canvas.style.display !== 'none';
    }

    stats(): FxStageStats {
        return {
            ...this.renderer.counts(),
            fired: this.firedCount,
            liveProjectiles: this.projectiles.length,
            distortionAvailable: this.renderer.distortionAvailable,
        };
    }

    /** Trigger the selected effect once, per the active mode. */
    fire(effectName: string): void {
        const now = this.now();
        this.firedCount++;
        const { def } = resolveEffect(this.lib, effectName);
        this.adoptTrailStyle(def.emitters?.find((e) => e.shader === 'trail'));

        if (this.mode === 'muzzle') {
            const d = this.barrelDir();
            this.spawnBatch(compileEffect(this.lib, effectName, {
                x: GUN.x + d[0] * 16, y: GUN.y + d[1] * 16, z: GUN.z + d[2] * 16,
                dirX: d[0], dirY: d[1], dirZ: d[2], now,
            }), null);
            return;
        }

        if (this.mode === 'projectile') {
            this.launchProjectile(effectName, now);
            return;
        }

        // impact / loop — detonate at the target marker (burstHeight above
        // ground so airburst effects can be judged at altitude), direction up.
        this.spawnBatch(compileEffect(this.lib, effectName, {
            x: TARGET.x, y: TARGET.y + this.burstHeight, z: TARGET.z,
            dirX: 0, dirY: 1, dirZ: 0, now,
        }), null);
    }

    /** Re-aim the orbit camera at what the active mode actually shows:
     *  muzzle → close on the gun; impact/loop → the target; projectile →
     *  wide on the whole arc. Called by the harness on mode/effect changes;
     *  the user's subsequent drag/zoom sticks until the next change. */
    frameForMode(): void {
        if (this.mode === 'muzzle') {
            this.camTarget = [GUN.x + 24, 18, GUN.z];
            this.camDist = 170;
        } else if (this.mode === 'projectile') {
            this.camTarget = [0, 50, 0];
            this.camDist = 560;
        } else {
            this.camTarget = [TARGET.x, 26 + this.burstHeight * 0.5, TARGET.z];
            this.camDist = 340;
        }
    }

    dispose(): void {
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        window.removeEventListener('resize', this.resize);
        this.renderer.dispose();
        this.gl.deleteProgram(this.groundProg);
        this.gl.deleteVertexArray(this.groundVao);
        this.gl.deleteProgram(this.markerProg);
        this.gl.deleteVertexArray(this.markerVao);
        this.canvas.remove();
    }

    // ── internals ────────────────────────────────────────────────────────────

    private now(): number {
        return (performance.now() - this.t0) / 1000;
    }

    private barrelDir(): [number, number, number] {
        const e = (BARREL_ELEV_DEG * Math.PI) / 180;
        const dx = TARGET.x - GUN.x, dz = TARGET.z - GUN.z;
        const l = Math.hypot(dx, dz) || 1;
        return [(dx / l) * Math.cos(e), Math.sin(e), (dz / l) * Math.cos(e)];
    }

    private adoptTrailStyle(e?: { sprite?: string; tint?: [number, number, number] }): void {
        if (!e) return;
        this.trailSprite = e.sprite ?? 'smoketrail';
        this.trailTint = e.tint ?? [0.6, 0.58, 0.55];
    }

    /** Push a compiled batch into the pools; register projectile-attached
     *  specs on `proj` (or spawn static stand-ins when there is none). */
    private spawnBatch(batch: CompiledBatch, proj: LiveProjectile | null): void {
        const now = this.now();
        if (batch.particles) this.renderer.spawnParticles(batch.particles, batch.particleCount);
        if (batch.muzzles) this.renderer.spawnMuzzles(batch.muzzles, batch.muzzleCount);
        if (batch.shocks) this.renderer.spawnShocks(batch.shocks, batch.shockCount);

        for (const spec of batch.tracers) {
            if (proj) {
                proj.tracers.push({ h: this.allocTracerFor(spec, proj, now) });
            } else {
                // No projectile context (impact/muzzle mode): fire-and-forget
                // streak along the barrel line so the shader still showcases.
                const d = this.barrelDir();
                const row = new Float32Array(16);
                packTracer(row, 0,
                    [GUN.x + d[0] * spec.length, GUN.y + d[1] * spec.length, GUN.z + d[2] * spec.length],
                    [d[0] * PROJECTILE_SPEED, d[1] * PROJECTILE_SPEED, d[2] * PROJECTILE_SPEED],
                    { ...spec, life: Math.min(spec.life, 0.6) }, now);
                this.renderer.allocTracer(row);
            }
        }

        for (const spec of batch.trails) {
            if (proj) {
                proj.trails.push({ spec, lastNode: null, lastNodeAt: 0, distAlong: 0, segments: [] });
            } else if (this.mode !== 'projectile') {
                // Trail effects only make sense on a moving emitter; auto-launch
                // a carrier round so "trail effect + impact mode" still shows
                // something (documented in the panel hint).
                this.launchProjectileWithSpecs([], [spec], null, this.now());
            }
        }

        for (const d of batch.delayed) {
            const ctx = {
                x: proj ? proj.x : TARGET.x, y: proj ? proj.y : TARGET.y + 2, z: proj ? proj.z : TARGET.z,
                dirX: 0, dirY: 1, dirZ: 0, now: now + d.delay,
            };
            this.delayed.push({
                at: now + d.delay,
                run: () => this.spawnBatch(compileEmitter(this.lib, d.emitter, ctx), null),
            });
        }
    }

    private allocTracerFor(spec: TracerSpec, proj: LiveProjectile, now: number): TracerHandle {
        const row = new Float32Array(16);
        packTracer(row, 0, [proj.x, proj.y, proj.z], [proj.vx, proj.vy, proj.vz], spec, now);
        return this.renderer.allocTracer(row);
    }

    private launchProjectile(effectName: string, now: number): void {
        const { def } = resolveEffect(this.lib, effectName);
        const usage = def.usage ?? 'impact';

        // What rides the round vs what fires at the ends, per usage:
        //   projectile → its tracers ride; impact = linked default
        //   trail      → its trails ride; impact = linked default
        //   impact     → default tracer rides; THIS effect fires on landing
        //   muzzle     → this effect fires at launch; default tracer rides
        let tracers: TracerSpec[] = [];
        let trails: TrailSpec[] = [];
        let impact: string | null = this.linkedImpact ? 'expl_small' : null;

        const batch = compileEffect(this.lib, effectName, {
            x: GUN.x, y: GUN.y, z: GUN.z,
            dirX: 0, dirY: 1, dirZ: 0, now,
        });

        if (usage === 'projectile' || usage === 'trail') {
            tracers = batch.tracers;
            trails = batch.trails;
            // Muzzle-ish emitters authored alongside (rare) still pop at launch.
            this.spawnStaticPortion(batch, now);
        } else if (usage === 'impact') {
            // The selected effect IS the payload — always fires on landing
            // (linkedImpact only governs the default link for tracer/trail
            // effects, where the impact is incidental).
            impact = effectName;
            tracers = defaultCarrierTracer();
        } else {
            // muzzle usage: fire it at the barrel, ride a default tracer.
            this.fireMuzzleAtBarrel(effectName, now);
            tracers = defaultCarrierTracer();
        }

        const d = this.barrelDir();
        const proj: LiveProjectile = {
            x: GUN.x + d[0] * 16, y: GUN.y + d[1] * 16, z: GUN.z + d[2] * 16,
            vx: d[0] * PROJECTILE_SPEED, vy: d[1] * PROJECTILE_SPEED, vz: d[2] * PROJECTILE_SPEED,
            tracers: [], trails: [], impactEffect: impact,
        };
        for (const spec of tracers) proj.tracers.push({ h: this.allocTracerFor(spec, proj, now) });
        for (const spec of trails) {
            this.adoptTrailStyle({ sprite: spec.sprite, tint: spec.tint });
            proj.trails.push({ spec, lastNode: null, lastNodeAt: 0, distAlong: 0, segments: [] });
        }
        this.projectiles.push(proj);
    }

    private launchProjectileWithSpecs(
        tracers: TracerSpec[], trails: TrailSpec[], impact: string | null, now: number,
    ): void {
        const d = this.barrelDir();
        const proj: LiveProjectile = {
            x: GUN.x + d[0] * 16, y: GUN.y + d[1] * 16, z: GUN.z + d[2] * 16,
            vx: d[0] * PROJECTILE_SPEED, vy: d[1] * PROJECTILE_SPEED, vz: d[2] * PROJECTILE_SPEED,
            tracers: [], trails: [], impactEffect: impact,
        };
        for (const spec of tracers) proj.tracers.push({ h: this.allocTracerFor(spec, proj, now) });
        for (const spec of trails) {
            proj.trails.push({ spec, lastNode: null, lastNodeAt: 0, distAlong: 0, segments: [] });
        }
        this.projectiles.push(proj);
    }

    private fireMuzzleAtBarrel(effectName: string, now: number): void {
        const d = this.barrelDir();
        this.spawnBatch(compileEffect(this.lib, effectName, {
            x: GUN.x + d[0] * 16, y: GUN.y + d[1] * 16, z: GUN.z + d[2] * 16,
            dirX: d[0], dirY: d[1], dirZ: d[2], now,
        }), null);
    }

    /** Spawn only the pool-row portion of a batch (no tracer/trail specs). */
    private spawnStaticPortion(batch: CompiledBatch, _now: number): void {
        if (batch.particles) this.renderer.spawnParticles(batch.particles, batch.particleCount);
        if (batch.muzzles) this.renderer.spawnMuzzles(batch.muzzles, batch.muzzleCount);
        if (batch.shocks) this.renderer.spawnShocks(batch.shocks, batch.shockCount);
    }

    // ── per-frame ────────────────────────────────────────────────────────────

    private tick = (): void => {
        if (this.disposed) return;
        const nowMs = performance.now();
        const dt = Math.min((nowMs - this.last) / 1000, 0.1);
        this.last = nowMs;
        const now = this.now();

        // Delayed emitters (composite stages).
        for (let i = this.delayed.length - 1; i >= 0; i--) {
            if (this.delayed[i].at <= now) {
                const d = this.delayed[i];
                this.delayed.splice(i, 1);
                d.run();
            }
        }

        this.stepProjectiles(dt, now);

        if (this.visible) this.draw(now);
        this.raf = requestAnimationFrame(this.tick);
    };

    private stepProjectiles(dt: number, now: number): void {
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            p.vy -= GRAVITY * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;

            for (const t of p.tracers) this.renderer.updateTracerHead(t.h, p.x, p.y, p.z);

            for (const tr of p.trails) {
                this.streamTrail(tr, p, now);
                this.fadeTrail(tr, now);
            }

            if (p.y <= 0) {
                // Landed: kill riders, fire the payload, retire.
                for (const t of p.tracers) this.renderer.killTracer(t.h);
                if (p.impactEffect) {
                    this.spawnBatch(compileEffect(this.lib, p.impactEffect, {
                        x: p.x, y: 2, z: p.z, dirX: 0, dirY: 1, dirZ: 0, now,
                    }), null);
                }
                // Orphan the trail (it keeps fading via the orphan sweep below).
                this.orphanTrails.push(...p.trails);
                this.projectiles.splice(i, 1);
            }
        }

        // Orphaned trails (projectile landed) keep fading until all segments die.
        for (let i = this.orphanTrails.length - 1; i >= 0; i--) {
            const tr = this.orphanTrails[i];
            this.fadeTrail(tr, now);
            if (tr.segments.length === 0) this.orphanTrails.splice(i, 1);
        }
    }

    private orphanTrails: LiveProjectile['trails'] = [];

    private streamTrail(tr: LiveProjectile['trails'][number], p: LiveProjectile, now: number): void {
        if (now - tr.lastNodeAt < tr.spec.nodeInterval) return;
        const node: [number, number, number] = [p.x, p.y, p.z];
        if (tr.lastNode) {
            const segLen = Math.hypot(
                node[0] - tr.lastNode[0], node[1] - tr.lastNode[1], node[2] - tr.lastNode[2]);
            const uMin = tr.distAlong / tr.spec.tileLength;
            const uMax = (tr.distAlong + segLen) / tr.spec.tileLength;
            tr.distAlong += segLen;
            const row = new Float32Array(12);
            // p1 = younger (current head), p2 = older node. Width is baked at
            // spawn (head width both ends); ageing is expressed through the
            // per-end alpha fade only — width growth is a possible later
            // refinement (would ride the same updateTrailSegment* path).
            packTrailSegment(row, 0,
                node, tr.spec.widthHead,
                tr.lastNode, tr.spec.widthHead,
                uMin, uMax, tr.spec.alphaHead, tr.spec.alphaHead);
            tr.segments.push({
                h: this.renderer.allocTrailSegment(row),
                born: now, a1: tr.spec.alphaHead, a2: tr.spec.alphaHead,
            });
        }
        tr.lastNode = node;
        tr.lastNodeAt = now;
    }

    /** CPU-side per-end alpha fade — the same model as projectile-trails.ts
     *  (trail.vert.glsl has no clock on purpose; parity with the shipped
     *  BAR/ZK ribbon path). Width growth is baked at spawn; alpha decays
     *  linearly over spec.life, with `rise` drifting bubble wakes upward. */
    private fadeTrail(tr: LiveProjectile['trails'][number], now: number): void {
        for (let i = tr.segments.length - 1; i >= 0; i--) {
            const s = tr.segments[i];
            const age = now - s.born;
            const u = age / tr.spec.life;
            if (u >= 1) {
                this.renderer.killTrailSegment(s.h);
                tr.segments.splice(i, 1);
                continue;
            }
            const k = 1 - u;
            this.renderer.updateTrailSegmentAlpha(s.h, tr.spec.alphaHead * k,
                Math.max(tr.spec.alphaTail, tr.spec.alphaHead * k * 0.7));
        }
    }

    // ── drawing ──────────────────────────────────────────────────────────────

    private resize = (): void => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.floor(this.canvas.clientWidth * dpr) || window.innerWidth;
        const h = Math.floor(this.canvas.clientHeight * dpr) || window.innerHeight;
        this.canvas.width = w;
        this.canvas.height = h;
        this.renderer.resize(w, h);
    };

    private draw(now: number): void {
        const eye = this.eye();
        const view = mat4LookAt(eye, this.camTarget, [0, 1, 0]);
        const proj = mat4Perspective(
            (50 * Math.PI) / 180, this.canvas.width / Math.max(1, this.canvas.height), NEAR, FAR);

        this.renderer.render({
            view, proj, camPos: eye, now,
            nearFar: [NEAR, FAR],
            softRange: this.softRange,
            distortionStrength: this.distortionStrength,
            solo: this.solo,
            trailSprite: this.trailSprite,
            trailTint: this.trailTint,
            drawOpaque: (gl, viewProj) => this.drawOpaque(gl, viewProj, eye),
            target: null,
        });
    }

    private eye(): [number, number, number] {
        const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
        return [
            this.camTarget[0] + this.camDist * cp * Math.cos(this.camYaw),
            this.camTarget[1] + this.camDist * sp,
            this.camTarget[2] + this.camDist * cp * Math.sin(this.camYaw),
        ];
    }

    private drawOpaque(gl: WebGL2RenderingContext, viewProj: Float32Array, eye: [number, number, number]): void {
        if (!this.drawStageDressing) return;
        // Ground plane (grid frag draws its own sky-ish horizon fade).
        gl.useProgram(this.groundProg);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.groundProg, 'uViewProj'), false, viewProj);
        gl.uniform3f(gl.getUniformLocation(this.groundProg, 'uCamPos'), ...eye);
        gl.bindVertexArray(this.groundVao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        // Gun + target markers (lines).
        gl.useProgram(this.markerProg);
        gl.uniformMatrix4fv(gl.getUniformLocation(this.markerProg, 'uViewProj'), false, viewProj);
        gl.bindVertexArray(this.markerVao);
        gl.drawArrays(gl.LINES, 0, this.markerVerts);
        gl.bindVertexArray(null);
    }

    // ── input (drag orbit / wheel zoom) ─────────────────────────────────────

    private bindInput(): void {
        let dragging = false;
        let px = 0, py = 0;
        this.canvas.addEventListener('pointerdown', (e) => {
            dragging = true;
            px = e.clientX; py = e.clientY;
            this.canvas.setPointerCapture(e.pointerId);
            this.canvas.style.cursor = 'grabbing';
        });
        this.canvas.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            this.camYaw += (e.clientX - px) * 0.005;
            this.camPitch = clamp(this.camPitch + (e.clientY - py) * 0.004, 0.08, 1.45);
            px = e.clientX; py = e.clientY;
        });
        this.canvas.addEventListener('pointerup', (e) => {
            dragging = false;
            this.canvas.releasePointerCapture(e.pointerId);
            this.canvas.style.cursor = 'grab';
        });
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camDist = clamp(this.camDist * (e.deltaY > 0 ? 1.1 : 0.9), 80, 2400);
        }, { passive: false });
    }
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function defaultCarrierTracer(): TracerSpec[] {
    return [{
        length: 26, width: 1.8, coreBoost: 2.2, taper: 1.4,
        color: [5, 2.8, 0.8, 1], life: 4,
    }];
}

// ── stage-owned inline shaders (NOT under test) ─────────────────────────────

const GROUND_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aXZ;
uniform mat4 uViewProj;
out vec3 vWorld;
void main() {
    vWorld = vec3(aXZ.x, 0.0, aXZ.y);
    gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

const GROUND_FRAG = `#version 300 es
precision highp float;
uniform vec3 uCamPos;
in vec3 vWorld;
out vec4 fragColor;
void main() {
    // 64-elmo grid, brighter 512 lines, distance-fogged dark ground.
    vec2 g64 = abs(fract(vWorld.xz / 64.0) - 0.5);
    vec2 g512 = abs(fract(vWorld.xz / 512.0) - 0.5);
    float line = smoothstep(0.47, 0.5, max(g64.x, g64.y)) * 0.12
               + smoothstep(0.48, 0.5, max(g512.x, g512.y)) * 0.2;
    vec3 base = vec3(0.05, 0.06, 0.07) + vec3(0.2, 0.24, 0.28) * line;
    float d = length(vWorld - uCamPos);
    float fog = clamp(d / 3000.0, 0.0, 1.0);
    fragColor = vec4(mix(base, vec3(0.02, 0.025, 0.03), fog), 1.0);
}`;

const MARKER_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vColor;
void main() {
    vColor = aColor;
    gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const MARKER_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main() { fragColor = vec4(vColor, 1.0); }`;

function compileInline(gl: WebGL2RenderingContext, vs: string, fs: string, label: string): WebGLProgram {
    const mk = (type: number, src: string): WebGLShader => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            throw new Error(`[fx-stage] ${label}: ${gl.getShaderInfoLog(sh)}`);
        }
        return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`[fx-stage] link ${label}: ${gl.getProgramInfoLog(prog)}`);
    }
    return prog;
}

function buildGround(gl: WebGL2RenderingContext): [WebGLProgram, WebGLVertexArrayObject] {
    const prog = compileInline(gl, GROUND_VERT, GROUND_FRAG, 'ground');
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const S = 3000;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -S, -S,  S, -S,  S, S,
        -S, -S,  S,  S, -S, S,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return [prog, vao];
}

/** Gun post + barrel at GUN, ring-ish target cross at TARGET. */
function buildMarkers(gl: WebGL2RenderingContext): [WebGLProgram, WebGLVertexArrayObject, number] {
    const prog = compileInline(gl, MARKER_VERT, MARKER_FRAG, 'markers');
    const verts: number[] = [];
    const push = (x: number, y: number, z: number, c: [number, number, number]): void => {
        verts.push(x, y, z, c[0], c[1], c[2]);
    };
    const steel: [number, number, number] = [0.5, 0.62, 0.72];
    const red: [number, number, number] = [0.75, 0.25, 0.2];
    // Gun: post up + barrel toward target at the fixed elevation.
    push(GUN.x, 0, GUN.z, steel); push(GUN.x, GUN.y, GUN.z, steel);
    const e = (BARREL_ELEV_DEG * Math.PI) / 180;
    push(GUN.x, GUN.y, GUN.z, steel);
    push(GUN.x + Math.cos(e) * 26, GUN.y + Math.sin(e) * 26, GUN.z, steel);
    // Target: cross + octagon ring at radius 24.
    push(TARGET.x - 16, 0.5, TARGET.z, red); push(TARGET.x + 16, 0.5, TARGET.z, red);
    push(TARGET.x, 0.5, TARGET.z - 16, red); push(TARGET.x, 0.5, TARGET.z + 16, red);
    for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
        push(TARGET.x + Math.cos(a0) * 24, 0.5, TARGET.z + Math.sin(a0) * 24, red);
        push(TARGET.x + Math.cos(a1) * 24, 0.5, TARGET.z + Math.sin(a1) * 24, red);
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return [prog, vao, verts.length / 6];
}

// ── placeholder textures (until fx_atlas.ktx2 is authored) ──────────────────

/** Bake a procedural stand-in for every frame named in library.json.atlas.
 *  Cell art is deliberately simple — silhouettes match the frame's role
 *  (dot/spark/fireball/smoke/…): good enough to judge motion, timing, and
 *  blending, which is what the harness tests. */
function buildPlaceholderAtlas(gl: WebGL2RenderingContext, lib: FxLibrary): WebGLTexture {
    const cols = lib.atlas.cols, rows = lib.atlas.rows;
    const cell = 64;
    const cv = document.createElement('canvas');
    cv.width = cols * cell;
    cv.height = rows * cell;
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, cv.width, cv.height);

    const painters: Record<string, (x: number, y: number) => void> = {
        dot: (x, y) => radial(c, x, y, cell, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]),
        spark: (x, y) => {
            const g = c.createLinearGradient(x + cell / 2, y + 4, x + cell / 2, y + cell - 4);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(0.5, 'rgba(255,255,255,1)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            c.fillStyle = g;
            c.fillRect(x + cell * 0.42, y + 2, cell * 0.16, cell - 4);
        },
        fireball: (x, y) => {
            radial(c, x, y, cell, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,240,210,0.9)'], [0.7, 'rgba(255,200,120,0.45)'], [1, 'rgba(255,160,60,0)']]);
            blotch(c, x, y, cell, 5, 'rgba(255,235,200,0.5)');
        },
        smoke: (x, y) => blotch(c, x, y, cell, 7, 'rgba(255,255,255,0.55)'),
        dust: (x, y) => blotch(c, x, y, cell, 9, 'rgba(255,255,255,0.4)'),
        flash: (x, y) => {
            radial(c, x, y, cell, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]);
            c.save();
            c.translate(x + cell / 2, y + cell / 2);
            c.fillStyle = 'rgba(255,255,255,0.8)';
            for (let i = 0; i < 4; i++) {
                c.rotate(Math.PI / 4);
                c.fillRect(-cell * 0.46, -1.6, cell * 0.92, 3.2);
            }
            c.restore();
        },
        ring: (x, y) => {
            c.strokeStyle = 'rgba(255,255,255,0.9)';
            c.lineWidth = cell * 0.08;
            c.beginPath();
            c.arc(x + cell / 2, y + cell / 2, cell * 0.34, 0, Math.PI * 2);
            c.stroke();
        },
        foam: (x, y) => {
            for (let i = 0; i < 14; i++) {
                const a = (i * 2.39996) % (Math.PI * 2);   // golden-angle scatter
                const r = cell * (0.1 + 0.28 * ((i * 0.618) % 1));
                const bx = x + cell / 2 + Math.cos(a) * r;
                const by = y + cell / 2 + Math.sin(a) * r;
                radialAt(c, bx, by, cell * (0.06 + 0.05 * ((i * 0.37) % 1)),
                    [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
            }
        },
        smoketrail: (x, y) => stripInCell(c, x, y, cell, 0.5),
        bubbletrail: (x, y) => {
            for (let i = 0; i < 10; i++) {
                radialAt(c, x + (i + 0.5) * (cell / 10), y + cell / 2 + Math.sin(i * 1.7) * cell * 0.14,
                    cell * 0.07, [[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]);
            }
        },
        scorch: (x, y) => {
            radial(c, x, y, cell, [[0, 'rgba(255,255,255,0.9)'], [0.6, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
            blotch(c, x, y, cell, 6, 'rgba(255,255,255,0.35)');
        },
    };

    for (const [name, idx] of Object.entries(lib.atlas.frames)) {
        const cx = (idx % cols) * cell;
        const cy = Math.floor(idx / cols) * cell;
        (painters[name] ?? painters.dot)(cx, cy);
    }

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

/** Ribbon strips need REPEAT along U — they get standalone textures rather
 *  than atlas cells (trail.vert tiles U beyond [0,1]; see effects/README). */
function buildTrailStrips(gl: WebGL2RenderingContext): Record<string, WebGLTexture> {
    const mk = (paint: (c: CanvasRenderingContext2D, w: number, h: number) => void): WebGLTexture => {
        const cv = document.createElement('canvas');
        cv.width = 128; cv.height = 32;
        const c = cv.getContext('2d')!;
        paint(c, cv.width, cv.height);
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    };
    return {
        smoketrail: mk((c, w, h) => {
            const g = c.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            c.fillStyle = g;
            c.fillRect(0, 0, w, h);
        }),
        bubbletrail: mk((c, w, h) => {
            for (let i = 0; i < 24; i++) {
                const x = (i / 24) * w + (i % 3);
                const y = h / 2 + Math.sin(i * 1.9) * h * 0.22;
                const r = 2 + (i % 4);
                const g = c.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, 'rgba(255,255,255,0.9)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                c.fillStyle = g;
                c.beginPath();
                c.arc(x, y, r, 0, Math.PI * 2);
                c.fill();
            }
        }),
    };
}

function radial(c: CanvasRenderingContext2D, x: number, y: number, cell: number,
    stops: [number, string][]): void {
    radialAt(c, x + cell / 2, y + cell / 2, cell * 0.46, stops);
}

function radialAt(c: CanvasRenderingContext2D, cx: number, cy: number, r: number,
    stops: [number, string][]): void {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, col] of stops) g.addColorStop(o, col);
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
}

/** Cluster of soft blobs — deterministic golden-angle placement (no RNG so
 *  the placeholder art is stable across sessions/screenshots). */
function blotch(c: CanvasRenderingContext2D, x: number, y: number, cell: number,
    n: number, colour: string): void {
    for (let i = 0; i < n; i++) {
        const a = i * 2.39996;
        const r = cell * 0.16 * ((i * 0.618) % 1 + 0.4);
        const bx = x + cell / 2 + Math.cos(a) * cell * 0.14;
        const by = y + cell / 2 + Math.sin(a) * cell * 0.12;
        const g = c.createRadialGradient(bx, by, 0, bx, by, r);
        g.addColorStop(0, colour);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(bx, by, r, 0, Math.PI * 2);
        c.fill();
    }
}

function stripInCell(c: CanvasRenderingContext2D, x: number, y: number, cell: number, alpha: number): void {
    const g = c.createLinearGradient(x, y, x, y + cell);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, cell, cell);
}
