/**
 * ClipAutoPolicy — movement-driven walk/idle clip playback for native models
 * (DESIGN-MODEL-BUILDING.md §16b, "task 6b").
 *
 * `walk` engages on sustained movement and hands back to `idle` at rest. Since
 * PLAN-metalstorm-model-integration §M1 a model that ships `idle` and NO walk
 * (most of the M1 vehicle roster — dish sweeps, pennant sway, tether drift)
 * plays that idle from the same trigger instead: movement engages the only
 * cycle it has, and it keeps idling once stopped.
 *
 * §M2 (buildings) adds the one population that movement can never speak for.
 * An immobile unit — pumpjack beam, headframe wheel, crane trolley, saw blade,
 * meeting-hall bell, market awning — has an authored `idle` and no possible way
 * to trip a speed threshold, so `deps.isStatic` engages its idle directly on
 * first sighting. That reopens the exact risk the §16b cap exists for (a
 * resting population filling every slot and starving the walkers), so statics
 * are admitted LAST and may hold at most `STATIC_SHARE` of the cap; movers can
 * always claim the rest. A game with no `isStatic` dep behaves exactly as
 * before: never-moved still means never-animated.
 *
 * Natives are deliberately script-less: the sim never turns a piece for them,
 * so nothing enters the 0x05 piece-state stream and a walker would glide.
 * This policy closes that gap CLIENT-SIDE — pure cosmetics off the entity
 * state we already receive, no new wire, no sim change (same philosophy as
 * squad fan-out). ZK walkers keep animating through their sim-side unit
 * scripts; they own no clips, so this policy never engages for them.
 *
 * Speed comes from consecutive WIRE positions, never the camera-lerped
 * render pose: the interpolator smooths and lags, and feeding its output
 * back into a start/stop decision would ring.
 *
 * Precedence (asserted here because it is invisible at the call sites):
 * a clip pose OVERRIDES streamed piece state for a unit
 * (`EntityRenderer.setClipPose` beats `applyPieceState`). That is safe today
 * because the two populations are disjoint — natives have authored clips and
 * no piece stream; ZK/BAR units have a piece stream and no clips. If a unit
 * ever has both, §16c's merge policy (streamed 0x05 wins over clips + aim)
 * is the intended resolution.
 *
 * The `death` clip is deliberately NOT wired here: a killed synced entity
 * despawns and a wreck feature replaces it, so there is no entity left to
 * pose. It stays button/showcase-facing until damage-states work gives us a
 * corpse that persists (§16b task 3).
 */

import type { Matrix } from '@babylonjs/core';
import type { ModelClip } from './clip-player.js';
import type { EntityStateSnapshot } from './entity-state.js';

/** Sim frames per game second — the timebase of `baseFrame`. Speeds derived
 *  from it are elmos per GAME second, matching UnitDef.speed
 *  (`maxVelocity * GAME_SPEED`, see rts/Sim/Units/UnitDef.cpp). */
const SIM_HZ = 30;

// Spring losStatus / packed state bits (module-local by convention — see
// entity-renderer.ts and intel-transitions.ts, which declare the same).
const LOS_INLOS = 1 << 0;
const STATE_BIT_ALWAYS_VISIBLE = 1 << 7;

/** Start walking above this planar speed (elmos/s), held for START_TICKS
 *  consecutive evaluations. */
const START_SPEED = 0.5;
/** Drop out of walk below this planar speed (elmos/s), held for STOP_HOLD_SEC. */
const STOP_SPEED = 0.2;
const START_TICKS = 2;
const STOP_HOLD_SEC = 0.3;

/** Playback-rate clamp. Outside this the cycle reads as slow-motion or a
 *  blur, which looks worse than the residual foot-slide it would fix. */
const SPEED_MIN = 0.6;
const SPEED_MAX = 1.6;

/**
 * Server-side position deadband: `EntityDeltaCache::POS_THRESHOLD` (elmos).
 * A unit whose position moved less than this is omitted from delta
 * snapshots entirely — so a STOPPED unit does not report zero speed, it
 * simply stops appearing. Absence is therefore the stop signal, and this
 * constant is what lets us bound the speed of an absent unit: no delta since
 * frame F means it has moved < POS_DEADBAND since F. Full snapshots (every
 * 30 frames, StateStreamer.cpp) re-report everyone and settle it exactly;
 * the bound just gets us there sooner and survives a dropped full snapshot.
 */
const POS_DEADBAND = 0.5;

/** Fallback reference speed (elmos/s) when a def carries neither
 *  `walk_speed_ref` nor a usable top speed. Only reachable for a def with a
 *  `walk` clip but speed 0, which would not be walking anyway. */
