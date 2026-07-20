/**
 * Native-FX effect compiler — Metalstorm effects/library.json → per-instance
 * attribute rows for the native GLSL ES 3.00 programs in
 * data/games/metalstorm/shaders/fx/.
 *
 * PURE DATA MODULE: no GL, no DOM, no Babylon — vitest-able in node and
 * loadable in the game-processor worker unchanged. This is the fx-offload X3
 * "name → emitter configs → GPU buffers" compiler; the fx-viewer scenario
 * uses it on the main thread today, and the Stage-7 worker FX adapter is
 * expected to instantiate the same module against the real scene
 * (see data/games/metalstorm/shaders/fx/README.md "Wiring").
 *
 * Row layouts MUST match the shader attribute packing documented in that
 * README (and in each .glsl header) float-for-float:
 *   particle    7×vec4 = 28 floats   (iPosLife iVelTime iSize iRot iAnim iColStart iColEnd)
 *   muzzleFlash 3×vec4 = 12 floats   (iPosLife iBirth iColor)
 *   tracer      4×vec4 = 16 floats   (iHeadLife iVelTime iShape iColor)
 *   trail       3×vec4 = 12 floats   (iP1 iP2 iUVAlpha)   — built by the caller per segment
 *   shockwave   2×vec4 =  8 floats   (iPosLife iParams)
 *
 * Tracer and trail emitters return DESCRIPTORS rather than finished rows:
 * both are projectile-attached (head refresh / node streaming is the
 * caller's per-frame job, mirroring projectile-trails.ts in the BAR/ZK
 * client), so the compiler only resolves their authored parameters.
 */

export const PARTICLE_FLOATS = 28;
export const MUZZLE_FLOATS = 12;
export const TRACER_FLOATS = 16;
export const TRAIL_FLOATS = 12;
export const SHOCK_FLOATS = 8;

export type ShaderKind = 'particle' | 'muzzleFlash' | 'tracer' | 'trail' | 'shockwave';

export const SHADER_KINDS: readonly ShaderKind[] = [
    'particle', 'muzzleFlash', 'tracer', 'trail', 'shockwave',
];

/** Orientation enum → iRot.z (particle.vert.glsl). */
const ORIENT: Record<string, number> = { billboard: 0, ground: 1, stretch: 2 };

// ── library.json shapes (deliberately loose: authored JSON, stub-tuned) ─────

export interface FxAtlasSpec {
    texture: string;
    cols: number;
    rows: number;
    frames: Record<string, number>;
}

/** One emitter entry inside an effect. Field superset across shaders. */
export interface FxEmitter {
    shader: ShaderKind;
    // particle
    count?: number | [number, number];
    sprite?: string;
    orient?: 'billboard' | 'ground' | 'stretch';
    life?: number | [number, number];
    size?: number | [number, number];
    speed?: number | [number, number];
    spread?: string;             // sphere | hemisphere | disc | cone:<deg>
    /** Spawn-POSITION scatter (elmos): number = sphere radius, triple =
     *  half-extents of an axis-aligned box. Distinct from `spread`, which
     *  scatters velocity DIRECTION. Needed for area effects — building
     *  collapse dust, dreadnought hull explosions, suppression fields —
     *  and costs no shader change (iPosLife is already per-instance). */
    posSpread?: number | [number, number, number];
    gravity?: number;
    stretch?: number;
    rot?: [number, number];
    animFrames?: number;
    animFps?: number;
    colorStart?: [number, number, number, number];
    colorEnd?: [number, number, number, number];
    delay?: number;
    // muzzleFlash
    color?: [number, number, number, number];
    spin?: number;
    // tracer
    length?: number;
    width?: number | [number, number];
    coreBoost?: number;
    taper?: number;
    // trail
    tileLength?: number;
    nodeInterval?: number;
    tint?: [number, number, number];
    alpha?: [number, number];
    rise?: number;
    // shockwave
    maxRadius?: number;
    strength?: number;
}

export interface FxEffectDef {
    /** Authoring hint for consumers + the fx-viewer default mode:
     *  muzzle/projectile/trail/impact are weapon-slot usages (weapon-fx.json);
     *  'death' marks unit-death effects (unit-fx.json `death` slot);
     *  'attached' marks binding-driven continuous emitters (damage smoke,
     *  dust trails, wakes, thruster/burning loops — retriggered by the
     *  binding interpreter, not fired by a weapon). */
    usage?: 'muzzle' | 'projectile' | 'trail' | 'impact' | 'death' | 'attached';
    alias?: string;
    emitters?: FxEmitter[];
    _doc?: string | string[];
}

