/**
 * ceg-translator — convert streamed Spring CEG defs into runtime
 * `EffectDef` shapes the CegRuntime can render.
 *
 * The server parses every `gamedata/explosions.lua` / `effects/*.lua`
 * table into `CegDefInfo` records (one per cegtag, each with N
 * `CegSpawnInfo` sub-emitters carrying class + count + raw Lua-source
 * property strings). This module turns each spawn into a runtime
 * `ParticleSpawn` (or `SubCegSpawn`) by:
 *
 *   - mapping the Spring class to a translator function (CSPS,
 *     CHeatCloud, CSmokeProjectile, sub-CEG spawners, etc.).
 *   - reading the authored `texture = "..."` property and passing it
 *     straight through as `ParticleSpawn.texture`. The runtime
 *     allocates a thin-instance batch per unique texture name (Phase
 *     5a) — no more collapsing to three generic pools.
 *   - decoding atlas dims from `_NxM` suffix names and authored
 *     `animparams` (Phase 5b) for tile-grid sprite animation.
 *   - decoding the rest (`numparticles`, `particlelife`,
 *     `particlespeed`, `gravity`, `colormap`, `sizegrowth`, …) into
 *     per-spawn runtime parameters, converting Spring's frame-rate-
 *     relative units (life in frames, speed in elmos/frame) into the
 *     runtime's wall-clock seconds and elmos/sec.
 *
 * Where a Spring class has no translator (e.g. `CWakeProjectile`
 * with no authored texture — defaults to a small wake puff;
 * unrecognised classes — silently dropped), the spawn is skipped so
 * the rest of the CEG still fires.
 *
 * Design constraint: this code runs once per game session at game
 * start, not per-frame. It can be permissive about parse failures
 * (returning sensible defaults) without performance concerns.
 */

import type { CegDefInfo, CegSpawnInfo, CegPropertyInfo } from './connection.js';
import type { EffectDef, GroundFlash, ParticleSpawn, SubCegSpawn, Expr } from './ceg-runtime.js';
import { ORIENT_GROUND, ORIENT_STRETCH } from './ceg-orient.js';

/// Spring's sim runs at 30 Hz; CEG `particlelife` and `ttl` are
/// in sim frames, `particlespeed` is elmos/frame. Convert at
/// this constant rate — the visual runtime uses wall-clock seconds.
const SIM_HZ = 30;

/// Per-spawn particle-count and lifetime budget (Phase T / G).
///
/// These were hardcoded `12` / `4.0s` placeholders that silently
/// clamped every authored ZK CEG far below what Recoil renders (Recoil
/// routinely spawns dozens per sub-emitter with multi-second lifetimes).
/// They are now mutable module state seeded with generous high-tier
/// defaults and re-pointed by Phase G's `gfx.particleQuality` setting at
/// game load (translation re-runs per session via `ingestCegDefs`, so a
/// per-session quality read is sufficient — live mid-game change is a
/// non-goal, matching the `requiresRestart` convention for heavy knobs).
///
/// The values are still *caps*, not targets: they bound a pathological
/// `numparticles = 10000` CEG and keep the longest-lived puffs from
/// lapping the per-class ring buffer. Defaults are sized so no authored
/// ZK CEG is clamped at the `high` tier.
let MAX_PARTICLES_PER_SPAWN = 64;
let MAX_LIFETIME_S = 12.0;

/// Phase G hook: set the per-spawn particle budget before CEG defs are
/// ingested/translated. Called from the quality-preset wiring with the
/// tier's values; absent a call, the generous defaults above apply.
export function setParticleBudget(maxPerSpawn: number, maxLifetimeS: number): void {
    if (Number.isFinite(maxPerSpawn) && maxPerSpawn > 0) MAX_PARTICLES_PER_SPAWN = maxPerSpawn;
    if (Number.isFinite(maxLifetimeS) && maxLifetimeS > 0) MAX_LIFETIME_S = maxLifetimeS;
}

/// Read-back for tests / Phase G diagnostics.
export function getParticleBudget(): { maxPerSpawn: number; maxLifetimeS: number } {
    return { maxPerSpawn: MAX_PARTICLES_PER_SPAWN, maxLifetimeS: MAX_LIFETIME_S };
}

/// Translate one streamed CEG into a runtime `EffectDef`. Returns
/// null if the CEG has no spawns the runtime can render — caller can
/// fall through to BUILTIN_EFFECTS in that case.
export function translateCegDef(def: CegDefInfo): EffectDef | null {
    const spawns: Array<ParticleSpawn | SubCegSpawn> = [];
    for (const s of def.spawns) {
        const ps = translateSpawn(s);
        if (!ps) continue;
        // Propagate the streamed `flags` byte for Phase 6 visibility
        // gating. Set only when non-zero to keep the common
        // "unrestricted" case branchless at dispatch time.
        if (s.flags) ps.flags = s.flags;
        spawns.push(ps);
    }
    const groundFlash = translateGroundFlashSubtable(def);
    if (spawns.length === 0 && !def.useDefaultExplosions && !groundFlash) return null;
    return {
        name: def.tag,
        spawns,
        useDefaultExplosions: def.useDefaultExplosions,
        groundFlash,
    };
}

