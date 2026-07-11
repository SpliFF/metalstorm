/**
 * Native-FX renderer — raw-WebGL2 execution of the Metalstorm native FX
 * programs (data/games/metalstorm/shaders/fx/*.glsl).
 *
 * CONTEXT-AGNOSTIC: takes an injected WebGL2 context + the shader SOURCE
 * STRINGS (the caller fetches them — VFS, HTTP, bundler; the renderer never
 * does I/O) and owns programs, VAOs, instance pools, and the pass sequence:
 *
 *   1. scene pass    — caller-provided opaque draw into sceneFBO
 *                      (RGBA8 colour + DEPTH_COMPONENT24 depth texture)
 *   2. depth copy    — blitFramebuffer into a second depth texture so the
 *                      soft-particle fade can sample the opaque scene depth
 *                      while still depth-TESTING against the original
 *                      (sampling an attached depth texture is a feedback loop)
 *   3. FX passes     — particle / muzzleFlash / tracer / trail draws,
 *                      premultiplied additive (ONE, ONE), depth test ON
 *                      write OFF — the blend + depth contract every
 *                      shaders/fx header documents
 *   4. offset pass   — shockwave instances additively into an RGBA16F
 *                      offset target (EXT_color_buffer_float; shockwaves
 *                      auto-disable without it)
 *   5. composite     — fullscreen-tri.vert + shockwave-composite.frag warps
 *                      sceneFBO by the accumulated offset onto the caller's
 *                      target framebuffer
 *
 * Pool model mirrors the shaders' birth-state contract: spawns upload rows
 * ONCE (bufferSubData at the ring cursor); the GPU integrates age from uNow
 * and self-culls dead rows, so there is no per-frame per-particle CPU work
 * (PLAN-fx-offload.md §5). Tracer heads and trail alphas are the two
 * documented exceptions (projectile-attached state, faithful to
 * projectile-trails.ts) — both are explicit update calls here.
 *
 * This module is the reference implementation for the Stage-7 GP-worker FX
 * loader (shaders/fx/README.md "Wiring"): the worker adapter should
 * instantiate it against Babylon's context via getEngineGl(engine) and drive
 * beginFrame/render with the game camera instead of the harness stage.
 */

import {
    MUZZLE_FLOATS, PARTICLE_FLOATS, SHOCK_FLOATS, TRACER_FLOATS, TRAIL_FLOATS,
} from './effect-compiler.js';

export interface NativeFxSources {
    /** Keyed by file basename, e.g. 'particle.vert.glsl'. */
    [file: string]: string;
}

export interface NativeFxTextures {
    /** FX sprite atlas (particle pass). */
    atlas: WebGLTexture;
    atlasCols: number;
    atlasRows: number;
    /** Ribbon strip per trail sprite name ('smoketrail', 'bubbletrail', …). */
    trailStrips: Record<string, WebGLTexture>;
}

export interface NativeFxFrame {
    view: Float32Array;        // column-major 4×4
    proj: Float32Array;
    camPos: [number, number, number];
    now: number;               // seconds — the uNow clock rows were stamped with
    /** Opaque scene content drawn into the scene FBO before FX. */
    drawOpaque: (gl: WebGL2RenderingContext, viewProj: Float32Array) => void;
    /** Framebuffer to composite into (null = default/canvas). */
    target?: WebGLFramebuffer | null;
    /** Soft-particle fade range in elmos (<=0 disables). */
    softRange?: number;
    /** Composite UV displacement scale. */
    distortionStrength?: number;
    /** Solo one program for ?shader= isolation (null = all). */
    solo?: ShaderSolo | null;
    /** Camera near/far used to build `proj` (soft-particle linearise). */
    nearFar: [number, number];
    /** Active trail tint + strip (single-effect-under-test simplification:
     *  uTint/uTrailTex are per-DRAW uniforms in trail.frag.glsl, so one draw
     *  renders one style — fine for a harness; a production adapter would
     *  bucket segments by style). */
    trailSprite?: string;
    trailTint?: [number, number, number];
}

export type ShaderSolo = 'particle' | 'muzzleFlash' | 'tracer' | 'trail' | 'shockwave';

export interface PoolCounts {
    particles: number;
    muzzles: number;
    tracers: number;
    trailSegments: number;
    shocks: number;
}