export interface FxLibrary {
    version?: number;
    atlas: FxAtlasSpec;
    effects: Record<string, FxEffectDef>;
}

// ── weapon-fx.json shapes ────────────────────────────────────────────────────

export interface WeaponFxSlots {
    muzzle: string | null;
    projectile: string | null;
    trail: string | null;
    impact: string | null;
    fireSound: string | null;
    impactSound: string | null;
}

export interface WeaponFxMap {
    version?: number;
    defaults: Record<string, WeaponFxSlots | unknown>;
    __fallback: WeaponFxSlots;
    weapons: Record<string, WeaponFxSlots>;
}

// ── compile output ───────────────────────────────────────────────────────────

/** Projectile-attached tracer parameters (caller allocates the pool row and
 *  refreshes headPos each frame). */
export interface TracerSpec {
    length: number;
    width: number;
    coreBoost: number;
    taper: number;
    color: [number, number, number, number];
    life: number;
}

/** Projectile-attached ribbon parameters (caller streams nodes → segments and
 *  fades per-end alphas CPU-side, faithful to projectile-trails.ts). */
export interface TrailSpec {
    sprite: string;
    widthHead: number;
    widthTail: number;
    tileLength: number;
    nodeInterval: number;
    life: number;
    tint: [number, number, number];
    alphaHead: number;
    alphaTail: number;
    rise: number;
}

export interface CompiledBatch {
    particles: Float32Array | null;   // n × PARTICLE_FLOATS
    particleCount: number;
    muzzles: Float32Array | null;     // n × MUZZLE_FLOATS
    muzzleCount: number;
    shocks: Float32Array | null;      // n × SHOCK_FLOATS
    shockCount: number;
    tracers: TracerSpec[];
    trails: TrailSpec[];
    /** Emitters authored with `delay` — re-compile these at now+delay. */
    delayed: { delay: number; emitter: FxEmitter }[];
}

