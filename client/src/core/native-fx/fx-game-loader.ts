/**
 * fx-game-loader — the game-processor worker's native-FX pass.
 *
 * This is the loader `data/games/metalstorm/shaders/fx/README.md` "Wiring"
 * asked for: it fetches the authored GLSL + effect JSON over the game VFS
 * (HTTP, `/api/games/data/<game>/…` — the same tree `fx-viewer` reads, in the
 * same order as its `loadFxAssets`), builds a NativeFxRenderer on Babylon's
 * own WebGL2 context, and draws the additive FX passes inside the scene from
 * `scene.onAfterRenderingGroupObservable` on the last rendering group — so the
 * FX are depth-tested against the world and pass through the HDR pipeline's
 * bloom/tonemap with it.
 *
 * GL-state contract is the LuaUI raw-GL pass's, verbatim (game-processor.ts
 * `gpRunUiPass`): draw, unbind the VAO, then `engine.wipeCaches(true)` so
 * Babylon re-verifies every cached binding it owns. The framebuffer is NOT
 * saved/restored here — unlike the LuaUI pass (which runs after the scene and
 * must retarget the canvas), this pass draws into whatever Babylon has bound
 * at that moment, which is exactly the scene target it is meant to land in.
 *
 * Beta scope (PLAN-beta-presentation.md L-FX steps 1–4):
 *   - `uSoftRange = 0` — no depth copy, no soft particles.
 *   - shockwaves stay on distortion-renderer.ts (the native shockwave/offset
 *     pass is stage-only).
 *   - the atlas is the procedural placeholder (fx-atlas-placeholder.ts) on an
 *     OffscreenCanvas until `unittextures/fx_atlas.png` exists; the PNG is
 *     probed first and decoded with createImageBitmap (no ktx2 transcoder in
 *     the worker).
 *   - trail ribbons are allocated but nothing streams them yet (the
 *     projectile-attached trail slot is a later step).
 */

import type { Engine, Scene } from '@babylonjs/core';
import {
    compileEffect,
    compileEmitter,
    packTracer,
    TRACER_FLOATS,
    type FxEmitter,
    type FxLibrary,
    type SpawnContext,
    type TracerSpec,
    type WeaponFxMap,
    type WeaponFxSlots,
} from './effect-compiler.js';
import {
    NativeFxRenderer,
    NATIVE_FX_SHADER_FILES,
    type NativeFxPoolCapacities,
    type NativeFxSources,
    type PoolCounts,
    type TracerHandle,
} from './native-fx-renderer.js';
import { buildPlaceholderAtlas, buildTrailStrips } from './fx-atlas-placeholder.js';
import { getEngineGl } from '../engine-gl.js';
import {
    resolveWeaponFx, slotsHaveEffects, weaponTypeForProjectileType,
    type NativeFxSink,
} from '../weapon-fx-resolver.js';
import type { UnitFxMap } from '../unit-fx-dispatch.js';

/** The authored JSON the game path consumes. `unitFx` is loaded here (same
 *  fetch batch, one round trip each) so the unit-FX dispatcher can read it
 *  without a second loader. */
export interface FxGameAssets {
    sources: NativeFxSources;
    library: FxLibrary;
    weaponFx: WeaponFxMap;
    unitFx: UnitFxMap;
}

/** `gfx.particleQuality` (0/1/2) → native particle-pool capacity and
 *  per-effect spawn-count scale (PLAN-beta-presentation L-FX step 5). Pool
 *  capacity is read once at pass construction (a WebGL buffer can't resize
 *  live); countScale is read live via setQuality. */
export const NATIVE_FX_QUALITY_TIERS: ReadonlyArray<{ particleCap: number; countScale: number }> = [
    { particleCap: 8000, countScale: 0.5 },    // 0 low
    { particleCap: 24000, countScale: 0.75 },  // 1 medium
    { particleCap: 50000, countScale: 1.0 },   // 2 high
];