const POOL = {
    particle: 4096,
    muzzle: 128,
    tracer: 256,
    trail: 1024,
    shock: 32,
} as const;

/** Files the renderer needs from shaders/fx/. Exported so callers can drive
 *  their fetch loop off the same list (single source of truth). */
export const NATIVE_FX_SHADER_FILES = [
    'particle.vert.glsl', 'particle.frag.glsl',
    'muzzle-flash.vert.glsl', 'muzzle-flash.frag.glsl',
    'tracer.vert.glsl', 'tracer.frag.glsl',
    'trail.vert.glsl', 'trail.frag.glsl',
    'shockwave.vert.glsl', 'shockwave.frag.glsl',
    'fullscreen-tri.vert.glsl', 'shockwave-composite.frag.glsl',
] as const;

interface Pool {
    buf: WebGLBuffer;
    vao: WebGLVertexArrayObject;
    floatsPerRow: number;
    capacity: number;
    cursor: number;          // ring write index (rows)
    high: number;            // high-water mark → instance draw count
    spawned: number;         // lifetime spawn counter (stats)
    cpu: Float32Array;       // CPU mirror for row updates (tracer/trail)
}

interface Handle { row: number; gen: number; }
export type TracerHandle = Handle;
export type TrailSegmentHandle = Handle;

export class NativeFxRenderer {
    private gl: WebGL2RenderingContext;
    private progs = new Map<string, WebGLProgram>();
    private uni = new Map<string, Record<string, WebGLUniformLocation | null>>();
    private pools: Record<'particle' | 'muzzle' | 'tracer' | 'trail' | 'shock', Pool>;
    private quadBuf: WebGLBuffer;
    private quadIdx: WebGLBuffer;
    private emptyVao: WebGLVertexArrayObject;   // fullscreen tri (gl_VertexID)
    private tex: NativeFxTextures;

    private sceneFbo: WebGLFramebuffer;
    private sceneColor: WebGLTexture;
    private sceneDepth: WebGLTexture;
    private depthCopyFbo: WebGLFramebuffer;
    private depthCopy: WebGLTexture;
    private offsetFbo: WebGLFramebuffer | null = null;
    private offsetTex: WebGLTexture | null = null;
    /** False when EXT_color_buffer_float is unavailable — shockwave pass
     *  disabled, composite passes through undistorted. */
    readonly distortionAvailable: boolean;

    private width = 0;
    private height = 0;
    private tracerGen = new Int32Array(POOL.tracer);
    private trailGen = new Int32Array(POOL.trail);
    /** Rows the CPU touched since the last draw (row-index ranges per pool),
     *  flushed with one bufferSubData per pool per frame. */
    private dirtyTracer = new Set<number>();
    private dirtyTrail = new Set<number>();

    constructor(gl: WebGL2RenderingContext, sources: NativeFxSources, textures: NativeFxTextures) {
        this.gl = gl;
        this.tex = textures;
        this.distortionAvailable = gl.getExtension('EXT_color_buffer_float') !== null;

        for (const f of NATIVE_FX_SHADER_FILES) {
            if (!sources[f]) throw new Error(`[native-fx] missing shader source "${f}"`);
        }

        // ── programs ────────────────────────────────────────────────────────
        this.link('particle', sources['particle.vert.glsl'], sources['particle.frag.glsl']);
        this.link('muzzle', sources['muzzle-flash.vert.glsl'], sources['muzzle-flash.frag.glsl']);
        this.link('tracer', sources['tracer.vert.glsl'], sources['tracer.frag.glsl']);
        this.link('trail', sources['trail.vert.glsl'], sources['trail.frag.glsl']);
        this.link('shock', sources['shockwave.vert.glsl'], sources['shockwave.frag.glsl']);
        this.link('composite', sources['fullscreen-tri.vert.glsl'], sources['shockwave-composite.frag.glsl']);

        // ── base quad (aCorner loc 0, aUV loc 1) ────────────────────────────
        //    x, y corner in [-0.5, 0.5]; u, v in [0, 1]
        const quad = new Float32Array([
            -0.5, -0.5, 0, 0,
             0.5, -0.5, 1, 0,
             0.5,  0.5, 1, 1,
            -0.5,  0.5, 0, 1,
        ]);
        this.quadBuf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
        this.quadIdx = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIdx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
        this.emptyVao = gl.createVertexArray()!;

        // ── instance pools + VAOs (attribute locations match the .glsl
        //    layout(location=N) declarations exactly) ─────────────────────────
        this.pools = {
            particle: this.makePool(PARTICLE_FLOATS, POOL.particle, 2, 7, true),
            muzzle:   this.makePool(MUZZLE_FLOATS, POOL.muzzle, 2, 3, true),
            tracer:   this.makePool(TRACER_FLOATS, POOL.tracer, 2, 4, true),
            trail:    this.makePool(TRAIL_FLOATS, POOL.trail, 2, 3, true),
            // shockwave.vert has NO aUV: instance attribs start at location 1.
            shock:    this.makePool(SHOCK_FLOATS, POOL.shock, 1, 2, false),
        };

        // ── render targets (sized on first beginFrame/resize) ───────────────
        this.sceneFbo = gl.createFramebuffer()!;
        this.sceneColor = gl.createTexture()!;
        this.sceneDepth = gl.createTexture()!;
        this.depthCopyFbo = gl.createFramebuffer()!;
        this.depthCopy = gl.createTexture()!;
        if (this.distortionAvailable) {
            this.offsetFbo = gl.createFramebuffer()!;
            this.offsetTex = gl.createTexture()!;
        }
    }

