/**
 * nl-resolver.test.ts — the rules that decide whether a sentence becomes an
 * order, a question, or a refusal
 * (PLAN-metalstorm-command-language.md §5, §8)
 *
 * The resolver is where a wrong answer does real damage: it is the only thing
 * between "Chimera" and a specific squad, and between a typo'd place name and an
 * assault on the wrong region. So the asymmetry it enforces is tested directly:
 *
 *   - a PLACE resolves on outright score dominance
 *   - a FORCE resolves only when it is the sole candidate above threshold
 *
 * and the class-count ranking (idle → nearest → largest → id) is tested tier by
 * tier, including what happens when a tier's data isn't available on the wire.
 */

import { describe, it, expect } from 'vitest';
import { NLResolver, FUZZY_SCORE_THRESHOLD, DEFAULT_AREA_RADIUS } from './nl-resolver.js';
import { buildFixtureWorld } from './nl-fixtures/fixture-world.js';
import { loadContexts, loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

const vocabulary = loadVocabulary();
const contexts = loadContexts();

const world = (key: string) => buildFixtureWorld(contexts[key], vocabulary);
const resolver = (key: string) => world(key).resolver;

describe('entity resolution: places', () => {
    it('an exact match wins outright', () => {
        const found = resolver('basin').resolveEntity('Northgate');
        expect(found).toEqual({ kind: 'ok', value: expect.objectContaining({ name: 'Northgate' }) });
    });

    it('exact match is case-insensitive', () => {
        const found = resolver('basin').resolveEntity('NORTHGATE');
        expect(found.kind).toBe('ok');
    });

    it('an exact match short-circuits an ambiguity it sits inside', () => {
        // "Randtown" is also a prefix of "Randtown East". Ambiguity must not make
        // a precise sentence unusable.
        const found = resolver('ambiguous-places').resolveEntity('Randtown');
        expect(found).toMatchObject({ kind: 'ok', value: { id: 'randtown' } });
    });

    it('a unique fuzzy hit above threshold wins', () => {
        const found = resolver('basin').resolveEntity('Osprey');
        expect(found).toMatchObject({ kind: 'ok', value: { name: 'Osprey Fen' } });
    });

    it('an outright score winner beats the runner-up', () => {
        // "Slag" prefix-matches "Slag Forge" (500) and nothing else above
        // threshold, so there is no contest to resolve.
        expect(resolver('basin').resolveEntity('Slag').kind).toBe('ok');
    });

    it('two comparable hits become a question, not a guess', () => {
        const found = resolver('ambiguous-places').resolveEntity('Rand');
        expect(found.kind).toBe('clarify');
        if (found.kind === 'clarify') {
            expect(found.question).toContain('Which place');
            expect(found.options).toEqual(['Randtown', 'Randtown East']);
        }
    });

    it('zero hits refuse, naming what was not found', () => {
        const found = resolver('basin').resolveEntity('Wolfden');
        expect(found).toEqual({ kind: 'refuse', reason: 'I don\'t know a place called "Wolfden".' });
    });

    it('a below-threshold hit is not a hit', () => {
        // The live index only emits 1000/500/100, all of which clear the
        // threshold — so this rule is tested against a stub that emits a weak
        // score directly. It matters because M3's query engine and any later
        // scorer (token-set, edit distance) will emit weak matches, and the
        // resolver must already refuse them rather than order on them.
        const weak = new NLResolver({
            index: {
                searchScored: () => [{
                    entity: { id: 'x', type: 'region' as const, name: 'Somewhere', x: 0, z: 0 },
                    score: FUZZY_SCORE_THRESHOLD - 1,
                }],
                getAll: () => [],
            },
            vocabulary,
            groups: [],
        });
        expect(weak.resolveEntity('somewhre')).toMatchObject({ kind: 'refuse' });
    });

    it('the index emits only the three tiers the threshold is defined against', () => {
        const scores = new Set(
            ['Northgate', 'North', 'gate', 'Fen', 'Slag Forge']
                .flatMap((q) => world('basin').index.searchScored(q, undefined, 8))
                .map((h) => h.score),
        );
        expect([...scores].sort((a, b) => a - b)).toEqual([100, 500, 1000].filter((s) => scores.has(s)));
        for (const score of scores) expect([100, 500, 1000]).toContain(score);
    });

    it('an empty board refuses every reference', () => {
        expect(resolver('empty').resolveEntity('Northgate').kind).toBe('refuse');
    });

    it('type-filters, so a group is never returned as a place', () => {
        // "Chimera Squad" is in the index, but not as somewhere to go.
        const found = resolver('basin').resolveEntity('Chimera Squad', {
            types: ['region', 'district', 'city', 'objective', 'landmark'],
        });
        expect(found.kind).toBe('refuse');
    });
});

describe('entity resolution: forces (never guess between armies)', () => {
    it('an exact squad name resolves', () => {
        expect(resolver('basin').resolveGroupId('Chimera Squad')).toEqual({ kind: 'ok', value: 1 });
    });

    it('a sole fuzzy candidate resolves', () => {
        expect(resolver('basin').resolveGroupId('Chimera')).toEqual({ kind: 'ok', value: 1 });
    });

    it('TWO candidates ask, even though one would score higher', () => {
        // THE rule. In `ambiguous-forces`, "Chimera" prefix-matches both squads;
        // even if the scores differed, a points win is not evidence about which
        // squad the player meant.
        const found = resolver('ambiguous-forces').resolveGroupId('Chimera');
        expect(found.kind).toBe('clarify');
        if (found.kind === 'clarify') {
            expect(found.options).toEqual(['Chimera Reserve', 'Chimera Squad']);
        }
    });

    it('the strict rule asks even when the runner-up scores strictly lower', () => {
        // Constructed to be unambiguous by SCORE and still ambiguous by meaning:
        // "Chimera Squad" is a whole-name prefix of nothing else, but
        // "Chimera Squad Reserve" contains it as a substring (100) while the exact
        // hit is 1000. A place would take the winner here — a force does not have
        // to, because the exact tier already settled it.
        const custom = buildFixtureWorld({
            groups: [
                { n: 'Chimera Squad', id: 1, cls: 'tanks', size: 4 },
                { n: 'Chimera Squad Reserve', id: 2, cls: 'tanks', size: 4 },
            ],
        }, vocabulary);
        // Exact wins (that tier is checked before any scoring).
        expect(custom.resolver.resolveGroupId('Chimera Squad')).toEqual({ kind: 'ok', value: 1 });
        // A partial that fits both asks.
        expect(custom.resolver.resolveGroupId('Chim').kind).toBe('clarify');
    });

    it('an unknown squad refuses', () => {
        expect(resolver('basin').resolveGroupId('Ghost Squad')).toMatchObject({ kind: 'refuse' });
    });

    it('a place is never resolved as a force', () => {
        expect(resolver('basin').resolveGroupId('Northgate').kind).toBe('refuse');
    });

    it('a platoon resolves like a squad', () => {
        expect(resolver('basin').resolveGroupId('Ironback Platoon')).toEqual({ kind: 'ok', value: 5 });
    });
});

describe('resolveSingleSubject', () => {
    it('selection resolves to the selected group', () => {
        expect(resolver('basin-selected').resolveSingleSubject({ type: 'selection' }))
            .toEqual({ kind: 'ok', value: { type: 'group', groupId: 4 } });
    });

    it('selection with nothing selected refuses rather than widening to team-wide', () => {
        const found = resolver('basin').resolveSingleSubject({ type: 'selection' });
        expect(found).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('Nothing is selected') });
    });

    it("'any' is the compile table's condition-scoped subject", () => {
        expect(resolver('basin').resolveSingleSubject({ type: 'any' }))
            .toEqual({ kind: 'ok', value: { type: 'group', groupId: 0 } });
    });

    it('ai passes straight through', () => {
        expect(resolver('basin').resolveSingleSubject({ type: 'ai' }))
            .toEqual({ kind: 'ok', value: { type: 'ai' } });
    });

    it('an idle-filter canonicalises the spoken phrase to the real ms_class', () => {
        // "statics" is what a player says; `staticdefense` is what the defs call it.
        expect(resolver('basin').resolveSingleSubject({ type: 'idle-filter', filterClass: 'statics' }))
            .toEqual({ kind: 'ok', value: { type: 'idle-filter', filterClass: 'staticdefense' } });
    });

    it('a single-class role reduces to that class', () => {
        expect(resolver('basin').resolveSingleSubject({ type: 'idle-filter', filterClass: 'labour' }))
            .toEqual({ kind: 'ok', value: { type: 'idle-filter', filterClass: 'engineers' } });
    });

    it('a multi-class role refuses — filterClass holds one class', () => {
        const found = resolver('basin').resolveSingleSubject({ type: 'idle-filter', filterClass: 'air defense' });
        expect(found).toMatchObject({
            kind: 'refuse', reason: expect.stringContaining('spans more than one unit class'),
        });
    });
});