const NOMINAL_FALLBACK = 30;

/** Concurrency cap for AUTO playbacks — walk AND idle (§16b perf guard).
 *  Manual/harness playbacks are never counted or evicted. */
const MAX_AUTO_PLAYBACKS = 64;

/** Fraction of the cap immobile units (§M2 buildings) may hold at once. A base
 *  is a *permanent* resting population — unlike a stopped walker it never frees
 *  its slot — so without a sub-cap a dense town would own all 64 forever and no
 *  walker would ever animate again. Movers are still admitted against the full
 *  cap, so this only ever costs a building its ambience. */
const STATIC_SHARE = 0.5;

export interface ResolvedClip {
    clip: ModelClip;
    restLocals: Matrix[];
}

/** The ClipPlayer surface the policy drives (structural, so tests can pass a
 *  fake without a Babylon scene). */
export interface ClipPlaybackSink {
    play(unitId: number, clip: ModelClip, restLocals: readonly Matrix[],
         opts?: { loop?: boolean; speed?: number }): unknown;
    stop(unitId?: number): void;
    setSpeed(unitId: number, speed: number): void;
    playingClip(unitId: number): string | null;
}

export interface ClipAutoPolicyDeps {
    /** Resolve an authored clip + rest pose for a unit. null = no such clip,
     *  unknown unit, or model still loading (retried on the next snapshot). */
    getClip(unitId: number, name: string): ResolvedClip | null;
    /**
     * Reference ground speed (elmos/s) that the unit's `walk` cycle was
     * authored for — playback scales `unitSpeed / nominal`.
     *
     * DIVERGENCE / open question (DESIGN-MODEL-BUILDING.md §12): the faithful
     * derivation is "one modelled stride per cycle" (fable_mech: ~1.1 m per
     * 1.2 s), but that needs a settled metre→elmo render scale, and today the
     * render path applies none — models draw at 1 model-unit = 1 elmo while
     * the def moves at tens of elmos/s. So the stride derivation is not yet
     * computable and the default is the def's own top speed: the cycle then
     * runs at its authored rate at full throttle and scales down as the unit
     * slows, which is the part that actually reads at gameplay zoom.
     * `customparams.walk_speed_ref` overrides per def. Revisit once §12 lands.
     */
    nominalSpeed(unitId: number): number;
    /**
     * Whether the unit's model has finished loading, so its clip list is
     * known. Until it has, a missing `walk` means "not yet", not "never" —
     * this is what lets the policy retire a unit permanently instead of
     * re-probing every mover of a clipless game forever.
     */
    clipsLoaded(unitId: number): boolean;
    /** Camera focus in world XZ for the nearest-first cap. Omitted / null →
     *  admission falls back to first-come order. */
    cameraXZ?(): { x: number; z: number } | null;
    /**
     * Is this unit immobile (a building)? Such a unit can never reach the
     * movement threshold, so its authored `idle` is engaged on sighting
     * instead — see the header. Omitted = no unit is static, which is the
     * pre-§M2 behaviour and what every non-metalstorm game wants.
     *
     * Answer `false` while the def is still unknown, not `true`: a wrong
     * `false` costs one wire tick (the unit is re-checked on the next
     * snapshot), a wrong `true` would start an idle on a mover and then have
     * to be walked back.
     */
    isStatic?(unitId: number): boolean;
}

interface Motion {
    /** Frame + planar position of the last accepted wire sample. */
    frame: number;
    x: number;
    z: number;
    /** Planar speed (elmos/s) measured across the last consecutive pair. */
    speed: number;
    /** Consecutive evaluations at/above START_SPEED (start hysteresis). */
    aboveTicks: number;
    /** Frame the current sub-STOP_SPEED run began, or null (stop hysteresis). */
    belowSinceFrame: number | null;
    /** Clip the POLICY currently has playing on this unit, or null. Tracked
     *  separately from the player's own state because the harness can take a
     *  unit over, and the player auto-stops on disappearance, at any time —
     *  `evaluate` reconciles the two. Both walk and idle hold a slot against
     *  the concurrency cap; walk→idle reuses the same slot. */
    autoClip: 'walk' | 'idle' | null;
    /** Model loaded and ships an `idle` cycle but no `walk` — never queue a
     *  walk start for it again (it would re-resolve to the same idle clip
     *  every wire tick and restart the playback). */
    idleOnly: boolean;
    /** Model loaded and ships NEITHER cycle — this unit can never animate, so
     *  it is retired from evaluation. True for every unit of ZK, BAR and the
     *  converted wz_* models, which is the case worth not paying for. */
    ineligible: boolean;
    /** Immobile (§M2 building): idles on sighting rather than on movement, and
     *  counts against the STATIC_SHARE sub-cap. Latched once `deps.isStatic`
     *  says yes — a def does not stop being a building. */
    staticUnit: boolean;
}

