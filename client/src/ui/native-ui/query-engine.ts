/**
 * query-engine.ts — answering questions without becoming a wallhack
 * (PLAN-metalstorm-command-language.md §6.4, milestone M3)
 *
 * "How many heavy tanks do we have left?" · "Where is Chimera Platoon?" ·
 * "Locate the enemy commander" · "How are we doing on authority?"
 *
 * ── LOS-HONESTY IS THE PILLAR (§ design pillar 3) ──
 *
 * Every answer comes from ONE source: the client's own unit mirror, which the
 * server already filtered to what this player may see before it ever crossed the
 * wire. That is the whole safety argument, and it only holds because of what
 * this file does NOT do:
 *
 *   - it never reads a server-side or sim-side collection;
 *   - it never asks the worker for "all units" — the census op it calls is the
 *     same `liveState.units` map every `Spring.GetTeamUnits*` callout answers
 *     from, i.e. the LOS-filtered stream and nothing else;
 *   - it never infers presence from absence in the other direction: an enemy
 *     that is not in the mirror is answered "not currently spotted", never
 *     "there are none" — the two are different claims and only one is true.
 *
 * The consequence is that LOS honesty is a property of the DATA PATH, not of a
 * check this file remembers to perform. There is no filtering code here to get
 * wrong, because there is nothing unfiltered to filter.
 *
 * ── Why the census and not `GetTeamUnitsSorted` through the Lua bridge ──
 *
 * The plan offered either. `GetTeamUnitsSorted` is reachable from main only via
 * `window.widgets.eval` — a single-flight, 5-second-timeout, string-returning
 * Lua eval bridge, which would mean the command language building Lua source
 * strings and parsing prose back. The census op instead answers in TypeScript
 * from the same `liveState.units` that callout reads, joined worker-side against
 * the def cache the worker already holds (main has no defs mirror at all, so the
 * `ms_class` join CANNOT happen on this thread). Same data, one structured
 * round-trip, no Lua strings in the command path — and, per design pillar 1, no
 * eval hatch anywhere near the NL layer.
 *
 * ── Why the snapshot is pulled, not awaited ──
 *
 * `CensusPort.snapshot()` is synchronous and returns whatever the last refresh
 * fetched, so the executor (and therefore the whole envelope path) stays
 * synchronous. The console refreshes before running a sentence, which is the one
 * place a round-trip can be awaited without infecting anything else. A snapshot
 * that never arrived is `null`, and every query then refuses out loud rather
 * than answering from an empty world — "you have no tanks" and "I can't see your
 * units right now" must never be the same sentence.
 */

import { classClausesFor, matchesClassClauses, type Resolution } from './nl-resolver.js';
import type { ClassVocabulary } from './class-vocabulary.js';
import type { NamedEntity, EntityType } from './named-entity-index.js';
import type { OrgGroupSummary, DirectiveSummary } from './ui-store.js';
import type { NLQuery, NLScale } from './nl-envelope.js';

/** Which side of the war a mirrored unit is on, from the local player's seat. */
export type CensusSide = 'own' | 'ally' | 'enemy';

/**
 * One unit as the client mirror holds it. `className`/`scale` are the def's
 * `customParams.ms_class`/`ms_scale`, joined worker-side.
 *
 * An enemy entry existing here IS the statement "this is currently visible to
 * you" — the server sends no others.
 */
export interface CensusUnit {
    unitId: number;
    team: number;
    side: CensusSide;
    className?: string;
    scale?: number;
    x: number;
    z: number;
    /**
     * Health as a fraction of maximum, 0..1. Absent when the mirror has not
     * carried a health field for this unit yet.
     *
     * Added for the drill-down ladder's rung 1 (DESIGN-DRILLDOWN.md §4): a
     * summary chip's job is to answer "is this force OK?", and no combination
     * of the other fields answers it. It is on the census rather than a new op
     * because the census is already the client's LOS-honest unit mirror — a
     * second unit feed would be a second thing to keep true.
     */
    health?: number;
    /** True while the unit is under way. The one state word rung 1 shows. */
    moving?: boolean;
}

