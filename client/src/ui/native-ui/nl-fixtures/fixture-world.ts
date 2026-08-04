/**
 * nl-fixtures/fixture-world.ts — the world the golden fixtures are resolved against
 * (PLAN-metalstorm-command-language.md §8, milestone M1)
 *
 * A fixture is `{ utterance, context, expected: NLResponse }`. `expected` is
 * what a correct model emits; `context` names the board it was said on. This
 * module turns a named context into the live objects the resolver reads — a
 * `NamedEntityIndex`, an org-group list, a `unitClass` lookup — so all three
 * fixture suites (envelope / executor / resolver) reason about the same world.
 *
 * The fixture `context` is a superset of the §2 wire payload the LLM will
 * actually receive. The payload is names-only by design; a fixture also carries
 * region keys, group ids, sizes and coordinates, because those are what the
 * CLIENT holds and what resolution has to produce. Nothing in `expected` may
 * reference them — that is the property the suites check by construction: every
 * `expected` envelope is name-shaped, and the ids only ever appear on the
 * resolved side.
 */

import {
    NamedEntityIndex, parseLandmarksFromRulesParams, type EntityType, type NamedEntity,
} from '../named-entity-index.js';
import type { OrgGroupSummary } from '../ui-store.js';
import type { ClassVocabulary } from '../class-vocabulary.js';
import { NLResolver, type ResolverDeps } from '../nl-resolver.js';
import type { NLResponse } from '../nl-envelope.js';

// ─────────────────────────── fixture shapes ───────────────────────────

/** A named place. `k` is the region KEY (`region_<k>_name`'s `<k>`) — what the
 *  guidance store paints and what a when-gate references; `n` is what a player
 *  says. Keeping them different in every fixture is deliberate: a resolver that
 *  quietly used the display name as the key would pass with them equal. */
export interface FixturePlace {
    n: string;
    t: Extract<EntityType, 'region' | 'district' | 'city' | 'landmark' | 'enemy-force'>;
    k?: string;
    x: number;
    z: number;
}

export interface FixtureObjective {
    n: string;
    id: number;
    x: number;
    z: number;
}

/** One own-team org group. `cls`/`scale` describe what its members ARE — the
 *  world builder synthesizes member unit ids carrying that `ms_class`/`ms_scale`,
 *  so the resolver's dominant-class logic runs for real rather than being handed
 *  a pre-computed answer. `attach` adds a minority of another class, which is
 *  what makes "modal, not first-member" testable. */
export interface FixtureGroup {
    n: string;
    id: number;
    cls: string;
    scale?: number;
    size: number;
    /** No active directive. Absent ⇒ idle (the common case). */
    busy?: boolean;
    echelon?: OrgGroupSummary['echelon'];
    x?: number;
    z?: number;
    attach?: { cls: string; scale?: number; n: number };
}

export interface FixtureContext {
    map?: { name: string };
    places?: FixturePlace[];
    objectives?: FixtureObjective[];
    groups?: FixtureGroup[];
    /** The group the player has selected, for a `selection` subject. */
    selection?: { groupId: number };
    /** Omit the `unitClass` port, to exercise the honest "I can't tell which
     *  squads are tanks yet" refusal that the live client hits today. */
    noUnitClass?: boolean;
    /** Omit the `groupPosition` port, so nearest-to-target is skipped. */
    noGroupPosition?: boolean;
}

/** Test-side expectations that go beyond the envelope itself. The required trio
 *  is `{utterance, context, expected}`; this is what the EXECUTOR should do with
 *  `expected`, which no amount of schema-checking can imply. */
export interface FixtureExpect {
    /** `type` (and, for directives, `groupId`) of each `sendCommand` call, in
     *  order. An empty array asserts nothing was sent. */
    sends?: Array<{ type: string; groupId?: number; wire?: string }>;
    /** The executor must ask rather than act. */
    clarifies?: boolean;
    /** How many refusal lines the run produced. */
    refusals?: number;
    /** Substrings that must appear somewhere in the printed lines. */
    saysLike?: string[];
}

export interface NLFixture {
    name: string;
    utterance: string;
    /** Key into `contexts.json`. */
    context: string;
    expected: NLResponse;
    expect?: FixtureExpect;
    /** Why this fixture exists, when that isn't obvious from the utterance. */
    note?: string;
}

export interface FixtureFile {
    _comment?: string;
    fixtures: NLFixture[];
}

// ─────────────────────────── the world ───────────────────────────

