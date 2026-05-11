/**
 * ceg-translator — convert streamed Spring CEG defs into runtime
 * `EffectDef` shapes the existing CegRuntime pool can render.
 *
 * Phase 5c. The server parses every `gamedata/explosions.lua` /
 * `effects/*.lua` table into `CegDefInfo` records (one per cegtag,
 * each with N `CegSpawnInfo` sub-emitters carrying class + count +
 * raw Lua-source property strings). This module collapses each CEG
 * down to the three pool classes the runtime ships (`flare`,
 * `spark`, `smoke`) by:
 *
 *   - picking a pool per Spring class (`CSimpleParticleSystem` →
 *     flare or smoke depending on `texture`; `CSimpleGroundFlash`
 *     → flare; `CHeatCloudProjectile` → flare; etc.).
 *   - decoding the relevant properties (`numparticles`,
 *     `particlelife`, `particlespeed`, `gravity`, `colormap`,
 *     `sizegrowth`, …) into the runtime's per-spawn parameters.
 *   - converting Spring's frame-rate-relative units (life in
 *     frames, speed in elmos/frame) into the runtime's
 *     wall-clock seconds and elmos/sec.
 *
 * Where a Spring class has no good pool match (e.g. `CExpGenSpawner`
 * which transitively emits another CEG, `explspike` which is a
 * one-off line projectile, `CBitmapMuzzleFlame` which is a stretched
 * model quad), the spawn is skipped — its absence reads as a
 * "lighter" version of the effect rather than a hole. Future phases
 * can add specialised pools or transitively resolve sub-CEGs.
 *
 * Design constraint: this code runs once per game session at game
 * start, not per-frame. It can be permissive about parse failures
 * (returning sensible defaults) without performance concerns.
 */

import type { CegDefInfo, CegSpawnInfo, CegPropertyInfo } from './connection.js';
import type { EffectDef, ParticleSpawn } from './ceg-runtime.js';

/// Spring's sim runs at 30 Hz; CEG `particlelife` and `ttl` are
/// in sim frames, `particlespeed` is elmos/frame. Convert at
/// this constant rate — the visual runtime uses wall-clock seconds.
const SIM_HZ = 30;

/// Hard cap on per-spawn particle count after translation. A few ZK
/// CEGs author `numparticles = 30`+ across multiple sub-emitters; left
/// unscaled, a single impact eats most of the pool's ring buffer in
/// one frame. The cap keeps a single CEG from monopolising the pool
/// without affecting visual fidelity at typical RTS-camera ranges.
const MAX_PARTICLES_PER_SPAWN = 12;

/// Hard cap on lifetime in seconds. Some authored CEGs use
/// `particlelife = 600` (20s) which is fine in Spring's wider pool
/// budget but starves the runtime's ring buffer here.
const MAX_LIFETIME_S = 4.0;

/// Translate one streamed CEG into a runtime `EffectDef`. Returns
/// null if the CEG has no spawns the runtime can render — caller can
/// fall through to BUILTIN_EFFECTS in that case.
export function translateCegDef(def: CegDefInfo): EffectDef | null {
    const spawns: ParticleSpawn[] = [];
    for (const s of def.spawns) {
        const ps = translateSpawn(s);
        if (ps) spawns.push(ps);
    }
    if (spawns.length === 0) return null;
    return { name: def.tag, spawns };
}

function translateSpawn(s: CegSpawnInfo): ParticleSpawn | null {
    const props = new PropMap(s.properties);
    const cls = s.className;

    switch (cls) {
        case 'CSimpleParticleSystem':
        case 'CSphereParticleSystem':
            return translateParticleSystem(s, props);

        case 'CSimpleGroundFlash':
            return translateGroundFlash(s, props);

        case 'CHeatCloudProjectile':
            return translateHeatCloud(s, props);

        // Stretched-quad muzzle flame (CBitmapMuzzleFlame) — render as
        // a directional flare burst. Spring's version morphs over the
        // gun barrel for ~2 frames; we approximate with a short-lived
        // flare cluster fired along the spawn direction.
        case 'CBitmapMuzzleFlame':
            return translateMuzzleFlame(s, props);

        // Sub-CEG dispatcher. We don't resolve transitively yet — a
        // proper implementation would look up the sub-tag at spawn
        // time and emit it. For now, drop it: the parent CEG usually
        // has enough direct spawns to read visually.
        case 'CExpGenSpawner':
        case 'CSpherePartSpawner':
            return null;

        // explspike, CSmokeTrailProjectile, CFireProjectile, debris,
        // CTracerProjectile — visually distinct enough that pooling
        // them as flares would mislead. Skip until specialised
        // pools land in 5d.
        default:
            return null;
    }
}