/// Convert the streamed `groundflash` subtable (sim-frames, world-units
/// per frame) into the runtime's wall-clock representation. Returns
/// undefined when the def didn't author one — keeping the `groundFlash`
/// field absent rather than zero-valued lets the runtime branch on
/// `!== undefined` without checking nine fields.
function translateGroundFlashSubtable(def: CegDefInfo): GroundFlash | undefined {
    const gf = def.groundFlash;
    if (!gf || gf.ttl <= 0) return undefined;
    return {
        lifetimeS: clamp(gf.ttl / SIM_HZ, 0.05, MAX_LIFETIME_S),
        flashSize: clamp(gf.flashSize, 1, 400),
        flashAlpha: clamp(gf.flashAlpha, 0, 1),
        circleAlpha: clamp(gf.circleAlpha, 0, 1),
        circleGrowth: gf.circleGrowth * SIM_HZ, // frames → seconds
        colorR: gf.colorR,
        colorG: gf.colorG,
        colorB: gf.colorB,
        flags: gf.flags,
    };
}

function translateSpawn(s: CegSpawnInfo): ParticleSpawn | SubCegSpawn | null {
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

        // Sub-CEG dispatcher — `delayspawner` alias. Fires the named
        // child CEG after a (possibly random, possibly damage-scaled)
        // frame delay. The canonical multi-level CEG idiom (nuke →
        // mushroom → smokejets) routes through here.
        case 'CExpGenSpawner':
            return translateExpGenSpawner(s, props);

        // Sphere-distributed sub-CEG. Translator handles the case
        // where an `explosiongenerator` property is present (sub-CEG
        // chained over a sphere). The variant without one — a self-
        // contained `CSpherePartProjectile` cluster — falls through
        // to the projectile-class translator below.
        case 'CSpherePartSpawner':
            return translateSpherePartSpawner(s, props);

        // ── Workhorse projectile spawners ─────────────────────────
        // Each class translates onto the existing flare/spark/smoke
        // pools with parameters mapped from its native properties.
        // Dedicated shader pipelines (stretched tracer beams,
        // ground-aligned wake decals) can replace these per-class
        // billboards if a future visual audit demands the extra
        // fidelity.

        case 'CFireProjectile':
            return translateFireProjectile(s, props);

        case 'CSmokeProjectile':
        case 'CSmokeProjectile2':
            return translateSmokeProjectile(s, props);

        case 'CDirtProjectile':
            return translateDirtProjectile(s, props);

        case 'CSpherePartProjectile':
            return translateSpherePartProjectile(s, props);

        case 'CMuzzleFlame':
            // Legacy non-bitmap muzzle flame; rare in ZK but appears
            // in older content. Treat as CBitmapMuzzleFlame — visual
            // difference is small enough at typical zoom that the
            // shared translator is adequate.
            return translateMuzzleFlame(s, props);

        case 'CGfxProjectile':
            return translateGfxProjectile(s, props);

        case 'CGeoSquareProjectile':
            return translateGeoSquareProjectile(s, props);

        case 'CTracerProjectile':
            return translateTracerProjectile(s, props);

        case 'CExploSpikeProjectile':
            return translateExploSpikeProjectile(s, props);

        case 'CSmokeTrailProjectile':
            return translateSmokeTrailProjectile(s, props);

        case 'CBubbleProjectile':
            return translateBubbleProjectile(s, props);

        case 'CWakeProjectile':
            return translateWakeProjectile(s, props);

        default:
            // No translator for this Spring class. Record it so the
            // Z4/Z5 verification gate can assert "no unknown CEG class"
            // instead of silently dropping the spawn. The set is drained
            // by takeUnknownClasses() at registration time.
            if (cls) unknownClasses.set(cls, (unknownClasses.get(cls) ?? 0) + 1);
            return null;
    }
}

/// Classes encountered by translateSpawn that have no translator,
/// counted by how many spawns referenced them. Populated during
/// translateCegDef; read + cleared by takeUnknownClasses().
const unknownClasses = new Map<string, number>();

/// Drain the unknown-class tally accumulated since the last call.
/// CegRuntime.ingestCegDefs reports this once after a batch so the
/// Z4 verification gate ("a nuke runs every spawn class without an
/// unknown-class warning") is observable rather than silent.
export function takeUnknownClasses(): Map<string, number> {
    const out = new Map(unknownClasses);
    unknownClasses.clear();
    return out;
}

// ── CSimpleParticleSystem ───────────────────────────────────────────────────
//
// The workhorse class — used by every particle/spark/smoke effect
// in ZK. Reads ~12 properties; the most load-bearing are
// numparticles, particlelife, particlespeed, gravity, colormap, and
// texture (which decides which pool to allocate from).