/** One queued playback start, pending admission against the caps. */
interface Start {
    id: number;
    /** Planar speed to scale a `walk` playback by; 0 (unused) for statics. */
    speed: number;
    want: 'walk' | 'idle';
    isStatic: boolean;
}

export class ClipAutoPolicy {
    private deps: ClipAutoPolicyDeps;
    private player: ClipPlaybackSink;
    private motion = new Map<number, Motion>();
    /** Units the harness drives explicitly — the policy leaves them alone
     *  until stopClip (§16b: "F8 buttons keep working on stationary units"). */
    private manual = new Set<number>();
    /** Leading edge of the wire clock; advances on every snapshot, including
     *  ones that carry no entity we track. */
    private latestFrame = -1;
    private maxAuto: number;

    constructor(deps: ClipAutoPolicyDeps, player: ClipPlaybackSink,
                maxAuto: number = MAX_AUTO_PLAYBACKS) {
        this.deps = deps;
        this.player = player;
        this.maxAuto = maxAuto;
    }

    /** Mark a unit as harness-driven (window.test.playClip). */
    markManual(unitId: number): void {
        this.manual.add(unitId);
        // It may hold an auto playback that playClip is about to replace —
        // release the slot so a later stopClip re-evaluates clean.
        const m = this.motion.get(unitId);
        if (m) m.autoClip = null;
    }

    /** Release harness control. No argument = release everything (matches the
     *  no-arg `stopClip` verb); the policy re-engages on the next snapshot. */
    clearManual(unitId?: number): void {
        if (unitId === undefined) this.manual.clear();
        else this.manual.delete(unitId);
    }

    /** Drop per-unit bookkeeping (death / LOS eviction). */
    remove(unitId: number): void {
        this.motion.delete(unitId);
        this.manual.delete(unitId);
    }

    reset(): void {
        this.motion.clear();
        this.manual.clear();
        this.latestFrame = -1;
    }

    /**
     * Ingest one wire snapshot: refresh planar speed from consecutive
     * positions, then re-evaluate every tracked unit. Called from the
     * entity-state callback, so the policy ticks at the wire cadence
     * (~10 Hz delta / 1 Hz full) rather than at render rate.
     *
     * `isDelta` mirrors EntityRenderer.update: a FULL snapshot lists every
     * visible entity, so anything missing from one has gone for good and its
     * bookkeeping is dropped (deltas list only what changed — absence there
     * is the stop signal, not a removal).
     */
    observe(snapshot: EntityStateSnapshot, isDelta = false): void {
        // Advance the clock before any early-out so an entity-less snapshot
        // still ages the stop hysteresis of a unit that has gone quiet.
        if (snapshot.baseFrame > this.latestFrame) this.latestFrame = snapshot.baseFrame;
        const { count, entityIds, positionsX, positionsZ, losStates, stateBits } = snapshot;
        if (entityIds && positionsX && positionsZ) {
            for (let i = 0; i < count; i++) {
                // Radar-only contacts carry a server-deceived position
                // (posErrorVector) that would jitter into fake movement — the
                // same reason EntityRenderer only feeds the interpolator in
                // LOS. alwaysVisible units stream their true position.
                const inLos = losStates ? (losStates[i] & LOS_INLOS) !== 0 : true;
                const alwaysVisible = stateBits
                    ? (stateBits[i] & STATE_BIT_ALWAYS_VISIBLE) !== 0 : false;
                if (!inLos && !alwaysVisible) continue;
                this.sample(entityIds[i], snapshot.baseFrame, positionsX[i], positionsZ[i]);
            }
        }
        if (!isDelta && entityIds) this.pruneTo(entityIds, count);
        this.evaluate();
    }

    /** Drop units absent from a full snapshot. Built from every id in the
     *  packet, not just the in-LOS ones, so a radar contact keeps its
     *  history. */
    private pruneTo(entityIds: Uint32Array, count: number): void {
        if (this.motion.size === 0) return;
        const seen = new Set<number>();
        for (let i = 0; i < count; i++) seen.add(entityIds[i]);
        for (const id of this.motion.keys()) {
            if (!seen.has(id)) this.remove(id);
        }
    }