export interface Census {
    /** Sim frame the mirror was at. 0 before the first frame. */
    frame: number;
    myTeam: number;
    units: readonly CensusUnit[];
}

export interface CensusPort {
    /** Last fetched snapshot, or null when none has arrived. */
    snapshot(): Census | null;
}

/** The index slice the engine reads — resolution plus "what region is this near". */
export interface QueryIndex {
    getAll(): NamedEntity[];
    getByType(type: EntityType): NamedEntity[];
}

export interface QueryEngineDeps {
    census: CensusPort;
    index: QueryIndex;
    vocabulary: ClassVocabulary;
    /** Name → entity, through the same resolver the order path uses. */
    resolveEntity(
        name: string,
        opts?: { types?: EntityType[]; strict?: boolean; noun?: string },
    ): Resolution<NamedEntity>;
    /** Own-team org groups (`uiStore.getOrgGroups()`). */
    groups: readonly OrgGroupSummary[];
    /** Live directives, for `status`. */
    directives: readonly DirectiveSummary[];
    /** `gameRulesParams` / this team's `teamRulesParams` readers. */
    gameRulesParam(key: string): number | string | undefined;
    teamRulesParam(key: string): number | string | undefined;
    /** Local sim playerNum — `authority_player_<playerId>` is scoped by it. */
    playerId: number;
    /**
     * Optional: point the camera at what `locate` found (§6.4 "locate optionally
     * pings/focuses"). Absent ⇒ the answer is words only, which is the correct
     * degradation, not a silent no-op.
     */
    focusCamera?(x: number, z: number): void;
}

const ok = (text: string): Resolution<string> => ({ kind: 'ok', value: text });
const refuse = (reason: string): Resolution<string> => ({ kind: 'refuse', reason });

/** Places a `locate` may name. */
const PLACE_TYPES: EntityType[] = ['region', 'district', 'city', 'objective', 'landmark', 'enemy-force'];
const FORCE_TYPES: EntityType[] = ['group', 'platoon', 'army'];

/**
 * The vision wording, in the two grammatical shapes the answers need.
 *
 * Exported because the fixtures assert on them and a reworded copy in the test
 * would prove nothing. Two constants rather than one because the first live run
 * produced "No enemy tanks are not currently spotted." — the count line already
 * carries the negation in "No", so pasting the negated phrase after it says the
 * opposite of what it means.
 */
export const SPOTTED = 'currently spotted';
export const NOT_SPOTTED = `not ${SPOTTED}`;

export class QueryEngine {
    constructor(private readonly deps: QueryEngineDeps) {}

    answer(query: NLQuery): Resolution<string> {
        switch (query.op) {
            case 'count':      return this.count(query);
            case 'locate':     return this.locate(query);
            case 'status':     return this.status(query);
            case 'resources':  return this.resources();
            case 'objectives': return this.objectives();
        }
    }

    // ───────────────────────────── count ─────────────────────────────

    /**
     * Count by class (and optionally scale) on one side.
     *
     * The own-side count is exact: your units are all in the mirror by
     * definition. The enemy-side count is exactly as complete as your vision,
     * and says so — "3 enemy tanks in sight" is true, "the enemy has 3 tanks" is
     * a guess dressed as a fact.
     */
    private count(query: Extract<NLQuery, { op: 'count' }>): Resolution<string> {
        const census = this.deps.census.snapshot();
        if (!census) return refuse(this.noMirror());

        const clauses = classClausesFor(this.deps.vocabulary, query.class, query.scale);
        if (!clauses) return refuse(`"${query.class}" isn't a unit class I know.`);

        const match = this.deps.vocabulary.lookup(query.class)!;
        const label = describeClassPhrase(match.label, query.scale);

        const matching = census.units.filter((u) =>
            u.side === query.side
            && u.className !== undefined
            && matchesClassClauses(clauses, { className: u.className, scale: u.scale ?? null }));

        const n = matching.length;

        if (query.side === 'enemy') {
            return ok(n === 0
                ? `No enemy ${label} are ${SPOTTED}.`
                : `${n} enemy ${label} ${n === 1 ? 'is' : 'are'} in sight — that's only what's spotted right now.`);
        }
        if (query.side === 'ally') {
            return ok(n === 0
                ? `I can't see any allied ${label}.`
                : `Your allies have ${n} ${label} in sight.`);
        }
        return ok(n === 0 ? `You have no ${label}.` : `You have ${n} ${label}.`);
    }