// ── CSimpleParticleSystem ───────────────────────────────────────────────────
//
// The workhorse class — used by every particle/spark/smoke effect
// in ZK. Reads ~12 properties; the most load-bearing are
// numparticles, particlelife, particlespeed, gravity, colormap, and
// texture (which decides which pool to allocate from).

function translateParticleSystem(s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const texture = props.getString('texture', '').toLowerCase();
    const poolClass = pickPoolFromTexture(texture);

    const numParticles = props.getInt('numparticles', 1);
    if (numParticles <= 0) return null;

    // Scale outer count by sub-emitter `count` so ZK's
    // `count = 5, numparticles = 6` reads as 30 particles total
    // (capped). Capping protects the ring buffer while preserving
    // the visual signature for 1-3-particle entries.
    const totalParticles = clamp(s.count * numParticles, 1, MAX_PARTICLES_PER_SPAWN);

    const lifeFrames     = props.getFloat('particlelife', 30);
    const lifeSpread     = props.getFloat('particlelifespread', 0);
    const lifeMin = clamp(lifeFrames / SIM_HZ, 0.05, MAX_LIFETIME_S);
    const lifeMax = clamp((lifeFrames + lifeSpread) / SIM_HZ, lifeMin, MAX_LIFETIME_S);

    const sizeBase   = props.getFloat('particlesize', 4);
    const sizeSpread = props.getFloat('particlesizespread', 0);
    const sizeStart  = sizeBase + sizeSpread * 0.5;
    const sizeGrowthPerFrame = props.getFloat('sizegrowth', 0);
    const lifetimeAvg = (lifeMin + lifeMax) * 0.5;
    const sizeEnd = Math.max(0,
        sizeStart + sizeGrowthPerFrame * SIM_HZ * lifetimeAvg);

    const speedBase   = props.getFloat('particlespeed', 0);
    const speedSpread = props.getFloat('particlespeedspread', 0);
    // particlespeed is elmos/frame in Spring; multiply by SIM_HZ
    // for elmos/second. Spread gives an isotropic cone — the runtime
    // applies it as `random[-1,+1] * velocitySpread`, so we halve.
    const velocityScale = speedBase * SIM_HZ;
    const velocitySpread = speedSpread * SIM_HZ * 0.5;

    // Gravity. Spring's vec3 gravity is per-frame². Most CEGs only
    // populate the y component (positive = upward smoke drift,
    // negative = downward spark fall). Our runtime takes a scalar
    // pulling *down* (positive). Convert: gravity_y > 0 → negative
    // runtime gravity (rises); gravity_y < 0 → positive (falls).
    const gravityVec = props.getVec3('gravity', [0, 0, 0]);
    const gravityYPerFrame2 = gravityVec[1];
    const runtimeGravity = -gravityYPerFrame2 * SIM_HZ * SIM_HZ;

    // emitvector — the "forward" direction relative to the spawn
    // direction. `directional = true` lines up with our existing
    // velocityScale; `directional = false` makes us drop velocityScale
    // and rely on velocitySpread for an isotropic cloud.
    const directional = props.getBool('directional', false);
    const baseScale = directional ? velocityScale : 0;
    const baseSpread = directional ? velocitySpread : Math.max(velocitySpread, velocityScale * 0.5);

    const color = parseColormap(props.getString('colormap', ''));

    return {
        class: poolClass,
        count: totalParticles,
        lifetimeMin: lifeMin,
        lifetimeMax: lifeMax,
        velocityBase: [0, 0, 0],
        velocitySpread: clamp(baseSpread, 0, 200),
        velocityScale: clamp(baseScale, -200, 200),
        gravity: clamp(runtimeGravity, -50, 200),
        sizeStart: clamp(sizeStart, 0.5, 80),
        sizeEnd:   clamp(sizeEnd,   0.1, 200),
        colorStart: color,
        rotationSpeedMax: 1.0,
    };
}

