/**
 * battle-events.ts — the fight, reduced to a handful of MOMENTS
 * (DESIGN-DRILLDOWN.md §2/§4; battle-clarity U3, awareness)
 *
 * The user report this exists to answer, from a live `crossing_standoff`:
 *
 * > it is generally unclear what is happening in the battle
 *
 * — first contact, two enemy tanks nearly dead and a whole reinforcement wave
 * all happened with NOTHING on screen saying so. The client was already being
 * told every one of those things; nothing turned them into something a player
 * could notice.
 *
 * ── Moments, not a log ────────────────────────────────────────────────────
 *
 * The directive forbids the obvious fix. An accumulating event feed beside the
 * viewport is a resident panel, and a resident panel is the spreadsheet this
 * whole framework exists to remove. So this module emits MOMENTS: a bounded
 * number of discrete, coalesced, decaying things worth interrupting for. The
 * full history is rung-4 content (`event-log`), reached through one access
 * point — and it is rendered from these same moments, never re-parsed from
 * anything's prose.
 *
 * ── Where it lives, and why the census of EMITTERS matters ────────────────
 *
 * Combat reaches the client in the worker and NOWHERE else. Main receives no
 * combat stream at all, so a main-side detector is not an option. There are
 * also **two** outcome families, not one, and hooking either alone covers about
 * half the arsenal:
 *
 *   - `onCombatEvents`   — `CombatEvent`, the faithful/ballistic path. Every
 *                          weapon that actually spawns a projectile.
 *   - `onVolleyOutcomes` — `VolleyOutcome`, Metalstorm's Model-1 statistical
 *                          path (PLAN-metalstorm-combat-resolution.md §2).
 *                          Autocannons, MGs, tank guns, small arms — i.e. most
 *                          of what a Metalstorm scenario shoots with, and it
 *                          spawns no projectile and produces no CombatEvent.
 *
 * Both normalise to `noteFire()` here. `onEntityDestroy` is the third emitter
 * (deaths — the ballistic path also reports `CombatResult.Kill`, so deaths are
 * deduplicated by unit id, not counted twice), and the entity mirror's roster
 * is the fourth (arrivals — reinforcements have no event of their own on the
 * wire at all).
 *
 * ── Pure ─────────────────────────────────────────────────────────────────
 *
 * No Babylon, no DOM, no globals, no clock of its own — every entry point takes
 * the sim frame. That is what makes a whole battle testable as a list of calls.
 * Screen-space classification (`markers`) is deliberately NOT here: it needs the
 * real camera and projection, so the game-processor does it and feeds the
 * result back through `setScreenState`.
 */

/** What kind of thing just happened. One per notice wording. */
export type BattleMomentKind =
    | 'first-contact'       // the battle started
    | 'under-fire'          // our units are being shot at, over there
    | 'losses'              // we lost units
    | 'kills'               // we destroyed enemy units
    | 'enemy-crippled'      // an enemy we are fighting is nearly dead
    | 'reinforcements'      // our units arrived
    | 'enemy-reinforcements'; // enemy units arrived in our vision

/**
 * One thing worth telling the player.
 *
 * Carries DATA, never prose. The wording lives on the main thread
 * (`battle-moment-phrasing.ts`) beside the objective phrasing, for the reason
 * U2 learned the hard way: two places that compose text about one thing end up
 * calling it two different names, and the player sees both at once.
 */
export interface BattleMoment {
    /** Monotonic within a session. The identity every later message keys on. */
    id: number;
    kind: BattleMomentKind;
    /** Sim frame this was decided on. */
    frame: number;
    /** Where it happened, in elmos. Always present — a moment the player cannot
     *  be sent to is a moment they cannot act on. */
    x: number;
    z: number;
    /** How many things this moment coalesces (units lost, units arrived, …).
     *  1 for the singular kinds. */
    count: number;
    /** Own/allied units this moment is ABOUT, when it is about ours. Main
     *  resolves these against the org-group roster to get a NAME, which is what
     *  turns "3 units under fire" into "3rd Tanks under fire". */
    unitIds: number[];
    /** Majority `ms_class` of the units involved ("tanks"), when they agree. */
    className?: string;
    /** True when the units involved are Metalstorm squad units, so the wording
     *  can say "squads" rather than "units". */
    squads?: boolean;
    /** True when the camera was not looking at this when it happened. Drives
     *  the minimap ping and the edge marker. */
    offScreen?: boolean;
}

