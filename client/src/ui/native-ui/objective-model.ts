/**
 * objective-model.ts — the client's read of the objective board
 * (DESIGN-DRILLDOWN.md §3/§4; U1, interaction story 2)
 *
 * Pure: no DOM, no store import, no camera. It turns the `objective_<id>_*`
 * rulesParams `game_objectives.lua` publishes into records, decides which of
 * them earn a rung-1 chip, and reports the state CHANGES a player must not
 * miss. `objective-phrasing.ts` turns a record into English; `objective-hud.ts`
 * is the only thing here that touches a screen.
 *
 * ── The census this file was written from (U1's first job) ──
 *
 * `game_objectives.lua`'s PUBLISHED_FIELDS, in full:
 *
 *     type scope state reward team team2 progress phase stage expire
 *     region x z r suggested source victory completed_by      (+ objective_count)
 *
 * The old `objectives-panel` widget rendered SEVEN of those: type, scope (as a
 * CSS class), reward, progress (a bare bar), phase, stage, plus the badges from
 * team2/suggested. It never rendered `region`, `x`/`z`/`r`, `expire`,
 * `victory` or `source` at all — so the panel could not say WHERE an objective
 * was, WHEN it lapsed, or that winning one ENDED THE WAR. That, and not a
 * missing server field, is why the player reported objectives as unclear. The
 * gap is presentation, exactly as the brief said.
 *
 * What the server genuinely does NOT publish, so nothing here may claim it:
 *
 *   - free briefing text. There is none on the wire; every sentence this
 *     module's phrasing produces is composed client-side from the structured
 *     fields, which is why that lives in one tested file rather than scattered
 *     through a renderer.
 *   - `holdFrames` / `notBefore`. `progress` is a FRACTION, so a control
 *     objective can be shown as "62 % held" but NOT as "2:10 of 3:00" — the
 *     denominator is scenario content the client has never been told. Publishing
 *     the two frame counts is a one-line change to PUBLISHED_FIELDS and is filed
 *     as a follow-up rather than guessed at here.
 *   - the referenced UNIT ids (`targetUnitIDs`, `transportUnitIDs`). Only a
 *     position hint derived from them ships, so rung 2 can point at the place
 *     and must not pretend to list the units.
 *
 * ── Position hints are exactly one of two shapes ──
 *
 * `publish()` writes `region` OR `x`/`z`(/`r`), never both. A region key is a
 * slug, not a place a player recognises, so it is resolved against the region
 * entities the named-entity index already carries. An `x`/`z` hint carries no
 * name at all (it is a unit's position), so the nearest named place is used and
 * `approximate` is set — "near Storm Sound" is honest, "Storm Sound" would not
 * be.
 */

/** One objective, exactly as the wire describes it. Every field is optional
 *  because `publish()` emits most of them conditionally, and a missing field
 *  must read as "not set", never as a zero. */
export interface ObjectiveRecord {
    id: number;
    /** `control | kill | escort | protect | extract | infra`. */
    type: string;
    /** `strategic | tactical`. */
    scope?: string;
    /** `active | complete | failed | expired`. */
    state?: string;
    reward?: number;
    /** ELIGIBILITY, not outcome. -1 (or absent) means an open race. */
    team?: number;
    /** The co-eligible team of a joint objective (parley widening). */
    team2?: number;
    /** 0..1. A fraction — see the header: there is no denominator on the wire. */
    progress?: number;
    phase?: number;
    /** extract only: `secure | evac`. */
    stage?: string;
    /** ABSOLUTE sim frame at which this lapses. */
    expire?: number;
    region?: string;
    x?: number;
    z?: number;
    r?: number;
    /** A sim playerNum this was suggested to (joiner onboarding). */
    suggested?: number;
    /** `scripted | systemic | bounty`. */
    source?: string;
    /** 1 when winning this ends the war. */
    victory?: number;
    /** WHO finished it — the only field that can tell the loser of an open
     *  race that it was not them. */
    completedBy?: number;
}