export interface SpawnContext {
    /** World spawn position. */
    x: number; y: number; z: number;
    /** Emission direction (need not be normalised; zero → up). */
    dirX: number; dirY: number; dirZ: number;
    /** Clock value matching the renderer's uNow (seconds). */
    now: number;
    /** RNG in [0,1) — injectable for deterministic tests. */
    rng?: () => number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function range(v: number | [number, number] | undefined, fallback: number, rng: () => number): number {
    if (v == null) return fallback;
    if (typeof v === 'number') return v;
    return v[0] + (v[1] - v[0]) * rng();
}

function pair(v: number | [number, number] | undefined, fallback: [number, number]): [number, number] {
    if (v == null) return fallback;
    if (typeof v === 'number') return [v, v];
    return v;
}

/** Resolve alias chains (`__default_explosion` → `expl_small`). Throws on a
 *  dangling or circular alias — an authoring error worth failing loudly on. */
export function resolveEffect(lib: FxLibrary, name: string): { name: string; def: FxEffectDef } {
    let cur = name;
    for (let hops = 0; hops < 8; hops++) {
        const def = lib.effects[cur];
        if (!def) throw new Error(`[native-fx] unknown effect "${cur}" (via "${name}")`);
        if (!def.alias) return { name: cur, def };
        cur = def.alias;
    }
    throw new Error(`[native-fx] alias loop resolving "${name}"`);
}

/** Effects whose (alias-resolved) emitters touch `shader` — the ?shader=
 *  filter for the fx-viewer menu. */
export function effectsUsingShader(lib: FxLibrary, shader: ShaderKind | null): string[] {
    const names: string[] = [];
    for (const name of Object.keys(lib.effects)) {
        let def: FxEffectDef;
        try {
            def = resolveEffect(lib, name).def;
        } catch {
            continue;   // dangling alias — skip from menus, surfaced by tests
        }
        const emitters = def.emitters ?? [];
        if (!shader || emitters.some((e) => e.shader === shader)) names.push(name);
    }
    return names.sort();
}

/** Default harness mode for an effect (fx-viewer `?mode=` fallback).
 *  'attached' emitters map to loop mode — continuous retrigger at a point
 *  is exactly how the binding interpreter drives them in-game. */
export function defaultModeForUsage(
    usage: FxEffectDef['usage'],
): 'muzzle' | 'projectile' | 'impact' | 'loop' {
    if (usage === 'muzzle') return 'muzzle';
    if (usage === 'projectile' || usage === 'trail') return 'projectile';
    if (usage === 'attached') return 'loop';
    return 'impact';   // impact, death, and anything unhinted
}

/** Weapon → slots via the documented resolution order: exact weapon entry →
 *  defaults[weapontype] → __fallback. */
export function resolveWeaponFx(
    map: WeaponFxMap, weaponName: string, weaponType?: string,
): WeaponFxSlots {
    const exact = map.weapons[weaponName];
    if (exact) return exact;
    if (weaponType) {
        const d = map.defaults[weaponType];
        if (d && typeof d === 'object' && 'impact' in (d as Record<string, unknown>)) {
            return d as WeaponFxSlots;
        }
    }
    return map.__fallback;
}

/** Emission direction sampler. `spread` grammar from effects/README.md:
 *  sphere | hemisphere (biased along +dir) | disc (ground plane) |
 *  cone:<deg> (around dir). Returns a unit vector. */
export function sampleSpread(
    spread: string | undefined,
    dir: [number, number, number],
    rng: () => number,
): [number, number, number] {
    const [dx, dy, dz] = normalise(dir);
    if (!spread || spread === 'point') return [dx, dy, dz];

    if (spread === 'sphere') return randomUnit(rng);

    if (spread === 'hemisphere') {
        const v = randomUnit(rng);
        const dot = v[0] * dx + v[1] * dy + v[2] * dz;
        return dot < 0 ? [-v[0], -v[1], -v[2]] : v;
    }

    if (spread === 'disc') {
        const a = rng() * Math.PI * 2;
        return [Math.cos(a), 0, Math.sin(a)];
    }

    if (spread.startsWith('cone:')) {
        const deg = Number(spread.slice(5)) || 0;
        const half = (deg * Math.PI) / 180;
        // Uniform cap around +Z, then rotate +Z onto dir.
        const cosT = 1 - rng() * (1 - Math.cos(half));
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phi = rng() * Math.PI * 2;
        const local: [number, number, number] =
            [sinT * Math.cos(phi), sinT * Math.sin(phi), cosT];
        return rotateZTo(local, [dx, dy, dz]);
    }

    return [dx, dy, dz];
}

/** Spawn-position offset for `posSpread` — uniform in a sphere (scalar
 *  radius) or an axis-aligned box (half-extent triple). Exported for tests. */
export function samplePosSpread(
    posSpread: number | [number, number, number] | undefined,
    rng: () => number,
): [number, number, number] {
    if (posSpread == null) return [0, 0, 0];
    if (typeof posSpread === 'number') {
        if (posSpread <= 0) return [0, 0, 0];
        // Uniform in the ball: direction × cbrt-weighted radius.
        const dir = randomUnit(rng);
        const r = posSpread * Math.cbrt(rng());
        return [dir[0] * r, dir[1] * r, dir[2] * r];
    }
    return [
        (rng() * 2 - 1) * posSpread[0],
        (rng() * 2 - 1) * posSpread[1],
        (rng() * 2 - 1) * posSpread[2],
    ];
}

function normalise(v: [number, number, number]): [number, number, number] {
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l < 1e-6) return [0, 1, 0];
    return [v[0] / l, v[1] / l, v[2] / l];
}

function randomUnit(rng: () => number): [number, number, number] {
    // Marsaglia-style rejection-free: uniform on the sphere.
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(a), z, r * Math.sin(a)];
}

/** Rotate vector `v` (authored around +Z) so +Z maps onto `to` (unit).
 *  Handedness of the (u, w) pair is irrelevant for symmetric cone sampling —
 *  only orthonormality matters. */
function rotateZTo(v: [number, number, number], to: [number, number, number]): [number, number, number] {
    const [tx, ty, tz] = to;
    // u ⟂ to. Prefer the horizontal cross((0,1,0), to); that degenerates
    // when `to` ≈ ±Y — the COMMON case (impact dir = straight up) — so fall
    // back to +X there.
    const u: [number, number, number] = (Math.abs(ty) > 0.999)
        ? [1, 0, 0]
        : normalise([tz, 0, -tx]);
    // w = to × u completes the orthonormal frame.
    const w: [number, number, number] = [
        ty * u[2] - tz * u[1],
        tz * u[0] - tx * u[2],
        tx * u[1] - ty * u[0],
    ];
    return [
        u[0] * v[0] + w[0] * v[1] + tx * v[2],
        u[1] * v[0] + w[1] * v[1] + ty * v[2],
        u[2] * v[0] + w[2] * v[1] + tz * v[2],
    ];
}

// ── the compiler ─────────────────────────────────────────────────────────────

/**
 * Expand one named effect at a spawn point into pool-ready rows/specs.
 * Emitters with `delay` are returned unexpanded in `delayed` — the caller
 * schedules `compileEmitter` at `ctx.now + delay` (keeps the compiler pure).
 */