/** Live screen-space state of a moment, recomputed by the owner of the camera. */
export interface BattleMomentMarker {
    id: number;
    /** Normalised viewport coords, 0..1 from the top-left, when on screen. */
    sx: number;
    sy: number;
    /** True while the moment's position is inside the viewport. An on-screen
     *  moment needs no marker at all — the player is already looking at it. */
    onScreen: boolean;
}

// ───────────────────────────── tuning ───────────────────────────────────
//
// Every number here is a coalescing width. They are generous on purpose: the
// failure this module exists to fix is silence, but the failure it would
// SHIP if these were tight is a wall of notices, which is the same wall in
// motion.

/** Two shots this far apart (elmos) are the same engagement. Roughly the
 *  radius over which a player would say "the fight at the crossing". */
export const ENGAGEMENT_RADIUS = 700;

/** An engagement with no fire for this many frames is over, and the next shot
 *  in the same place is a NEW engagement (so a second assault re-announces). */
export const ENGAGEMENT_QUIET_FRAMES = 30 * 12;

/** Losses/kills/arrivals inside this window merge into one moment with a
 *  count, rather than one notice per unit. 3 sim seconds. */
export const COALESCE_FRAMES = 30 * 3;

/** Below this health ratio an enemy we are engaging is "nearly dead" — the
 *  literal thing the user report says went unannounced. */
export const CRIPPLED_HEALTH = 0.3;

/** How many arrivals in one window count as a WAVE. One unit trickling out of
 *  a factory is not news; a wave is. */
export const WAVE_MIN_UNITS = 3;

/**
 * How long a unit that left our vision is still "the same unit" if it comes
 * back (frames). Without this, a squad that walks behind a ridge and out again
 * reads as a fresh arrival — and `crossing_standoff` is full of exactly that
 * traffic, so the "reinforcement wave" notice would fire on our own scouting.
 * Sixty sim seconds: long enough to cover a flank, short enough that a genuine
 * second wave from a factory is still news.
 */
export const RETURN_GRACE_FRAMES = 30 * 60;

/** Ring of moments kept for the rung-4 history. Bounded for the same reason
 *  `game_warlog.lua`'s is: the record is not the HUD's job to hold. */
export const HISTORY_MAX = 60;

// ───────────────────────────── inputs ───────────────────────────────────

/** One shot's outcome, normalised across the two emitter families. */
export interface FireObservation {
    attackerId: number;
    targetId: number;
    /** Side of the TARGET, as the viewer sees it. */
    targetSide: Side;
    /** Side of the ATTACKER; `unknown` when the viewer cannot see them
     *  (a statistical volley from outside LOS reports attacker 0). */
    attackerSide: Side | 'unknown';
    x: number;
    z: number;
    damage: number;
}

export type Side = 'own' | 'ally' | 'enemy';

/** The mirror slice the detector reads, once per tick. LOS-honest by
 *  construction: it is the same `liveState.units` the NL census walks, and
 *  there is no "all units" collection anywhere on the client to reach for. */
export interface RosterUnit {
    unitId: number;
    side: Side;
    x: number;
    z: number;
    health?: number;
    className?: string;
    squad?: boolean;
}

// ───────────────────────────── the detector ─────────────────────────────

interface Engagement {
    x: number;
    z: number;
    lastFireFrame: number;
    /** True once an `under-fire` notice went out for this engagement. Reset
     *  with the engagement, which is what re-arms it for a second assault. */
    announced: boolean;
    /** Own/ally unit ids seen taking fire in this engagement. */
    victims: Set<number>;
}

/**
 * A pending coalescing bucket — losses, kills or arrivals accumulating.
 *
 * Buckets are matched by PROXIMITY to their own running centroid, not by a
 * grid cell. A fixed grid looks equivalent and is not: three tanks dying 50
 * elmos apart can straddle a cell boundary and become two pieces of news about
 * one event, which is exactly the noise this layer exists to avoid. (Caught by
 * `battle-events.test.ts`'s three-deaths case, which a cell key fails.)
 */
interface Bucket {
    kind: BattleMomentKind;
    frame: number;
    /** Running SUM of member positions; divided by `total` when the bucket closes. */
    x: number;
    z: number;
    /** Centroid so far — what proximity is measured against. */
    cx: number;
    cz: number;
    unitIds: number[];
    classes: string[];
    squads: number;
    total: number;
}