/** Where an objective is, and how sure we are of the name. */
export interface ObjectivePlace {
    /** Null when nothing named could be found near it. */
    name: string | null;
    x: number;
    z: number;
    r?: number;
    /** True when `name` is the nearest named place to a bare coordinate rather
     *  than the region the objective actually names. Phrasing says "near X". */
    approximate: boolean;
}

export const RESOLVED_STATES: ReadonlySet<string> = new Set(['complete', 'failed', 'expired']);

const FIELD_KEY = /^objective_(\d+)_(\w+)$/;

const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
    'reward', 'team', 'team2', 'progress', 'phase', 'expire', 'x', 'z', 'r',
    'suggested', 'completed_by', 'victory',
]);

/** Wire field → record field. Only the one that differs. */
const RENAMED: Record<string, string> = { completed_by: 'completedBy' };

/** 30 fps, the sim's own rate. Used for every frame → clock conversion. */
export const FRAMES_PER_SECOND = 30;

/** Under this many frames to expiry an objective reads as URGENT and outranks
 *  an ordinary active one. Two sim minutes: long enough that a player can still
 *  march somewhere, short enough that saying "urgent" means something. */
export const URGENT_FRAMES = 3600;

/**
 * How many objective chips may rest on screen at once.
 *
 * `crossing_standoff` alone gives one side FIVE simultaneously-active
 * objectives, and five stacked chips is the wall of rows the directive exists
 * to remove. Three is the same budget the focus HUD holds itself to; the rest
 * are one click away behind the overflow line, never silently dropped.
 */
export const MAX_OBJECTIVE_CHIPS = 3;

/** Parse the whole `objective_*` slice of a gameRulesParams map. */
export function parseObjectives(
    params: ReadonlyMap<string, number | string>,
): ObjectiveRecord[] {
    const count = Number(params.get('objective_count') ?? 0);
    if (!Number.isFinite(count) || count <= 0) return [];

    const byId = new Map<number, Record<string, unknown>>();
    for (const [key, raw] of params) {
        const m = FIELD_KEY.exec(key);
        if (!m) continue;
        const id = Number(m[1]);
        // `objective_count` is a HIGH-WATER MARK, not a live count: an id past
        // it cannot happen, but ids BELOW it routinely have no fields at all
        // (resolved and retention-expired, or burned by a rejected Create).
        if (id < 1 || id > count) continue;
        const field = m[2];
        let record = byId.get(id);
        if (!record) { record = { id }; byId.set(id, record); }
        record[RENAMED[field] ?? field] = coerce(field, raw);
    }

    const out: ObjectiveRecord[] = [];
    for (let id = 1; id <= count; id++) {
        const record = byId.get(id);
        // No `type` means no objective — a stray field for a cleared id is not
        // something to render an empty row for.
        if (record && typeof record.type === 'string') out.push(record as unknown as ObjectiveRecord);
    }
    return out;
}

function coerce(field: string, raw: number | string): number | string {
    if (!NUMERIC_FIELDS.has(field)) return raw;
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
}

/** True once an objective has left `active` and before its params are cleared. */
export function isResolved(o: ObjectiveRecord): boolean {
    return o.state !== undefined && RESOLVED_STATES.has(o.state);
}

/**
 * Is `teamId` eligible for this?
 *
 * `team === -1` (or absent) is the sim's own "open to anyone" convention
 * (`o.forTeam or -1`), and `team2` is the co-eligible team a parley widening
 * added — the sim really does let that team complete it, so omitting it here
 * would hide the objective from the only team the widening exists for.
 */
export function visibleTo(o: ObjectiveRecord, teamId: number | undefined): boolean {
    if (o.team === undefined || o.team === -1) return true;
    if (teamId === undefined) return true;
    return o.team === teamId || (o.team2 !== undefined && o.team2 === teamId);
}