/** Global wind drift (elmos/s) the game pass sets on construction — a
 *  gentle, constant breeze (PLAN-beta-presentation L-FX step 7). Biased on
 *  one horizontal axis so drift reads as directional rather than a diffuse
 *  wobble. */
const DEFAULT_WIND: readonly [number, number, number] = [4, 0, 1.5];

/** Slot in the spawn scheduler: an emitter authored with `delay`. */
interface DelayedSpawn {
    at: number;                 // seconds on the FX clock
    emitter: FxEmitter;
    ctx: SpawnContext;
}

/** A cosmetic tracer the CPU is flying (the tracer shader holds a static head
 *  — projectile-attached state is the caller's job by design). */
interface LiveTracer {
    handle: TracerHandle | null;
    row: Float32Array;
    spec: TracerSpec;
    /** Launch time on the FX clock; negative dt = still queued in the burst. */
    startAt: number;
    travel: number;             // seconds from muzzle to impact point
    x0: number; y0: number; z0: number;
    dx: number; dy: number; dz: number;   // unit direction
    dist: number;
}

const DEFAULT_BASE = '/api/games/data';

/** Fetch the FX asset set for a game. Rejects when the game ships none —
 *  callers treat that as "this game has no native FX" and keep the existing
 *  CEG path. Order mirrors fx-viewer/index.ts loadFxAssets. */
export async function loadFxGameAssets(
    gameId: string, lobbyHttpUrl = '', base = DEFAULT_BASE,
): Promise<FxGameAssets> {
    const root = `${lobbyHttpUrl}${base}/${gameId}`;
    const get = async (rel: string): Promise<string> => {
        const res = await fetch(`${root}/${rel}`);
        if (!res.ok) throw new Error(`GET ${root}/${rel} → ${res.status}`);
        return res.text();
    };
    const sources: NativeFxSources = {};
    for (const f of NATIVE_FX_SHADER_FILES) sources[f] = await get(`shaders/fx/${f}`);
    const library = JSON.parse(await get('effects/library.json')) as FxLibrary;
    const weaponFx = JSON.parse(await get('effects/weapon-fx.json')) as WeaponFxMap;
    const unitFx = JSON.parse(await get('effects/unit-fx.json')) as UnitFxMap;
    return { sources, library, weaponFx, unitFx };
}

/**
 * Load the authored atlas if it exists, else bake the placeholder. PNG only:
 * `createImageBitmap` is available in the worker, a ktx2 transcoder is not.
 */
async function loadAtlasTexture(
    gl: WebGL2RenderingContext, lib: FxLibrary, root: string,
): Promise<WebGLTexture> {
    try {
        const res = await fetch(`${root}/unittextures/fx_atlas.png`);
        if (res.ok) {
            const bmp = await createImageBitmap(await res.blob());
            const tex = gl.createTexture()!;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            bmp.close();
            return tex;
        }
    } catch {
        // fall through to the placeholder
    }
    return buildPlaceholderAtlas(gl, lib);
}

/**
 * The live native-FX pass. Implements NativeFxSink, so the dispatch sites in
 * combat-fx.ts / projectile-renderer.ts hold this and nothing GL-shaped.
 */
export class NativeFxGamePass implements NativeFxSink {
    private readonly renderer: NativeFxRenderer;
    private readonly gl: WebGL2RenderingContext;
    private readonly scene: Scene;
    private readonly engine: Engine;
    private readonly lib: FxLibrary;
    private readonly weaponFx: WeaponFxMap;
    /** Unit-side FX map (death/damage-smoke/move-dust), consumed by
     *  unit-fx-dispatch.ts — fetched here (one round trip) and read off the
     *  pass rather than loaded twice. */
    readonly unitFx: UnitFxMap;