    // ── spawning (rows come from effect-compiler) ───────────────────────────

    spawnParticles(rows: Float32Array, count: number): void {
        this.ringWrite(this.pools.particle, rows, count);
    }

    spawnMuzzles(rows: Float32Array, count: number): void {
        this.ringWrite(this.pools.muzzle, rows, count);
    }

    spawnShocks(rows: Float32Array, count: number): void {
        if (!this.distortionAvailable) return;
        this.ringWrite(this.pools.shock, rows, count);
    }

    /** Allocate a projectile-attached tracer row. Caller refreshes the head
     *  via updateTracerHead each frame and killTracer on impact. */
    allocTracer(row: Float32Array): TracerHandle {
        const pool = this.pools.tracer;
        const r = pool.cursor;
        pool.cursor = (pool.cursor + 1) % pool.capacity;
        pool.high = Math.max(pool.high, r + 1);
        pool.spawned++;
        pool.cpu.set(row.subarray(0, TRACER_FLOATS), r * TRACER_FLOATS);
        this.tracerGen[r]++;
        this.dirtyTracer.add(r);
        return { row: r, gen: this.tracerGen[r] };
    }

    updateTracerHead(h: TracerHandle, x: number, y: number, z: number): void {
        if (this.tracerGen[h.row] !== h.gen) return;   // row recycled
        const o = h.row * TRACER_FLOATS;
        const cpu = this.pools.tracer.cpu;
        cpu[o + 0] = x; cpu[o + 1] = y; cpu[o + 2] = z;
        this.dirtyTracer.add(h.row);
    }

    killTracer(h: TracerHandle): void {
        if (this.tracerGen[h.row] !== h.gen) return;
        this.pools.tracer.cpu[h.row * TRACER_FLOATS + 3] = 0;   // lifetime<=0 → culled
        this.dirtyTracer.add(h.row);
    }

    /** Allocate one ribbon segment; caller fades its per-end alphas over the
     *  segment's life (updateTrailSegmentAlpha) and kills it at expiry. */
    allocTrailSegment(row: Float32Array): TrailSegmentHandle {
        const pool = this.pools.trail;
        const r = pool.cursor;
        pool.cursor = (pool.cursor + 1) % pool.capacity;
        pool.high = Math.max(pool.high, r + 1);
        pool.spawned++;
        pool.cpu.set(row.subarray(0, TRAIL_FLOATS), r * TRAIL_FLOATS);
        this.trailGen[r]++;
        this.dirtyTrail.add(r);
        return { row: r, gen: this.trailGen[r] };
    }

    updateTrailSegmentAlpha(h: TrailSegmentHandle, a1: number, a2: number): void {
        if (this.trailGen[h.row] !== h.gen) return;
        const o = h.row * TRAIL_FLOATS;
        const cpu = this.pools.trail.cpu;
        cpu[o + 10] = a1; cpu[o + 11] = a2;
        this.dirtyTrail.add(h.row);
    }