    // ───────────────────────────── locate ─────────────────────────────

    /**
     * Where is it?
     *
     * Index first (a name beats a class — "Northgate" is a place, not a unit
     * type), then the class vocabulary against the mirror. Both paths end at the
     * same LOS rule: a hit means something of that description is in the
     * player's stream right now; a miss means it is not spotted, NOT that it
     * doesn't exist.
     */
    private locate(query: Extract<NLQuery, { op: 'locate' }>): Resolution<string> {
        const side = query.side ?? 'own';

        // ── a named entity ──
        const named = this.deps.resolveEntity(query.targetRef, {
            types: [...PLACE_TYPES, ...FORCE_TYPES],
            noun: 'place or force',
        });
        if (named.kind === 'clarify') return named as Resolution<string>;
        if (named.kind === 'ok') return this.locateNamed(named.value);

        // ── a unit class / role ("the enemy tanks", "our artillery") ──
        const byClass = this.locateClass(query.targetRef, side);
        if (byClass) return byClass;

        // Neither a name nor a class: the ORIGINAL name refusal is the useful
        // one ("I don't know a place called …"), so it is passed through rather
        // than replaced by a vaguer class complaint.
        return named as Resolution<string>;
    }

    private locateNamed(entity: NamedEntity): Resolution<string> {
        // An `enemy-force` index entry is a REPORT, not a position.
        //
        // It arrives from the macro-intel stream (a sighting the player was told
        // about), so it is stale by construction — the force may have moved, or
        // died, since. Answering "Enemy 3rd Armour is near Northgate" would
        // present remembered intel as current vision, which is the pillar-3
        // failure in its most convincing form: every word of it comes from data
        // the client legitimately holds, and it is still a lie about NOW. Hence
        // the "last seen" wording, and no camera move — the camera pointing at a
        // spot is a claim that there is something there to look at.
        if (entity.type === 'enemy-force') {
            return ok(`${entity.name}: ${NOT_SPOTTED} — last seen ${this.near({ x: entity.x, z: entity.z })}.`);
        }

        // A force: its position is its members' centroid, from the mirror. Own
        // groups are always present; a group whose members have all left the
        // mirror is dead or out of vision, and is reported as such.
        if (FORCE_TYPES.includes(entity.type)) {
            const census = this.deps.census.snapshot();
            if (!census) return refuse(this.noMirror());
            const group = this.deps.groups.find((g) => g.groupId === Number(entity.id));
            if (!group) return refuse(`I don't have ${entity.name} on the order of battle any more.`);

            const members = new Set(group.memberIds);
            const seen = census.units.filter((u) => members.has(u.unitId));
            if (seen.length === 0) {
                return ok(`${entity.name} is ${NOT_SPOTTED}${this.lastSeenSuffix(entity)}.`);
            }
            const centre = centroid(seen);
            this.deps.focusCamera?.(centre.x, centre.z);
            return ok(`${entity.name} is ${this.near(centre)} (${seen.length} of ${group.memberIds.length} in sight).`);
        }

        // A place. Places don't move and aren't hidden — a region name IS public
        // knowledge (it came from the same rulesParams stream every client
        // gets), so pointing the camera at one reveals nothing.
        this.deps.focusCamera?.(entity.x, entity.z);
        const at = this.near({ x: entity.x, z: entity.z }, entity.name);
        return ok(`${entity.name} is ${at}.`);
    }