describe('class-count: candidates and ranking', () => {
    const target = { x: 1000, z: 1000 };   // Randtown

    it('idle squads outrank busy ones', () => {
        const found = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 3 }, target);
        expect(found.kind).toBe('ok');
        if (found.kind === 'ok') {
            // Basilisk (id 2) is the only busy tank squad and comes last despite
            // sitting closest-but-one to Randtown.
            expect(found.value.groups.map((g) => g.groupId)).toEqual([1, 3, 2]);
        }
    });

    // basin has exactly two idle tank squads, so a count of 2 consumes the idle
    // tier exactly and resolves without a question (see the M5 excess rule). The
    // ORDER of the two is what these pin: nearest-to-target first.
    it('among idle squads, nearest to the target wins', () => {
        const found = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        expect(found.kind).toBe('ok');
        if (found.kind === 'ok') expect(found.value.groups.map((g) => g.groupId)).toEqual([1, 3]);
    });

    it('the nearest tier follows the target, not a fixed order', () => {
        const far = { x: 3000, z: 3000 };   // Slag Forge — Warhound is on top of it
        const found = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, far);
        if (found.kind === 'ok') expect(found.value.groups.map((g) => g.groupId)).toEqual([3, 1]);
        else expect.fail('expected an ok resolution');
    });

    it('more equally-idle squads than the sentence asked for is a question (M5)', () => {
        // THE acceptance case: three idle tank squads, "two tank squads" — the
        // ranking would happily pick two, but which two of your armies drive
        // across the map is not a decision a distance tie-break gets to make.
        const found = resolver('three-idle-tanks')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        if (found.kind !== 'clarify') return expect.fail('expected a question');
        expect(found.pick).toBe(2);
        expect(found.patchable).toBe(true);
        expect(found.options).toEqual([
            'Chimera Squad', 'Basilisk Squad', 'Warhound Squad', 'cancel',
        ]);
        expect(found.question).toContain('which two');
    });

    it('an exactly-consumed idle tier does not ask', () => {
        // The other half of the rule, and the reason it is about availability
        // rather than count: basin has three tank squads but only two idle ones,
        // so "two tank squads" has exactly one answer and goes straight through.
        const found = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        expect(found.kind).toBe('ok');
    });

    it('with no group positions on the wire, largest wins instead', () => {
        const found = resolver('no-positions')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        if (found.kind === 'ok') expect(found.value.groups.map((g) => g.groupId)).toEqual([2, 1]);
        else expect.fail('expected an ok resolution');
    });

    it('a missing tie-break never widens the candidate set', () => {
        const found = resolver('no-positions')
            .resolveClassCount({ type: 'class-count', class: 'fighters', count: 1 }, target);
        expect(found.kind).toBe('refuse');
    });

    it('an explicit scale narrows the candidates', () => {
        const found = resolver('basin')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2, scale: 3 }, target);
        if (found.kind === 'ok') expect(found.value.groups.map((g) => g.groupId)).toEqual([1, 2]);
        else expect.fail('expected an ok resolution');
    });

    it('a scale phrase and an explicit scale pick the same squads', () => {
        const byPhrase = resolver('basin')
            .resolveClassCount({ type: 'class-count', class: 'heavy tanks', count: 2 }, target);
        const byField = resolver('basin')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2, scale: 3 }, target);
        expect(byPhrase.kind === 'ok' && byPhrase.value.groups.map((g) => g.groupId))
            .toEqual(byField.kind === 'ok' && byField.value.groups.map((g) => g.groupId));
    });

    it('the dominant class is modal, not the first member', () => {
        // Warhound is 5 tanks + 2 attached engineers. It must count as a tank
        // squad, and must not count as an engineer squad.
        const tanks = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 3 }, target);
        expect(tanks.kind === 'ok' && tanks.value.groups.map((g) => g.groupId)).toContain(3);
        const engineers = resolver('basin')
            .resolveClassCount({ type: 'class-count', class: 'engineers', count: 1 }, target);
        expect(engineers.kind).toBe('refuse');
    });

    it('a multi-class role matches any of its clauses', () => {
        // "air" = fighters ∪ bombers; Kestrel Flight is fighters.
        const found = resolver('basin').resolveClassCount({ type: 'class-count', class: 'air', count: 1 }, target);
        expect(found.kind === 'ok' && found.value.groups.map((g) => g.groupId)).toEqual([4]);
    });

    it('a role with a scale bound honours it', () => {
        // "heavy armour" = tanks/mechs at scale ≥ 3. Warhound (scale 2) is out.
        const found = resolver('basin')
            .resolveClassCount({ type: 'class-count', class: 'heavy armour', count: 3 }, target);
        expect(found.kind).toBe('clarify');           // only 2 qualify
        if (found.kind === 'clarify') expect(found.question).toContain('not 3');
    });

    it('fewer candidates than asked for asks, offering the ones there are', () => {
        const found = resolver('one-tank-squad')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        expect(found.kind).toBe('clarify');
        if (found.kind === 'clarify') {
            expect(found.question).toContain('only have 1 tank squad, not 2');
            expect(found.options).toEqual(['Chimera Squad', 'cancel']);
        }
    });

    it('no candidates at all refuses — forming a group is never implicit', () => {
        const found = resolver('no-tanks')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        expect(found).toMatchObject({
            kind: 'refuse', reason: expect.stringContaining("isn't something I'll do on my own"),
        });
    });

    it('with no unit-class lookup it refuses, rather than taking the first N groups', () => {
        const found = resolver('no-defs')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 2 }, target);
        expect(found).toMatchObject({
            kind: 'refuse', reason: expect.stringContaining("isn't wired up on the client"),
        });
    });

    it('an unknown class refuses', () => {
        const found = resolver('basin')
            .resolveClassCount({ type: 'class-count', class: 'battlemechs', count: 1 }, target);
        expect(found.kind).toBe('refuse');
    });

    it('ranks identically on repeated calls', () => {
        const once = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 3 }, target);
        const twice = resolver('basin').resolveClassCount({ type: 'class-count', class: 'tanks', count: 3 }, target);
        expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    });

    it('never reaches a group that is not the team\'s own', () => {
        // The candidate pool IS `deps.groups` (uiStore.getOrgGroups() — own team).
        // A group absent from that list is unreachable by construction, which is
        // the structural half of "never order the wrong army".
        const found = resolver('one-tank-squad')
            .resolveClassCount({ type: 'class-count', class: 'tanks', count: 1 }, target);
        expect(found.kind === 'ok' && found.value.groups.every((g) => g.groupId === 1)).toBe(true);
    });
});

