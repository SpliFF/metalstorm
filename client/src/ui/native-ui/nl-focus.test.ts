/**
 * nl-focus.test.ts — pronouns resolve against the focus, or refuse by name
 * (battle-clarity U4)
 *
 * Every case here is a sentence a player says and nothing else in the stack
 * can parse. The assertions are about the two things that can go wrong with a
 * pronoun: pointing it at the wrong thing, and pointing it at nothing while
 * saying nothing about that.
 */

import { describe, it, expect } from 'vitest';
import {
    bindFocusReferences, focusContextFor, focusViewFrom, focusViewFromContext,
    findSubjectDeictic, findTargetDeictic, isSubjectDeictic, isTargetDeictic,
} from './nl-focus.js';
import type { NLFocusView } from './focus-model.js';
import type { NLResponse } from './nl-envelope.js';

const view = (over: Partial<NLFocusView> = {}): NLFocusView => ({
    primary: null, subjects: [], drilled: null, openSurfaces: [], selectionCount: 0,
    ...over,
});

const squad = (label: string) => ({ kind: 'squad' as const, label });
const town = (label: string) => ({ kind: 'town' as const, label, place: label });
const objective = (label: string, place: string) =>
    ({ kind: 'objective' as const, label, place });

const order = (subject: string, target: string): NLResponse => ({
    actions: [{
        kind: 'command',
        intent: {
            verb: 'attack',
            subject: { type: 'entity-ref', name: subject },
            target: { type: 'entity-ref', name: target },
        },
    }],
});

const intentOf = (r: NLResponse) => {
    const a = r.actions[0];
    if (a.kind !== 'command') throw new Error(`expected a command, got ${a.kind}`);
    return a.intent;
};

const refusalOf = (r: NLResponse) => {
    const a = r.actions[0];
    if (a.kind !== 'refuse') throw new Error(`expected a refusal, got ${a.kind}`);
    return a.reason;
};

// ─────────────────────────── the phrase lists ───────────────────────────

describe('what counts as a pronoun', () => {
    it('matches whole phrases, never prefixes', () => {
        expect(isSubjectDeictic('them')).toBe(true);
        expect(isSubjectDeictic('Them')).toBe(true);
        expect(isSubjectDeictic('them.')).toBe(true);
        // A group genuinely called "Thunder" is a group.
        expect(isSubjectDeictic('Thunder')).toBe(false);
        expect(isTargetDeictic('that town')).toBe(true);
        expect(isTargetDeictic('Thatcham')).toBe(false);
    });

    it('finds the LONGEST phrase in a sentence, so "that town" beats "that"', () => {
        expect(findTargetDeictic('attack that town')).toBe('that town');
        expect(findTargetDeictic('defend it')).toBe('it');
        expect(findSubjectDeictic('pull them back')).toBe('them');
        expect(findTargetDeictic('attack Storm Sound')).toBeNull();
    });

    it('does not find a phrase inside a word', () => {
        // "there" is a target deictic; "Netherfield" must not match it.
        expect(findTargetDeictic('attack Netherfield')).toBeNull();
    });
});

// ───────────────────────────── subject binding ─────────────────────────────

describe('a subject pronoun', () => {
    it('binds to the SELECTION, not to the selected group\'s name', () => {
        const bound = bindFocusReferences(
            order('them', 'Storm Sound'),
            view({ subjects: [squad('3rd Tanks')], selectionCount: 6,
                   primary: squad('3rd Tanks') }),
        );
        // `selection`, so the resolver's own rules (partial rosters, several
        // groups) still get to run. A name here would route around all of it.
        expect(intentOf(bound.response).subject).toEqual({ type: 'selection' });
        expect(bound.bindings).toEqual([{
            actionIndex: 0, slot: 'subject', phrase: 'them',
            label: '3rd Tanks', source: 'selection',
        }]);
    });

    it('names every selected squad in the echo when there are several', () => {
        const bound = bindFocusReferences(
            order('them', 'Storm Sound'),
            view({ subjects: [squad('3rd Tanks'), squad('1st Recon')], selectionCount: 9 }),
        );
        expect(bound.bindings[0].label).toBe('3rd Tanks and 1st Recon');
    });

    it('falls back to the DRILLED squad when nothing is selected', () => {
        const bound = bindFocusReferences(
            order('them', 'Storm Sound'),
            view({ drilled: squad('3rd Tanks'), primary: squad('3rd Tanks') }),
        );
        expect(intentOf(bound.response).subject).toEqual({
            type: 'entity-ref', name: '3rd Tanks',
        });
        expect(bound.bindings[0].source).toBe('drilled');
    });

    it('refuses with what to do instead when there is no antecedent', () => {
        const bound = bindFocusReferences(order('them', 'Storm Sound'), view());
        expect(refusalOf(bound.response)).toContain('"them"');
        expect(refusalOf(bound.response)).toContain('select the units you mean');
        expect(bound.bindings).toEqual([]);
    });
});

