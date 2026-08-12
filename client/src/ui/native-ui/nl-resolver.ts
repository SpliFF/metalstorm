/**
 * nl-resolver.ts — names → ids, deterministically and LLM-free
 * (PLAN-metalstorm-command-language.md §5, milestone M1)
 *
 * Design pillar 4: the LLM emits NAMES; this file is the only thing that turns
 * one into something the sim can act on. Nothing here calls out to a model,
 * makes a network request, or reads the DOM — given the same index and the same
 * envelope it produces the same answer every time, which is what makes it
 * testable and what makes a wrong order reproducible instead of mysterious.
 *
 * THE RULE THAT MATTERS (§5, and the one unforgivable failure): never guess
 * between armies. A place resolved slightly wrong sends a squad to the wrong
 * field; a SUBJECT resolved wrong sends the wrong squad — possibly the one
 * holding the line. So the two resolve under different strictness:
 *
 *   - places (regions/objectives/landmarks): exact wins; otherwise the best
 *     fuzzy hit above threshold wins IF it beats the runner-up outright; a tie
 *     asks.
 *   - forces (groups/platoons/armies): exact wins; otherwise a fuzzy hit wins
 *     ONLY if it is the sole candidate above threshold. Two plausible squads is
 *     always a question, even when one scores higher — "Chimera" beating
 *     "Chimera Reserve" on points is not evidence about which one the player
 *     meant.
 *
 * A clarification is synthesized HERE, client-side: no second LLM call, no
 * round-trip, and therefore no cost or latency for the most common failure. A
 * refusal is likewise a local decision — "no such place" needs no model.
 */

import {
    PRIORITY_BANDS, getPriorityBand, TARGET_SHAPES_BY_VERB,
    type CommandVerb, type CommandTarget, type CommandSubject,
    type WhenCondition, type TargetShape,
} from './compile-table.js';
import type { NamedEntity, EntityType } from './named-entity-index.js';
import type { OrgGroupSummary } from './ui-store.js';
import type { ClassVocabulary, RoleMatch } from './class-vocabulary.js';
import type {
    NLCommandIntent, NLGuidance, NLPriority, NLSubject, NLTarget, NLWhen,
} from './nl-envelope.js';
import type { ResolvedGuidance } from './guidance-wire.js';

/**
 * Minimum relevance for a fuzzy hit to count at all — the substring tier of
 * `NamedEntityIndex.searchScored` (100). The any-word-prefix tier (50) is
 * deliberately BELOW threshold: "s" prefix-matching the second word of "Slag
 * Forge" is not a player naming Slag Forge, and acting on it is how a
 * one-letter typo becomes an assault on the wrong region.
 */
export const FUZZY_SCORE_THRESHOLD = 100;

/** Radius for an `area-around` target that names none (elmos). Roughly a
 *  region's worth of ground — the same order of magnitude as the composer's
 *  default circle. */
export const DEFAULT_AREA_RADIUS = 512;

/** Where a player can be told to act. */
const PLACE_TYPES: EntityType[] = ['region', 'district', 'city', 'objective', 'landmark', 'enemy-force'];
/** Regions proper — the only things the guidance store can paint. */
const REGION_TYPES: EntityType[] = ['region', 'district', 'city'];
/** Who can be ordered. */
const FORCE_TYPES: EntityType[] = ['group', 'platoon', 'army'];

export type Resolution<T> =
    | { kind: 'ok'; value: T }
    | { kind: 'clarify'; question: string; options?: string[] }
    | { kind: 'refuse'; reason: string };

const ok = <T>(value: T): Resolution<T> => ({ kind: 'ok', value });
const refuse = <T>(reason: string): Resolution<T> => ({ kind: 'refuse', reason });
const clarify = <T>(question: string, options?: string[]): Resolution<T> =>
    ({ kind: 'clarify', question, ...(options ? { options } : {}) });

/** The slice of `NamedEntityIndex` the resolver reads. */
export interface ResolverIndex {
    searchScored(
        query: string, typeFilter?: EntityType | EntityType[], limit?: number,
    ): Array<{ entity: NamedEntity; score: number }>;
    getAll(): NamedEntity[];
}

