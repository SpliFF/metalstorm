/**
 * query-engine.test.ts — the answers, and the ones it must refuse to give
 * (PLAN-metalstorm-command-language.md §6.4, milestone M3; design pillar 3)
 *
 * The golden fixtures (`nl-fixtures/camera-ui-query.json`) already run the engine
 * end-to-end through the executor. This suite covers what a fixture can't say
 * cleanly: the STRUCTURAL properties of LOS honesty.
 *
 * The central one is negative and worth stating plainly, because it is the whole
 * safety argument: there is no code path from a query to a collection the server
 * didn't filter. The engine's only world is `CensusPort.snapshot()`. So the tests
 * here work by taking things OUT of that snapshot and checking the answer changes
 * — the same way vision actually works.
 */

import { describe, it, expect } from 'vitest';
import { QueryEngine, CensusCache, NOT_SPOTTED, type Census, type CensusUnit } from './query-engine.js';
import { NLResolver } from './nl-resolver.js';
import { NamedEntityIndex, type NamedEntity } from './named-entity-index.js';
import { ClassVocabulary, type ClassVocabularyData } from './class-vocabulary.js';
import type { OrgGroupSummary } from './ui-store.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const vocabulary = ClassVocabulary.fromData(JSON.parse(readFileSync(
    join(HERE, '..', '..', '..', '..', 'data', 'games', 'metalstorm', 'ui', 'class-vocabulary.json'),
    'utf8')) as ClassVocabularyData);

const PLACES: NamedEntity[] = [
    { id: 'northgate', type: 'region', name: 'Northgate', x: 2000, z: 500 },
    { id: 'slag_forge', type: 'region', name: 'Slag Forge', x: 3000, z: 3000 },
];

function unit(over: Partial<CensusUnit> & Pick<CensusUnit, 'unitId' | 'side'>): CensusUnit {
    return { team: 0, className: 'tanks', scale: 3, x: 0, z: 0, ...over };
}

interface Board {
    engine: QueryEngine;
    focused: Array<{ x: number; z: number }>;
}

function board(opts: {
    units?: CensusUnit[];
    noCensus?: boolean;
    groups?: OrgGroupSummary[];
    entities?: NamedEntity[];
    game?: Record<string, number | string>;
    team?: Record<string, number | string>;
} = {}): Board {
    const index = new NamedEntityIndex();
    const groups = opts.groups ?? [];
    index.replaceAll([
        ...PLACES,
        ...(opts.entities ?? []),
        ...groups.map((g): NamedEntity => ({ id: g.groupId, type: 'group', name: g.name, x: 0, z: 0 })),
    ]);
    const resolver = new NLResolver({ index, vocabulary, groups });
    const census: Census | null = opts.noCensus
        ? null
        : { frame: 100, myTeam: 0, units: opts.units ?? [] };
    const focused: Array<{ x: number; z: number }> = [];

    return {
        focused,
        engine: new QueryEngine({
            census: { snapshot: () => census },
            index,
            vocabulary,
            resolveEntity: (name, o) => resolver.resolveEntity(name, o),
            groups,
            directives: [],
            gameRulesParam: (key) => opts.game?.[key],
            teamRulesParam: (key) => opts.team?.[key],
            playerId: 0,
            focusCamera: (x, z) => focused.push({ x, z }),
        }),
    };
}

const answer = (b: Board, query: Parameters<QueryEngine['answer']>[0]): string => {
    const result = b.engine.answer(query);
    if (result.kind !== 'ok') throw new Error(`expected an answer, got ${result.kind}: ${JSON.stringify(result)}`);
    return result.value;
};