export class BattleEventDetector {
    private nextId = 1;
    private contactAnnounced = false;
    private engagements: Engagement[] = [];
    private buckets: Bucket[] = [];
    private pending: BattleMoment[] = [];
    private crippled = new Set<number>();
    /** Last roster we saw, so an arrival is "in the mirror now, wasn't before". */
    private known = new Map<number, RosterUnit>();
    /** Units that left the mirror, and the frame they left on. A unit that
     *  comes back inside `RETURN_GRACE_FRAMES` is the same unit re-spotted,
     *  not a reinforcement — see that constant. */
    private departed = new Map<number, number>();
    /**
     * True once a roster with anything IN it has been ingested. Everything
     * present at that moment is the starting army, not a reinforcement wave.
     *
     * "Non-empty" and not "first call" — the distinction is the whole guard,
     * and it was found live: the detector's tick starts with the render loop
     * and the entity mirror is still empty for the first second of a match, so
     * priming on the first call primed on NOTHING and the army arriving a tick
     * later announced itself as an 18-unit reinforcement wave at frame 0.
     */
    private rosterPrimed = false;
    private history: BattleMoment[] = [];

    /** One shot's outcome. Called from BOTH outcome handlers — see the header. */
    noteFire(o: FireObservation, frame: number): void {
        const mine = o.targetSide === 'own' || o.targetSide === 'ally';
        const enemyInvolved = o.targetSide === 'enemy'
            || o.attackerSide === 'enemy' || o.attackerSide === 'unknown';
        // A shot between two sides we merely SEE is somebody else's war. It
        // still opens an engagement (so the fight is a place on the map) but it
        // is never what "first contact" means.
        const eng = this.touchEngagement(o.x, o.z, frame);
        if (mine) eng.victims.add(o.targetId);

        if (!this.contactAnnounced && mine && enemyInvolved && o.damage > 0) {
            this.contactAnnounced = true;
            this.emit({
                kind: 'first-contact', frame, x: o.x, z: o.z, count: 1,
                unitIds: [o.targetId],
            });
            // First contact IS the under-fire notice for this engagement; two
            // notices about the same shot is the wall, not the fix.
            eng.announced = true;
            return;
        }

        if (mine && o.damage > 0 && !eng.announced) {
            eng.announced = true;
            this.emit({
                kind: 'under-fire', frame, x: eng.x, z: eng.z,
                count: eng.victims.size,
                unitIds: [...eng.victims],
            });
        }
    }

    /** A unit died. Deduplicated by id, so the ballistic path's `Kill` result
     *  and the entity-destroy stream cannot double-count one death. */
    noteDeath(unitId: number, x: number, z: number, frame: number): void {
        const known = this.known.get(unitId);
        if (!known) return;             // never in our mirror ⇒ never our news
        this.known.delete(unitId);
        this.crippled.delete(unitId);
        this.departed.delete(unitId);
        const kind: BattleMomentKind = known.side === 'enemy' ? 'kills' : 'losses';
        this.bucket(kind, frame, x, z, known);
    }

    /**
     * The current LOS-honest roster. Drives arrivals, departures and the
     * "nearly dead" read; called on the HUD's own slow tick, never per frame.
     */
    noteRoster(units: readonly RosterUnit[], frame: number): void {
        const seen = new Set<number>();
        for (const u of units) {
            seen.add(u.unitId);
            const prev = this.known.get(u.unitId);
            this.known.set(u.unitId, u);
            if (!prev) {
                const left = this.departed.get(u.unitId);
                this.departed.delete(u.unitId);
                const respotted = left !== undefined
                    && frame - left <= RETURN_GRACE_FRAMES;
                // Everything already in the world when we first look is the
                // starting army; anything we merely lost sight of is not new.
                if (this.rosterPrimed && !respotted) {
                    this.bucket(
                        u.side === 'enemy' ? 'enemy-reinforcements' : 'reinforcements',
                        frame, u.x, u.z, u,
                    );
                }
                continue;
            }
            if (u.side === 'enemy'
                && u.health !== undefined && u.health < CRIPPLED_HEALTH
                && !this.crippled.has(u.unitId)
                && this.inLiveEngagement(u.x, u.z, frame)) {
                this.crippled.add(u.unitId);
                this.bucket('enemy-crippled', frame, u.x, u.z, u);
            }
        }
        // A unit that left the mirror without a destroy event went out of
        // vision, not out of the war. Forgetting it is right; announcing it
        // would be a lie — see `noteDeath`'s "never in our mirror" guard.
        for (const id of [...this.known.keys()]) {
            if (seen.has(id)) continue;
            this.known.delete(id);
            this.crippled.delete(id);
            this.departed.set(id, frame);
        }
        for (const [id, left] of [...this.departed]) {
            if (frame - left > RETURN_GRACE_FRAMES) this.departed.delete(id);
        }
        if (units.length > 0) this.rosterPrimed = true;
    }