export interface ResolverDeps {
    index: ResolverIndex;
    vocabulary: ClassVocabulary;
    /** Own-team org groups (`uiStore.getOrgGroups()`). The class-count candidate
     *  pool — and the reason a class-count order can never reach another team's
     *  squads: they are not in this list. */
    groups: readonly OrgGroupSummary[];
    /**
     * `ms_class`/`ms_scale` for one unit id, from the defs' `customParams`.
     *
     * OPTIONAL, and absent on the client today: the widget context exposes the
     * ui-store but no defs mirror, and the LOS-honest defs join lands with the
     * query engine in M3. Without it a class-count subject cannot be resolved at
     * all — there is no way to know which squads are the tank squads — so it is
     * REFUSED with that reason rather than filled with the first N groups.
     * Guessing here is precisely the wrong-army failure.
     */
    unitClass?: (unitId: number) => { className?: string; scale?: number } | undefined;
    /**
     * Group centroid, for the nearest-to-target ranking tier. Also absent
     * today (`gp:orgGroups` carries member ids but no aggregate position — see
     * `entity-index-producer.ts`), in which case that tier is simply skipped
     * and ranking falls through to largest-first. Skipping a tie-break degrades
     * the CHOICE between valid candidates; it never widens the candidate set.
     */
    groupPosition?: (groupId: number) => { x: number; z: number } | undefined;
    /** The group the player has selected, for a `selection` subject. */
    selectionGroupId?: number | null;
}

/** What a class-count subject resolved to: the groups to fan out over. */
export interface ClassCountResolution {
    groups: OrgGroupSummary[];
    /** Display phrase for the echo ("2 tank squads"). */
    label: string;
}

export class NLResolver {
    constructor(private readonly deps: ResolverDeps) {}

    // ───────────────────────── entities ─────────────────────────

    /**
     * Resolve one name against the index.
     *
     * `strict` is the never-guess-between-armies switch (see the file header):
     * with it, ANY second candidate above threshold produces a question.
     */
    resolveEntity(
        name: string,
        opts: { types?: EntityType[]; strict?: boolean; noun?: string } = {},
    ): Resolution<NamedEntity> {
        const noun = opts.noun ?? 'place';
        const query = name.trim();
        if (!query) return refuse(`I need a ${noun} name.`);

        const types = opts.types;
        const lower = query.toLowerCase();

        // 1. Exact (case-insensitive) wins outright.
        const exact = this.deps.index.getAll().filter((e) =>
            e.name.toLowerCase() === lower && (!types || types.includes(e.type)));
        if (exact.length === 1) return ok(exact[0]);
        if (exact.length > 1) {
            // Two things genuinely share a name. Nothing to score between them,
            // so the player has to say which.
            return clarify(
                `More than one ${noun} is called "${query}" — which one?`,
                exact.map(describeEntity),
            );
        }

        // 2. Fuzzy, above threshold.
        const hits = this.deps.index
            .searchScored(query, types, 8)
            .filter((h) => h.score >= FUZZY_SCORE_THRESHOLD);

        if (hits.length === 0) {
            return refuse(`I don't know a ${noun} called "${query}".`);
        }
        if (hits.length === 1) return ok(hits[0].entity);

        const dominant = opts.strict
            ? false                                   // forces: sole candidate or ask
            : hits[0].score > hits[1].score;          // places: outright winner is enough
        if (dominant) return ok(hits[0].entity);

        return clarify(
            `Which ${noun} did you mean — ${joinOptions(hits.slice(0, 4).map((h) => h.entity.name))}?`,
            hits.slice(0, 4).map(describeEntity_),
        );
    }

    /** A region key the guidance store can paint (`region_<key>_*`'s `<key>`). */
    resolveRegionKey(name: string): Resolution<string> {
        const found = this.resolveEntity(name, { types: REGION_TYPES, noun: 'region' });
        if (found.kind !== 'ok') return found as Resolution<string>;
        return ok(String(found.value.id));
    }

    /** A numeric org-group id. Strict — see the file header. */
    resolveGroupId(name: string): Resolution<number> {
        const found = this.resolveEntity(name, { types: FORCE_TYPES, strict: true, noun: 'group' });
        if (found.kind !== 'ok') return found as Resolution<number>;
        const id = Number(found.value.id);
        if (!Number.isFinite(id) || id <= 0) {
            return refuse(`"${found.value.name}" isn't a group I can give orders to.`);
        }
        return ok(id);
    }