// ── CSimpleGroundFlash ──────────────────────────────────────────────────────
//
// One billboarded ground decal that scales over `ttl` frames.
// Maps cleanly to a single flare particle — the "ground" attachment
// is purely visual (decal would clip into terrain anyway in our
// projected billboard model).

function translateGroundFlash(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 30);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.1, MAX_LIFETIME_S);

    const sizeStart = clamp(props.getFloat('size', 20), 4, 120);
    const sizeGrowthPerFrame = props.getFloat('sizegrowth', 0);
    const sizeEnd = Math.max(0.5,
        sizeStart + sizeGrowthPerFrame * SIM_HZ * ttlS);

    const color = parseColormap(props.getString('colormap', ''));

    return {
        class: 'flare',
        count: 1,
        lifetimeMin: ttlS,
        lifetimeMax: ttlS,
        velocityBase: [0, 0, 0],
        velocitySpread: 0,
        velocityScale: 0,
        gravity: 0,
        sizeStart,
        sizeEnd,
        colorStart: color,
        rotationSpeedMax: 0,
    };
}

// ── CHeatCloudProjectile ────────────────────────────────────────────────────
//
// Spring's hot-air rising shimmer. Single particle, expands over
// `heatfalloff` frames. Pool: smoke (long-lived, large) keyed off
// the size — we lerp colour from the authored `color` triple.

function translateHeatCloud(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('heatfalloff', 30);
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.1, MAX_LIFETIME_S);
    const sizeStart = clamp(props.getFloat('size', 12), 4, 80);
    const sizeGrowthPerFrame = props.getFloat('sizegrowth', 0.5);
    const sizeEnd = Math.max(sizeStart,
        sizeStart + sizeGrowthPerFrame * SIM_HZ * ttlS);
    const c = props.getVec3('color', [1, 0.5, 0.2]);

    return {
        class: 'smoke',
        count: 1,
        lifetimeMin: ttlS,
        lifetimeMax: ttlS,
        velocityBase: [0, 4, 0],
        velocitySpread: 2,
        velocityScale: 0,
        gravity: -3,
        sizeStart,
        sizeEnd,
        colorStart: [c[0], c[1], c[2], 0.8],
        rotationSpeedMax: 0.6,
    };
}

// ── CBitmapMuzzleFlame ──────────────────────────────────────────────────────
//
// Stretched textured quad along the firing axis. We approximate as
// a small directional flare cluster — visually closer to the
// real "tongue" than a single billboarded sprite because the
// runtime applies velocityScale along the spawn direction so the
// cluster stretches forward over its (very short) lifetime.

function translateMuzzleFlame(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const lifeFrames = props.getFloat('life', 6);
    const lifeS = clamp(lifeFrames / SIM_HZ, 0.05, 0.5);
    const sizeStart = clamp(props.getFloat('size', 14), 4, 30);
    const sizeEnd   = clamp(props.getFloat('sizegrowth', sizeStart * 1.5), sizeStart, 60);
    const c = props.getVec3('color', [1, 0.85, 0.4]);
    const lengthFactor = props.getFloat('length', 30);

    return {
        class: 'flare',
        count: 3,
        lifetimeMin: lifeS,
        lifetimeMax: lifeS,
        velocityBase: [0, 0, 0],
        velocitySpread: 4,
        velocityScale: clamp(lengthFactor * 0.6, 0, 80),
        gravity: 0,
        sizeStart,
        sizeEnd,
        colorStart: [c[0], c[1], c[2], 1.0],
        rotationSpeedMax: 0,
    };
}