// ───────────────────────────── target binding ─────────────────────────────

describe('a target pronoun', () => {
    it('binds to the drilled objective\'s PLACE, not to its title', () => {
        // The chip reads "Hold Raven Basin"; the entity index holds
        // "Hold: Raven Basin"; the place is "Raven Basin". Only the last of
        // those is a name the resolver can look up.
        const bound = bindFocusReferences(
            order('3rd Tanks', 'it'),
            view({ drilled: objective('Hold Raven Basin', 'Raven Basin'),
                   primary: objective('Hold Raven Basin', 'Raven Basin') }),
        );
        expect(intentOf(bound.response).target).toEqual({
            type: 'entity-ref', name: 'Raven Basin',
        });
        expect(bound.bindings[0]).toMatchObject({ phrase: 'it', label: 'Raven Basin' });
    });

    it('prefers the drilled panel over the selection', () => {
        const bound = bindFocusReferences(
            order('3rd Tanks', 'that town'),
            view({ drilled: town('Storm Sound'), subjects: [town('Amber Row')] }),
        );
        expect(intentOf(bound.response).target).toEqual({
            type: 'entity-ref', name: 'Storm Sound',
        });
    });

    it('refuses BY NAME when the antecedent is a force, not a place', () => {
        const bound = bindFocusReferences(
            order('Chimera Platoon', 'it'),
            view({ subjects: [squad('3rd Tanks')], primary: squad('3rd Tanks'),
                   selectionCount: 6 }),
        );
        // The failure the whole module exists to avoid: aiming at wherever the
        // selected squad happens to be standing.
        expect(refusalOf(bound.response))
            .toBe('"it" is 3rd Tanks, which isn\'t a place — name where.');
    });

    it('asks rather than picks when two selected things are both places', () => {
        const bound = bindFocusReferences(
            order('3rd Tanks', 'there'),
            view({ subjects: [town('Storm Sound'), town('Amber Row')] }),
        );
        expect(refusalOf(bound.response)).toContain('Storm Sound or Amber Row');
    });
});

// ────────────────────────────── the no-ops ──────────────────────────────

describe('what binding must never touch', () => {
    it('returns the SAME object when nothing was deictic', () => {
        const response = order('3rd Tanks', 'Storm Sound');
        const bound = bindFocusReferences(response, view({ drilled: town('Amber Row') }));
        expect(bound.response).toBe(response);
        expect(bound.bindings).toEqual([]);
    });

    it('leaves a point target alone', () => {
        const response: NLResponse = {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'attack',
                    subject: { type: 'selection' },
                    target: { type: 'point', x: 100, z: 200 },
                },
            }],
        };
        expect(bindFocusReferences(response, view()).response).toBe(response);
    });

    it('treats a missing focus exactly like an empty one', () => {
        const bound = bindFocusReferences(order('them', 'Storm Sound'), undefined);
        // A refusal that names the pronoun, NOT "I don't know a group called
        // 'them'" three layers down.
        expect(refusalOf(bound.response)).toContain('"them"');
    });
});

describe('the camera', () => {
    it('sends "show me that" to the drilled place', () => {
        const response: NLResponse = {
            actions: [{ kind: 'camera', camera: { op: 'focus', targetRef: 'that' } }],
        };
        const bound = bindFocusReferences(response,
            view({ drilled: objective('Hold Raven Basin', 'Raven Basin') }));
        expect(bound.response.actions[0]).toEqual({
            kind: 'camera', camera: { op: 'focus', targetRef: 'Raven Basin' },
        });
    });

    it('sends "follow them" to a FORCE, because that is what follow takes', () => {
        const response: NLResponse = {
            actions: [{ kind: 'camera', camera: { op: 'follow', targetRef: 'them' } }],
        };
        const bound = bindFocusReferences(response,
            view({ subjects: [squad('3rd Tanks')], selectionCount: 6 }));
        expect(bound.response.actions[0]).toEqual({
            kind: 'camera', camera: { op: 'follow', targetRef: '3rd Tanks' },
        });
    });
});

// ──────────────────────────── the context field ────────────────────────────