describe('count', () => {
    it('counts own units by class, joined on ms_class', () => {
        const b = board({
            units: [
                unit({ unitId: 1, side: 'own' }),
                unit({ unitId: 2, side: 'own' }),
                unit({ unitId: 3, side: 'own', className: 'fighters', scale: 2 }),
            ],
        });
        expect(answer(b, { op: 'count', class: 'tanks', side: 'own' })).toBe('You have 2 tanks.');
    });

    it('narrows on ms_scale', () => {
        const b = board({
            units: [
                unit({ unitId: 1, side: 'own', scale: 3 }),
                unit({ unitId: 2, side: 'own', scale: 2 }),
            ],
        });
        expect(answer(b, { op: 'count', class: 'tanks', scale: 3, side: 'own' }))
            .toBe('You have 1 heavy tanks.');
    });

    it('does not double the scale word when the class phrase already carries it', () => {
        const b = board({ units: [unit({ unitId: 1, side: 'own', scale: 3 })] });
        // An envelope may legitimately send both "heavy tanks" and scale 3.
        expect(answer(b, { op: 'count', class: 'heavy tanks', scale: 3, side: 'own' }))
            .not.toContain('heavy heavy');
    });

    it('counts by ROLE using the same clause reduction the order path uses', () => {
        const b = board({
            units: [
                unit({ unitId: 1, side: 'own', className: 'fighters', scale: 2 }),
                unit({ unitId: 2, side: 'own', className: 'staticdefense', scale: 3 }),
                unit({ unitId: 3, side: 'own', className: 'tanks', scale: 3 }),
            ],
        });
        // "air defense" spans fighters ∪ staticdefense s2+ — a role, not a class.
        // If this drifted from the resolver's reduction, "how many air defense"
        // and "2 air defense squads attack X" would disagree about what counts.
        const text = answer(b, { op: 'count', class: 'air defense', side: 'own' });
        expect(text).toBe('You have 2 Air defense.');
    });

    it('an own count of zero is a real zero', () => {
        const b = board({ units: [] });
        expect(answer(b, { op: 'count', class: 'tanks', side: 'own' })).toBe('You have no tanks.');
    });

    it('an ENEMY count is qualified by vision, never stated as fact', () => {
        const b = board({ units: [unit({ unitId: 9, side: 'enemy', team: 2 })] });
        const text = answer(b, { op: 'count', class: 'tanks', side: 'enemy' });
        expect(text).toContain('1 enemy tanks is in sight');
        expect(text).toContain("only what's spotted right now");
        // The claim it must NOT make.
        expect(text).not.toMatch(/the enemy has/i);
    });

    it('an enemy count of zero says NOT SPOTTED, not "there are none" — and reads as English', () => {
        // The live run said "No enemy tanks are not currently spotted." The count
        // line already carries the negation in "No"; the negated phrase after it
        // said the opposite of what it meant.
        const b = board({ units: [] });
        expect(answer(b, { op: 'count', class: 'tanks', side: 'enemy' }))
            .toBe('No enemy tanks are currently spotted.');
    });

    it('refuses when no snapshot has arrived, rather than answering zero', () => {
        const b = board({ noCensus: true });
        const result = b.engine.answer({ op: 'count', class: 'tanks', side: 'own' });
        expect(result.kind).toBe('refuse');
        if (result.kind === 'refuse') expect(result.reason).toContain("can't read your units");
    });

    it('refuses a class the shipped vocabulary doesn\'t know', () => {
        const b = board();
        const result = b.engine.answer({ op: 'count', class: 'battlemechs', side: 'own' });
        expect(result.kind).toBe('refuse');
    });
});