    /** A numeric objective id. */
    resolveObjectiveId(name: string): Resolution<number> {
        const found = this.resolveEntity(name, { types: ['objective'], noun: 'objective' });
        if (found.kind !== 'ok') return found as Resolution<number>;
        const id = Number(found.value.id);
        if (!Number.isInteger(id)) return refuse(`"${found.value.name}" has no objective id.`);
        return ok(id);
    }

    // ───────────────────────── subjects ─────────────────────────

    /**
     * Resolve a subject that maps to exactly ONE `CommandSubject`.
     * `class-count` is not handled here — it fans out into several directives,
     * so the executor asks for `resolveClassCount` explicitly.
     */
    resolveSingleSubject(subject: NLSubject): Resolution<CommandSubject> {
        switch (subject.type) {
            case 'ai':
                return ok({ type: 'ai' });

            case 'idle-filter': {
                const single = this.toSingleClass(subject.filterClass);
                if (!single) {
                    return refuse(
                        `"${subject.filterClass}" spans more than one unit class, and an idle-filter ` +
                        `order can only carry one. Name a single class, or name a group.`);
                }
                return ok({ type: 'idle-filter', filterClass: single.className });
            }

            case 'selection': {
                const selected = this.deps.selectionGroupId;
                if (selected == null) {
                    return refuse('Nothing is selected — name a group, or select one first.');
                }
                return ok({ type: 'group', groupId: selected });
            }

            // groupId 0 = the compile table's condition-scoped subject: the sim
            // takes whatever idles. See NLSubject's doc for why this case exists.
            case 'any':
                return ok({ type: 'group', groupId: 0 });

            case 'entity-ref': {
                const groupId = this.resolveGroupId(subject.name);
                if (groupId.kind !== 'ok') return groupId as Resolution<CommandSubject>;
                return ok({ type: 'group', groupId: groupId.value });
            }

            case 'class-count':
                return refuse('internal: class-count subjects resolve through resolveClassCount');
        }
    }

    /**
     * "2 tank squads" → the actual squads (§5).
     *
     * Candidates are own-team org groups whose DOMINANT member `ms_class`
     * matches the phrase (a class, or a role spanning classes). Ranking, in
     * order: idle first (no active directive — a squad already tasked is a worse
     * pick than one standing around), then nearest to the target, then largest,
     * then group id so the result is stable across calls.
     *
     * Fewer candidates than asked for → clarify (the plan's "I only have one
     * tank squad — send Chimera Squad alone?"). None at all → refuse: forming a
     * group from loose units costs authority and touches AI locks, so it is
     * never done implicitly (§5).
     */
    resolveClassCount(
        subject: Extract<NLSubject, { type: 'class-count' }>,
        targetPos?: { x: number; z: number },
    ): Resolution<ClassCountResolution> {
        const phrase = subject.class;
        const match = this.deps.vocabulary.lookup(phrase);
        if (!match) {
            return refuse(`"${phrase}" isn't a unit class I know.`);
        }
        if (!this.deps.unitClass) {
            // Honest gap, not a guess: see ResolverDeps.unitClass.
            return refuse(
                `I can't tell which of your squads are ${phrase} yet — the unit-class lookup ` +
                `isn't wired up on the client. Name the squad instead.`);
        }

        const clauses = this.classClauses(phrase, subject.scale);
        if (!clauses) return refuse(`"${phrase}" isn't a unit class I know.`);

        const label = subject.count === 1
            ? `1 ${singularish(match.label)}`
            : `${subject.count} ${match.label}`;

        const candidates = this.deps.groups.filter((g) => {
            const dominant = this.dominantClass(g);
            return dominant != null && clausesMatch(clauses, dominant);
        });

        // "tanks" → "tank squads": the vocabulary's label is already plural, so
        // it is singularised before "squad(s)" is attached. Cosmetic, but this
        // string is read out loud (M6) and "no tanks squads" is not a sentence.
        const unit = singularish(match.label);

        if (candidates.length === 0) {
            return refuse(
                `You have no ${unit} squads under command. ` +
                `Forming one from loose units isn't something I'll do on my own.`);
        }

        const ranked = this.rankGroups(candidates, targetPos);

        if (candidates.length < subject.count) {
            const names = ranked.map((g) => groupName(g));
            return clarify(
                `You only have ${candidates.length} ${unit} ` +
                `${candidates.length === 1 ? 'squad' : 'squads'}, not ${subject.count} — ` +
                `send ${joinOptions(names)}?`,
                [...names, 'cancel'],
            );
        }

        return ok({ groups: ranked.slice(0, subject.count), label });
    }