describe('the focus as the model sees it', () => {
    it('carries kinds, labels and places — and nothing else', () => {
        const payload = focusContextFor(view({
            subjects: [squad('3rd Tanks')],
            drilled: objective('Hold Raven Basin', 'Raven Basin'),
            primary: objective('Hold Raven Basin', 'Raven Basin'),
            openSurfaces: ['scoreboard-panel', 'command-console'],
            selectionCount: 6,
        }));

        expect(payload).toEqual({
            primary: { kind: 'objective', label: 'Hold Raven Basin', place: 'Raven Basin' },
            subjects: [{ kind: 'squad', label: '3rd Tanks' }],
            drilled: { kind: 'objective', label: 'Hold Raven Basin', place: 'Raven Basin' },
            // Sorted: a set with no natural order must not make two identical
            // boards produce different payloads.
            surfaces: ['command-console', 'scoreboard-panel'],
            selected: 6,
        });
        expect(JSON.stringify(payload)).not.toMatch(/"id"|"unitIds"|"position"/);
    });

    it('omits primary and drilled rather than sending null', () => {
        expect(focusContextFor(view())).toEqual({
            subjects: [], surfaces: [], selected: 0,
        });
    });
});

// ────────────────── the focus PORT: whatever shape it arrives in ──────────────────

/**
 * `focusViewFrom` is the seam between the NL layer and whoever owns the focus,
 * and it is the only place in the layer that looks at a focus store's shape.
 * Four producers feed it and they do not agree with each other: the TS
 * `FocusModel` (`nlFocus()`), lane 9's `lib/focus.js` store (`getFocus()`), an
 * already-normalised snapshot, and the WIRE shape a fixture board or a replayed
 * eval payload carries (`surfaces`/`selected` rather than
 * `openSurfaces`/`selectionCount`).
 *
 * These tests exist because the alternative to feature-detecting here is a
 * second focus store inside the NL layer, and two stores that disagree about
 * what is selected is how the wrong army moves.
 */
describe('focusViewFrom feature-detects its producer', () => {
    const wire = {
        primary: { kind: 'town', label: 'Randtown', place: 'Randtown' },
        subjects: [{ kind: 'squad', label: 'Chimera Squad' }],
        drilled: { kind: 'town', label: 'Randtown', place: 'Randtown' },
        surfaces: ['command-console'],
        selected: 8,
    };

    it('reads a FocusModel through nlFocus()', () => {
        const snap = focusViewFrom({ nlFocus: () => wire });
        expect(snap?.drilled?.place).toBe('Randtown');
        expect(snap?.selectionCount).toBe(8);
    });

    it('reads lane 9’s store through getFocus()', () => {
        const snap = focusViewFrom({ getFocus: () => wire });
        expect(snap?.subjects.map((s) => s.label)).toEqual(['Chimera Squad']);
        expect(snap?.openSurfaces).toEqual(['command-console']);
    });

    it('accepts the wire shape directly, mapping surfaces/selected', () => {
        const snap = focusViewFrom(wire);
        expect(snap?.openSurfaces).toEqual(['command-console']);
        expect(snap?.selectionCount).toBe(8);
    });

    it('accepts an already-normalised snapshot unchanged', () => {
        const snap = focusViewFrom(view({ drilled: town('Randtown'), selectionCount: 3 }));
        expect(snap?.drilled?.label).toBe('Randtown');
        expect(snap?.selectionCount).toBe(3);
    });

    it('infers primary from a single subject, and refuses to from several', () => {
        expect(focusViewFrom({ subjects: [{ kind: 'squad', label: 'Chimera Squad' }] })?.primary?.label)
            .toBe('Chimera Squad');
        expect(focusViewFrom({
            subjects: [{ kind: 'squad', label: 'Chimera Squad' }, { kind: 'squad', label: 'Basilisk Squad' }],
        })?.primary).toBeNull();
    });

    it('carries contract v2’s camera place, asked and brief target', () => {
        const snap = focusViewFrom({
            subjects: [],
            drilled: {
                kind: 'proposal', label: 'Ceasefire at Osprey Fen',
                place: 'Osprey Fen', target: 'Raider column near Osprey Fen',
            },
            camera: { place: 'Northgate' },
            asked: { question: 'Which one?', options: ['a', 'b'] },
        });
        expect(snap?.cameraPlace).toBe('Northgate');
        expect(snap?.asked).toEqual({ question: 'Which one?', options: ['a', 'b'] });
        expect(snap?.drilled?.target).toBe('Raider column near Osprey Fen');
    });

    it('drops a malformed brief rather than carrying a half one', () => {
        // A producer mid-refactor sends a brief with no label. Binding against
        // it would produce `target: {name: undefined}`, which the validator
        // rejects three layers later with a message about the wrong thing.
        const snap = focusViewFrom({ subjects: [{ kind: 'squad' }, { kind: 'squad', label: 'Ok' }] });
        expect(snap?.subjects.map((s) => s.label)).toEqual(['Ok']);
    });

    it('a primitive is null, not a throw', () => {
        for (const input of [null, undefined, 42, 'focus', true, () => {}]) {
            expect(focusViewFrom(input)).toBeNull();
        }
    });

    it('an object with no focus fields is an EMPTY focus, not null', () => {
        // Deliberate, and the distinction does not matter downstream: the
        // binder treats a null focus and an empty one identically (a pronoun
        // with nothing to point at refuses either way). What it must not do is
        // throw on a producer that has come up but has nothing selected yet.
        for (const input of [{}, [], { unrelated: 1 }]) {
            expect(focusViewFrom(input)).toEqual({
                primary: null, subjects: [], drilled: null,
                openSurfaces: [], selectionCount: 0,
            });
        }
    });

    it('round-trips through the wire shape without losing a field', () => {
        const snap = focusViewFrom(wire)!;
        expect(focusViewFromContext(focusContextFor(snap))).toEqual(snap);
    });
});