describe('locate — the LOS pillar', () => {
    const enemyTanksAt = (x: number, z: number): CensusUnit[] => [
        unit({ unitId: 901, side: 'enemy', team: 2, x, z }),
        unit({ unitId: 902, side: 'enemy', team: 2, x: x + 10, z }),
    ];

    it('an enemy IN the mirror gets a position', () => {
        const b = board({ units: enemyTanksAt(3000, 3000) });
        const text = answer(b, { op: 'locate', targetRef: 'enemy tanks', side: 'enemy' });
        expect(text).toContain('Enemy tanks: 2 near Slag Forge');
        expect(text).toContain('spotted now');
    });

    it('an enemy OUT of the mirror is "not currently spotted"', () => {
        // Same query, same board minus the two entries. There is no other way to
        // model out-of-LOS, because the real mirror has no other way either.
        const b = board({ units: [] });
        expect(answer(b, { op: 'locate', targetRef: 'enemy tanks', side: 'enemy' }))
            .toBe(`Enemy tanks: ${NOT_SPOTTED}.`);
    });

    it('an unspotted enemy does NOT move the camera', () => {
        const b = board({ units: [] });
        b.engine.answer({ op: 'locate', targetRef: 'enemy tanks', side: 'enemy' });
        // A camera that swung to an unspotted enemy would be the wallhack the
        // words just denied.
        expect(b.focused).toEqual([]);
    });

    it('a NAMED enemy force is reported as last-seen intel, never as a current position', () => {
        // Found by this test: the name path treated an `enemy-force` entry as an
        // ordinary place and answered "Enemy tanks is near Northgate", pointing
        // the camera at it — remembered intel presented as live vision. Every
        // word of it came from data the client legitimately holds, and it was
        // still a lie about NOW.
        const b = board({
            units: [],
            entities: [{ id: 'ef1', type: 'enemy-force', name: '3rd Armour', x: 2000, z: 500 }],
        });
        const text = answer(b, { op: 'locate', targetRef: '3rd Armour', side: 'enemy' });
        expect(text).toBe(`3rd Armour: ${NOT_SPOTTED} — last seen near Northgate.`);
        expect(b.focused).toEqual([]);
    });

    it('a class-based miss borrows the same "last seen" intel when the index has it', () => {
        // The enemy-force type has no producer yet, so this is the wording the
        // day one lands rather than behaviour a player sees today.
        const b = board({
            units: [],
            entities: [{ id: 'ef1', type: 'enemy-force', name: 'Enemy tank column', x: 3000, z: 3000 }],
        });
        const text = answer(b, { op: 'locate', targetRef: 'enemy tanks', side: 'enemy' });
        expect(text).toContain(NOT_SPOTTED);
        expect(text).toContain('last seen near Slag Forge');
    });

    it('the side words in the sentence win over the query default', () => {
        // "locate the enemy tanks" with side omitted must not search your own.
        const b = board({ units: [unit({ unitId: 1, side: 'own' })] });
        expect(answer(b, { op: 'locate', targetRef: 'enemy tanks' })).toContain(NOT_SPOTTED);
    });

    it('locates an own group at its members\' centroid, and frames it', () => {
        const groups: OrgGroupSummary[] = [{
            groupId: 1, echelon: 'Squad', ownerTeam: 0, parentId: 0, name: 'Chimera Squad',
            memberIds: [11, 12], currentDirectiveId: 0, postureJson: '', baseCostSum: 20,
        }];
        const b = board({
            groups,
            units: [
                unit({ unitId: 11, side: 'own', x: 1000, z: 1000 }),
                unit({ unitId: 12, side: 'own', x: 1100, z: 1000 }),
            ],
        });
        const text = answer(b, { op: 'locate', targetRef: 'Chimera Squad' });
        expect(text).toContain('2 of 2 in sight');
        expect(b.focused).toEqual([{ x: 1050, z: 1000 }]);
    });

    it('a group whose members have all left the mirror is not spotted either', () => {
        const groups: OrgGroupSummary[] = [{
            groupId: 1, echelon: 'Squad', ownerTeam: 0, parentId: 0, name: 'Chimera Squad',
            memberIds: [11, 12], currentDirectiveId: 0, postureJson: '', baseCostSum: 20,
        }];
        const b = board({ groups, units: [] });
        expect(answer(b, { op: 'locate', targetRef: 'Chimera Squad' })).toContain(NOT_SPOTTED);
        expect(b.focused).toEqual([]);
    });

    it('a place is located from the index and framed — public knowledge, not intel', () => {
        const b = board();
        expect(answer(b, { op: 'locate', targetRef: 'Northgate' })).toContain('Northgate is near');
        expect(b.focused).toEqual([{ x: 2000, z: 500 }]);
    });

    it('names the nearest OTHER region, so a place is never "near itself"', () => {
        const b = board();
        expect(answer(b, { op: 'locate', targetRef: 'Northgate' })).not.toContain('near Northgate');
    });

    it('refuses a reference that is neither a place nor a class', () => {
        const b = board();
        const result = b.engine.answer({ op: 'locate', targetRef: 'the enemy commander', side: 'enemy' });
        expect(result.kind).toBe('refuse');
        if (result.kind === 'refuse') expect(result.reason).toContain("don't know a place or force");
    });
});

