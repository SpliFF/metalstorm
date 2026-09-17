/**
 * unit-fx-dispatch — resolves `effects/unit-fx.json` by def-name convention
 * `ms_<class>_s<n>` and dispatches the unit-side FX weapon-fx.json doesn't
 * cover: death (on EntityDestroy, at the last known position), damage-state
 * smoke (re-triggered loop at health thresholds, 1.5s hysteresis), and
 * move-dust for moving tanks/artillery (rate ∝ speed, capped 40 emitters by
 * camera distance via entity-fx-fence.ts).
 *
 * PLAN-beta-presentation L-FX step 6. `MotionLeanRegistry.impulse` (hit-
 * flinch) and `WheelSpinDriver.spinning` (move-dust rate) are pres-anim
 * dependencies, kept STRUCTURAL (duck-typed) here rather than imported
 * directly so this file has no compile-time dependency on pres-anim's
 * module — `onHit`/the move-dust rate simply no-op if the caller ever wires
 * in an object without the matching method.
 */

import { EntityFxFence } from './entity-fx-fence.js';
import type { NativeFxSink } from './weapon-fx-resolver.js';

// ── unit-fx.json shapes ──────────────────────────────────────────────────────

export interface UnitFxSlots {
    death: string | null;
    sound: string | null;
    damageSmoke: string | null;
    damageSmokeHeavy: string | null;
    burning: string | null;
    moveDust: string | null;
    contactPlant: string | null;
    wake: string | null;
    thruster: string | null;
    buildFx: string | null;
}

export interface UnitFxMap {
    version?: number;
    byClass: Record<string, Partial<UnitFxSlots>>;
    scaleOverrides: Record<string, Record<string, Partial<UnitFxSlots>>>;
    units: Record<string, Partial<UnitFxSlots>>;
}

const EMPTY_SLOTS: UnitFxSlots = {
    death: null, sound: null, damageSmoke: null, damageSmokeHeavy: null,
    burning: null, moveDust: null, contactPlant: null, wake: null,
    thruster: null, buildFx: null,
};

/** `units/_builder.lua` def-name convention: `ms_<class>_s<n>`. */
const DEF_NAME_RE = /^ms_([a-z0-9]+)_s(\d+)$/i;

export function parseUnitClassScale(defName: string): { cls: string; scale: number } | null {
    const m = DEF_NAME_RE.exec(defName);
    if (!m) return null;
    return { cls: m[1].toLowerCase(), scale: Number(m[2]) };
}

/**
 * Resolve one def's unit-FX slots: `byClass[<class>]` as the base, layered
 * with `scaleOverrides[<class>][<scale>]`, layered with an exact
 * `units[<defName>]` override — each layer only replacing the keys it sets
 * (mirrors the doc comment's "highest precedence" phrasing without forcing
 * an exact entry to repeat every field). Returns null when the def neither
 * parses to a class nor has an exact entry (buildings not yet named).
 */
export function resolveUnitFx(map: UnitFxMap, defName: string): UnitFxSlots | null {
    const lower = defName.toLowerCase();
    const exact = map.units[defName] ?? map.units[lower];
    const parsed = parseUnitClassScale(lower);
    const base = parsed ? map.byClass[parsed.cls] : undefined;
    if (!base && !exact) return null;
    const scaleOverride = parsed ? map.scaleOverrides[parsed.cls]?.[String(parsed.scale)] : undefined;
    return { ...EMPTY_SLOTS, ...base, ...scaleOverride, ...exact };
}

// ── structural (duck-typed) cross-lane deps ─────────────────────────────────

/** pres-anim `MotionLeanRegistry.impulse` — hit-flinch nudge. Structural so
 *  this file compiles against pres-anim's motion-lean.ts whether or not that
 *  lane has landed `impulse` yet. */
export interface MotionLeanImpulseSink {
    impulse(unitId: number, dirX: number, dirZ: number, mag: number): void;
}

/** pres-anim `WheelSpinDriver.spinning` — the move-dust rate source
 *  (rad/s, 0 when stopped/untracked). Structural for the same reason. */
export interface WheelSpinRateSource {
    spinning(unitId: number): number;
}

export interface UnitFxEntity {
    defId: number;
    healthScale: number;
}