    /**
     * Locate by unit class. Returns null when the phrase isn't a class at all,
     * so the caller can fall back to the name-based refusal.
     */
    private locateClass(phrase: string, side: 'own' | 'enemy'): Resolution<string> | null {
        const cleaned = stripSideWords(phrase);
        const clauses = classClausesFor(this.deps.vocabulary, cleaned);
        if (!clauses) return null;
        const match = this.deps.vocabulary.lookup(cleaned)!;

        // "the enemy tanks" carries its own side; an explicit `side` on the
        // query is honoured, but the words win when they disagree with the
        // default — the player said "enemy" out loud.
        const wanted: CensusSide = /\benem(y|ies)\b|\bhostile/i.test(phrase) ? 'enemy' : side;

        const census = this.deps.census.snapshot();
        if (!census) return refuse(this.noMirror());

        const hits = census.units.filter((u) =>
            u.side === wanted
            && u.className !== undefined
            && matchesClassClauses(clauses, { className: u.className, scale: u.scale ?? null }));

        const label = match.label;

        if (hits.length === 0) {
            // THE LOS-HONEST ANSWER. Not "you have none", not silence.
            const stale = wanted === 'enemy' ? this.staleIntelFor(label) : '';
            return ok(wanted === 'enemy'
                ? `Enemy ${label}: ${NOT_SPOTTED}${stale}.`
                : `You have no ${label} I can see.`);
        }

        const centre = centroid(hits);
        this.deps.focusCamera?.(centre.x, centre.z);
        const who = wanted === 'enemy' ? `Enemy ${label}` : `Your ${label}`;
        return ok(`${who}: ${hits.length} ${this.near(centre)}${wanted === 'enemy' ? ' — spotted now' : ''}.`);
    }

    /**
     * Stale intel about an enemy force, if the index happens to hold any.
     *
     * `enemy-force` entities come from the macro-intel stream, which has no
     * producer yet (`entity-index-producer.ts`) — so this returns '' today and
     * will start returning "— last seen near X" the day one lands, with no
     * change here. It is deliberately built now: "last seen" is the difference
     * between an honest fog-of-war answer and a useless one, and wiring it later
     * would mean revisiting the one function whose wording the whole pillar
     * rests on.
     */
    private staleIntelFor(label: string): string {
        const plural = label.toLowerCase();
        // A force is named by a human ("Enemy tank column"), so the class LABEL
        // is plural and the name usually isn't. Match either form rather than
        // missing every report whose author wrote "tank".
        const singular = plural.endsWith('s') ? plural.slice(0, -1) : plural;
        for (const force of this.deps.index.getByType('enemy-force')) {
            const name = force.name.toLowerCase();
            if (!name.includes(plural) && !name.includes(singular)) continue;
            return ` — last seen ${this.near({ x: force.x, z: force.z })}`;
        }
        return '';
    }

    private lastSeenSuffix(entity: NamedEntity): string {
        if (entity.x === 0 && entity.z === 0) return '';
        return ` — last known position ${this.near({ x: entity.x, z: entity.z })}`;
    }

    // ───────────────────────────── status ─────────────────────────────

    private status(query: Extract<NLQuery, { op: 'status' }>): Resolution<string> {
        const found = this.deps.resolveEntity(query.subjectRef, {
            types: FORCE_TYPES, strict: true, noun: 'group',
        });
        if (found.kind !== 'ok') return found as Resolution<string>;

        const group = this.deps.groups.find((g) => g.groupId === Number(found.value.id));
        if (!group) return refuse(`I don't have ${found.value.name} on the order of battle.`);

        const bits: string[] = [`${group.memberIds.length} units`];

        const census = this.deps.census.snapshot();
        if (census) {
            const members = new Set(group.memberIds);
            const alive = census.units.filter((u) => members.has(u.unitId)).length;
            if (alive !== group.memberIds.length) bits.push(`${alive} in sight`);
        }

        const directive = group.currentDirectiveId
            ? this.deps.directives.find((d) => d.directiveId === group.currentDirectiveId)
            : undefined;
        bits.push(directive ? `${directive.type.toLowerCase()} (priority ${directive.priority})` : 'no active directive');

        return ok(`${found.value.name} — ${bits.join(', ')}.`);
    }