    killTrailSegment(h: TrailSegmentHandle): void {
        if (this.trailGen[h.row] !== h.gen) return;
        const o = h.row * TRAIL_FLOATS;
        const cpu = this.pools.trail.cpu;
        cpu[o + 10] = 0; cpu[o + 11] = 0;   // invisible (trail has no lifetime attr)
        this.dirtyTrail.add(h.row);
    }

    counts(): PoolCounts {
        return {
            particles: this.pools.particle.spawned,
            muzzles: this.pools.muzzle.spawned,
            tracers: this.pools.tracer.spawned,
            trailSegments: this.pools.trail.spawned,
            shocks: this.pools.shock.spawned,
        };
    }

    // ── frame ────────────────────────────────────────────────────────────────

    resize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        const gl = this.gl;

        this.sizeTex(this.sceneColor, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
        this.sizeDepthTex(this.sceneDepth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneColor, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.sceneDepth, 0);

        this.sizeDepthTex(this.depthCopy);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthCopyFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthCopy, 0);

        if (this.offsetFbo && this.offsetTex) {
            this.sizeTex(this.offsetTex, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.offsetFbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.offsetTex, 0);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    render(frame: NativeFxFrame): void {
        const gl = this.gl;
        if (this.width === 0) throw new Error('[native-fx] render before resize');
        const viewProj = mat4Mul(frame.proj, frame.view);
        const solo = frame.solo ?? null;

        this.flushDirty();

        // 1. opaque scene → sceneFbo
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        frame.drawOpaque(gl, viewProj);

        // 2. depth copy for the soft-particle sampler
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthCopyFbo);
        gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height,
            gl.DEPTH_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);

        // 3. FX passes — additive premultiplied, depth test on / write off
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.depthMask(false);

        if (!solo || solo === 'particle') this.drawParticles(frame, viewProj);
        if (!solo || solo === 'muzzleFlash') this.drawMuzzles(frame, viewProj);
        if (!solo || solo === 'tracer') this.drawTracers(frame, viewProj);
        if (!solo || solo === 'trail') this.drawTrails(frame, viewProj);