export function compileEffect(lib: FxLibrary, name: string, ctx: SpawnContext): CompiledBatch {
    const { def } = resolveEffect(lib, name);
    const batch = emptyBatch();
    for (const emitter of def.emitters ?? []) {
        if (emitter.delay && emitter.delay > 0) {
            batch.delayed.push({ delay: emitter.delay, emitter });
            continue;
        }
        appendEmitter(lib, emitter, ctx, batch);
    }
    return batch;
}

/** Expand a single emitter (used directly for `delayed` re-entry). */
export function compileEmitter(lib: FxLibrary, emitter: FxEmitter, ctx: SpawnContext): CompiledBatch {
    const batch = emptyBatch();
    appendEmitter(lib, emitter, ctx, batch);
    return batch;
}

function emptyBatch(): CompiledBatch {
    return {
        particles: null, particleCount: 0,
        muzzles: null, muzzleCount: 0,
        shocks: null, shockCount: 0,
        tracers: [], trails: [], delayed: [],
    };
}

function appendEmitter(lib: FxLibrary, e: FxEmitter, ctx: SpawnContext, out: CompiledBatch): void {
    const rng = ctx.rng ?? Math.random;
    switch (e.shader) {
        case 'particle':    appendParticles(lib, e, ctx, rng, out); break;
        case 'muzzleFlash': appendMuzzle(e, ctx, rng, out); break;
        case 'shockwave':   appendShock(e, ctx, out); break;
        case 'tracer':      out.tracers.push(tracerSpec(e, rng)); break;
        case 'trail':       out.trails.push(trailSpec(e)); break;
        default:
            throw new Error(`[native-fx] emitter has unknown shader "${(e as { shader: string }).shader}"`);
    }
}

function appendParticles(
    lib: FxLibrary, e: FxEmitter, ctx: SpawnContext, rng: () => number, out: CompiledBatch,
): void {
    const n = Math.max(1, Math.round(range(e.count, 1, rng)));
    const rows = new Float32Array(n * PARTICLE_FLOATS);
    const frame = e.sprite != null ? (lib.atlas.frames[e.sprite] ?? 0) : 0;
    const sizePair = pair(e.size, [8, 8]);
    const colS = e.colorStart ?? [1, 1, 1, 1];
    const colE = e.colorEnd ?? [colS[0], colS[1], colS[2], 0];
    const orient = ORIENT[e.orient ?? 'billboard'] ?? 0;
    const dir: [number, number, number] = [ctx.dirX, ctx.dirY, ctx.dirZ];

    for (let i = 0; i < n; i++) {
        const o = i * PARTICLE_FLOATS;
        const life = Math.max(0.01, range(e.life, 0.5, rng));
        const speed = range(e.speed, 0, rng);
        const d = sampleSpread(e.spread, dir, rng);
        const rot = e.rot ?? [0, 0];
        const po = samplePosSpread(e.posSpread, rng);

        // iPosLife (spawn position scattered by posSpread)
        rows[o + 0] = ctx.x + po[0];
        rows[o + 1] = ctx.y + po[1];
        rows[o + 2] = ctx.z + po[2];
        rows[o + 3] = life;
        // iVelTime
        rows[o + 4] = d[0] * speed; rows[o + 5] = d[1] * speed; rows[o + 6] = d[2] * speed;
        rows[o + 7] = ctx.now;
        // iSize (sizeStart, sizeEnd, gravity, stretch)
        rows[o + 8] = sizePair[0]; rows[o + 9] = sizePair[1];
        rows[o + 10] = e.gravity ?? 0; rows[o + 11] = e.stretch ?? 1;
        // iRot (rotBase, rotSpeed, orient, animFps) — random base spin for
        // billboards so simultaneous puffs don't render identically.
        rows[o + 12] = rot[0] + (orient === 0 ? rng() * Math.PI * 2 : 0);
        rows[o + 13] = rot[1];
        rows[o + 14] = orient;
        rows[o + 15] = e.animFps ?? 0;
        // iAnim
        rows[o + 16] = frame; rows[o + 17] = e.animFrames ?? 0;
        rows[o + 18] = 0; rows[o + 19] = 0;
        // iColStart / iColEnd
        rows[o + 20] = colS[0]; rows[o + 21] = colS[1]; rows[o + 22] = colS[2]; rows[o + 23] = colS[3];
        rows[o + 24] = colE[0]; rows[o + 25] = colE[1]; rows[o + 26] = colE[2]; rows[o + 27] = colE[3];
    }
    out.particles = concat(out.particles, rows);
    out.particleCount += n;
}

