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
    bindFocusReferences, focusContextFor, findSubjectDeictic, findTargetDeictic,
    isSubjectDeictic, isTargetDeictic,
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