describe('targets', () => {
    it('prefers the entity shape, keeping the name attached', () => {
        const found = resolver('basin').resolveTarget('defend', { type: 'entity-ref', name: 'Northgate' });
        expect(found).toMatchObject({ kind: 'ok', value: { shape: 'entity', entity: { name: 'Northgate' } } });
    });

    it('resolves an entity target for withdraw (the table accepts entity since composer-wire widened it)', () => {
        // This used to assert the entity→point downgrade, when the branch's
        // table said withdraw: ['point']. Main's TARGET_SHAPES_BY_VERB gives
        // every point-taking verb an entity or area shape too, so that
        // downgrade is unreachable with real verbs — pickShape's preference
        // order is still covered by the coordinate-fallback cases below.
        const found = resolver('basin').resolveTarget('withdraw', { type: 'entity-ref', name: 'Randtown' });
        expect(found).toMatchObject({ kind: 'ok', value: { shape: 'entity', entity: { name: 'Randtown' } } });
    });

    it('refuses a route verb — a sentence cannot draw a route yet', () => {
        for (const verb of ['patrol', 'screen'] as const) {
            expect(resolver('basin').resolveTarget(verb, { type: 'entity-ref', name: 'Northgate' }))
                .toMatchObject({ kind: 'refuse', reason: expect.stringContaining('needs a route') });
        }
    });

    it('area-around becomes a circle at the place, with a default radius', () => {
        const found = resolver('basin').resolveTarget('defend', { type: 'area-around', name: 'Randtown' });
        expect(found).toMatchObject({
            kind: 'ok', value: { shape: 'area', area: { x: 1000, z: 1000, radius: DEFAULT_AREA_RADIUS } },
        });
    });

    it('area-around honours an explicit radius', () => {
        const found = resolver('basin')
            .resolveTarget('defend', { type: 'area-around', name: 'Randtown', radius: 1500 });
        expect(found).toMatchObject({ kind: 'ok', value: { area: { radius: 1500 } } });
    });

    it('area-around on a verb with no circle shape falls back to the place itself', () => {
        // `escort` accepts 'entity' alone. Refusing an otherwise-fine order
        // because the model wrapped the place in "the area around" would be a
        // schema detail leaking into gameplay.
        const found = resolver('basin')
            .resolveTarget('escort', { type: 'area-around', name: 'Grain Silo' });
        expect(found).toMatchObject({ kind: 'ok', value: { shape: 'entity' } });
    });

    it('a point target is accepted where the verb allows one', () => {
        expect(resolver('basin').resolveTarget('withdraw', { type: 'point', x: 5, z: 6 }))
            .toEqual({ kind: 'ok', value: { shape: 'point', point: { x: 5, z: 6 } } });
    });

    it('a point target becomes a circle for a verb that only takes areas', () => {
        const found = resolver('basin').resolveTarget('defend', { type: 'point', x: 5, z: 6 });
        expect(found).toMatchObject({ kind: 'ok', value: { shape: 'area' } });
    });

    it('an unknown place refuses before any shape is picked', () => {
        expect(resolver('basin').resolveTarget('attack', { type: 'entity-ref', name: 'Wolfden' }).kind)
            .toBe('refuse');
    });
});