    /** FX clock in seconds — the uNow every spawned row is stamped with. */
    private now = 0;
    private delayed: DelayedSpawn[] = [];
    private tracers: LiveTracer[] = [];
    /** The rendering group we draw on: last frame's highest. Babylon exposes
     *  no "how many groups will render" query, so the pass learns it from the
     *  previous frame and rolls over in tick(). */
    private lastGroup = 0;
    private maxGroupSeen = 0;
    private observer: unknown = null;
    private disposed = false;
    /** Optional sink for impact scars (game-processor wires the decal overlay). */
    private scarSink: ((x: number, y: number, z: number, radius: number) => void) | null = null;
    /** `gfx.particleQuality` per-effect spawn-count scale (step 5) — live,
     *  applied at every spawn/retrigger. Pool capacity itself is fixed at
     *  construction (see NATIVE_FX_QUALITY_TIERS). */
    private countScale = NATIVE_FX_QUALITY_TIERS[NATIVE_FX_QUALITY_TIERS.length - 1].countScale;

    constructor(
        scene: Scene, engine: Engine, assets: FxGameAssets, atlas: WebGLTexture,
        qualityTier = NATIVE_FX_QUALITY_TIERS.length - 1,
    ) {
        this.scene = scene;
        this.engine = engine;
        this.lib = assets.library;
        this.weaponFx = assets.weaponFx;
        this.unitFx = assets.unitFx;
        this.gl = getEngineGl(engine);
        const tier = NATIVE_FX_QUALITY_TIERS[Math.max(0, Math.min(NATIVE_FX_QUALITY_TIERS.length - 1, qualityTier))];
        this.countScale = tier.countScale;
        const capacities: NativeFxPoolCapacities = { particle: tier.particleCap };
        this.renderer = new NativeFxRenderer(this.gl, assets.sources, {
            atlas,
            atlasCols: assets.library.atlas.cols,
            atlasRows: assets.library.atlas.rows,
            trailStrips: buildTrailStrips(this.gl),
        }, capacities);
        this.renderer.setWind(...DEFAULT_WIND);
        this.observer = scene.onAfterRenderingGroupObservable.add((info) => {
            const g = info.renderingGroupId;
            if (g > this.maxGroupSeen) this.maxGroupSeen = g;
            if (g === this.lastGroup) this.draw();
        });
    }

    setScarSink(fn: ((x: number, y: number, z: number, radius: number) => void) | null): void {
        this.scarSink = fn;
    }

    /** Live-update the per-effect count scale (pool capacity stays fixed —
     *  see the class doc). Called from game-processor's `gfx.particleQuality`
     *  subscription. */
    setQuality(tier: number): void {
        const t = NATIVE_FX_QUALITY_TIERS[Math.max(0, Math.min(NATIVE_FX_QUALITY_TIERS.length - 1, tier))];
        this.countScale = t.countScale;
    }

    // ── NativeFxSink ────────────────────────────────────────────────────────

    resolve(weaponDefName: string, projectileType?: number): WeaponFxSlots | null {
        if (!weaponDefName) return null;
        const slots = resolveWeaponFx(this.weaponFx, weaponDefName,
            projectileType != null ? weaponTypeForProjectileType(projectileType) : undefined);
        return slotsHaveEffects(slots) ? slots : null;
    }

    has(effect: string): boolean {
        return !!this.lib.effects[effect];
    }

    spawn(effect: string, x: number, y: number, z: number,
        dx: number, dy: number, dz: number): void {
        if (this.disposed) return;
        const ctx: SpawnContext = {
            x, y, z, dirX: dx, dirY: dy, dirZ: dz, now: this.now, countScale: this.countScale,
        };
        let batch;
        try {
            batch = compileEffect(this.lib, effect, ctx);
        } catch (err) {
            // A dangling effect name is an authoring error; the resolver test
            // is the gate. Don't let it kill the render loop.
            console.warn(`[native-fx] spawn("${effect}") failed: ${(err as Error).message}`);
            return;
        }
        this.emit(batch, ctx);
    }