// ── Texture → pool mapping ─────────────────────────────────────────────────
//
// Spring's projectile bitmaps come from `gamedata/resources.lua`'s
// `graphics.projectiletextures` table. We don't carry that map
// over the wire — instead we look at the bare logical name and
// match common families. Unknown textures fall back to `flare`
// (the most generic of the three pools).

function pickPoolFromTexture(texture: string): 'flare' | 'spark' | 'smoke' {
    if (!texture) return 'flare';
    if (texture.includes('smoke') || texture.includes('cloud')
        || texture.includes('dust') || texture.includes('fume'))
        return 'smoke';
    if (texture.includes('spark') || texture.includes('gunshot')
        || texture.includes('debris') || texture === 'dot')
        return 'spark';
    return 'flare';
}

// ── Property accessor + parsers ─────────────────────────────────────────────
//
// `CegPropertyInfo[]` is a flat list of (key, raw-Lua-string) pairs.
// PropMap wraps it so we can peek with default fallbacks. All keys
// are already lowercased by the server-side serializer.

class PropMap {
    private map = new Map<string, string>();
    constructor(props: CegPropertyInfo[]) {
        for (const p of props) this.map.set(p.key, p.value);
    }
    getString(key: string, def: string): string {
        const v = this.map.get(key);
        return v !== undefined ? v : def;
    }
    getFloat(key: string, def: number): number {
        const v = this.map.get(key);
        if (v === undefined) return def;
        return parseLuaNumber(v, def);
    }
    getInt(key: string, def: number): number {
        return Math.round(this.getFloat(key, def));
    }
    getBool(key: string, def: boolean): boolean {
        const v = this.map.get(key);
        if (v === undefined) return def;
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
        return def;
    }
    /// Parse a comma- or space-separated triple. Falls back to
    /// `def` if the value is empty or fewer than 3 numbers parse.
    /// CEG authors mix `[[0, 2, 0]]` and `0 1 0` — we accept both.
    getVec3(key: string, def: [number, number, number]): [number, number, number] {
        const v = this.map.get(key);
        if (v === undefined) return def;
        const nums = parseNumberList(v);
        if (nums.length < 3) return def;
        return [nums[0], nums[1], nums[2]];
    }
}

/// Parse a Spring numeric expression, including the `r<bound>` random
/// notation. Returns the deterministic part — the runtime spread
/// fields cover the random component separately. `r-10` → -10 magnitude;
/// `r10` → 10. Leading `~` (some legacy syntax) is stripped.
function parseLuaNumber(s: string, def: number): number {
    if (!s) return def;
    let t = s.trim();
    if (t.startsWith('~')) t = t.slice(1);
    if (t.startsWith('r') || t.startsWith('R')) t = t.slice(1);
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : def;
}

/// Split a string of numbers on whitespace + commas + brackets,
/// drop everything that doesn't parse cleanly. Used for both vec3
/// properties (`[[0, 1, 0]]`) and colormaps (`"1 0 0 0.5  0 0 0 0"`).
function parseNumberList(s: string): number[] {
    if (!s) return [];
    const tokens = s.replace(/[\[\]{}()]/g, ' ')
                    .split(/[\s,]+/)
                    .filter(t => t.length > 0);
    const out: number[] = [];
    for (const t of tokens) {
        const n = parseLuaNumber(t, NaN);
        if (Number.isFinite(n)) out.push(n);
    }
    return out;
}

/// Spring colormaps are `"R G B A R G B A …"` — a sequence of RGBA
/// keyframes the engine lerps over particle lifetime. The runtime
/// only carries the start RGBA today (lifetime fade is built-in),
/// so we take the first 4 values. Falls back to a neutral white
/// when the string is empty or malformed.
function parseColormap(s: string): [number, number, number, number] {
    const nums = parseNumberList(s);
    if (nums.length >= 4) return [nums[0], nums[1], nums[2], nums[3]];
    if (nums.length === 3) return [nums[0], nums[1], nums[2], 1];
    return [1, 1, 1, 1];
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : (v > hi ? hi : v);
}
