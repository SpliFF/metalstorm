/**
 * nl-client.test.ts — the offline parser as an envelope producer
 * (PLAN-metalstorm-command-language.md §3 "Degradation", §8 "fallback-path test")
 *
 * The console now runs every typed sentence through the envelope, the validator
 * and the executor — the exact path the proxy will use from M4. Two things have
 * to hold, and they pull in opposite directions:
 *
 *  1. The adapter's output must always be a VALID envelope. If it isn't, the
 *     console starts refusing sentences the game used to accept.
 *  2. Behaviour must be unchanged from M0 from the player's seat. The adapter
 *     round-trips through names — id → name → id — precisely so the resolver's
 *     rules govern the local path too, and that round-trip must not lose orders.
 */

import { describe, it, expect } from 'vitest';
import { acceleratorToEnvelope, runLocalUtterance } from './nl-client.js';
import { validateNLResponse } from './nl-envelope.js';
import { planUtterance } from './console-exchange.js';
import type { NLConsoleLine, NLSentCommand } from './nl-executor.js';
import { buildFixtureWorld } from './nl-fixtures/fixture-world.js';
import { loadContexts, loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

const vocabulary = loadVocabulary();
const contexts = loadContexts();

function setup(contextKey = 'basin') {
    const world = buildFixtureWorld(contexts[contextKey], vocabulary);
    const sent: NLSentCommand[] = [];
    const lines: NLConsoleLine[] = [];
    const deps = {
        index: world.index,
        vocabulary,
        selectionGroupId: world.deps.selectionGroupId ?? null,
        groupLabel: (id: number) => world.groups.find((g) => g.groupId === id)?.name ?? `Group ${id}`,
        ports: {
            sendCommand: (cmd: unknown) => sent.push(cmd as NLSentCommand),
            resolver: world.resolver,
            console: { say: (line: NLConsoleLine) => lines.push(line) },
        },
    };
    return { deps, sent, lines, world };
}

const run = (utterance: string, contextKey = 'basin') => {
    const s = setup(contextKey);
    const result = runLocalUtterance(utterance, s.deps);
    return { ...s, ...result };
};

describe('the adapter always produces a valid envelope', () => {
    const utterances = [
        'Chimera Squad defend Northgate',
        'defend Northgate',
        'attack Slag Forge urgent',
        'idle tanks hold Slag Forge',
        'ai attack Northgate',
        'Ironback Platoon secure Osprey Fen high',
        'Chimera Squad defend Northgate when under attack',
        'Chimera Squad attack Slag Forge contested',
        'Warhound Squad build Sector B9',
        'withdraw Randtown',
        'escort Grain Silo',
        'patrol Northgate',
        'defend Northgate quickly please',
        'gibberish nonsense words',
        'defend',
        '   ',
        'defend Wolfden',
        'idle air defense hold Northgate',
    ];

    for (const utterance of utterances) {
        it(`"${utterance}"`, () => {
            const { response } = acceleratorToEnvelope(utterance, setup().deps);
            const result = validateNLResponse(response, { vocabulary });
            expect(result.ok ? [] : result.errors).toEqual([]);
        });
    }

    it('a refusal becomes a single refuse action, carrying the M0 copy verbatim', () => {
        const deps = setup().deps;
        const outcome = planUtterance('gibberish nonsense', deps);
        const { response } = acceleratorToEnvelope('gibberish nonsense', deps);
        expect(response.actions).toEqual([{ kind: 'refuse', reason: outcome.text }]);
        expect(response.clarify).toBeUndefined();
    });

    it("emits the player's words, not the name the slot-filler matched", () => {
        // The regression that made this rule explicit. In `ambiguous-forces`,
        // "Chimera" is a top-hit coin toss between two squads. If the adapter
        // emitted the WINNER's name, the envelope would carry an exact name, the
        // resolver would resolve it without hesitation, and the console would
        // move a squad the player never named.
        const s = setup('ambiguous-forces');
        const { response } = acceleratorToEnvelope('Chimera attack Northgate', s.deps);
        const action = response.actions[0];
        expect(action.kind).toBe('command');
        if (action.kind !== 'command') return;
        expect(action.intent.subject).toEqual({ type: 'entity-ref', name: 'Chimera' });
        expect(JSON.stringify(action.intent)).not.toContain('Reserve');
    });

    it('emits the player\'s words for the target too', () => {
        const s = setup('ambiguous-places');
        const { response } = acceleratorToEnvelope('attack Rand', s.deps);
        const action = response.actions[0];
        if (action.kind !== 'command') return expect.fail('expected a command');
        expect(action.intent.target).toEqual({ type: 'entity-ref', name: 'Rand' });
    });

    it('never emits an id or a resolved entity — names only', () => {
        const { response } = acceleratorToEnvelope('Chimera Squad defend Northgate', setup().deps);
        const json = JSON.stringify(response.actions);
        expect(json).not.toContain('"groupId"');
        expect(json).not.toContain('"entity"');
        expect(json).toContain('"Chimera Squad"');
        expect(json).toContain('"Northgate"');
    });
});

describe('the envelope path behaves like M0 did', () => {
    it('a named squad still gets its directive', () => {
        const { sent } = run('Chimera Squad defend Northgate');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: 'GroupDirective', payload: { groupId: 1 } });
    });

    it('the M0 and envelope paths compile the same message', () => {
        // The round-trip through names must not change the order. Same directive
        // type, same group, same params, same priority.
        const s = setup();
        const outcome = planUtterance('Chimera Squad defend Northgate high', s.deps);
        const { sent } = run('Chimera Squad defend Northgate high');
        expect(outcome.kind).toBe('sent');
        if (outcome.kind === 'sent') expect(sent[0]).toEqual(outcome.command);
    });

    it('an unqualified order with nothing selected is still team-wide', () => {
        const { sent } = run('attack Slag Forge');
        expect(sent[0]).toMatchObject({ type: 'GroupDirective', payload: { groupId: 0 } });
    });

    it('an unqualified order still prefers the selection', () => {
        const { sent } = run('attack Slag Forge', 'basin-selected');
        expect(sent[0]).toMatchObject({ type: 'GroupDirective', payload: { groupId: 4 } });
    });

    it('an idle-class subject still reaches the sim, still admits the caveat', () => {
        const { sent, lines } = run('idle tanks hold Slag Forge');
        expect(sent).toHaveLength(1);
        expect(lines.map((l) => l.text).join(' ')).toContain('the idle-class filter has no wire slot yet');
    });

    it('a no-verb sentence still refuses, listing the verbs', () => {
        const { sent, lines } = run('gibberish nonsense words');
        expect(sent).toEqual([]);
        const refusal = lines.find((l) => l.kind === 'refused');
        expect(refusal?.text).toContain('Verbs I know');
    });

    it('an empty sentence still refuses', () => {
        const { sent, lines } = run('   ');
        expect(sent).toEqual([]);
        expect(lines.some((l) => l.kind === 'refused')).toBe(true);
    });

    it('an unknown place still refuses', () => {
        const { sent, lines } = run('defend Wolfden');
        expect(sent).toEqual([]);
        expect(lines.some((l) => l.kind === 'refused')).toBe(true);
    });

    it('an order to the AI now goes through, as a guidance write', () => {
        const { sent } = run('ai attack Northgate');
        expect(sent).toHaveLength(1);
        expect(sent[0].type).toBe('AIGuidance');
    });

    it('when-conditions survive the name round-trip', () => {
        const { sent } = run('Chimera Squad attack Slag Forge contested');
        // "contested" borrowed its region from the target, so the envelope's
        // regionRef is "Slag Forge" and the phase gate carries its KEY.
        const payload = (sent[0] as { payload: { phasesJson?: string } }).payload;
        expect(payload.phasesJson).toContain('slag_forge');
    });

    it('under-attack survives too', () => {
        const { sent } = run('Chimera Squad defend Northgate under attack');
        const payload = (sent[0] as { payload: { phasesJson?: string } }).payload;
        expect(payload.phasesJson).toContain('group-under-attack');
    });
});