function translateParticleSystem(s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    // Phase 5a: the authored texture name flows straight through to the
    // runtime as the pool key. Empty / missing texture falls back to
    // the generic `flare` bitmap — matches today's catch-all behaviour
    // for CSPS-without-texture entries, and the runtime allocates a
    // shared pool keyed off the name for cross-spawn batching.
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    const anim = parseAnimParams(props.getString('animparams', ''));

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

    const ramp = parseColormap(props.getString('colormap', ''));

    return {
        texture,
        count: totalParticles,
        lifetimeMin: lifeMin,
        lifetimeMax: lifeMax,
        velocityBase: [0, 0, 0],
        velocitySpread: clamp(baseSpread, 0, 200),
        velocityScale: clamp(baseScale, -200, 200),
        gravity: clamp(runtimeGravity, -50, 200),
        sizeStart: clamp(sizeStart, 0.5, 80),
        sizeEnd:   clamp(sizeEnd,   0.1, 200),
        colorStart: ramp.start,
        colorEnd: ramp.end,
        rotationSpeedMax: 1.0,
        animFrameStart: anim?.frameStart,
        animFrameCount: anim?.frameCount,
        animFps: anim?.fps,
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

    const ramp = parseColormap(props.getString('colormap', ''));
    // CSimpleGroundFlash carries an optional `texture` property —
    // honour it; bare flashes default to the engine's generic flare.
    const texture = props.getString('texture', '').toLowerCase() || 'flare';

    return {
        texture,
        count: 1,
        lifetimeMin: ttlS,
        lifetimeMax: ttlS,
        velocityBase: [0, 0, 0],
        velocitySpread: 0,
        velocityScale: 0,
        gravity: 0,
        sizeStart,
        sizeEnd,
        colorStart: ramp.start,
        colorEnd: ramp.end,
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
    // Heat clouds prefer a soft puff sprite when authored; fall back
    // to the generic smoke trail bitmap for unspecified entries.
    const texture = props.getString('texture', '').toLowerCase() || 'smoketrail';

    return {
        texture,
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
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    const anim = parseAnimParams(props.getString('animparams', ''));

    return {
        texture,
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
        animFrameStart: anim?.frameStart,
        animFrameCount: anim?.frameCount,
        animFps: anim?.fps,
    };
}

// ── Phase 4 workhorse projectile spawners ──────────────────────────────────
//
// These classes are individual projectile types in Spring — each was
// historically rendered with its own draw path. We collapse them onto
// the existing flare/spark/smoke pools so authored CEGs that reference
// them produce *something* visible at the right scale and colour
// signature. Dedicated shader pipelines (stretched tracer beams,
// ground-aligned wake decals, animated bubble sprites) can replace
// these per-class billboards later when ZK content actually demands
// the extra fidelity.

// ── CFireProjectile ───────────────────────────────────────────────────────
// Long-lived flame chunk. Spring authors use it as the visual debris
// from burning structures and as fireball impact petals. Properties
// of note: `ttl` (frames), `size`, `agespeed` (size decay rate), and
// optional `emitVector` (initial drift bias). We render as a flame-
// coloured flare cluster with small upward drift.

function translateFireProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 60);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.2, MAX_LIFETIME_S);
    const sizeStart = clamp(props.getFloat('size', 10), 2, 60);
    const sizeEnd = clamp(sizeStart * 0.4, 0.5, sizeStart);
    // CFireProjectile authored textures are typically `flame` /
    // `fireball` atlases; fall back to the generic flare bitmap for
    // entries that didn't specify one.
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    const anim = parseAnimParams(props.getString('animparams', ''));
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 4, 0],
        velocitySpread: 3,
        velocityScale: 0,
        gravity: -4,
        sizeStart, sizeEnd,
        colorStart: [1.0, 0.7, 0.2, 1.0],
        colorEnd:   [0.6, 0.2, 0.05, 0.0],
        rotationSpeedMax: 1.0,
        animFrameStart: anim?.frameStart,
        animFrameCount: anim?.frameCount,
        animFps: anim?.fps,
    };
}

// ── CSmokeProjectile / CSmokeProjectile2 ──────────────────────────────────
// Spring's dedicated smoke puff classes. Differ from CSimpleParticle-
// System-with-smoke-texture by their authored alpha/size curves and
// the use of `startsize` + `sizeexpansion` rather than `particlesize`
// + `sizegrowth`. Author intent: a single big puff per spawn, not a
// fan of small ones. We honour `color` (luminosity 0..1), `startsize`,
// `sizeexpansion` (per-frame size growth), and `ttl`.

function translateSmokeProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    // `agespeed` is "age fraction added per sim frame"; ttl = 1 / agespeed.
    const ageSpeed = props.getFloat('agespeed', 1 / 60);
    const ttlFrames = ageSpeed > 0 ? Math.min(1 / ageSpeed, 240) : 90;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.5, MAX_LIFETIME_S);
    const startSize = clamp(props.getFloat('startsize', 6), 2, 60);
    const expansionPerFrame = props.getFloat('sizeexpansion', 0.4);
    const sizeEnd = clamp(startSize + expansionPerFrame * SIM_HZ * ttlS,
                          startSize, 200);
    // `color` is a single luminance value in Spring's smoke shader
    // (0 = dark grey smoke, 1 = light cloud). Map to a grey RGB.
    const lum = clamp(props.getFloat('color', 0.5), 0, 1);
    // CSmokeProjectile sometimes carries an explicit texture; the
    // default is the engine smoketrail bitmap (sized for puffy smoke).
    const texture = props.getString('texture', '').toLowerCase() || 'smoketrail';
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 4, 0],
        velocitySpread: 2,
        velocityScale: 0,
        gravity: -2,
        sizeStart: startSize, sizeEnd,
        colorStart: [lum, lum, lum, 0.6],
        colorEnd:   [lum * 0.6, lum * 0.6, lum * 0.6, 0.0],
        rotationSpeedMax: 0.8,
    };
}

// ── CDirtProjectile ───────────────────────────────────────────────────────
// Kicked-up debris chunk. Strong downward gravity, brown/grey colour,
// short-lived. ZK uses it for explosion ground-debris fans alongside
// CSimpleParticleSystem dirt sparks.

function translateDirtProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 45);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.2, MAX_LIFETIME_S);
    const sizeStart = clamp(props.getFloat('size', 3), 0.5, 20);
    const slowDown = props.getFloat('slowdown', 1);
    // `slowdown` divides velocity each frame; we use it as a damping
    // signal — higher slowdown → less spread to keep debris compact.
    const spread = clamp(40 / Math.max(0.5, slowDown), 5, 80);
    const c = props.getVec3('color', [0.5, 0.4, 0.3]);
    const alpha = clamp(props.getFloat('alpha', 1), 0, 1);
    // CDirtProjectile authors often specify a `circularthingy` /
    // `dirt` sprite; fall back to flare for the generic case (small
    // bright kick).
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS * 0.7, lifetimeMax: ttlS,
        velocityBase: [0, 5, 0],
        velocitySpread: spread,
        velocityScale: 0,
        gravity: 80,
        sizeStart, sizeEnd: sizeStart * 0.5,
        colorStart: [c[0], c[1], c[2], alpha],
        colorEnd:   [c[0] * 0.4, c[1] * 0.4, c[2] * 0.4, 0.0],
        rotationSpeedMax: 0.6,
    };
}

// ── CSpherePartProjectile ─────────────────────────────────────────────────
// Single sphere fragment fired from CSpherePartSpawner (or directly).
// Properties: `expansionspeed` (radial growth), `ttl`, `color`, `alpha`.
// Renders as a single growing flare puff.

function translateSpherePartProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 30);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.1, MAX_LIFETIME_S);
    const expansion = clamp(props.getFloat('expansionspeed', 4), 0, 60);
    const sizeStart = 1;
    const sizeEnd = clamp(sizeStart + expansion * SIM_HZ * ttlS, 2, 200);
    const c = props.getVec3('color', [1, 1, 1]);
    const alpha = clamp(props.getFloat('alpha', 1), 0, 1);
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 0, 0],
        velocitySpread: 0,
        velocityScale: 0,
        gravity: 0,
        sizeStart, sizeEnd,
        colorStart: [c[0], c[1], c[2], alpha],
        colorEnd:   [c[0], c[1], c[2], 0.0],
        rotationSpeedMax: 0,
    };
}

// ── CGfxProjectile ────────────────────────────────────────────────────────
// Generic textured billboard — Spring's catch-all "I just need a quad"
// class. Honour `ttl`, `size`, `pos`, with a neutral white default.

function translateGfxProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 30);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.1, MAX_LIFETIME_S);
    const sizeStart = clamp(props.getFloat('size', 6), 1, 40);
    // CGfxProjectile is the generic "draw this texture as a quad"
    // class; authored texture name flows straight through (or defaults
    // to flare when blank). animparams overrides for atlases.
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    const anim = parseAnimParams(props.getString('animparams', ''));
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 0, 0],
        velocitySpread: 0,
        velocityScale: 0,
        gravity: 0,
        sizeStart, sizeEnd: sizeStart,
        colorStart: [1, 1, 1, 0.8],
        colorEnd:   [1, 1, 1, 0.0],
        rotationSpeedMax: 0.4,
        animFrameStart: anim?.frameStart,
        animFrameCount: anim?.frameCount,
        animFps: anim?.fps,
    };
}

// ── CGeoSquareProjectile ──────────────────────────────────────────────────
// Geo vent puff — a small upward-drifting square sprite. Rare in ZK
// (only on geothermal-themed maps). Honour `ttl`, `width`, `length`.

function translateGeoSquareProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 30);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.3, MAX_LIFETIME_S);
    const size = clamp(Math.max(
        props.getFloat('width', 4),
        props.getFloat('length', 4)), 2, 40);
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 6, 0],
        velocitySpread: 1,
        velocityScale: 0,
        gravity: -3,
        sizeStart: size, sizeEnd: size * 0.7,
        colorStart: [0.9, 0.6, 0.3, 0.7],
        colorEnd:   [0.4, 0.2, 0.1, 0.0],
        rotationSpeedMax: 0.5,
    };
}

// ── CTracerProjectile ─────────────────────────────────────────────────────
// Stretched-line tracer — Spring renders as a textured quad scaled
// along the velocity axis. Lacking a dedicated stretched-quad pool
// (Phase 4 deferred), we approximate with a short bright directional
// flare cluster fired along the spawn direction. Visual signature
// (bright streak following the line of fire) reads adequately at
// typical RTS-camera zoom.

function translateTracerProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const length = clamp(props.getFloat('length', 10), 4, 60);
    const speed = clamp(props.getFloat('speed', 200), 50, 500);
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    // Phase T: render as a velocity-stretched streak (ORIENT_STRETCH)
    // rather than a flare blob. width is the cross extent; `stretch`
    // scales the along-velocity extent up to ~`length` elmos so the
    // tracer reads as a bright line down the line of fire.
    const width = clamp(length * 0.12, 0.5, 4);
    return {
        texture,
        count: 1,
        lifetimeMin: 0.08, lifetimeMax: 0.18,
        velocityBase: [0, 0, 0],
        velocitySpread: 0,
        velocityScale: speed,
        gravity: 0,
        sizeStart: width,
        sizeEnd: width * 0.5,
        colorStart: [1.0, 0.9, 0.4, 1.0],
        colorEnd:   [1.0, 0.6, 0.1, 0.0],
        rotationSpeedMax: 0,
        orient: ORIENT_STRETCH,
        stretch: length / width,
    };
}

// ── CExploSpikeProjectile ─────────────────────────────────────────────────
// Directional radial spike — Spring fires N of these from an explosion
// origin pointing outward, drawn as stretched quads along each spike's
// direction. Without a stretched-quad pool, we render as a spark cluster
// fired isotropically: the visual effect of "explosion spikes" reads
// through the per-particle velocity spread.

function translateExploSpikeProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 15);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.1, 0.8);
    const length = clamp(props.getFloat('length', 30), 5, 80);
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    // Phase T: each spike is a stretched quad aligned to its own random
    // outward velocity (ORIENT_STRETCH). The per-particle velocitySpread
    // gives each its radial direction; the stretch turns the resulting
    // streaks into the spiky star-burst Spring draws.
    const width = clamp(length * 0.08, 0.5, 4);
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 0, 0],
        velocitySpread: length * 4,
        velocityScale: 0,
        gravity: 0,
        sizeStart: width,
        sizeEnd: width * 0.4,
        colorStart: [1.0, 0.85, 0.3, 1.0],
        colorEnd:   [1.0, 0.4, 0.1, 0.0],
        rotationSpeedMax: 0,
        orient: ORIENT_STRETCH,
        stretch: length / width,
    };
}

// ── CSmokeTrailProjectile ─────────────────────────────────────────────────
// Connected-segment smoke trail — Spring renders as a textured strip
// along the projectile's path. The existing missile-trail renderer
// (projectile-renderer.ts) already handles missile smoke; this class
// would extract that into a shared pool. Phase 4 defers the extraction.
// Approximate as a low-alpha smoke puff for the brief case where a CEG
// directly spawns one (rare outside missile trails themselves).

function translateSmokeTrailProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 30);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.2, MAX_LIFETIME_S);
    const size = clamp(props.getFloat('size', 6), 2, 30);
    const texture = props.getString('texture', '').toLowerCase() || 'smoketrail';
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 1, 0],
        velocitySpread: 1,
        velocityScale: 0,
        gravity: -1,
        sizeStart: size, sizeEnd: size * 2,
        colorStart: [0.5, 0.5, 0.5, 0.5],
        colorEnd:   [0.3, 0.3, 0.3, 0.0],
        rotationSpeedMax: 0.6,
    };
}

// ── CBubbleProjectile ─────────────────────────────────────────────────────
// Underwater bubble — small rising translucent sphere. Used in
// water-themed weapon CEGs (torpedo wakes, depth-charge bursts).

function translateBubbleProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 60);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.3, MAX_LIFETIME_S);
    const size = clamp(props.getFloat('size', 3), 1, 12);
    const texture = props.getString('texture', '').toLowerCase() || 'flare';
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 6, 0],
        velocitySpread: 1,
        velocityScale: 0,
        gravity: -5,
        sizeStart: size, sizeEnd: size * 1.5,
        colorStart: [0.7, 0.85, 1.0, 0.5],
        colorEnd:   [0.5, 0.65, 0.85, 0.0],
        rotationSpeedMax: 0,
    };
}

