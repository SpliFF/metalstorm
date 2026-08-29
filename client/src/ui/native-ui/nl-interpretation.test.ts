/**
 * nl-interpretation.test.ts — the echo says what will happen, not what was said
 * (battle-clarity U4)
 *
 * The one property worth pinning: the reading is built from RESOLVED names. A
 * console that echoes the player's own words back has confirmed nothing, and
 * "attack storm" that quietly resolves to the wrong Storm is exactly the class
 * of mistake this affordance exists to catch.
 */

import { describe, it, expect } from 'vitest';
import { interpret } from './nl-interpretation.js';
import { NLResolver } from './nl-resolver.js';
import { NamedEntityIndex } from './named-entity-index.js';
import { ClassVocabulary } from './class-vocabulary.js';
import type { FocusBinding } from './nl-focus.js';
import type { NLResponse } from './nl-envelope.js';

const index = new NamedEntityIndex();
index.replaceAll([
    { id: 'storm_sound', type: 'region', name: 'Storm Sound', x: 4000, z: 4000 },
    { id: 'amber_row', type: 'region', name: 'Amber Row', x: 1000, z: 1000 },
    { id: 3, type: 'group', name: '3rd Tanks', x: 0, z: 0 },
]);

const vocabulary = ClassVocabulary.fromData({
    version: 1,
    // Shipped shape: `display` is singular, `plural` is what a count reads
    // with ("2 tank squads") — see data/games/metalstorm/ui/class-vocabulary.json.
    classes: { tanks: { display: 'Tank', plural: 'tank squads', synonyms: ['tanks', 'armour'] } },
    roles: {},
});

const resolver = new NLResolver({
    index,
    vocabulary,
    groups: [{ groupId: 3, name: '3rd Tanks', memberIds: [1, 2], currentDirectiveId: 0 }] as never,
});

const groupLabel = (id: number) => (id === 3 ? '3rd Tanks' : `Group ${id}`);

const command = (over: Record<string, unknown> = {}): NLResponse => ({
    say: 'the model wrote this',
    actions: [{
        kind: 'command',
        intent: {
            verb: 'attack',
            subject: { type: 'selection' },
            target: { type: 'entity-ref', name: 'Storm Sound' },
            ...over,
        },
    }],
} as NLResponse);

const binding = (over: Partial<FocusBinding> = {}): FocusBinding => ({
    actionIndex: 0, slot: 'subject', phrase: 'them', label: '3rd Tanks',
    source: 'selection', ...over,
});

describe('the reading', () => {
    it('names the bound subject and the RESOLVED place', () => {
        const plan = interpret(command(), { resolver, groupLabel, bindings: [binding()] });
        expect(plan?.text).toBe('3rd Tanks attacking Storm Sound');
    });

    it('resolves a fuzzy target to the name that will actually be ordered', () => {
        // "storm" is what was typed; "Storm Sound" is what the resolver found,
        // and the second one is the sentence the player has to be able to check.
        const plan = interpret(
            command({ target: { type: 'entity-ref', name: 'storm' } }),
            { resolver, groupLabel, bindings: [binding()] },
        );
        expect(plan?.text).toBe('3rd Tanks attacking Storm Sound');
    });

    it('reads as English per verb, with the preposition the verb wants', () => {
        const withdraw = interpret(
            command({ verb: 'withdraw', target: { type: 'entity-ref', name: 'Amber Row' } }),
            { resolver, groupLabel, bindings: [binding()] },
        );
        expect(withdraw?.text).toBe('3rd Tanks pulling back to Amber Row');
    });

    it('carries a non-default priority and a when-gate, and drops the defaults', () => {
        const plan = interpret(
            command({ priority: 'urgent', when: { type: 'under-attack' } }),
            { resolver, groupLabel, bindings: [binding()] },
        );
        expect(plan?.text).toBe('3rd Tanks attacking Storm Sound · urgent priority · if attacked');

        const plain = interpret(command({ priority: 'normal', when: { type: 'now' } }),
            { resolver, groupLabel, bindings: [binding()] });
        expect(plain?.text).toBe('3rd Tanks attacking Storm Sound');
    });

    it('says whose order an unqualified one is', () => {
        const plan = interpret(command({ subject: { type: 'any' } }), { resolver, groupLabel });
        expect(plan?.text).toBe('Whoever is free attacking Storm Sound');
    });

    it('keeps a class-count subject in the player\'s own words', () => {
        // NOT resolved to squad names: the executor ranks those against the
        // target position, and re-ranking from here can pick different squads —
        // an echo naming Chimera while Basilisk gets the order is worse than
        // none. The executor prints one line per squad it actually tasked.
        const plan = interpret(
            command({ subject: { type: 'class-count', class: 'tanks', count: 2 } }),
            { resolver, groupLabel },
        );
        expect(plan?.text).toBe('2 tank squads attacking Storm Sound');
    });
});

describe('the confirm gate', () => {
    it('fires when a pronoun was bound and the order commits', () => {
        const plan = interpret(command(), { resolver, groupLabel, bindings: [binding()] });
        expect(plan?.commits).toBe(true);
        expect(plan?.needsConfirm).toBe(true);
    });

    it('does NOT fire for a sentence that named everything it meant', () => {
        // The common case, and it must cost nothing: an order typed in full has
        // already been confirmed by being typed.
        const plan = interpret(command(), { resolver, groupLabel, bindings: [] });
        expect(plan?.needsConfirm).toBe(false);
    });

    it('does NOT fire for a camera pronoun — framing the wrong hill is a keystroke', () => {
        const response: NLResponse = {
            actions: [{ kind: 'camera', camera: { op: 'focus', targetRef: 'Storm Sound' } }],
        };
        const plan = interpret(response, {
            resolver, groupLabel,
            bindings: [binding({ slot: 'camera-target' })],
        });
        expect(plan).toBeNull();
    });
});

describe('what earns no echo at all', () => {
    it('a question', () => {
        expect(interpret({ actions: [], clarify: { question: 'which one?' } }, { resolver }))
            .toBeNull();
    });

    it('a refusal', () => {
        expect(interpret({ actions: [{ kind: 'refuse', reason: 'no' }] }, { resolver }))
            .toBeNull();
    });

    it('a query or a panel — the executor\'s own answer already says it', () => {
        expect(interpret({
            actions: [{ kind: 'query', query: { op: 'resources' } }],
        }, { resolver })).toBeNull();
        expect(interpret({
            actions: [{ kind: 'ui', ui: { op: 'open', panelId: 'scoreboard-panel' } }],
        }, { resolver })).toBeNull();
    });

    it('an unresolvable place is QUOTED, never asserted as a name', () => {
        const plan = interpret(
            command({ target: { type: 'entity-ref', name: 'the ridge' } }),
            { resolver, groupLabel, bindings: [binding()] },
        );
        expect(plan?.text).toBe('3rd Tanks attacking "the ridge"');
    });
});