    volleyTracers(effect: string,
        from: { x: number; y: number; z: number },
        to: { x: number; y: number; z: number },
        rounds: number, spreadDeg: number, burstSec: number): void {
        if (this.disposed) return;
        let spec: TracerSpec | undefined;
        try {
            const probe = compileEffect(this.lib, effect, {
                x: 0, y: 0, z: 0, dirX: 0, dirY: 0, dirZ: 1, now: this.now,
            });
            spec = probe.tracers[0];
        } catch {
            return;
        }
        if (!spec) return;

        const ax = to.x - from.x, ay = to.y - from.y, az = to.z - from.z;
        const dist = Math.hypot(ax, ay, az);
        if (dist < 1) return;
        const travel = Math.min(Math.max(dist / TRACER_SPEED, 0.04), spec.life);
        const n = Math.max(1, Math.min(rounds, MAX_VOLLEY_TRACERS));
        const half = (spreadDeg * Math.PI) / 180;
        for (let k = 0; k < n; k++) {
            // Jitter the direction, not the endpoint: a cone around the line
            // of fire is what a burst of rounds looks like from any angle.
            const yaw = (Math.random() * 2 - 1) * half;
            const pitch = (Math.random() * 2 - 1) * half;
            const d = jitterDir(ax / dist, ay / dist, az / dist, yaw, pitch);
            const row = new Float32Array(TRACER_FLOATS);
            this.tracers.push({
                handle: null, row, spec,
                startAt: this.now + (k * burstSec) / n,
                travel,
                x0: from.x, y0: from.y, z0: from.z,
                dx: d[0], dy: d[1], dz: d[2], dist,
            });
        }
    }

    // ── frame ───────────────────────────────────────────────────────────────

    /** Advance the FX clock, release delayed emitters, fly live tracers.
     *  Called from the game-processor render loop beside the other FX ticks. */
    tick(dt: number): void {
        if (this.disposed) return;
        this.now += dt;
        // Roll the group high-water over: the draw hook fires inside
        // scene.render(), which runs after this.
        this.lastGroup = this.maxGroupSeen;
        this.maxGroupSeen = 0;

        if (this.delayed.length) {
            const due = this.delayed.filter((d) => d.at <= this.now);
            if (due.length) {
                this.delayed = this.delayed.filter((d) => d.at > this.now);
                for (const d of due) {
                    const ctx = { ...d.ctx, now: this.now };
                    this.emit(compileEmitter(this.lib, d.emitter, ctx), ctx);
                }
            }
        }

        if (!this.tracers.length) return;
        const alive: LiveTracer[] = [];
        for (const t of this.tracers) {
            const age = this.now - t.startAt;
            if (age < 0) { alive.push(t); continue; }
            if (age > t.travel) {
                if (t.handle) this.renderer.killTracer(t.handle);
                continue;
            }
            const travelled = (age / t.travel) * t.dist;
            const hx = t.x0 + t.dx * travelled;
            const hy = t.y0 + t.dy * travelled;
            const hz = t.z0 + t.dz * travelled;
            if (!t.handle) {
                packTracer(t.row, 0, [hx, hy, hz],
                    [t.dx, t.dy, t.dz], t.spec, this.now);
                t.handle = this.renderer.allocTracer(t.row);
            } else {
                this.renderer.updateTracerHead(t.handle, hx, hy, hz);
            }
            alive.push(t);
        }
        this.tracers = alive;
    }