        // 4. shockwave offsets → RGBA16F target
        const distort = this.distortionAvailable && (!solo || solo === 'shockwave');
        if (this.offsetFbo) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.offsetFbo);
            gl.viewport(0, 0, this.width, this.height);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (distort && this.pools.shock.high > 0) {
                gl.disable(gl.DEPTH_TEST);          // screen-space effect
                this.drawShocks(frame, viewProj);
                gl.enable(gl.DEPTH_TEST);
            }
        }

        // 5. composite scene (+ warp) onto the caller's target
        gl.bindFramebuffer(gl.FRAMEBUFFER, frame.target ?? null);
        gl.viewport(0, 0, this.width, this.height);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        const prog = this.use('composite');
        this.bindTex(0, this.sceneColor, prog.uScene);
        // Without float-buffer support the offset sampler is a black texture
        // → zero displacement → clean pass-through (documented fallback).
        this.bindTex(1, this.offsetTex ?? this.sceneColor, prog.uOffset);
        this.gl.uniform1f(prog.uStrength,
            this.offsetTex ? (frame.distortionStrength ?? 0.06) : 0);
        gl.bindVertexArray(this.emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
    }

    dispose(): void {
        const gl = this.gl;
        for (const p of this.progs.values()) gl.deleteProgram(p);
        for (const pool of Object.values(this.pools)) {
            gl.deleteBuffer(pool.buf);
            gl.deleteVertexArray(pool.vao);
        }
        gl.deleteBuffer(this.quadBuf);
        gl.deleteBuffer(this.quadIdx);
        gl.deleteVertexArray(this.emptyVao);
        gl.deleteFramebuffer(this.sceneFbo);
        gl.deleteFramebuffer(this.depthCopyFbo);
        if (this.offsetFbo) gl.deleteFramebuffer(this.offsetFbo);
        gl.deleteTexture(this.sceneColor);
        gl.deleteTexture(this.sceneDepth);
        gl.deleteTexture(this.depthCopy);
        if (this.offsetTex) gl.deleteTexture(this.offsetTex);
    }

    // ── internals ────────────────────────────────────────────────────────────

    private link(name: string, vertSrc: string, fragSrc: string): void {
        const gl = this.gl;
        const vs = this.compile(gl.VERTEX_SHADER, vertSrc, `${name}.vert`);
        const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc, `${name}.frag`);
        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(prog);
            gl.deleteProgram(prog);
            throw new Error(`[native-fx] link "${name}": ${log}`);
        }
        this.progs.set(name, prog);
        // Cache every active uniform location up front.
        const uniforms: Record<string, WebGLUniformLocation | null> = {};
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
        for (let i = 0; i < n; i++) {
            const info = gl.getActiveUniform(prog, i);
            if (info) uniforms[info.name] = gl.getUniformLocation(prog, info.name);
        }
        this.uni.set(name, uniforms);
    }

    private compile(type: number, src: string, label: string): WebGLShader {
        const gl = this.gl;
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh);
            gl.deleteShader(sh);
            throw new Error(`[native-fx] compile ${label}: ${log}`);
        }
        return sh;
    }

    private use(name: string): Record<string, WebGLUniformLocation | null> {
        this.gl.useProgram(this.progs.get(name)!);
        return this.uni.get(name)!;
    }

    /** Build a pool VAO: base quad at locations 0(+1), instance vec4 streams
     *  from `firstLoc`, divisor 1. `withUv` binds aUV at location 1. */
    private makePool(
        floatsPerRow: number, capacity: number,
        firstLoc: number, vec4Count: number, withUv: boolean,
    ): Pool {
        const gl = this.gl;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);      // aCorner
        if (withUv) {
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);  // aUV
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIdx);

        const buf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * floatsPerRow * 4, gl.DYNAMIC_DRAW);
        const stride = floatsPerRow * 4;
        for (let i = 0; i < vec4Count; i++) {
            const loc = firstLoc + i;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, i * 16);
            gl.vertexAttribDivisor(loc, 1);
        }
        gl.bindVertexArray(null);

        return {
            buf, vao, floatsPerRow, capacity,
            cursor: 0, high: 0, spawned: 0,
            cpu: new Float32Array(capacity * floatsPerRow),
        };
    }

    /** Ring-write `count` rows and upload them in one or two subData calls
     *  (two when the write wraps the ring boundary). */
    private ringWrite(pool: Pool, rows: Float32Array, count: number): void {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, pool.buf);
        let written = 0;
        while (written < count) {
            const at = pool.cursor;
            const run = Math.min(count - written, pool.capacity - at);
            const src = rows.subarray(written * pool.floatsPerRow, (written + run) * pool.floatsPerRow);
            pool.cpu.set(src, at * pool.floatsPerRow);
            gl.bufferSubData(gl.ARRAY_BUFFER, at * pool.floatsPerRow * 4, src);
            pool.cursor = (at + run) % pool.capacity;
            pool.high = Math.max(pool.high, at + run);
            written += run;
        }
        pool.spawned += count;
    }

    /** Flush tracer/trail row edits — one contiguous upload per pool spanning
     *  the dirty range (rows are few and clustered; simpler than N calls). */
    private flushDirty(): void {
        const gl = this.gl;
        this.flushDirtySet(this.pools.tracer, this.dirtyTracer, TRACER_FLOATS);
        this.flushDirtySet(this.pools.trail, this.dirtyTrail, TRAIL_FLOATS);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    private flushDirtySet(pool: Pool, dirty: Set<number>, floats: number): void {
        if (dirty.size === 0) return;
        let lo = Infinity, hi = -Infinity;
        for (const r of dirty) { if (r < lo) lo = r; if (r > hi) hi = r; }
        dirty.clear();
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, pool.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, lo * floats * 4,
            pool.cpu.subarray(lo * floats, (hi + 1) * floats));
    }

    private drawInstanced(pool: Pool): void {
        if (pool.high === 0) return;
        const gl = this.gl;
        gl.bindVertexArray(pool.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, pool.high);
        gl.bindVertexArray(null);
    }

    private drawParticles(frame: NativeFxFrame, viewProj: Float32Array): void {
        const gl = this.gl;
        const u = this.use('particle');
        gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
        gl.uniform1f(u.uNow, frame.now);
        gl.uniform3f(u.uCamPos, ...frame.camPos);
        gl.uniform1f(u.uAtlasCols, this.tex.atlasCols);
        gl.uniform1f(u.uAtlasRows, this.tex.atlasRows);
        this.bindTex(0, this.tex.atlas, u.uParticleTex);
        gl.uniform2f(u.uAtlasDimsInv, 1 / this.tex.atlasCols, 1 / this.tex.atlasRows);
        this.bindTex(1, this.depthCopy, u.uDepthTex);
        gl.uniform2f(u.uCamNearFar, frame.nearFar[0], frame.nearFar[1]);
        gl.uniform2f(u.uScreenSize, this.width, this.height);
        gl.uniform1f(u.uSoftRange, frame.softRange ?? 10);
        this.drawInstanced(this.pools.particle);
    }

    private drawMuzzles(frame: NativeFxFrame, viewProj: Float32Array): void {
        const gl = this.gl;
        const u = this.use('muzzle');
        gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
        gl.uniform1f(u.uNow, frame.now);
        gl.uniform3f(u.uCamPos, ...frame.camPos);
        gl.uniform1f(u.uHasTex, 0);
        this.drawInstanced(this.pools.muzzle);
    }

    private drawTracers(frame: NativeFxFrame, viewProj: Float32Array): void {
        const gl = this.gl;
        const u = this.use('tracer');
        gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
        gl.uniform1f(u.uNow, frame.now);
        gl.uniform3f(u.uCamPos, ...frame.camPos);
        gl.uniform3f(u.uColorScale, 1, 1, 1);
        gl.uniform1f(u.uHasTex, 0);
        this.drawInstanced(this.pools.tracer);
    }

    private drawTrails(frame: NativeFxFrame, viewProj: Float32Array): void {
        const gl = this.gl;
        const u = this.use('trail');
        gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
        gl.uniform3f(u.uCamPos, ...frame.camPos);
        const sprite = frame.trailSprite ?? 'smoketrail';
        const strip = this.tex.trailStrips[sprite] ?? this.tex.trailStrips.smoketrail;
        this.bindTex(0, strip, u.uTrailTex);
        const tint = frame.trailTint ?? [0.6, 0.58, 0.55];
        gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
        this.drawInstanced(this.pools.trail);
    }

    private drawShocks(frame: NativeFxFrame, viewProj: Float32Array): void {
        const gl = this.gl;
        const u = this.use('shock');
        gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
        gl.uniform1f(u.uNow, frame.now);
        gl.uniform3f(u.uCamPos, ...frame.camPos);
        this.drawInstanced(this.pools.shock);
    }

    private bindTex(unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (loc) gl.uniform1i(loc, unit);
    }

    private sizeTex(tex: WebGLTexture, internal: number, format: number, type: number): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.width, this.height, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    private sizeDepthTex(tex: WebGLTexture): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.width, this.height, 0,
            gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
}