// ── CWakeProjectile ───────────────────────────────────────────────────────
// Water-surface wake decal. Spring draws as a ground-aligned quad
// expanding radially; without a decal pool we approximate as a flat
// low-alpha smoke puff sized to the wake's radius.

function translateWakeProjectile(_s: CegSpawnInfo, props: PropMap): ParticleSpawn | null {
    const ttlFrames = props.getFloat('ttl', 60);
    if (ttlFrames <= 0) return null;
    const ttlS = clamp(ttlFrames / SIM_HZ, 0.3, MAX_LIFETIME_S);
    const size = clamp(props.getFloat('size', 12), 4, 40);
    const texture = props.getString('texture', '').toLowerCase() || 'smoketrail';
    // Phase T: a wake is a ground-aligned expanding ring on the water
    // surface (ORIENT_GROUND) — flat, not a camera billboard.
    return {
        texture,
        count: 1,
        lifetimeMin: ttlS, lifetimeMax: ttlS,
        velocityBase: [0, 0, 0],
        velocitySpread: 0,
        velocityScale: 0,
        gravity: 0,
        sizeStart: size, sizeEnd: size * 2.5,
        colorStart: [0.85, 0.9, 0.95, 0.45],
        colorEnd:   [0.7, 0.75, 0.8, 0.0],
        rotationSpeedMax: 0.3,
        orient: ORIENT_GROUND,
    };
}

// ── CExpGenSpawner / CSpherePartSpawner ────────────────────────────────────
//
// Sub-CEG dispatchers. Both wrap a named child CEG (`explosiongenerator`
// property, with the engine's `custom:` prefix already stripped server
// side). The translator builds a SubCegSpawn record; the runtime
// enqueues N PendingSpawn entries on every parent spawn() and fires
// them through spawn() again when their delay elapses.
//
// Phase 1 parses properties as bare numeric constants (and the existing
// `r`-prefixed random magnitude — already handled by parseLuaNumber).
// Compound expressions like `delay = "0 i1"` or damage-scaled forms
// silently collapse to their leading constant; Phase 2's expression
// evaluator picks up the residue without changing this code path.

function translateExpGenSpawner(s: CegSpawnInfo, props: PropMap): SubCegSpawn | null {
    const targetTag = stripCustomPrefix(props.getString('explosiongenerator', '')).toLowerCase();
    if (!targetTag) return null;
    return buildSubCegSpawn(s, props, targetTag, 'point');
}

function translateSpherePartSpawner(s: CegSpawnInfo, props: PropMap): SubCegSpawn | null {
    const targetTag = stripCustomPrefix(props.getString('explosiongenerator', '')).toLowerCase();
    // When there's no child tag, this is a self-contained particle
    // sphere (CSpherePartProjectile) — Phase 4 territory. Drop it
    // for now rather than mistranslating as a no-op sub-CEG.
    if (!targetTag) return null;
    return buildSubCegSpawn(s, props, targetTag, 'sphere');
}

function buildSubCegSpawn(
    s: CegSpawnInfo, props: PropMap, targetTag: string,
    distribution: 'point' | 'sphere',
): SubCegSpawn {
    const delayFramesExpr = props.getExpr('delay', constExpr(0));
    const posOffsetExpr = props.getVec3Expr('pos', 0, 0, 0);

    // `dir = "dir"` (Spring's keyword for "inherit parent direction")
    // is the dominant author pattern. Numeric triples are rare and
    // typically `(0,1,0)` — we treat the absence of the keyword as
    // "use world up" so impacts radiate outward sanely.
    const dirRaw = props.getString('dir', '').trim().toLowerCase();
    const dirInherit = dirRaw === 'dir' || dirRaw === '';

    const radius = clamp(props.getFloat('radius', 0), 0, 200);

    // Outer count multiplies the SubCegSpawn's own dispatch count.
    // The streamed CegSpawnInfo.count is the "how many copies of this
    // spawn entry" multiplier; CEG authors compose it with the inner
    // expression by writing `count = N` at the spawn level. Wrap as
    // a const Expr so the runtime always evaluates through one path.
    const countExpr = constExpr(clamp(s.count, 1, 32));

    return {
        kind: 'subceg',
        countExpr,
        targetTag,
        delayFramesExpr,
        posOffsetExpr,
        dirInherit,
        distribution,
        radius,
    };
}

function stripCustomPrefix(s: string): string {
    if (!s) return s;
    if (s.startsWith('custom:')) return s.slice('custom:'.length);
    if (s.startsWith('CUSTOM:')) return s.slice('CUSTOM:'.length);
    return s;
}