export interface FixtureWorld {
    index: NamedEntityIndex;
    groups: OrgGroupSummary[];
    resolver: NLResolver;
    deps: ResolverDeps;
}

function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Member unit ids for a fixture group — `<groupId>*1000 + n`, so a unit id
 *  identifies its group on sight when a test needs to read one. */
function memberIds(group: FixtureGroup): number[] {
    const total = group.size + (group.attach?.n ?? 0);
    return Array.from({ length: total }, (_, i) => group.id * 1000 + i);
}

export function buildFixtureWorld(context: FixtureContext, vocabulary: ClassVocabulary): FixtureWorld {
    const entities: NamedEntity[] = [];

    // Landmarks take the long way round on purpose. Every other place in a
    // fixture is a hand-built `NamedEntity`, which is fine because its producer
    // is landed and covered elsewhere; landmarks have NO publisher yet (that is
    // the scenario-gen lane's), so a hand-built one would prove only that the
    // fixture builder works. Instead the fixture synthesizes the
    // `landmark_<key>_x/_z/_name` rulesParams a publisher would emit and runs
    // them through the REAL parser — so "escort the grain silo" is evidence
    // about the wire shape the day something starts publishing it.
    const landmarkParams = new Map<string, number | string>();
    for (const place of context.places ?? []) {
        if (place.t === 'landmark') {
            const key = place.k ?? slug(place.n);
            landmarkParams.set(`landmark_${key}_x`, place.x);
            landmarkParams.set(`landmark_${key}_z`, place.z);
            landmarkParams.set(`landmark_${key}_name`, place.n);
            continue;
        }
        entities.push({ id: place.k ?? slug(place.n), type: place.t, name: place.n, x: place.x, z: place.z });
    }
    entities.push(...parseLandmarksFromRulesParams(landmarkParams));
    for (const objective of context.objectives ?? []) {
        entities.push({ id: objective.id, type: 'objective', name: objective.n, x: objective.x, z: objective.z });
    }

    const groups: OrgGroupSummary[] = (context.groups ?? []).map((g) => ({
        groupId: g.id,
        echelon: g.echelon ?? 'Squad',
        ownerTeam: 0,
        parentId: 0,
        name: g.n,
        memberIds: memberIds(g),
        // The store's own "0 = none assigned" convention IS the idle test (§5
        // "no active directive"); a fixture says `busy: true` and gets an id.
        currentDirectiveId: g.busy ? 100 + g.id : 0,
        postureJson: '',
        baseCostSum: g.size * 10,
    }));

    // Groups go in the index as SUBJECTS with x/z 0, exactly as the live
    // producer stores them (entity-index-producer.ts: `gp:orgGroups` carries no
    // centroid). Group positions come from the separate `groupPosition` port —
    // if a fixture could rank by the index's zeroes it would be testing a bug.
    for (const g of context.groups ?? []) {
        const type: EntityType = g.echelon === 'Platoon' ? 'platoon' : g.echelon === 'Army' ? 'army' : 'group';
        entities.push({ id: g.id, type, name: g.n, x: 0, z: 0 });
    }

    const index = new NamedEntityIndex();
    index.replaceAll(entities);

    // unit id → ms_class/ms_scale, built from the same synthesized rosters.
    const classByUnit = new Map<number, { className: string; scale?: number }>();
    for (const g of context.groups ?? []) {
        // A fixture whose "attached" minority outnumbers its stated class would
        // be asserting a dominant class the resolver correctly disagrees with —
        // catch the fixture bug here rather than debugging a mystery failure.
        if ((g.attach?.n ?? 0) >= g.size) {
            throw new Error(`fixture group "${g.n}": attached members are not a minority`);
        }
        memberIds(g).forEach((unitId, i) => {
            classByUnit.set(unitId, i < g.size
                ? { className: g.cls, scale: g.scale }
                : { className: g.attach!.cls, scale: g.attach!.scale });
        });
    }

    const positionByGroup = new Map<number, { x: number; z: number }>();
    for (const g of context.groups ?? []) {
        if (typeof g.x === 'number' && typeof g.z === 'number') positionByGroup.set(g.id, { x: g.x, z: g.z });
    }

    const deps: ResolverDeps = {
        index,
        vocabulary,
        groups,
        selectionGroupId: context.selection?.groupId ?? null,
        ...(context.noUnitClass ? {} : { unitClass: (unitId: number) => classByUnit.get(unitId) }),
        ...(context.noGroupPosition ? {} : { groupPosition: (groupId: number) => positionByGroup.get(groupId) }),
    };

    return { index, groups, deps, resolver: new NLResolver(deps) };
}