/** Two teams eligible for one reward that only pays whoever finishes it. */
export function isJoint(o: ObjectiveRecord): boolean {
    return o.team2 !== undefined && o.team !== undefined && o.team !== -1;
}

/** Did WE complete it? An open race published `team -1` to both sides, so
 *  `completedBy` is the only field that can answer. */
export function completedByUs(o: ObjectiveRecord, teamId: number | undefined): boolean {
    return o.completedBy === undefined || o.completedBy === teamId;
}

/** Frames until this lapses, or null when it has no expiry / we have no clock. */
export function framesRemaining(o: ObjectiveRecord, frame: number): number | null {
    if (o.expire === undefined || !Number.isFinite(o.expire)) return null;
    // Frame 0 is "the scene feed has not answered yet", not "the match just
    // started" — counting down from it would show a wildly wrong clock for the
    // first second of every session.
    if (!Number.isFinite(frame) || frame <= 0) return null;
    return Math.max(0, o.expire - frame);
}

// ───────────────────────────── position hints ───────────────────────────

export interface PlaceResolvers {
    /** Region key → its name and centroid (the named-entity index's regions). */
    region(key: string): { name: string; x: number; z: number } | undefined;
    /** Nearest named place to a bare coordinate, for hints derived from a
     *  unit's position. Optional: without it such an objective is nameless
     *  rather than mis-named. */
    nearest?(at: { x: number; z: number }): { name: string; x: number; z: number } | null;
}

/**
 * Where this objective is, named as well as we honestly can.
 *
 * The NAME and the GEOMETRY come from different fields and are resolved
 * separately, because since battle-clarity U2 they are no longer exclusive.
 * `publish()` used to write `region` OR `x`/`z`, and a `control` objective took
 * the region branch — which gave it a name and no extent, so "Hold Raven
 * Basin" could not be drawn on the map. It now publishes BOTH: the key still
 * names the place, and `GG.Regions.Area` supplies the circle.
 *
 * So the order is:
 *   name      — a resolvable `region` wins (it is the region the objective
 *               actually names); otherwise the nearest named place to the
 *               coordinate, which is `approximate` and phrased "near X".
 *   geometry  — published `x`/`z`/`r` wins (it is the objective's own area);
 *               otherwise the region centroid, with no radius.
 *
 * A region key we cannot resolve AND no coordinates is a real objective we
 * simply cannot place: null greys "Go there" out with a reason rather than
 * travelling somewhere wrong.
 */
export function resolvePlace(
    o: ObjectiveRecord,
    resolvers: PlaceResolvers,
): ObjectivePlace | null {
    const region = typeof o.region === 'string' ? resolvers.region(o.region) ?? null : null;
    const hasCoords = typeof o.x === 'number' && typeof o.z === 'number';

    if (hasCoords) {
        // `approximate` is about the NAME, not the position: with a region we
        // know exactly which place this is, so "near Raven Basin" would be a
        // needlessly vague sentence about a fact we hold.
        const named = region ?? resolvers.nearest?.({ x: o.x!, z: o.z! }) ?? null;
        return {
            name: named?.name ?? null,
            x: o.x!,
            z: o.z!,
            r: o.r,
            approximate: region === null,
        };
    }
    if (region) return { name: region.name, x: region.x, z: region.z, approximate: false };
    return null;
}

// ─────────────────────────────── ranking ────────────────────────────────

export interface RankContext {
    /** Current sim frame, 0 when unknown. */
    frame: number;
    /** Our sim playerNum, for the "yours to take" hint. */
    playerId?: number;
    /** Ids whose state changed inside the announcement window. */
    changedIds?: ReadonlySet<number>;
}