    // ───────────────────────── targets ─────────────────────────

    /**
     * Resolve a target into the shape the VERB actually compiles against
     * (`TARGET_SHAPES_BY_VERB` — the compile table stays the authority on
     * verb:shape, this only picks among what it already allows).
     *
     * Preference order is entity → area → point: an entity target keeps the
     * name attached (so the echo and the AI-guidance region key survive), and a
     * bare point is the least informative form.
     */
    resolveTarget(verb: CommandVerb, target: NLTarget): Resolution<CommandTarget> {
        const accepted = TARGET_SHAPES_BY_VERB[verb] ?? [];

        // Route verbs can't be expressed by this envelope at all (there is no
        // multi-point target type — the map arm is where routes are drawn).
        if (accepted.length === 1 && accepted[0] === 'route') {
            return refuse(
                `"${verb}" needs a route, which a sentence can't draw yet — ` +
                `use the command composer's map arm.`);
        }

        switch (target.type) {
            case 'entity-ref': {
                const found = this.resolveEntity(target.name, { types: PLACE_TYPES });
                if (found.kind !== 'ok') return found as Resolution<CommandTarget>;
                const shape = pickShape(accepted, ['entity', 'area', 'point']);
                if (!shape) return refuse(`"${verb}" can't be aimed at a place.`);
                return ok({ shape, entity: found.value });
            }

            case 'area-around': {
                const found = this.resolveEntity(target.name, { types: PLACE_TYPES });
                if (found.kind !== 'ok') return found as Resolution<CommandTarget>;
                if (!accepted.includes('area')) {
                    // The verb takes no circle; fall back to the place itself
                    // rather than refusing an order that is otherwise fine.
                    const shape = pickShape(accepted, ['entity', 'point']);
                    if (!shape) return refuse(`"${verb}" can't be aimed at an area.`);
                    return ok({ shape, entity: found.value });
                }
                return ok({
                    shape: 'area',
                    area: {
                        x: found.value.x,
                        z: found.value.z,
                        radius: target.radius ?? DEFAULT_AREA_RADIUS,
                    },
                    entity: found.value,
                });
            }

            case 'point': {
                const shape = pickShape(accepted, ['point', 'area']);
                if (!shape) return refuse(`"${verb}" can't be aimed at a bare coordinate.`);
                if (shape === 'area') {
                    return ok({
                        shape: 'area',
                        area: { x: target.x, z: target.z, radius: DEFAULT_AREA_RADIUS },
                    });
                }
                return ok({ shape: 'point', point: { x: target.x, z: target.z } });
            }
        }
    }

    /** Symbolic when-gate → the compile table's id-keyed `WhenCondition`. */
    resolveWhen(when: NLWhen): Resolution<WhenCondition | undefined> {
        switch (when.type) {
            case 'now':
                return ok(undefined);            // no gate is the honest encoding of "now"
            case 'under-attack':
                return ok({ type: 'under-attack' });
            case 'region-contested': {
                const key = this.resolveRegionKey(when.regionRef);
                if (key.kind !== 'ok') return key as Resolution<WhenCondition | undefined>;
                return ok({ type: 'region-contested', regionId: key.value });
            }
            case 'objective-complete': {
                const id = this.resolveObjectiveId(when.objectiveRef);
                if (id.kind !== 'ok') return id as Resolution<WhenCondition | undefined>;
                return ok({ type: 'objective-complete', objectiveId: id.value });
            }
            case 'strength-below':
                return ok({ type: 'strength-below', percent: when.percent });
        }
    }

    /** `NLPriority` → the composer's slider number (`PRIORITY_BANDS`). */
    resolvePriority(priority: NLPriority | undefined): number {
        return priority ? PRIORITY_BANDS[priority] : PRIORITY_BANDS.normal;
    }