export interface UnitFxDeps {
    unitFx: UnitFxMap;
    sink: NativeFxSink;
    getUnitDefName(defId: number): string | undefined;
    getEntities(): IterableIterator<[number, UnitFxEntity]>;
    getEntityPosition(unitId: number): { x: number; y: number; z: number } | null;
    /** Named-SoundItem playback at a world position — the same synthesised
     *  path `game-processor.ts onUiSound`'s "named" branch uses, so a
     *  `sound` key that isn't in gamedata/sounds.lua yet just resolves to
     *  nothing rather than erroring. */
    playNamedSound?(name: string, x: number, y: number, z: number): void;
    /** Re-checked on every onHit call (not snapshotted at construction) so
     *  this activates the moment pres-anim's MotionLeanRegistry gains
     *  `impulse`, with no reconstruction needed on this side. */
    getMotionLean?(): MotionLeanImpulseSink | null;
    /** Move-dust rate source (see WheelSpinRateSource doc). Returns 0 (no
     *  dust) when absent. */
    getUnitSpeed?(unitId: number): number;
    fence?: EntityFxFence;
}

/** Health fractions (EntityMeta.healthScale) below which the smoke slots
 *  fire — mirrors unit-fx.json's own _doc thresholds. */
const DAMAGE_SMOKE_THRESHOLD = 0.5;
const DAMAGE_SMOKE_HEAVY_THRESHOLD = 0.25;
/** Re-evaluate damage-smoke state and re-trigger the loop on this cadence.
 *  Doubles as the hysteresis window: a health value bouncing across a
 *  threshold between ticks doesn't flicker the effect on/off faster than
 *  this (PLAN-beta-presentation L-FX step 6: "1.5s hysteresis"). */
const DAMAGE_SMOKE_TICK_S = 1.5;
/** Re-evaluate move-dust candidates on this cadence — bounds the per-tick
 *  entity sweep + sort cost independent of roster size, matching the wire-
 *  cadence pattern clip-auto-policy.ts / wheel-spin-driver.ts already use. */
const MOVE_DUST_TICK_S = 0.25;
/** Hard cap on concurrent move-dust emitters (PLAN-beta-presentation L-FX
 *  step 6), nearest-to-camera wins. */
const MAX_MOVE_DUST_EMITTERS = 40;
/** Dust retrigger interval at the reference speed, seconds. Faster units
 *  kick up dust more often ("rate ∝ speed"); clamped so a crawling unit
 *  still puffs occasionally and a very fast one doesn't spam the pool. */
const DUST_INTERVAL_AT_REF_S = 0.5;
const DUST_REF_SPEED = 4;           // WheelSpinDriver.spinning() units (rad/s)
const DUST_INTERVAL_MIN_S = 0.12;
const DUST_INTERVAL_MAX_S = 2.0;

type SmokeBand = 'none' | 'light' | 'heavy';

interface SmokeState {
    band: SmokeBand;
    nextEvalAt: number;
}

interface DustState {
    nextSpawnAt: number;
}

export class UnitFxDispatch {
    private readonly fence: EntityFxFence;
    private smoke = new Map<number, SmokeState>();
    private dust = new Map<number, DustState>();
    private moveDustAccum = 0;
    private now = 0;

    constructor(private readonly deps: UnitFxDeps) {
        this.fence = deps.fence ?? new EntityFxFence();
    }

    /** EntityDestroy — fire the class/scale's death burst + sound at the
     *  unit's last known position. `defId` is read from EntityMeta BEFORE
     *  the caller removes it (see game-processor.ts onEntityDestroy). */
    onDeath(unitId: number, defId: number, x: number, y: number, z: number): void {
        this.smoke.delete(unitId);
        this.dust.delete(unitId);
        const defName = this.deps.getUnitDefName(defId);
        if (!defName) return;
        const slots = resolveUnitFx(this.deps.unitFx, defName);
        if (!slots) return;
        if (slots.death && this.deps.sink.has(slots.death)) {
            this.deps.sink.spawn(slots.death, x, y, z, 0, 1, 0);
        }
        if (slots.sound) this.deps.playNamedSound?.(slots.sound, x, y, z);
    }

    /** A hit landed on `unitId` — nudge its lean away from the attacker.
     *  No-ops until pres-anim's `MotionLeanRegistry.impulse` is wired in
     *  (see the class doc). `dirX/dirZ` need not be normalised. */
    onHit(unitId: number, dirX: number, dirZ: number, mag: number): void {
        this.deps.getMotionLean?.()?.impulse(unitId, dirX, dirZ, mag);
    }