    private sample(id: number, frame: number, x: number, z: number): void {
        const prev = this.motion.get(id);
        if (!prev) {
            this.motion.set(id, {
                frame, x, z, speed: 0,
                aboveTicks: 0, belowSinceFrame: null, autoClip: null,
                idleOnly: false, ineligible: false, staticUnit: false,
            });
            return;
        }
        // Out-of-order / duplicate packet: keep the newer sample's position
        // but don't derive a speed from a non-positive interval.
        if (frame <= prev.frame) return;
        const dtSec = (frame - prev.frame) / SIM_HZ;
        prev.speed = Math.hypot(x - prev.x, z - prev.z) / dtSec;
        prev.frame = frame;
        prev.x = x;
        prev.z = z;
    }

    /**
     * Speed to judge a unit by right now. A unit that stopped reporting has
     * not been seen to stop — it has been seen to move less than the server's
     * position deadband since its last sample, which bounds its average speed
     * from above. Taking the min of that bound and the last measurement
     * decays a stale walker toward rest instead of leaving it marching.
     */
    private effectiveSpeed(m: Motion): number {
        const staleSec = (this.latestFrame - m.frame) / SIM_HZ;
        if (staleSec <= 0) return m.speed;
        return Math.min(m.speed, POS_DEADBAND / staleSec);
    }

    private evaluate(): void {
        const starts: Start[] = [];

        for (const [id, m] of this.motion) {
            if (m.ineligible || this.manual.has(id)) continue;
            const speed = this.effectiveSpeed(m);

            // Reconcile before deciding: the player drops a playback when its
            // unit disappears, so our slot may already be gone.
            if (m.autoClip !== null && this.player.playingClip(id) !== m.autoClip) {
                m.autoClip = null;
            }

            // §M2 buildings: no speed to judge, so the only question is
            // whether they already hold their idle. Latch once — re-asking
            // every tick would pay a def lookup for the whole standing base.
            if (!m.staticUnit && this.deps.isStatic?.(id)) m.staticUnit = true;
            if (m.staticUnit) {
                if (m.autoClip === null) {
                    starts.push({ id, speed: 0, want: 'idle', isStatic: true });
                }
                continue;
            }

            if (m.autoClip === 'walk') {
                // Hold the cycle until sustained rest, then hand back to
                // `idle` (or the rest pose when the model ships no idle clip).
                if (speed <= STOP_SPEED) {
                    if (m.belowSinceFrame === null) m.belowSinceFrame = this.latestFrame;
                    if ((this.latestFrame - m.belowSinceFrame) / SIM_HZ >= STOP_HOLD_SEC) {
                        this.stopWalk(id, m);
                        continue;
                    }
                } else {
                    m.belowSinceFrame = null;
                }
                this.player.setSpeed(id, this.playbackSpeed(id, speed));
                continue;
            }

            m.aboveTicks = speed >= START_SPEED ? m.aboveTicks + 1 : 0;
            // `idleOnly` units already hold the only cycle they have — see
            // admit(); re-queueing would restart that playback every tick.
            if (m.aboveTicks >= START_TICKS && !m.idleOnly) {
                starts.push({ id, speed, want: 'walk', isStatic: false });
            }
        }

        if (starts.length > 0) this.admit(starts);
    }

    /**
     * Start the queued walkers, nearest-to-camera first, up to the cap.
     * Units already animating keep their slot — evicting them would trade a
     * perf win for a visible pop.
     *
     * Movers are admitted before statics regardless of camera distance: a
     * building that misses its slot is a still bell, a walker that misses its
     * slot is a unit sliding across the ground.
     */
    private admit(starts: Start[]): void {
        let free = this.maxAuto - this.countAuto();
        let freeStatic = Math.floor(this.maxAuto * STATIC_SHARE) - this.countAuto(true);
        if (starts.length > 1) {
            const cam = this.deps.cameraXZ?.();
            starts.sort((a, b) => {
                if (a.isStatic !== b.isStatic) return a.isStatic ? 1 : -1;
                return cam ? this.distSq(a.id, cam) - this.distSq(b.id, cam) : 0;
            });
        }
        for (const { id, speed, want, isStatic } of starts) {
            const m = this.motion.get(id);
            if (!m) continue;
            // A unit already holding an idle slot upgrades to walk for free.
            const needsSlot = m.autoClip === null;
            // `continue`, not `break`: a later candidate may already hold a slot.
            if (needsSlot && free <= 0) continue;
            if (needsSlot && isStatic && freeStatic <= 0) continue;
            let playing: 'walk' | 'idle' = want;
            let resolved = this.deps.getClip(id, want);
            if (!resolved && want === 'walk') {
                // No walk cycle: an authored idle is still better than a
                // frozen model, and it is what this unit will play from here
                // on (`idleOnly` stops the walk probe repeating every tick).
                resolved = this.deps.getClip(id, 'idle');
                playing = 'idle';
                if (resolved && this.deps.clipsLoaded(id)) m.idleOnly = true;
            }
            if (!resolved) {
                // Reset the run so a model that finishes loading isn't
                // started off a stale hysteresis count...
                m.aboveTicks = 0;
                // ...but once it HAS loaded and has neither cycle (the walk
                // start above already tried idle), retire it: otherwise every
                // mover in a clipless game re-probes here for the whole match.
                if (this.deps.clipsLoaded(id)) m.ineligible = true;
                continue;
            }
            this.player.play(id, resolved.clip, resolved.restLocals,
                { loop: true, speed: playing === 'walk' ? this.playbackSpeed(id, speed) : 1 });
            m.autoClip = playing;
            m.belowSinceFrame = null;
            if (needsSlot) {
                free--;
                if (isStatic) freeStatic--;
            }
        }
    }