// ─────────────────────────── target elision (contract v2) ───────────────────────────

describe('a verb with no target at all', () => {
    const bare = (verb: string): NLResponse => ({
        actions: [{ kind: 'command', intent: { verb: verb as 'attack', subject: { type: 'any' } } }],
    });

    it('takes the drilled panel’s place, and says the focus supplied it', () => {
        const { response, bindings } = bindFocusReferences(bare('attack'), view({ drilled: town('Randtown') }));
        expect(intentOf(response).target).toEqual({ type: 'entity-ref', name: 'Randtown' });
        expect(bindings).toEqual([{
            actionIndex: 0, slot: 'target', phrase: '',
            label: 'Randtown', source: 'drilled', elided: true,
        }]);
    });

    it('elides for every verb that can take a place', () => {
        for (const verb of ['attack', 'secure', 'defend', 'hold', 'patrol', 'screen', 'scout', 'reinforce', 'build']) {
            const { response } = bindFocusReferences(bare(verb), view({ drilled: town('Randtown') }));
            expect(intentOf(response).target, verb).toEqual({ type: 'entity-ref', name: 'Randtown' });
        }
    });

    it('never elides for withdraw or escort', () => {
        // `withdraw`'s empty target is the departure zone, and an open town must
        // not turn "pull back" into "pull back INTO the town". `escort`'s
        // drilled thing is what would be escorted, not where to.
        for (const verb of ['withdraw', 'escort']) {
            const { response, bindings } = bindFocusReferences(bare(verb), view({ drilled: town('Randtown') }));
            expect(intentOf(response).target, verb).toBeUndefined();
            expect(bindings, verb).toEqual([]);
        }
    });

    it('elides from the DRILLED panel only, never from the camera or the selection', () => {
        const fromCamera = bindFocusReferences(bare('attack'), view({ cameraPlace: 'Northgate' }));
        expect(intentOf(fromCamera.response).target).toBeUndefined();

        const fromSelection = bindFocusReferences(
            bare('attack'), view({ subjects: [town('Randtown')], selectionCount: 1 }));
        expect(intentOf(fromSelection.response).target).toBeUndefined();
    });

    it('leaves the sentence alone when nothing is drilled', () => {
        const before = bare('attack');
        const { response, bindings } = bindFocusReferences(before, view());
        expect(response).toBe(before);       // same object: nothing to bind
        expect(bindings).toEqual([]);
    });

    it('a drilled panel with no PLACE supplies nothing', () => {
        // A squad's panel is a thing, not somewhere. Guessing its centroid
        // would aim the order at a position the player never named.
        const { response } = bindFocusReferences(bare('attack'), view({ drilled: squad('Chimera Squad') }));
        expect(intentOf(response).target).toBeUndefined();
    });
});

// ─────────────────────────── the events query (contract v2) ───────────────────────────

describe('"what’s happening there"', () => {
    const near = (name: string): NLResponse => ({
        actions: [{ kind: 'query', query: { op: 'events', near: name } }],
    });
    const queryOf = (r: NLResponse) => {
        const a = r.actions[0];
        if (a.kind !== 'query') throw new Error(`expected a query, got ${a.kind}`);
        return a.query;
    };

    it('binds its place by the same rule an order’s target uses', () => {
        const { response } = bindFocusReferences(near('there'), view({ drilled: town('Randtown') }));
        expect(queryOf(response)).toEqual({ op: 'events', near: 'Randtown' });
    });

    it('leaves a named place alone', () => {
        const before = near('Slag Forge');
        expect(bindFocusReferences(before, view({ drilled: town('Randtown') })).response).toBe(before);
    });

    it('refuses by name when the pronoun has no antecedent', () => {
        const { response } = bindFocusReferences(near('there'), view());
        expect(refusalOf(response)).toMatch(/there/);
    });

    it('a query with no `near` at all is untouched', () => {
        const before: NLResponse = { actions: [{ kind: 'query', query: { op: 'events' } }] };
        expect(bindFocusReferences(before, view({ drilled: town('Randtown') })).response).toBe(before);
    });
});
