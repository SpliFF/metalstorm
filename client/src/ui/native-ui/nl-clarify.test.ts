/**
 * nl-clarify.test.ts — what a chip tap does
 * (PLAN-metalstorm-command-language.md §4/§5, milestone M5)
 *
 * The console widget has no test environment (no jsdom — see
 * command-composer.test.ts), which is exactly why the DECISION half of the chip
 * flow lives in `nl-clarify.ts` and not in the widget. This suite covers it:
 * which questions can be answered without the model, what the patched envelope
 * looks like, and — the part that matters most — which ones must NOT be
 * patched, because a wrong patch is an order the player never confirmed.
 *
 * The end-to-end half (question → patch → executor → sendCommand) runs against
 * the real fixture worlds, so the answer is proved to move the squads the player
 * actually picked and no others.
 */

import { describe, it, expect } from 'vitest';
import { answerLocally, isCancel, resubmissionText, type PendingClarification } from './nl-clarify.js';
import { executeNLResponse, type NLSentCommand } from './nl-executor.js';
import { validateNLResponse, type NLResponse } from './nl-envelope.js';
import { buildFixtureWorld } from './nl-fixtures/fixture-world.js';
import { loadContexts, loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

const vocabulary = loadVocabulary();
const contexts = loadContexts();

/** Ask the question a sentence raises, on a real board, and hand back
 *  everything the console would be holding when the chips appear. */
function ask(contextKey: string, utterance: string, response: NLResponse) {
    const world = buildFixtureWorld(contexts[contextKey], vocabulary);
    const sent: NLSentCommand[] = [];
    const ports = {
        sendCommand: (cmd: unknown) => sent.push(cmd as NLSentCommand),
        resolver: world.resolver,
        console: { say: () => {} },
        ...world.ports,
    };
    const report = executeNLResponse(response, ports);
    const pending: PendingClarification = {
        utterance,
        response,
        ...(report.clarifyContext ? { context: report.clarifyContext } : {}),
        options: report.clarification?.options ?? [],
        pick: report.clarification?.pick ?? 1,
    };
    return { world, ports, sent, report, pending };
}

/** Answer it, and run whatever comes back. */
function answer(asked: ReturnType<typeof ask>, chosen: string[]) {
    const patched = answerLocally(asked.pending, chosen);
    if (!patched) return { patched: null, sent: [] as NLSentCommand[] };
    const validation = validateNLResponse(patched, { vocabulary });
    expect(validation.ok, JSON.stringify((validation as { errors?: string[] }).errors)).toBe(true);
    const sent: NLSentCommand[] = [];
    executeNLResponse(patched, { ...asked.ports, sendCommand: (cmd) => sent.push(cmd as NLSentCommand) });
    return { patched, sent };
}

const groupIds = (sent: NLSentCommand[]) =>
    sent.map((c) => (c as { payload?: { groupId?: number } }).payload?.groupId);

describe('the acceptance flow: which two tank squads?', () => {
    const utterance = 'move 2 tank squads to Randtown';
    const envelope: NLResponse = {
        actions: [{
            kind: 'command',
            intent: {
                verb: 'secure',
                subject: { type: 'class-count', class: 'tanks', count: 2 },
                target: { type: 'entity-ref', name: 'Randtown' },
            },
        }],
    };

    it('asks, sends nothing, and offers the callsigns as a two-pick question', () => {
        const asked = ask('three-idle-tanks', utterance, envelope);
        expect(asked.sent).toEqual([]);
        expect(asked.report.clarification?.pick).toBe(2);
        expect(asked.pending.options).toEqual([
            'Chimera Squad', 'Basilisk Squad', 'Warhound Squad', 'cancel',
        ]);
        expect(asked.report.clarifyContext).toEqual({
            actionIndex: 0, slot: 'subject', patchable: true,
        });
    });

    it('picking two chips executes exactly those two, locally', () => {
        const asked = ask('three-idle-tanks', utterance, envelope);
        const { patched, sent } = answer(asked, ['Chimera Squad', 'Warhound Squad']);

        // One directive per named squad — the class-count fan-out, but named.
        expect(patched?.actions).toHaveLength(2);
        expect(sent.map((c) => c.type)).toEqual(['GroupDirective', 'GroupDirective']);
        expect(groupIds(sent)).toEqual([1, 3]);
    });

    it('the squad that was NOT picked is not touched', () => {
        const asked = ask('three-idle-tanks', utterance, envelope);
        const { sent } = answer(asked, ['Basilisk Squad', 'Warhound Squad']);
        expect(groupIds(sent)).toEqual([2, 3]);
        expect(groupIds(sent)).not.toContain(1);
    });

    it('every directive keeps the target and priority of the original order', () => {
        const asked = ask('three-idle-tanks', utterance, {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'secure',
                    subject: { type: 'class-count', class: 'tanks', count: 2 },
                    target: { type: 'entity-ref', name: 'Randtown' },
                    priority: 'urgent',
                },
            }],
        });
        const { sent } = answer(asked, ['Chimera Squad', 'Warhound Squad']);
        for (const cmd of sent) {
            const payload = (cmd as { payload: { params: number[]; priority: number } }).payload;
            expect(payload.params).toEqual([1000, 0, 1000]);   // Randtown
            expect(payload.priority).toBe(100);                // urgent
        }
    });

    it('drops the acknowledgement, which was written before the answer existed', () => {
        const asked = ask('three-idle-tanks', utterance, {
            say: 'Moving 2 tank squads to Randtown.',
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'secure',
                    subject: { type: 'class-count', class: 'tanks', count: 2 },
                    target: { type: 'entity-ref', name: 'Randtown' },
                },
            }],
        });
        const { patched } = answer(asked, ['Chimera Squad', 'Warhound Squad']);
        expect(patched?.say).toBeUndefined();
    });
});