    // ─────────────────────────── resources ───────────────────────────

    /** Authority, the resource the macro layer actually spends
     *  (PLAN-metalstorm-authority.md): the team pool plus this player's slice. */
    private resources(): Resolution<string> {
        const pool = numeric(this.deps.teamRulesParam('authority_pool'));
        const mine = numeric(this.deps.teamRulesParam(`authority_player_${this.deps.playerId}`));

        if (pool === null && mine === null) {
            return refuse("I can't read the authority pool yet — no rules params have arrived.");
        }

        const bits: string[] = [];
        if (mine !== null) bits.push(`you have ${Math.round(mine)} authority`);
        if (pool !== null) bits.push(`the team pool holds ${Math.round(pool)}`);
        return ok(`${bits.join('; ')}.`);
    }

    // ─────────────────────────── objectives ───────────────────────────

    private objectives(): Resolution<string> {
        const count = numeric(this.deps.gameRulesParam('objective_count')) ?? 0;
        const nameById = new Map<number, string>(
            this.deps.index.getByType('objective').map((o) => [Number(o.id), o.name]));

        const lines: string[] = [];
        for (let id = 1; id <= count; id++) {
            const state = this.deps.gameRulesParam(`objective_${id}_state`);
            if (state !== 'active') continue;      // complete/failed/cleared aren't the answer to "what now"
            const name = nameById.get(id) ?? `objective ${id}`;
            const progress = numeric(this.deps.gameRulesParam(`objective_${id}_progress`));
            const reward = numeric(this.deps.gameRulesParam(`objective_${id}_reward`));
            const bits: string[] = [];
            if (progress !== null) bits.push(`${Math.round(progress * 100)}%`);
            if (reward !== null) bits.push(`${Math.round(reward)} authority`);
            lines.push(bits.length ? `${name} (${bits.join(', ')})` : name);
        }

        if (lines.length === 0) {
            return ok(count > 0
                ? 'Nothing active right now — every objective on the board is settled.'
                : 'No objectives have been issued yet.');
        }
        return ok(`Active: ${lines.join(' · ')}.`);
    }

    // ─────────────────────────── helpers ───────────────────────────

    /** "near Northgate" / "at 4200, 3100" when no region is close enough. */
    private near(position: { x: number; z: number }, exclude?: string): string {
        const region = this.nearestRegion(position, exclude);
        if (region) return `near ${region.name}`;
        return `at ${Math.round(position.x)}, ${Math.round(position.z)}`;
    }

    private nearestRegion(
        position: { x: number; z: number }, exclude?: string,
    ): NamedEntity | null {
        let best: NamedEntity | null = null;
        let bestD = Infinity;
        for (const type of ['region', 'district', 'city'] as const) {
            for (const entity of this.deps.index.getByType(type)) {
                if (exclude && entity.name === exclude) continue;
                const d = (entity.x - position.x) ** 2 + (entity.z - position.z) ** 2;
                if (d < bestD) { bestD = d; best = entity; }
            }
        }
        return best;
    }

    private noMirror(): string {
        return "I can't read your units right now — the client mirror hasn't answered. " +
               'Ask again in a moment.';
    }
}

// ───────────────────────── the live census cache ─────────────────────────

