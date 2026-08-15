/**
 * nl-context.test.ts — the payload is the model's whole world
 * (PLAN-metalstorm-command-language.md §2, milestone M4)
 *
 * The prompt's first rule is "never invent a name", and it is only meaningful
 * because this payload defines the set of names that exist. So the properties
 * worth pinning are the ones that decide what the model is ALLOWED to say:
 *
 *  - **No ids.** An id in the payload is an id the model can echo back, and an
 *    id in the envelope skips `nl-resolver.ts` — which is where ambiguity
 *    becomes a question and an unknown name becomes a refusal.
 *  - **Determinism.** Same board, same bytes. The fixtures are diffable and
 *    eval runs are comparable only if this holds.
 *  - **The caps actually cap.** ~1.5k tokens is a budget, and a 400-place
 *    generated map has to fit in it without the truncation dropping the places
 *    the player is standing in.
 */

import { describe, it, expect } from 'vitest';
import {
    buildNLContext, MAX_PLACES, MAX_GROUPS, type BuildContextDeps,
} from './nl-context.js';
import type { Census } from './query-engine.js';
import type { NamedEntity, EntityType } from './named-entity-index.js';
import type { OrgGroupSummary } from './ui-store.js';
import { loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

const vocabulary = loadVocabulary();

function entity(type: EntityType, name: string, x = 0, z = 0): NamedEntity {
    return { id: `${type}:${name}`, type, name, x, z };
}

function group(over: Partial<OrgGroupSummary> = {}): OrgGroupSummary {
    return {
        groupId: 1, echelon: 'Squad', ownerTeam: 0, parentId: 0,
        name: 'Chimera Squad', memberIds: [10, 11], currentDirectiveId: 0,
        postureJson: '', baseCostSum: 0,
        ...over,
    };
}

function deps(over: Partial<BuildContextDeps> = {}): BuildContextDeps {
    const entities: NamedEntity[] = over.index ? [] : [
        entity('city', 'Randtown', 100, 100),
        entity('region', 'Osprey Fen', 200, 200),
        entity('objective', 'Hold Fallow Gate'),
    ];
    const census: Census = {
        frame: 42, myTeam: 0,
        units: [
            { unitId: 10, team: 0, side: 'own', className: 'tanks', scale: 2, x: 100, z: 100 },
            { unitId: 11, team: 0, side: 'own', className: 'tanks', scale: 2, x: 110, z: 100 },
            { unitId: 12, team: 0, side: 'own', className: 'soldiers', scale: 1, x: 120, z: 100 },
            { unitId: 99, team: 1, side: 'enemy', className: 'tanks', scale: 3, x: 900, z: 900 },
        ],
    };
    return {
        index: {
            getAll: () => entities,
            getByType: (t) => entities.filter((e) => e.type === t),
        },
        census: { snapshot: () => census },
        vocabulary,
        groups: [group()],
        directives: [],
        panelIds: ['minimap', 'objectives-panel'],
        selectionCount: 2,
        ...over,
    };
}

describe('the payload carries names and never ids', () => {
    it('has no numeric id anywhere in the serialised payload', () => {
        const ctx = buildNLContext(deps());
        const text = JSON.stringify(ctx);

        // The fixture's ids: group 1, units 10/11/12/99. If any of them leaked
        // into a field, the model could address a unit the resolver never saw.
        expect(text).not.toContain('"groupId"');
        expect(text).not.toContain('"unitId"');
        expect(text).not.toContain('memberIds');
        expect(text).not.toContain('"id"');
    });

    it('names groups, places and objectives exactly as the index holds them', () => {
        const ctx = buildNLContext(deps());
        expect(ctx.groups.map((g) => g.n)).toEqual(['Chimera Squad']);
        expect(ctx.places.map((p) => p.n)).toEqual(['Osprey Fen', 'Randtown']);
        expect(ctx.objectives).toEqual(['Hold Fallow Gate']);
    });
});

describe('the payload is deterministic', () => {
    it('produces byte-identical JSON for the same board', () => {
        const a = JSON.stringify(buildNLContext(deps()));
        const b = JSON.stringify(buildNLContext(deps()));
        expect(a).toBe(b);
    });

    it('sorts every list rather than trusting insertion order', () => {
        const entities = [
            entity('city', 'Zebra'), entity('city', 'Alpha'), entity('region', 'Mango'),
        ];
        const ctx = buildNLContext(deps({
            index: { getAll: () => entities, getByType: (t) => entities.filter((e) => e.type === t) },
            panelIds: ['zoom-panel', 'ai-command-panel'],
            groups: [group({ name: 'Zulu Squad', groupId: 2 }), group({ name: 'Alpha Squad' })],
        }));

        expect(ctx.places.map((p) => p.n)).toEqual(['Alpha', 'Mango', 'Zebra']);
        expect(ctx.groups.map((g) => g.n)).toEqual(['Alpha Squad', 'Zulu Squad']);
        expect(ctx.panels).toEqual(['ai-command-panel', 'zoom-panel']);
    });
});

describe('groups describe what the resolver would rank on', () => {
    it('reports the dominant member class and the size', () => {
        const ctx = buildNLContext(deps({
            groups: [group({ memberIds: [10, 11, 12] })],   // 2 tanks, 1 soldier
        }));
        expect(ctx.groups[0]).toEqual({ n: 'Chimera Squad', cls: 'tanks', sz: 3, state: 'idle' });
    });

    it('marks a group with a live directive as tasked', () => {
        // idle-first is the resolver's ranking rule; the model can only prefer
        // the same group if it can see which ones are free.
        const ctx = buildNLContext(deps({ groups: [group({ currentDirectiveId: 7 })] }));
        expect(ctx.groups[0].state).toBe('tasked');
    });

    it('omits the class for a group with nothing on the field', () => {
        const ctx = buildNLContext(deps({ groups: [group({ memberIds: [] })] }));
        expect(ctx.groups[0].cls).toBeUndefined();
        expect(ctx.groups[0].sz).toBe(0);
    });
});

describe('self reflects the board, not the client', () => {
    it('counts only own units, by class', () => {
        const ctx = buildNLContext(deps());
        // The enemy tank is NOT in the count — "how many tanks do I have" is
        // about the player's tanks, and mixing sides here would make every
        // class-count subject overshoot.
        expect(ctx.self.counts).toEqual({ tanks: 2, soldiers: 1 });
        expect(ctx.classes).toEqual(['soldiers', 'tanks']);
    });

    it('reports the selection size so the model can see when there is none', () => {
        expect(buildNLContext(deps({ selectionCount: 0 })).self.selection).toBe(0);
        expect(buildNLContext(deps({ selectionCount: 5 })).self.selection).toBe(5);
    });

    it('omits authority rather than reporting a fake zero', () => {
        // A missing rulesParam and "you have no authority" are different facts,
        // and 0 would let the model refuse a legal order.
        expect(buildNLContext(deps()).self.authority).toBeUndefined();
        expect(buildNLContext(deps({ authority: 44.6 })).self.authority).toBe(45);
    });

    it('survives a board with no census at all', () => {
        // Pre-spawn, or the mirror not yet arrived. Must not throw — the
        // console would swallow the sentence entirely.
        const ctx = buildNLContext(deps({ census: { snapshot: () => null } }));
        expect(ctx.self.counts).toEqual({});
        expect(ctx.classes).toEqual([]);
        expect(ctx.groups[0].cls).toBeUndefined();
    });
});

describe('the caps hold on a huge map', () => {
    it('keeps the places nearest the player when there are too many', () => {
        // 200 far-away regions plus one underfoot. The truncation must not be
        // "the first 60 the index happened to hand back".
        const far: NamedEntity[] = Array.from({ length: 200 }, (_, i) =>
            entity('region', `Far ${String(i).padStart(3, '0')}`, 10000 + i, 10000));
        const near = entity('region', 'Underfoot', 105, 100);
        const entities = [...far, near];

        const ctx = buildNLContext(deps({
            index: { getAll: () => entities, getByType: (t) => entities.filter((e) => e.type === t) },
        }));

        expect(ctx.places).toHaveLength(MAX_PLACES);
        expect(ctx.places.map((p) => p.n)).toContain('Underfoot');
    });

    it('falls back to a stable name order when nothing is on the field yet', () => {
        const entities: NamedEntity[] = Array.from({ length: 100 }, (_, i) =>
            entity('region', `R${String(i).padStart(3, '0')}`, i, i));
        const build = () => buildNLContext(deps({
            index: { getAll: () => entities, getByType: (t) => entities.filter((e) => e.type === t) },
            census: { snapshot: () => ({ frame: 0, myTeam: 0, units: [] }) },
        }));

        const first = build();
        expect(first.places).toHaveLength(MAX_PLACES);
        // Deterministic even with no centroid to rank against.
        expect(JSON.stringify(build())).toBe(JSON.stringify(first));
    });

    it('caps groups', () => {
        const many = Array.from({ length: MAX_GROUPS + 10 }, (_, i) =>
            group({ groupId: i + 1, name: `Squad ${String(i).padStart(3, '0')}` }));
        expect(buildNLContext(deps({ groups: many })).groups).toHaveLength(MAX_GROUPS);
    });

    it('drops nameless groups instead of shipping a blank ref', () => {
        // An unnamed group is one the callsign producer (§5) has not reached.
        // A blank `n` would be a name the model could echo and the resolver
        // could never find.
        const ctx = buildNLContext(deps({
            groups: [group({ name: '' }), group({ groupId: 2, name: 'Real Squad' })],
        }));
        expect(ctx.groups.map((g) => g.n)).toEqual(['Real Squad']);
    });
});

describe('enemies come from the intel stream, not from raw units', () => {
    it('is empty when no enemy-force summaries exist, despite visible enemies', () => {
        // The census HAS a visible enemy tank. It still must not become an
        // "enemy" entry: the resolver can only look up names the index holds,
        // so a synthesised name would be a target the order path cannot use.
        const ctx = buildNLContext(deps());
        expect(ctx.enemies).toEqual([]);
    });

    it('passes through enemy-force names when the producer supplies them', () => {
        const entities = [entity('enemy-force', 'enemy armour near Osprey Fen', 900, 900)];
        const ctx = buildNLContext(deps({
            index: { getAll: () => entities, getByType: (t) => entities.filter((e) => e.type === t) },
        }));
        expect(ctx.enemies).toEqual([{ n: 'enemy armour near Osprey Fen' }]);
    });
});