// ── minimal column-major mat4 helpers (shared with fx-stage) ────────────────

export function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] =
                a[0 * 4 + r] * b[c * 4 + 0] +
                a[1 * 4 + r] * b[c * 4 + 1] +
                a[2 * 4 + r] * b[c * 4 + 2] +
                a[3 * 4 + r] * b[c * 4 + 3];
        }
    }
    return out;
}

export function mat4Perspective(fovYRad: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1 / Math.tan(fovYRad / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
}

export function mat4LookAt(
    eye: [number, number, number], at: [number, number, number], up: [number, number, number],
): Float32Array {
    const zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    const z = [zx / zl, zy / zl, zz / zl];
    const xx = up[1] * z[2] - up[2] * z[1];
    const xy = up[2] * z[0] - up[0] * z[2];
    const xz = up[0] * z[1] - up[1] * z[0];
    const xl = Math.hypot(xx, xy, xz) || 1;
    const x = [xx / xl, xy / xl, xz / xl];
    const y = [
        z[1] * x[2] - z[2] * x[1],
        z[2] * x[0] - z[0] * x[2],
        z[0] * x[1] - z[1] * x[0],
    ];
    const out = new Float32Array(16);
    out[0] = x[0]; out[1] = y[0]; out[2] = z[0];
    out[4] = x[1]; out[5] = y[1]; out[6] = z[1];
    out[8] = x[2]; out[9] = y[2]; out[10] = z[2];
    out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
    out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
    out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
    out[15] = 1;
    return out;
}