describe('when-conditions', () => {
    it('"now" is no gate at all', () => {
        expect(resolver('basin').resolveWhen({ type: 'now' })).toEqual({ kind: 'ok', value: undefined });
    });

    it('under-attack needs nothing resolved', () => {
        expect(resolver('basin').resolveWhen({ type: 'under-attack' }))
            .toEqual({ kind: 'ok', value: { type: 'under-attack' } });
    });

    it('region-contested resolves the NAME to the region KEY', () => {
        expect(resolver('basin').resolveWhen({ type: 'region-contested', regionRef: 'Northgate' }))
            .toEqual({ kind: 'ok', value: { type: 'region-contested', regionId: 'north_gate_ridge' } });
    });

    it('objective-complete resolves the name to the objective id', () => {
        expect(resolver('basin').resolveWhen({ type: 'objective-complete', objectiveRef: 'Hold Fallow Gate' }))
            .toEqual({ kind: 'ok', value: { type: 'objective-complete', objectiveId: 1 } });
    });

    it('strength-below passes the percentage through', () => {
        expect(resolver('basin').resolveWhen({ type: 'strength-below', percent: 40 }))
            .toEqual({ kind: 'ok', value: { type: 'strength-below', percent: 40 } });
    });

    it('an unresolvable gate refuses the whole order', () => {
        expect(resolver('basin').resolveWhen({ type: 'region-contested', regionRef: 'Wolfden' }).kind)
            .toBe('refuse');
    });
});