    private stopWalk(id: number, m: Motion): void {
        m.aboveTicks = 0;
        m.belowSinceFrame = null;
        const idle = this.deps.getClip(id, 'idle');
        if (idle) {
            this.player.play(id, idle.clip, idle.restLocals, { loop: true, speed: 1 });
            m.autoClip = 'idle';   // reuses the walk slot
        } else {
            this.player.stop(id);
            m.autoClip = null;
        }
    }

    private playbackSpeed(id: number, unitSpeed: number): number {
        const nominal = this.deps.nominalSpeed(id) || NOMINAL_FALLBACK;
        const raw = unitSpeed / nominal;
        return Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw));
    }

    /** Live auto playbacks; `staticOnly` narrows to the building sub-cap. */
    private countAuto(staticOnly = false): number {
        let n = 0;
        for (const m of this.motion.values()) {
            if (m.autoClip !== null && (!staticOnly || m.staticUnit)) n++;
        }
        return n;
    }

    private distSq(id: number, cam: { x: number; z: number }): number {
        const m = this.motion.get(id);
        if (!m) return Infinity;
        const dx = m.x - cam.x;
        const dz = m.z - cam.z;
        return dx * dx + dz * dz;
    }

    /** Debug view (window.test.clipState / perf accounting). */
    stats(): {
        tracked: number; walking: number; idle: number;
        manual: number; ineligible: number; staticIdle: number;
    } {
        let walking = 0;
        let idle = 0;
        let ineligible = 0;
        let staticIdle = 0;
        for (const m of this.motion.values()) {
            if (m.autoClip === 'walk') walking++;
            else if (m.autoClip === 'idle') {
                idle++;
                if (m.staticUnit) staticIdle++;   // subset of `idle`, not disjoint
            }
            if (m.ineligible) ineligible++;
        }
        return {
            tracked: this.motion.size, walking, idle,
            manual: this.manual.size, ineligible, staticIdle,
        };
    }
}

/**
 * Nominal walk speed for a def (elmos/s): explicit `walk_speed_ref`
 * customparam wins, else the def's own top speed. See
 * `ClipAutoPolicyDeps.nominalSpeed` for why the stride derivation is not
 * used yet (§12).
 */
export function nominalSpeedFor(
    def: { speed?: number; customParams?: Record<string, string> } | undefined,
): number {
    if (!def) return 0;
    const ref = Number(def.customParams?.walk_speed_ref);
    if (Number.isFinite(ref) && ref > 0) return ref;
    return def.speed && def.speed > 0 ? def.speed : 0;
}

/**
 * Is this def immobile — a building, not a mover (§M2)? `speed` is the def's
 * top speed in elmos/s, and `units/_builder.lua` is explicit that an immobile
 * unit MUST carry speed 0 (a nonzero maxvelocity with no moveDef trips
 * MoveTypeFactory's IsImmobileUnit assertion), so this is the authoritative
 * signal and not a heuristic. An unknown def is NOT static — see
 * `ClipAutoPolicyDeps.isStatic` for why the wrong answer must be `false`.
 */
export function isStaticFor(
    def: { speed?: number } | undefined,
): boolean {
    return def !== undefined && !(def.speed !== undefined && def.speed > 0);
}

/** Speed-scaling knobs, exported for the tests + tuning. */
export const CLIP_AUTO_TUNING = {
    START_SPEED, STOP_SPEED, START_TICKS, STOP_HOLD_SEC,
    SPEED_MIN, SPEED_MAX, POS_DEADBAND, MAX_AUTO_PLAYBACKS, SIM_HZ,
    STATIC_SHARE,
} as const;