/**
 * Order the board so the top `MAX_OBJECTIVE_CHIPS` are the ones that change
 * what the player does next.
 *
 * The order is the design, so it is one readable table rather than a comparator
 * full of branches:
 *
 *   the war-ending one      — there is at most one, and it is why the map exists
 *   something just changed  — news outranks status, briefly (see the announcer)
 *   an outcome still retained — a loss must be seen before its params clear
 *   about to lapse          — a deadline is the only thing with a hard cost
 *   underway                — partial progress is a commitment already made
 *   suggested to me         — the joiner hint the sim publishes for exactly this
 *   richest                 — the tie-break, not the rule
 */
export function rankObjectives(
    records: readonly ObjectiveRecord[],
    ctx: RankContext,
): ObjectiveRecord[] {
    const score = (o: ObjectiveRecord): number => {
        let s = 0;
        if (o.victory === 1) s += 10_000;
        if (ctx.changedIds?.has(o.id)) s += 5_000;
        if (isResolved(o)) s += 4_000;
        const remaining = framesRemaining(o, ctx.frame);
        if (remaining !== null && remaining < URGENT_FRAMES) {
            // Sooner is higher, and every urgent objective beats every
            // non-urgent one.
            s += 2_000 + (URGENT_FRAMES - remaining) / URGENT_FRAMES * 500;
        }
        const p = o.progress ?? 0;
        if (p > 0.02 && p < 1) s += 1_000 + p * 200;
        if (ctx.playerId !== undefined && o.suggested === ctx.playerId) s += 800;
        s += Math.min(o.reward ?? 0, 999) / 1000;
        return s;
    };
    return records.slice().sort((a, b) => {
        const d = score(b) - score(a);
        return d !== 0 ? d : a.id - b.id;
    });
}

// ────────────────────────── state-change announcer ──────────────────────

export type ObjectiveEventKind = 'appeared' | 'complete' | 'lost-race' | 'failed' | 'expired';

export interface ObjectiveEvent {
    id: number;
    kind: ObjectiveEventKind;
    /** A snapshot, not the live record: the server clears these fields 30 s
     *  after resolution and a notice must still be able to name what was lost. */
    record: ObjectiveRecord;
}

export interface ObjectiveAnnouncer {
    /** Fold a fresh board in; returns what changed since the last call. */
    ingest(records: readonly ObjectiveRecord[], teamId: number | undefined): ObjectiveEvent[];
}

/**
 * Detect the transitions a player must notice.
 *
 * Two rules carried over from `authority-bar.js`'s event ring, because both
 * were learned the hard way:
 *
 *  1. **The first read syncs, it does not announce.** A HUD mounting into an
 *     already-populated store would otherwise replay the whole match's history
 *     as toasts at the moment the player joined.
 *  2. **Only a transition we OBSERVED counts.** An objective first seen already
 *     resolved (mounted mid-retention-window) is history, not news.
 */
export function createObjectiveAnnouncer(): ObjectiveAnnouncer {
    const seen = new Map<number, string | undefined>();
    let synced = false;

    return {
        ingest(records, teamId) {
            const events: ObjectiveEvent[] = [];
            const live = new Set<number>();

            for (const o of records) {
                live.add(o.id);
                const before = seen.get(o.id);
                const now = o.state;
                seen.set(o.id, now);
                if (!synced || now === before) continue;

                if (before === undefined && now === 'active') {
                    events.push({ id: o.id, kind: 'appeared', record: { ...o } });
                } else if (before === 'active' && now !== undefined && RESOLVED_STATES.has(now)) {
                    const kind: ObjectiveEventKind =
                        now === 'complete'
                            ? (completedByUs(o, teamId) ? 'complete' : 'lost-race')
                            : (now as 'failed' | 'expired');
                    events.push({ id: o.id, kind, record: { ...o } });
                }
            }

            // Retention expiry clears every field for an id; forget it so a
            // reused-looking id can announce again rather than being read as
            // an unchanged state.
            for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);

            synced = true;
            return events;
        },
    };
}