function appendMuzzle(e: FxEmitter, ctx: SpawnContext, rng: () => number, out: CompiledBatch): void {
    const rows = new Float32Array(MUZZLE_FLOATS);
    const col = e.color ?? [5, 3.5, 1.2, 1];
    const life = Math.max(0.01, range(e.life, 0.08, rng));
    // iPosLife
    rows[0] = ctx.x; rows[1] = ctx.y; rows[2] = ctx.z; rows[3] = life;
    // iBirth (birthTime, size, spin, seed)
    rows[4] = ctx.now; rows[5] = range(e.size, 10, rng);
    rows[6] = e.spin ?? 0; rows[7] = rng() * Math.PI * 2;
    // iColor
    rows[8] = col[0]; rows[9] = col[1]; rows[10] = col[2]; rows[11] = col[3];
    out.muzzles = concat(out.muzzles, rows);
    out.muzzleCount += 1;
}

function appendShock(e: FxEmitter, ctx: SpawnContext, out: CompiledBatch): void {
    const rows = new Float32Array(SHOCK_FLOATS);
    // iPosLife
    rows[0] = ctx.x; rows[1] = ctx.y; rows[2] = ctx.z;
    rows[3] = Math.max(0.01, typeof e.life === 'number' ? e.life : 0.5);
    // iParams (birthTime, maxRadius, strength, _)
    rows[4] = ctx.now; rows[5] = e.maxRadius ?? 80; rows[6] = e.strength ?? 0.7; rows[7] = 0;
    out.shocks = concat(out.shocks, rows);
    out.shockCount += 1;
}

function tracerSpec(e: FxEmitter, rng: () => number): TracerSpec {
    return {
        length: e.length ?? 24,
        width: range(e.width, 1.5, rng),
        coreBoost: e.coreBoost ?? 2,
        taper: e.taper ?? 1.2,
        color: e.color ?? [4, 2.6, 0.9, 1],
        life: typeof e.life === 'number' ? e.life : 3,
    };
}

function trailSpec(e: FxEmitter): TrailSpec {
    const w = pair(e.width, [5, 15]);
    const a = e.alpha ?? [0.8, 0];
    return {
        sprite: e.sprite ?? 'smoketrail',
        widthHead: w[0], widthTail: w[1],
        tileLength: e.tileLength ?? 48,
        nodeInterval: e.nodeInterval ?? 0.05,
        life: typeof e.life === 'number' ? e.life : 1.2,
        tint: e.tint ?? [0.6, 0.58, 0.55],
        alphaHead: a[0], alphaTail: a[1],
        rise: e.rise ?? 0,
    };
}

function concat(a: Float32Array | null, b: Float32Array): Float32Array {
    if (!a) return b;
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Pack one trail segment row (iP1 iP2 iUVAlpha) — helper shared by the
 *  stage's trail streamer and any future worker adapter. Per-end pairing:
 *  u1/a1 belong to p1 and u2/a2 to p2 (trail.vert.glsl mixes iUVAlpha.x at
 *  the p1 end and .y at the p2 end) — the caller decides which endpoint
 *  carries the smaller U. */
export function packTrailSegment(
    out: Float32Array, offset: number,
    p1: [number, number, number], w1: number,
    p2: [number, number, number], w2: number,
    u1: number, u2: number, a1: number, a2: number,
): void {
    out[offset + 0] = p1[0]; out[offset + 1] = p1[1]; out[offset + 2] = p1[2]; out[offset + 3] = w1;
    out[offset + 4] = p2[0]; out[offset + 5] = p2[1]; out[offset + 6] = p2[2]; out[offset + 7] = w2;
    out[offset + 8] = u1;    out[offset + 9] = u2;    out[offset + 10] = a1;   out[offset + 11] = a2;
}

/** Pack one tracer row (iHeadLife iVelTime iShape iColor). */
export function packTracer(
    out: Float32Array, offset: number,
    head: [number, number, number], vel: [number, number, number],
    spec: TracerSpec, birthTime: number,
): void {
    out[offset + 0] = head[0]; out[offset + 1] = head[1]; out[offset + 2] = head[2];
    out[offset + 3] = spec.life;
    out[offset + 4] = vel[0]; out[offset + 5] = vel[1]; out[offset + 6] = vel[2];
    out[offset + 7] = birthTime;
    out[offset + 8] = spec.length; out[offset + 9] = spec.width;
    out[offset + 10] = spec.coreBoost; out[offset + 11] = spec.taper;
    out[offset + 12] = spec.color[0]; out[offset + 13] = spec.color[1];
    out[offset + 14] = spec.color[2]; out[offset + 15] = spec.color[3];
}
