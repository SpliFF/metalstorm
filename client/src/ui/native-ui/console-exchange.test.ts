/**
 * console-exchange.test.ts — what one typed sentence does
 * (PLAN-metalstorm-command-language.md M0)
 *
 * The console widget is DOM + wiring; every decision it makes comes from
 * `planUtterance`, so this is where the console's behaviour is actually
 * pinned: what executes, what refuses, and what the player is told either way.
 * The hard rule under test throughout is "no silent no-ops" — every utterance
 * produces a command or a refusal with a reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planUtterance, type ExchangeDeps } from './console-exchange.js';
import { NamedEntityIndex, type NamedEntity } from './named-entity-index.js';
import { ClassVocabulary } from './class-vocabulary.js';
import { DirectiveType, OrderShape, StandingOrderType } from './compile-table.js';

/** The shipped vocabulary, not a stub — see free-text-accelerator.test.ts. */
const VOCABULARY = ClassVocabulary.fromData(JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
         'data', 'games', 'metalstorm', 'ui', 'class-vocabulary.json'),
    'utf8',
)));

const NORTHGATE: NamedEntity = { id: 'northgate', type: 'region', name: 'Northgate', x: 800, z: 1200 };
const CHIMERA: NamedEntity = { id: 4, type: 'group', name: 'Chimera Squad', x: 0, z: 0 };

function deps(overrides: Partial<ExchangeDeps> = {}): ExchangeDeps {
    const index = new NamedEntityIndex();
    index.add(NORTHGATE);
    index.add(CHIMERA);
    return { index, vocabulary: VOCABULARY, ...overrides };
}

describe('planUtterance — executing a sentence', () => {
    it('turns "defend <region>" with a selected group into a group directive', () => {
        const outcome = planUtterance('defend Northgate', deps({
            selectionGroupId: 4,
            groupLabel: () => 'Chimera Squad',
        }));

        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.command).toEqual({
            type: 'GroupDirective',
            payload: {
                directiveId: 0,
                groupId: 4,
                directiveType: DirectiveType.Defend,
                priority: 50,
                shape: OrderShape.Point,
                params: [800, 0, 1200],
                requestedStrength: 0,
                phasesJson: undefined,
            },
        });
        // The echo says who acted, on what, and that it took effect.
        expect(outcome.text).toContain('Chimera Squad (selected)');
        expect(outcome.text).toContain('defend Northgate');
        expect(outcome.text).toContain('directive issued');
        expect(outcome.notes).toEqual([]);
    });

    it('reads priority and the group named in the sentence', () => {
        const outcome = planUtterance('chimera squad attack Northgate urgent', deps());
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.command.type).toBe('GroupDirective');
        expect(outcome.command.payload).toMatchObject({
            groupId: 4, directiveType: DirectiveType.Assault, priority: 100,
        });
        expect(outcome.text).toContain('urgent priority');
        // Named explicitly, so it must NOT be labelled as coming from the
        // selection.
        expect(outcome.text).not.toContain('(selected)');
    });

    it('falls back to a team-wide order when nothing is selected, and says so', () => {
        const outcome = planUtterance('defend Northgate', deps({ selectionGroupId: null }));
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        // compile-table's own rule: no specific group ⇒ standing order.
        expect(outcome.command).toMatchObject({
            type: 'StandingOrder',
            payload: { orderType: StandingOrderType.DefendArea, priority: 50 },
        });
        expect(outcome.text).toContain('standing order set');
    });

    it('carries a when-condition through to the compiled phase gate', () => {
        const outcome = planUtterance('defend Northgate when contested', deps({ selectionGroupId: 4 }));
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.intent.when).toEqual({ type: 'region-contested', regionId: 'northgate' });
        expect(outcome.command.type).toBe('GroupDirective');
        expect(outcome.command.payload).toMatchObject({
            phasesJson: JSON.stringify({ type: 'region-state', regionId: 'northgate', state: 'contested' }),
        });
        expect(outcome.text).toContain('when contested');
    });

    it('reports words it did not understand alongside an order it did execute', () => {
        const outcome = planUtterance('defend Northgate quickly', deps({ selectionGroupId: 4 }));
        expect(outcome.kind).toBe('sent');
        expect(outcome.notes).toEqual(["didn't understand: 'quickly'"]);
    });

    it('names an idle-class subject in the sim\'s terms, spoken back in the player\'s', () => {
        const outcome = planUtterance('idle statics hold Northgate', deps());
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.intent.subject).toEqual({ type: 'idle-filter', filterClass: 'staticdefense' });
        expect(outcome.text).toContain('idle defenses');
    });

    it('echoes the scale it heard rather than silently widening the class', () => {
        const outcome = planUtterance('idle heavy tanks attack Northgate', deps());
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.text).toContain('idle heavy tanks');
    });

    it('admits that an idle-class subject reaches the sim unfiltered', () => {
        // compile-table has no wire slot for `filterClass` — the directive it
        // produces is plain groupId-0. Saying "directive issued" flat would
        // read as "the tanks specifically", which is not what happens.
        const outcome = planUtterance('idle heavy tanks attack Northgate', deps({ selectionGroupId: 4 }));
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.command.type).toBe('GroupDirective');
        expect(outcome.command.payload).toMatchObject({ groupId: 0 });
        expect(outcome.text).toContain('the idle-class filter has no wire slot yet');
        // …and it must NOT be reported as "no group selected": a class subject
        // WAS given, it just doesn't survive compilation.
        expect(outcome.text).not.toContain('no group selected');
    });
});