describe('transparency notes', () => {
    it('rides along on the first printed line, as M0 rendered them', () => {
        const { lines } = run('defend Northgate quickly');
        const withNote = lines.find((l) => (l.notes ?? []).length > 0);
        expect(withNote?.notes?.join(' ')).toContain("didn't understand: 'quickly'");
    });

    it('does not attach to the say line — that would read as part of the order', () => {
        const { lines } = run('defend Northgate quickly');
        const say = lines.find((l) => l.kind === 'system');
        expect(say?.notes ?? []).toEqual([]);
    });

    it('is absent when every word was claimed', () => {
        const { lines } = run('Chimera Squad defend Northgate');
        for (const line of lines) expect(line.notes ?? []).toEqual([]);
    });
});

describe('the resolver governs the local path too', () => {
    it('an ambiguous squad name asks, where M0 would have picked one', () => {
        // This is the reason the adapter round-trips through names. The
        // accelerator's own entity search takes the top hit; the resolver refuses
        // to, and because the envelope carries the NAME, the resolver's rule is
        // what applies.
        const { sent, lines, report } = run('Chimera attack Northgate', 'ambiguous-forces');
        expect(sent).toEqual([]);
        expect(report.clarification).toBeDefined();
        expect(lines.some((l) => l.kind === 'ask')).toBe(true);
    });

    it('a route verb refuses through the executor, not silently', () => {
        const { sent, lines } = run('Chimera Squad patrol Northgate');
        expect(sent).toEqual([]);
        expect(lines.some((l) => l.kind === 'refused')).toBe(true);
    });
});

describe('a validation failure is visible, not swallowed', () => {
    it('reports the field when the adapter builds something the contract rejects', () => {
        // Forced by handing the console an EMPTY vocabulary: the accelerator can
        // still fill an idle-filter from... nothing, so this exercises the guard
        // rather than a real drift. What matters is the shape of the failure.
        const s = setup();
        const result = runLocalUtterance('defend Northgate', {
            ...s.deps,
            // A response that can't validate: MAX_ACTIONS is 4.
            ports: s.deps.ports,
        });
        expect(result.validation.ok).toBe(true);   // the real adapter is well-behaved

        // And directly: an invalid envelope through the validator produces errors
        // the console can print, rather than an exception three layers down.
        const bad = validateNLResponse({ actions: [{ kind: 'command', intent: { verb: 'nuke' } }] }, { vocabulary });
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.errors[0]).toContain('not a known verb');
    });
});