/**
 * How stale a snapshot may be before it stops counting as an answer.
 *
 * The console refreshes before every sentence, so in normal play the snapshot is
 * milliseconds old. This bound only matters when the refresh FAILS (worker gone,
 * session torn down): the last good snapshot keeps answering for a few seconds
 * so a single dropped round-trip doesn't turn "you have 12 tanks" into "I can't
 * see your units", and then it stops — because an answer from a mirror that
 * stopped updating is worse than no answer.
 */
export const CENSUS_STALE_MS = 5000;

export class CensusCache implements CensusPort {
    private last: Census | null = null;
    private fetchedAt = 0;

    constructor(
        private readonly fetchCensus: () => Promise<Census | null>,
        private readonly now: () => number = () => Date.now(),
    ) {}

    /** Pull a fresh snapshot. Never throws: a failed refresh leaves the previous
     *  snapshot in place until it goes stale (see `CENSUS_STALE_MS`). */
    async refresh(): Promise<void> {
        try {
            const census = await this.fetchCensus();
            if (census) {
                this.last = census;
                this.fetchedAt = this.now();
            }
        } catch (e) {
            // Audited M5 (§7 "no silent drops"): a warn, not a transcript line.
            // A failed refresh is not itself an answer to anything — the player
            // sees the consequence instead, and the consequence is honest by
            // construction: the previous snapshot serves until `CENSUS_STALE_MS`
            // and then `snapshot()` returns null, at which point every query
            // refuses with "I can't see your units" rather than answering zero.
            // Printing "census refresh failed" into the transcript would be
            // telling the player about our plumbing in the middle of their game.
            console.warn('[query-engine] census refresh failed:', e);
        }
    }

    snapshot(): Census | null {
        if (!this.last) return null;
        if (this.now() - this.fetchedAt > CENSUS_STALE_MS) return null;
        return this.last;
    }
}

/** The session's cache, installed by `main.ts` (which owns the worker call
 *  channel) and read by the command console. Same holder pattern, and the same
 *  reason, as `cameraPortHolder`. */
class CensusCacheHolder {
    private cache: CensusCache | null = null;

    install(cache: CensusCache): CensusCache {
        this.cache = cache;
        return cache;
    }

    get current(): CensusCache | null {
        return this.cache;
    }

    clear(): void {
        this.cache = null;
    }
}

export const censusCacheHolder = new CensusCacheHolder();

// ───────────────────────────── free helpers ─────────────────────────────

function centroid(units: readonly CensusUnit[]): { x: number; z: number } {
    let x = 0, z = 0;
    for (const u of units) { x += u.x; z += u.z; }
    return { x: x / units.length, z: z / units.length };
}

/** "the enemy tanks" → "tanks": the side words are addressed by the caller, and
 *  leaving them in would stop the vocabulary matching a phrase it knows. */
function stripSideWords(phrase: string): string {
    return phrase
        .replace(/\b(?:the|our|their|my|his|her|its|all)\b/gi, ' ')
        .replace(/\b(?:enemy|enemies|hostile|hostiles|friendly|allied|ally)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** "tanks" + scale 3 → "heavy tanks". The scale words are `_builder.lua`'s
 *  SCALE_WORDS, which the vocabulary's own scale phrases are built from.
 *  Exported so the HUD's summary affordance (focus-hud.ts) names a force with
 *  the same words a sentence may use for it, rather than carrying a third copy
 *  of this table. */
export const SCALE_WORDS: Record<NLScale, string> = { 1: 'light', 2: 'line', 3: 'heavy', 4: 'super-heavy' };

function describeClassPhrase(label: string, scale?: NLScale): string {
    if (!scale) return label;
    // A scale PHRASE ("heavy tanks") already carries the word, and an envelope
    // may legitimately send both it and the matching `scale` — "heavy heavy
    // tanks" would be the tell that this line was assembled, not written.
    const word = SCALE_WORDS[scale];
    return label.toLowerCase().includes(word) ? label : `${word} ${label}`;
}

function numeric(value: number | string | undefined): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