    // ───────────────────────── guidance ─────────────────────────

    /** Turn every NAME in a guidance op into the id its gadget handler reads. */
    resolveGuidance(g: NLGuidance): Resolution<ResolvedGuidance> {
        const base: ResolvedGuidance = { op: g.op, value: g.value };

        switch (g.op) {
            case 'stance':
            case 'roe':
                return ok(base);

            case 'paint': {
                const key = this.resolveRegionKey(g.regionRef!);
                if (key.kind !== 'ok') return key as Resolution<ResolvedGuidance>;
                return ok({ ...base, regionKey: key.value });
            }

            case 'lock': {
                const id = this.resolveGroupId(g.groupRef!);
                if (id.kind !== 'ok') return id as Resolution<ResolvedGuidance>;
                return ok({ ...base, groupId: id.value });
            }

            case 'delegate': {
                const id = this.resolveObjectiveId(g.objectiveRef!);
                if (id.kind !== 'ok') return id as Resolution<ResolvedGuidance>;
                return ok({ ...base, objectiveId: id.value });
            }

            case 'fund':
                return ok({ ...base, amount: g.amount, rateCap: g.rateCap });

            case 'veto': {
                // Goal ids come from the AI's own proposals, so this ref is a
                // number in string clothing — the only such ref in the envelope
                // (see NLGuidance.goalRef).
                const id = Number(g.goalRef);
                if (!Number.isInteger(id)) {
                    return refuse(`"${g.goalRef}" isn't an AI goal id I can veto.`);
                }
                return ok({ ...base, goalId: id });
            }
        }
    }

    // ───────────────────────── internals ─────────────────────────

    /** A class phrase reduced to one `ms_class`, or null for a role that spans
     *  several (the compile table's `filterClass` has room for exactly one). */
    private toSingleClass(phrase: string): { className: string; scale: number | null } | null {
        const match = this.deps.vocabulary.lookup(phrase);
        if (!match) return null;
        if (match.kind === 'class') return { className: match.className, scale: match.scale };
        const classes = new Set(match.matches.map((m) => m.class));
        if (classes.size !== 1) return null;
        const only = match.matches[0];
        return {
            className: only.class,
            scale: match.matches.length === 1 && typeof only.scale === 'number' ? only.scale : null,
        };
    }

    /** The class phrase as a list of OR-ed `RoleMatch` clauses, so a class and a
     *  role are matched by the same code. */
    private classClauses(phrase: string, pinnedScale?: number): RoleMatch[] | null {
        return classClausesFor(this.deps.vocabulary, phrase, pinnedScale);
    }

    /**
     * The `ms_class`/`ms_scale` most of a group's members share.
     *
     * Modal, not first-member: a tank squad with two attached engineers is still
     * a tank squad, and picking by member[0] would make the answer depend on
     * roster order. Ties break by class name so the answer is stable.
     */
    private dominantClass(group: OrgGroupSummary): { className: string; scale: number | null } | null {
        const unitClass = this.deps.unitClass;
        if (!unitClass) return null;

        const counts = new Map<string, { n: number; scales: Map<number, number> }>();
        for (const unitId of group.memberIds) {
            const info = unitClass(unitId);
            if (!info?.className) continue;
            let entry = counts.get(info.className);
            if (!entry) { entry = { n: 0, scales: new Map() }; counts.set(info.className, entry); }
            entry.n++;
            if (typeof info.scale === 'number') {
                entry.scales.set(info.scale, (entry.scales.get(info.scale) ?? 0) + 1);
            }
        }
        if (counts.size === 0) return null;

        let best: { className: string; n: number; scales: Map<number, number> } | null = null;
        for (const [className, entry] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            if (!best || entry.n > best.n) best = { className, ...entry };
        }
        if (!best) return null;

        let scale: number | null = null;
        let bestScaleCount = 0;
        for (const [s, n] of [...best.scales.entries()].sort((a, b) => a[0] - b[0])) {
            if (n > bestScaleCount) { bestScaleCount = n; scale = s; }
        }
        return { className: best.className, scale };
    }