    /** Drop per-unit bookkeeping (LOS eviction without a death event). */
    remove(unitId: number): void {
        this.smoke.delete(unitId);
        this.dust.delete(unitId);
    }

    /** Advance the FX clock and run the damage-smoke + move-dust sweeps at
     *  their own cadence. Called once per render frame from game-processor's
     *  FX tick block, beside gpNativeFx/gpCombatFX. */
    tick(dt: number, camX: number, camY: number, camZ: number): void {
        this.now += dt;
        this.moveDustAccum += dt;
        if (this.moveDustAccum < MOVE_DUST_TICK_S) return;
        const elapsedSweep = this.moveDustAccum;
        this.moveDustAccum = 0;

        const dustCandidates: { id: number; dist: number; slots: UnitFxSlots;
            pos: { x: number; y: number; z: number }; speed: number }[] = [];

        for (const [id, meta] of this.deps.getEntities()) {
            const defName = this.deps.getUnitDefName(meta.defId);
            if (!defName) continue;
            const slots = resolveUnitFx(this.deps.unitFx, defName);
            if (!slots) continue;

            if (slots.damageSmoke || slots.damageSmokeHeavy) {
                this.evaluateDamageSmoke(id, slots, meta.healthScale);
            }

            if (slots.moveDust) {
                const speed = this.deps.getUnitSpeed?.(id) ?? 0;
                if (speed > 0) {
                    const pos = this.deps.getEntityPosition(id);
                    if (pos) {
                        const dist = Math.hypot(pos.x - camX, pos.y - camY, pos.z - camZ);
                        dustCandidates.push({ id, dist, slots, pos, speed });
                    }
                } else {
                    this.dust.delete(id);
                }
            }
        }

        dustCandidates.sort((a, b) => a.dist - b.dist);
        const capped = dustCandidates.slice(0, MAX_MOVE_DUST_EMITTERS);
        const cappedIds = new Set(capped.map((c) => c.id));
        for (const id of this.dust.keys()) if (!cappedIds.has(id)) this.dust.delete(id);

        for (const c of capped) {
            this.fence.run(`moveDust:${c.slots.moveDust}`, c.id, c.dist, () => {
                this.tickMoveDust(c.id, c.slots.moveDust!, c.pos, c.speed, elapsedSweep);
            });
        }
    }

    private evaluateDamageSmoke(unitId: number, slots: UnitFxSlots, healthScale: number): void {
        let s = this.smoke.get(unitId);
        if (!s) { s = { band: 'none', nextEvalAt: 0 }; this.smoke.set(unitId, s); }
        if (this.now < s.nextEvalAt) return;
        s.nextEvalAt = this.now + DAMAGE_SMOKE_TICK_S;

        const target: SmokeBand =
            healthScale < DAMAGE_SMOKE_HEAVY_THRESHOLD ? 'heavy'
            : healthScale < DAMAGE_SMOKE_THRESHOLD ? 'light' : 'none';
        s.band = target;
        if (target === 'none') return;

        const effect = target === 'heavy' ? slots.damageSmokeHeavy : slots.damageSmoke;
        if (!effect || !this.deps.sink.has(effect)) return;
        const pos = this.deps.getEntityPosition(unitId);
        if (!pos) return;
        this.deps.sink.spawn(effect, pos.x, pos.y, pos.z, 0, 1, 0);
    }

    private tickMoveDust(
        unitId: number, effect: string,
        pos: { x: number; y: number; z: number }, speed: number, dt: number,
    ): void {
        if (!this.deps.sink.has(effect)) return;
        let d = this.dust.get(unitId);
        if (!d) { d = { nextSpawnAt: 0 }; this.dust.set(unitId, d); }
        d.nextSpawnAt -= dt;
        if (d.nextSpawnAt > 0) return;
        const interval = Math.min(DUST_INTERVAL_MAX_S, Math.max(DUST_INTERVAL_MIN_S,
            DUST_INTERVAL_AT_REF_S * (DUST_REF_SPEED / Math.max(speed, 0.01))));
        d.nextSpawnAt = interval;
        this.deps.sink.spawn(effect, pos.x, pos.y, pos.z, 0, 1, 0);
    }
}