describe('status / resources / objectives', () => {
    const groups: OrgGroupSummary[] = [{
        groupId: 1, echelon: 'Squad', ownerTeam: 0, parentId: 0, name: 'Chimera Squad',
        memberIds: [11, 12, 13], currentDirectiveId: 0, postureJson: '', baseCostSum: 30,
    }];

    it('status reports strength, visible strength and the current directive', () => {
        const b = board({ groups, units: [unit({ unitId: 11, side: 'own' })] });
        const text = answer(b, { op: 'status', subjectRef: 'Chimera Squad' });
        expect(text).toContain('3 units');
        expect(text).toContain('1 in sight');
        expect(text).toContain('no active directive');
    });

    it('resources reads the authority pool and the player\'s slice', () => {
        const b = board({ team: { authority_pool: 720, authority_player_0: 92 } });
        expect(answer(b, { op: 'resources' }))
            .toBe('you have 92 authority; the team pool holds 720.');
    });

    it('resources refuses when no rules params have arrived', () => {
        const b = board();
        expect(b.engine.answer({ op: 'resources' }).kind).toBe('refuse');
    });

    it('objectives lists the active ones only', () => {
        const b = board({
            entities: [
                { id: 1, type: 'objective', name: 'Hold Fallow Gate', x: 0, z: 0 },
                { id: 2, type: 'objective', name: 'Secure Osprey Fen', x: 0, z: 0 },
            ],
            game: {
                objective_count: 2,
                objective_1_state: 'active', objective_1_progress: 0.25, objective_1_reward: 50,
                objective_2_state: 'complete',
            },
        });
        const text = answer(b, { op: 'objectives' });
        expect(text).toContain('Hold Fallow Gate (25%, 50 authority)');
        expect(text).not.toContain('Osprey Fen');
    });

    it('distinguishes "nothing active" from "nothing issued"', () => {
        const settled = board({ game: { objective_count: 1, objective_1_state: 'complete' } });
        expect(answer(settled, { op: 'objectives' })).toContain('every objective on the board is settled');
        const fresh = board({ game: {} });
        expect(answer(fresh, { op: 'objectives' })).toContain('No objectives have been issued');
    });
});

describe('CensusCache', () => {
    const census = (frame: number): Census => ({ frame, myTeam: 0, units: [] });

    it('holds the last fetched snapshot', async () => {
        const cache = new CensusCache(async () => census(7));
        expect(cache.snapshot()).toBeNull();
        await cache.refresh();
        expect(cache.snapshot()?.frame).toBe(7);
    });

    it('keeps the previous snapshot when a refresh fails, then lets it expire', async () => {
        let now = 1000;
        let fail = false;
        const cache = new CensusCache(
            async () => { if (fail) throw new Error('worker gone'); return census(7); },
            () => now,
        );
        await cache.refresh();
        fail = true;

        // A single dropped round-trip must not turn "12 tanks" into "I can't see".
        await cache.refresh();
        expect(cache.snapshot()?.frame).toBe(7);

        // But a mirror that stopped updating must stop answering.
        now += 60_000;
        expect(cache.snapshot()).toBeNull();
    });
});