    /** Idle first, then nearest to the target, then largest, then id (§5). */
    private rankGroups(
        groups: readonly OrgGroupSummary[], targetPos?: { x: number; z: number },
    ): OrgGroupSummary[] {
        const position = this.deps.groupPosition;
        const distance = (g: OrgGroupSummary): number => {
            if (!position || !targetPos) return 0;   // tier unavailable — skip, don't fake
            const p = position(g.groupId);
            if (!p) return Number.POSITIVE_INFINITY; // a group with no known position ranks last
            return (p.x - targetPos.x) ** 2 + (p.z - targetPos.z) ** 2;
        };

        return [...groups].sort((a, b) => {
            const idleA = a.currentDirectiveId === 0 ? 0 : 1;
            const idleB = b.currentDirectiveId === 0 ? 0 : 1;
            if (idleA !== idleB) return idleA - idleB;
            const dA = distance(a);
            const dB = distance(b);
            if (dA !== dB) return dA - dB;
            if (a.memberIds.length !== b.memberIds.length) return b.memberIds.length - a.memberIds.length;
            return a.groupId - b.groupId;
        });
    }
}

// ───────────────────────────── helpers ─────────────────────────────

/**
 * A class-or-role phrase as a list of OR-ed `RoleMatch` clauses, or null when
 * the vocabulary doesn't know the phrase.
 *
 * Exported (with `matchesClassClauses`) because the query engine has to answer
 * "how many tanks" against the same taxonomy the ORDER path selects squads with.
 * Two copies of this reduction would let "heavy tanks" mean one thing when you
 * count them and another when you order them — which is precisely the drift the
 * shipped vocabulary was introduced to end.
 */
export function classClausesFor(
    vocabulary: ClassVocabulary, phrase: string, pinnedScale?: number,
): RoleMatch[] | null {
    const match = vocabulary.lookup(phrase);
    if (!match) return null;
    const clauses: RoleMatch[] = match.kind === 'class'
        ? [{ class: match.className, ...(match.scale != null ? { scale: match.scale } : {}) }]
        : match.matches.map((m) => ({ ...m }));
    // An explicit `scale` narrows every clause: "2 heavy tank squads" is tanks
    // AND scale 3, not tanks OR scale 3.
    if (pinnedScale != null) {
        return clauses.map((c) => ({ ...c, scale: pinnedScale, scaleMin: undefined, scaleMax: undefined }));
    }
    return clauses;
}

/** Does a unit's class/scale satisfy any clause? See `clausesMatch`. */
export function matchesClassClauses(
    clauses: RoleMatch[], unit: { className: string; scale: number | null },
): boolean {
    return clausesMatch(clauses, unit);
}

/** Does the dominant class satisfy any clause? Fields within a clause AND. */
function clausesMatch(clauses: RoleMatch[], dominant: { className: string; scale: number | null }): boolean {
    return clauses.some((c) => {
        if (c.class !== dominant.className) return false;
        if (c.scale != null) return dominant.scale === c.scale;
        if (c.scaleMin != null && (dominant.scale == null || dominant.scale < c.scaleMin)) return false;
        if (c.scaleMax != null && (dominant.scale == null || dominant.scale > c.scaleMax)) return false;
        return true;
    });
}

function pickShape(accepted: readonly TargetShape[], preference: TargetShape[]): TargetShape | null {
    for (const shape of preference) if (accepted.includes(shape)) return shape;
    return null;
}

function groupName(group: OrgGroupSummary): string {
    return group.name || `Group ${group.groupId}`;
}

/** "Randtown (city)" — the type disambiguates two same-named places, which is
 *  the entire reason the option list exists. */
function describeEntity(entity: NamedEntity): string {
    return `${entity.name} (${entity.type})`;
}

/** Bare name for a fuzzy option list: the names already differ, so the type
 *  suffix would be noise the player has to read past. */
function describeEntity_(hit: { entity: NamedEntity }): string {
    return hit.entity.name;
}

function joinOptions(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** "tanks" → "tank squad" for a count of one. Crude on purpose: it only has to
 *  read naturally in an echo line, and the class label is data, not grammar. */
function singularish(label: string): string {
    return label.endsWith('s') ? label.slice(0, -1) : label;
}

/** Re-exported so callers echoing a resolved priority don't reach past this
 *  module into the compile table for the band name. */
export { getPriorityBand };