describe('the other slots a question can come from', () => {
    it('a target', () => {
        const asked = ask('ambiguous-places', 'attack Rand', {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'attack', subject: { type: 'any' },
                    target: { type: 'entity-ref', name: 'Rand' },
                },
            }],
        });
        expect(asked.report.clarifyContext?.slot).toBe('target');
        const { patched, sent } = answer(asked, ['Randtown East']);
        expect((patched?.actions[0] as { intent: { target: { name: string } } }).intent.target.name)
            .toBe('Randtown East');
        expect(sent).toHaveLength(1);
    });

    it('a subject named by a partial callsign', () => {
        const asked = ask('ambiguous-forces', 'Chimera, attack Northgate', {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'attack', subject: { type: 'entity-ref', name: 'Chimera' },
                    target: { type: 'entity-ref', name: 'Northgate' },
                },
            }],
        });
        const { sent } = answer(asked, ['Chimera Reserve']);
        expect(groupIds(sent)).toEqual([6]);
    });

    it('a guidance ref', () => {
        const asked = ask('ambiguous-places', 'prioritise Rand', {
            actions: [{ kind: 'guidance', guidance: { op: 'paint', value: 'priority', regionRef: 'Rand' } }],
        });
        expect(asked.report.clarifyContext?.slot).toBe('guidance-ref');
        const { sent } = answer(asked, ['Randtown East']);
        expect(sent).toEqual([{
            type: 'LuaRulesMsg', data: 'cmd=guidance.paint&regionKey=randtown_e&value=priority',
        }]);
    });

    it('a camera target', () => {
        const asked = ask('ambiguous-places', 'zoom to Rand', {
            actions: [{ kind: 'camera', camera: { op: 'focus', targetRef: 'Rand' } }],
        });
        expect(asked.report.clarifyContext?.slot).toBe('camera-target');
        const { patched } = answer(asked, ['Randtown']);
        expect(patched).not.toBeNull();
    });
});

describe('what must NOT be answered locally', () => {
    /** A pending question with no envelope behind it — what the console holds
     *  after a `clarify` the MODEL sent. */
    const modelAsked: PendingClarification = {
        utterance: 'send the tanks in',
        options: ['Chimera Squad', 'Basilisk Squad'],
        pick: 1,
    };

    it('a question the model asked has nothing to patch', () => {
        expect(answerLocally(modelAsked, ['Chimera Squad'])).toBeNull();
    });

    it('two places with the identical name — patching would ask forever', () => {
        const asked = ask('same-name-places', 'defend West Scarp', {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'defend', subject: { type: 'any' },
                    target: { type: 'entity-ref', name: 'West Scarp' },
                },
            }],
        });
        expect(asked.report.clarifyContext?.patchable).toBe(false);
        expect(answerLocally(asked.pending, ['West Scarp (district)'])).toBeNull();
    });

    it('cancel is never an answer', () => {
        const asked = ask('three-idle-tanks', 'move 2 tank squads to Randtown', {
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'secure',
                    subject: { type: 'class-count', class: 'tanks', count: 2 },
                    target: { type: 'entity-ref', name: 'Randtown' },
                },
            }],
        });
        expect(answerLocally(asked.pending, ['cancel'])).toBeNull();
        expect(answerLocally(asked.pending, [])).toBeNull();
    });

    it('an answer that would overflow the action ceiling goes to the model', () => {
        // Three squads picked, plus two other actions in the plan, is five —
        // and trimming one would drop a squad the player just chose.
        const asked = ask('three-idle-tanks', 'move 3 tank squads to Randtown, then go defensive', {
            actions: [
                {
                    kind: 'command',
                    intent: {
                        verb: 'secure',
                        subject: { type: 'class-count', class: 'tanks', count: 3 },
                        target: { type: 'entity-ref', name: 'Northgate' },
                    },
                },
                { kind: 'guidance', guidance: { op: 'stance', value: 'defensive' } },
                { kind: 'guidance', guidance: { op: 'roe', value: 'free' } },
            ],
        });
        // Force the question by hand: this board resolves 3-of-3 without asking,
        // so the pending state is synthesised to test the ceiling rule alone.
        const pending: PendingClarification = {
            utterance: 'move 3 tank squads to Northgate, then go defensive',
            response: asked.pending.response,
            context: { actionIndex: 0, slot: 'subject', patchable: true },
            options: ['Chimera Squad', 'Basilisk Squad', 'Warhound Squad'],
            pick: 3,
        };
        expect(answerLocally(pending, ['Chimera Squad', 'Basilisk Squad', 'Warhound Squad']))
            .toBeNull();
    });
});

describe('the resubmission sentence', () => {
    it('is the original plus the choice, which is what the model needs', () => {
        expect(resubmissionText('move 2 tank squads to Randtown', ['Chimera Squad']))
            .toBe('move 2 tank squads to Randtown. Chimera Squad');
    });

    it('joins several picks the way a player would say them', () => {
        expect(resubmissionText('send the tanks in', ['Chimera Squad', 'Warhound Squad']))
            .toBe('send the tanks in. Chimera Squad and Warhound Squad');
    });

    it('does not double the punctuation of a sentence that ended in a full stop', () => {
        expect(resubmissionText('attack Rand.', ['Randtown']))
            .toBe('attack Rand. Randtown');
    });

    it('recognises the cancel chip however it is cased', () => {
        expect(isCancel('cancel')).toBe(true);
        expect(isCancel(' Cancel ')).toBe(true);
        expect(isCancel('Chimera Squad')).toBe(false);
    });
});