describe('guidance resolution', () => {
    it('a region NAME becomes the region KEY', () => {
        expect(resolver('basin').resolveGuidance({ op: 'paint', value: 'priority', regionRef: 'Northgate' }))
            .toEqual({ kind: 'ok', value: { op: 'paint', value: 'priority', regionKey: 'north_gate_ridge' } });
    });

    it('a group NAME becomes a group id, strictly', () => {
        expect(resolver('basin').resolveGuidance({ op: 'lock', value: 'on', groupRef: 'Chimera Squad' }))
            .toEqual({ kind: 'ok', value: { op: 'lock', value: 'on', groupId: 1 } });
        expect(resolver('ambiguous-forces')
            .resolveGuidance({ op: 'lock', value: 'on', groupRef: 'Chimera' }).kind).toBe('clarify');
    });

    it('an objective NAME becomes an objective id', () => {
        expect(resolver('basin')
            .resolveGuidance({ op: 'delegate', value: 'on', objectiveRef: 'Secure Osprey Fen' }))
            .toEqual({ kind: 'ok', value: { op: 'delegate', value: 'on', objectiveId: 2 } });
    });

    it('a goal ref must be a number — it comes from the AI, not the name index', () => {
        expect(resolver('basin').resolveGuidance({ op: 'veto', goalRef: '99' }))
            .toEqual({ kind: 'ok', value: { op: 'veto', value: undefined, goalId: 99 } });
        expect(resolver('basin').resolveGuidance({ op: 'veto', goalRef: 'that plan' }).kind).toBe('refuse');
    });

    it('stance, roe and fund need nothing resolved', () => {
        expect(resolver('basin').resolveGuidance({ op: 'stance', value: 'aggressive' }).kind).toBe('ok');
        expect(resolver('basin').resolveGuidance({ op: 'roe', value: 'free' }).kind).toBe('ok');
        expect(resolver('basin').resolveGuidance({ op: 'fund', amount: 10 }))
            .toEqual({ kind: 'ok', value: { op: 'fund', value: undefined, amount: 10, rateCap: undefined } });
    });

    it('a region nobody has heard of refuses', () => {
        expect(resolver('basin')
            .resolveGuidance({ op: 'paint', value: 'priority', regionRef: 'Wolfden' }).kind).toBe('refuse');
    });
});

describe('priorities', () => {
    it('maps the four bands to the composer\'s slider numbers', () => {
        const r = resolver('basin');
        expect(r.resolvePriority('low')).toBe(25);
        expect(r.resolvePriority('normal')).toBe(50);
        expect(r.resolvePriority('high')).toBe(75);
        expect(r.resolvePriority('urgent')).toBe(100);
    });

    it('defaults to normal, matching the composer\'s slider default', () => {
        expect(resolver('basin').resolvePriority(undefined)).toBe(50);
    });
});

describe('the resolver reads nothing but its deps', () => {
    it('has no module state — two resolvers over different worlds do not interfere', () => {
        const a = new NLResolver(world('basin').deps);
        const b = new NLResolver(world('empty').deps);
        expect(a.resolveEntity('Northgate').kind).toBe('ok');
        expect(b.resolveEntity('Northgate').kind).toBe('refuse');
        expect(a.resolveEntity('Northgate').kind).toBe('ok');
    });
});