    counts(): PoolCounts {
        return this.renderer.counts();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.observer) {
            this.scene.onAfterRenderingGroupObservable.remove(this.observer as never);
            this.observer = null;
        }
        this.renderer.dispose();
    }

    // ── internals ───────────────────────────────────────────────────────────

    /** Push one compiled batch into the pools and queue its delayed emitters.
     *  Trails are skipped for beta (nothing streams ribbon nodes yet). */
    private emit(batch: ReturnType<typeof compileEffect>, ctx: SpawnContext): void {
        if (batch.particles && batch.particleCount) {
            this.renderer.spawnParticles(batch.particles, batch.particleCount);
        }
        if (batch.muzzles && batch.muzzleCount) {
            this.renderer.spawnMuzzles(batch.muzzles, batch.muzzleCount);
        }
        // Shockwaves stay on distortion-renderer.ts for beta — the native
        // offset/composite pass is stage-only (it owns render targets this
        // pass deliberately does not allocate).
        for (const d of batch.delayed) {
            this.delayed.push({ at: this.now + d.delay, emitter: d.emitter, ctx });
        }
    }

    /** The in-scene draw. Mirrors gpRunUiPass's state discipline. */
    private draw(): void {
        if (this.disposed) return;
        const cam = this.scene.activeCamera;
        if (!cam) return;
        const gl = this.gl;

        const viewProj = this.scene.getTransformMatrix().m as unknown as Float32Array;
        const p = cam.globalPosition;
        this.renderer.renderInto(gl, viewProj, this.now, /*depthTex*/ null, {
            camPos: [p.x, p.y, p.z],
            nearFar: [cam.minZ, cam.maxZ],
            screen: [this.engine.getRenderWidth(), this.engine.getRenderHeight()],
            softRange: 0,
        });

        // U8 (game-processor.ts gpRunUiPass): bind the DEFAULT VAO before
        // wipeCaches, or its unbindAllAttributes() disables the attributes of
        // whichever VAO we left bound. The renderer unbinds after each draw;
        // this is the belt to that braces.
        gl.bindVertexArray(null);
        (this.engine as unknown as { wipeCaches: (b?: boolean) => void }).wipeCaches(true);
    }

    /** Raise a scar for an impact, if the game wired a decal sink. */
    scar(x: number, y: number, z: number, radius: number): void {
        this.scarSink?.(x, y, z, radius);
    }
}

/** Cosmetic tracer flight speed (elmos/s). Statistical volleys carry no
 *  projectile and no authored velocity, so the streak needs one number: fast
 *  enough to read as kinetic, slow enough to be seen crossing the gap. */
const TRACER_SPEED = 900;
/** Cap on invented tracers per volley — `rounds` can be large for a squad. */
const MAX_VOLLEY_TRACERS = 12;

/** Rotate a unit direction by (yaw, pitch) radians in its own frame. Small
 *  angles only (±3° for a volley), so the cheap Euler form is exact enough. */
function jitterDir(
    dx: number, dy: number, dz: number, yaw: number, pitch: number,
): [number, number, number] {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x1 = dx * cy - dz * sy;
    const z1 = dx * sy + dz * cy;
    const y1 = dy + pitch;
    const l = Math.hypot(x1, y1, z1) || 1;
    return [x1 / l, y1 / l, z1 / l];
}

/**
 * Build the pass for a game, or return null when the game ships no FX set
 * (every non-Metalstorm game today). Never throws: a missing asset means "keep
 * the existing CEG path", not a broken boot.
 */
export async function createNativeFxGamePass(
    scene: Scene, engine: Engine, gameId: string, lobbyHttpUrl = '',
    qualityTier = NATIVE_FX_QUALITY_TIERS.length - 1,
): Promise<NativeFxGamePass | null> {
    if (!gameId) return null;
    try {
        const assets = await loadFxGameAssets(gameId, lobbyHttpUrl);
        const gl = getEngineGl(engine);
        const atlas = await loadAtlasTexture(
            gl, assets.library, `${lobbyHttpUrl}${DEFAULT_BASE}/${gameId}`);
        return new NativeFxGamePass(scene, engine, assets, atlas, qualityTier);
    } catch (err) {
        console.warn(`[native-fx] no native FX for game "${gameId}": ${(err as Error).message}`);
        return null;
    }
}