// ── Sprite atlas filename parser (Phase 5b) ────────────────────────────────
//
// Spring sprite atlases encode their tile grid in the filename:
// `FireBall02_8x8` declares an 8-column × 8-row atlas. The runtime
// allocates one `ParticleClass` per unique authored texture name, so
// the atlas dims need only be parsed once at class creation.
//
// Case-insensitive on the `x` separator (`8X8` is just as legal as
// `8x8`). Both dimensions must be ≥ 1 and ≤ 64 (no real atlas in
// engine or game content exceeds this); impossible values return
// null so the texture loads as a still.

export function parseAtlasDims(
    name: string,
): { cols: number; rows: number } | null {
    if (!name) return null;
    const m = name.match(/_(\d+)[xX](\d+)$/);
    if (!m) return null;
    const cols = parseInt(m[1], 10);
    const rows = parseInt(m[2], 10);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    if (cols < 1 || rows < 1) return null;
    // Refuse absurd values (some hex-encoded names look like dims).
    if (cols > 64 || rows > 64) return null;
    return { cols, rows };
}

// ── Atlas animation params (Phase 5b) ──────────────────────────────────────
//
// Spring CEGs that use sprite-atlas textures (`FireBall02_8x8`, etc.)
// may override the default "one full cycle per particle lifetime" with
// an explicit `animparams` property. The string is "<startFrame>
// <endFrame> <fps>" — startFrame is the first tile to display,
// endFrame the last, fps the cycle rate in frames-per-second. Both
// frame values are 0-indexed offsets into the atlas's row-major tile
// grid (col-major would be `frame % cols`, `frame / cols`).
//
// Returns null when the property is empty or unparsable — caller
// passes the resulting fields straight onto the ParticleSpawn,
// `undefined` triggering the runtime's lifetime-derived defaults.
function parseAnimParams(src: string): {
    frameStart: number;
    frameCount: number;
    fps: number;
} | null {
    if (!src) return null;
    const nums = parseNumberList(src);
    if (nums.length < 3) return null;
    const start = Math.max(0, Math.floor(nums[0]));
    const end = Math.max(start, Math.floor(nums[1]));
    const fps = Math.max(0, nums[2]);
    return { frameStart: start, frameCount: end - start + 1, fps };
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
    /// Parse the property as a Spring CEG mini-language scalar
    /// expression (Phase 2). Returns the `def` Expr when the key is
    /// missing. Bare numbers, `i<n>` (damage-scaled), `r<n>` (random
    /// 0..n), `~<n>` (signed-random ±n), `d<n>` (damage-linear), and
    /// compound forms ("0 i1", "24 r4 i2") all parse here.
    getExpr(key: string, def: Expr): Expr {
        const v = this.map.get(key);
        if (v === undefined) return def;
        return parseExpr(v) ?? def;
    }
    /// Parse three scalar expressions from a vec3 property. Each
    /// component is independently expression-typed so `pos = "0, 24 i8, 0"`
    /// works component-wise. The `[[…]]` Lua long-string wrapper, if
    /// present, is stripped before splitting.
    getVec3Expr(key: string, dx: number, dy: number, dz: number): [Expr, Expr, Expr] {
        const v = this.map.get(key);
        if (v === undefined) {
            return [constExpr(dx), constExpr(dy), constExpr(dz)];
        }
        return parseVec3Expr(v, dx, dy, dz);
    }
}

// ── Expression mini-language ────────────────────────────────────────────────
//
// Spring CEG properties use a tiny arithmetic mini-language layered
// on top of plain numbers: bare numbers (`42`), damage-scaled ints
// (`i1` → floor(damage * 1 / 1024)), random magnitudes (`r10` →
// random[0,10]), signed random (`~3` → random[-3,3]), damage-linear
// (`d0.5` → damage * 0.5), and compound sums (`"0 i1"`,
// `"24 r4 i2"`). Tokens are space-separated; their values are summed
// to produce the final scalar.
//
// `parseExpr` returns a closure `(ctx: ExprContext) => number` so the
// runtime can evaluate per-particle (random terms vary) and per-fire
// (damage-scaled terms vary). Constants collapse to a `() => N`
// closure for uniform call-site dispatch. Returns null for unparsable
// input — caller falls back to the supplied default.

export function constExpr(value: number): Expr {
    return () => value;
}

export function parseExpr(src: string): Expr | null {
    let s = src.trim();
    if (!s) return null;
    if (s.startsWith('[[') && s.endsWith(']]')) {
        s = s.slice(2, -2).trim();
    }
    if (!s) return null;

    // Tokenise on whitespace. Commas separate vec3 components so
    // they must already have been split by the caller; receiving a
    // comma here is treated as a soft error → return null.
    if (s.includes(',')) return null;
    const tokens = s.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return null;

    const terms: Array<(damage: number) => number> = [];
    for (const tok of tokens) {
        const fn = parseExprToken(tok);
        if (fn) terms.push(fn);
    }
    if (terms.length === 0) return null;
    if (terms.length === 1) {
        const t = terms[0];
        return (ctx) => t(ctx.damage);
    }
    return (ctx) => {
        let sum = 0;
        for (let i = 0; i < terms.length; i++) sum += terms[i](ctx.damage);
        return sum;
    };
}