describe('planUtterance — refusing out loud', () => {
    it('refuses gibberish instead of doing nothing', () => {
        const outcome = planUtterance('asdf qwer zxcv', deps());
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') return;
        expect(outcome.reason).toBe('no-verb');
        // The refusal has to teach: it lists the vocabulary it does know.
        expect(outcome.text).toContain('defend');
        expect(outcome.notes).toEqual(["didn't understand: 'asdf', 'qwer', 'zxcv'"]);
    });

    it('refuses a sentence with a subject and a place but no verb', () => {
        const outcome = planUtterance('chimera squad Northgate please', deps());
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') return;
        expect(outcome.reason).toBe('no-verb');
    });

    it('refuses a verb with no place it can find, quoting the words that failed', () => {
        const outcome = planUtterance('defend the grain silo', deps());
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') return;
        expect(outcome.reason).toBe('no-target');
        expect(outcome.text).toContain("'grain'");
        expect(outcome.text).toContain('defend Northgate');
    });

    it('refuses a verb:shape pair the compile table rejects', () => {
        // patrol only compiles against a route; an entity target is invalid,
        // and must be refused rather than quietly recompiled as something else.
        const outcome = planUtterance('patrol Northgate', deps({ selectionGroupId: 4 }));
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') return;
        expect(outcome.reason).toBe('invalid-intent');
        // Wording is owned by main's compile-table.ts (composer-wire lane):
        // "<verb> cannot take a named place — it needs a route drawn on the map".
        expect(outcome.text).toContain('patrol cannot take a named place');
        expect(outcome.text).toContain('Nothing sent');
    });

    it('sends an order to the AI, and echoes what the STORE now holds', () => {
        // This used to be a refusal: compileIntent produced AIGuidance happily,
        // but createSendCommand dropped it, so reporting success would have been
        // a lie. M1's guidance bridge (guidance-wire.ts) made it a real send —
        // and the echo names the store write, not the sentence, because the
        // guidance store paints regions and sets stances; it takes no directives.
        const outcome = planUtterance('ai attack Northgate', deps());
        expect(outcome.kind).toBe('sent');
        if (outcome.kind !== 'sent') return;
        expect(outcome.command.type).toBe('AIGuidance');
        expect(outcome.text).toContain('is now priority for the AI');
    });

    it('refuses an empty utterance', () => {
        const outcome = planUtterance('   ', deps());
        expect(outcome.kind).toBe('refused');
        if (outcome.kind !== 'refused') return;
        expect(outcome.reason).toBe('empty');
    });

    it('still parses verbs when the class vocabulary failed to load', () => {
        // A missing vocabulary costs class keywords, nothing else — the rest
        // of the sentence must keep working.
        const outcome = planUtterance('defend Northgate', deps({
            vocabulary: ClassVocabulary.empty(), selectionGroupId: 4,
        }));
        expect(outcome.kind).toBe('sent');
    });

    it('never returns an outcome with neither a command nor a reason', () => {
        const utterances = [
            'defend Northgate', 'asdf', 'patrol Northgate', 'ai attack Northgate',
            'idle air defense attack Northgate', 'attack', '   ', 'build Northgate',
            'escort chimera squad', 'withdraw Northgate high',
        ];
        for (const utterance of utterances) {
            const outcome = planUtterance(utterance, deps({ selectionGroupId: 4 }));
            expect(outcome.text.length, utterance).toBeGreaterThan(0);
            if (outcome.kind === 'sent') expect(outcome.command, utterance).toBeTruthy();
            else expect(outcome.reason, utterance).toBeTruthy();
        }
    });
});