    /**
     * Close every bucket whose coalescing window has passed and hand over
     * everything ready to show. Called on the same slow tick as `noteRoster`.
     */
    drain(frame: number): BattleMoment[] {
        const ripe = this.buckets.filter((b) => frame - b.frame >= COALESCE_FRAMES);
        this.buckets = this.buckets.filter((b) => frame - b.frame < COALESCE_FRAMES);
        for (const b of ripe) {
            this.emit({
                kind: b.kind, frame: b.frame, x: b.x / b.total, z: b.z / b.total,
                count: b.total,
                unitIds: b.unitIds,
                className: majority(b.classes),
                squads: b.squads > b.total / 2 ? true : undefined,
            });
        }
        // Waves are the one kind with a floor: a single unit walking into view
        // is not a reinforcement wave, and saying so every time one does would
        // be the noisiest thing on the HUD.
        const out = this.pending.filter((m) =>
            (m.kind !== 'reinforcements' && m.kind !== 'enemy-reinforcements')
            || m.count >= WAVE_MIN_UNITS);
        this.pending = [];
        this.expireEngagements(frame);
        for (const m of out) {
            this.history.push(m);
            if (this.history.length > HISTORY_MAX) this.history.shift();
        }
        return out;
    }

    /** The rung-4 history, oldest first. */
    getHistory(): readonly BattleMoment[] { return this.history; }

    reset(): void {
        this.nextId = 1;
        this.contactAnnounced = false;
        this.engagements = [];
        this.buckets = [];
        this.pending = [];
        this.crippled.clear();
        this.known.clear();
        this.departed.clear();
        this.rosterPrimed = false;
        this.history = [];
    }

    // ── internals ───────────────────────────────────────────────────────

    private emit(m: Omit<BattleMoment, 'id'>): void {
        this.pending.push({ id: this.nextId++, ...m });
    }

    private bucket(
        kind: BattleMomentKind, frame: number, x: number, z: number, u: RosterUnit,
    ): void {
        // One bucket per kind per engagement-sized NEIGHBOURHOOD, so a loss at
        // the crossing and a loss at the ridge stay two pieces of news while
        // three losses in one firefight stay one.
        for (const b of this.buckets) {
            if (b.kind !== kind) continue;
            if (Math.hypot(b.cx - x, b.cz - z) > ENGAGEMENT_RADIUS) continue;
            b.x += x; b.z += z; b.total++;
            b.cx = b.x / b.total; b.cz = b.z / b.total;
            b.unitIds.push(u.unitId);
            if (u.className) b.classes.push(u.className);
            if (u.squad) b.squads++;
            return;
        }
        this.buckets.push({
            kind, frame, x, z, cx: x, cz: z, total: 1,
            unitIds: [u.unitId],
            classes: u.className ? [u.className] : [],
            squads: u.squad ? 1 : 0,
        });
    }

    private touchEngagement(x: number, z: number, frame: number): Engagement {
        this.expireEngagements(frame);
        for (const e of this.engagements) {
            if (Math.hypot(e.x - x, e.z - z) <= ENGAGEMENT_RADIUS) {
                e.lastFireFrame = frame;
                return e;
            }
        }
        const eng: Engagement = {
            x, z, lastFireFrame: frame, announced: false, victims: new Set(),
        };
        this.engagements.push(eng);
        return eng;
    }

    private inLiveEngagement(x: number, z: number, frame: number): boolean {
        for (const e of this.engagements) {
            if (frame - e.lastFireFrame > ENGAGEMENT_QUIET_FRAMES) continue;
            if (Math.hypot(e.x - x, e.z - z) <= ENGAGEMENT_RADIUS) return true;
        }
        return false;
    }

    private expireEngagements(frame: number): void {
        this.engagements = this.engagements.filter(
            (e) => frame - e.lastFireFrame <= ENGAGEMENT_QUIET_FRAMES);
    }
}

/** The commonest string, or undefined when nothing agrees or nothing is set. */
function majority(values: readonly string[]): string | undefined {
    if (values.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: string | undefined;
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return bestN > values.length / 2 ? best : undefined;
}