/// Parse one mini-language token. Returns a `(damage) => number`
/// closure or null for unrecognised input. Leading `+`/`-` apply to
/// the whole magnitude. The `dir` keyword is treated as 0 in scalar
/// context — vec3 handling for `dir` is the caller's responsibility
/// since it only makes sense as a direction inheritor, not a number.
function parseExprToken(tok: string): ((damage: number) => number) | null {
    if (!tok) return null;
    // Lone keyword — no scalar value.
    if (tok === 'dir' || tok === '-dir') return () => 0;

    let sign = 1;
    let t = tok;
    while (t.startsWith('+') || t.startsWith('-')) {
        if (t.startsWith('-')) sign = -sign;
        t = t.slice(1);
    }
    if (!t) return null;

    // Prefix dispatch — magnitudes are floats; reject NaN.
    const c = t[0];
    if (c === 'i' || c === 'I') {
        const n = parseFloat(t.slice(1));
        if (!Number.isFinite(n)) return null;
        return (damage) => sign * Math.floor((damage * n) / 1024);
    }
    if (c === 'd' || c === 'D') {
        const n = parseFloat(t.slice(1));
        if (!Number.isFinite(n)) return null;
        return (damage) => sign * damage * n;
    }
    if (c === 'r' || c === 'R') {
        const n = parseFloat(t.slice(1));
        if (!Number.isFinite(n)) return null;
        return () => sign * Math.random() * n;
    }
    if (c === '~') {
        const n = parseFloat(t.slice(1));
        if (!Number.isFinite(n)) return null;
        return () => sign * (Math.random() * 2 - 1) * n;
    }
    // Bare numeric.
    const n = parseFloat(t);
    if (!Number.isFinite(n)) return null;
    return () => sign * n;
}

/// Parse a vec3 property as three independent expressions. CEG
/// authors mix comma-separated (`"0, 2, 0"`) and space-separated
/// (`"0 1 0"`) forms; compound expressions per component (`"0, 24 i8, 0"`)
/// require commas to mark component boundaries. Falls back to
/// component-wise defaults for unparsable parts.
export function parseVec3Expr(
    src: string, dx: number, dy: number, dz: number,
): [Expr, Expr, Expr] {
    let s = src.trim();
    if (s.startsWith('[[') && s.endsWith(']]')) {
        s = s.slice(2, -2).trim();
    }
    if (!s) return [constExpr(dx), constExpr(dy), constExpr(dz)];

    if (s.includes(',')) {
        const parts = s.split(',').map(p => p.trim());
        return [
            parseExpr(parts[0] ?? '') ?? constExpr(dx),
            parseExpr(parts[1] ?? '') ?? constExpr(dy),
            parseExpr(parts[2] ?? '') ?? constExpr(dz),
        ];
    }
    // Space-only form: three top-level whitespace-separated tokens,
    // one per component. Compound per-component is not expressible
    // without commas; that's a CEG authoring rule, not ours.
    const tokens = s.split(/\s+/).filter(t => t.length > 0);
    return [
        parseExpr(tokens[0] ?? '') ?? constExpr(dx),
        parseExpr(tokens[1] ?? '') ?? constExpr(dy),
        parseExpr(tokens[2] ?? '') ?? constExpr(dz),
    ];
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
/// keyframes the engine lerps over particle lifetime. Phase 3 keeps
/// two stops (start + end); intermediate keyframes get dropped at
/// translate time. Verified against ZK content — 2-stop ramps cover
/// the dominant authored cases (smoke fades to dark, fire fades to
/// orange-then-black approximated as orange-to-black, etc.).
///
/// Returns the start RGBA plus an optional end RGBA. When the input
/// only carries one keyframe (rare but legal), end is omitted so the
/// runtime degrades to a constant-colour-with-alpha-fade rendering.
function parseColormap(s: string): {
    start: [number, number, number, number];
    end?: [number, number, number, number];
} {
    const nums = parseNumberList(s);
    if (nums.length >= 8) {
        // Two or more keyframes — take first + last (the last
        // keyframe is what the particle interpolates toward).
        const lastBase = (Math.floor(nums.length / 4) - 1) * 4;
        return {
            start: [nums[0], nums[1], nums[2], nums[3]],
            end:   [nums[lastBase], nums[lastBase + 1],
                    nums[lastBase + 2], nums[lastBase + 3]],
        };
    }
    if (nums.length >= 4) return { start: [nums[0], nums[1], nums[2], nums[3]] };
    if (nums.length === 3) return { start: [nums[0], nums[1], nums[2], 1] };
    return { start: [1, 1, 1, 1] };
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : (v > hi ? hi : v);
}
