/**
 * nl-executor.test.ts — every golden fixture, through fake ports
 * (PLAN-metalstorm-command-language.md §8)
 *
 * This is the suite that makes the fixtures load-bearing rather than decorative:
 * each `expected` envelope is executed against a recording `sendCommand` and the
 * exact dispatch calls are asserted — "move 2 tank squads to Randtown" really
 * does have to produce two GroupDirective sends, to groups 1 and 3, in that
 * order.
 *
 * It also pins the two structural rules the whole layer exists for:
 *  - orders leave through `sendCommand` and nothing else (no `/api/exec`, no
 *    `ConsoleCommand`, no `window.test`), and
 *  - anything that cannot happen produces a visible refusal, never a silent
 *    success and never a guess.
 */

import { describe, it, expect } from 'vitest';
import {
    executeNLResponse,
    type ExecutorPorts, type NLCameraPort, type NLConsoleLine,
    type NLQueryPort, type NLSentCommand, type NLUiActionPort,
} from './nl-executor.js';
import type { NLResponse } from './nl-envelope.js';
import { buildFixtureWorld } from './nl-fixtures/fixture-world.js';
import { loadContexts, loadFixtures, loadVocabulary } from './nl-fixtures/load-fixtures.test-support.js';

const vocabulary = loadVocabulary();
const contexts = loadContexts();
const fixtures = loadFixtures();

interface Harness {
    ports: ExecutorPorts;
    sent: NLSentCommand[];
    lines: NLConsoleLine[];
    cameraCalls: string[];
    uiCalls: string[];
    queryCalls: string[];
}

function harness(contextKey: string, opts: { ports?: boolean } = {}): Harness {
    const world = buildFixtureWorld(contexts[contextKey], vocabulary);
    const sent: NLSentCommand[] = [];
    const lines: NLConsoleLine[] = [];
    const cameraCalls: string[] = [];
    const uiCalls: string[] = [];
    const queryCalls: string[] = [];

    const camera: NLCameraPort = {
        focus: (ref) => cameraCalls.push(`focus:${ref}`),
        follow: (ref) => cameraCalls.push(`follow:${ref}`),
        fitMap: () => cameraCalls.push('fitMap'),
        zoom: (dir) => cameraCalls.push(`zoom:${dir}`),
        saveView: (slot) => cameraCalls.push(`saveView:${slot}`),
        loadView: (slot) => cameraCalls.push(`loadView:${slot}`),
    };
    const uiActions: NLUiActionPort = {
        apply: (action) => { uiCalls.push(`${action.op}:${action.panelId}`); return action.panelId !== 'nope'; },
    };
    const queryEngine: NLQueryPort = {
        answer: (query) => { queryCalls.push(query.op); return query.op === 'status' ? null : `answer:${query.op}`; },
    };

    return {
        sent, lines, cameraCalls, uiCalls, queryCalls,
        ports: {
            sendCommand: (cmd) => sent.push(cmd as NLSentCommand),
            resolver: world.resolver,
            console: { say: (line) => lines.push(line) },
            ...(opts.ports ? { camera, uiActions, queryEngine } : {}),
        },
    };
}

/** `type` + groupId of each send, in the shape the fixtures declare. */
function sendShapes(sent: NLSentCommand[]): Array<{ type: string; groupId?: number; wire?: string }> {
    return sent.map((cmd) => {
        if (cmd.type === 'GroupDirective') return { type: cmd.type, groupId: cmd.payload.groupId };
        if (cmd.type === 'LuaRulesMsg') return { type: cmd.type, wire: cmd.data };
        if (cmd.type === 'OrgGroup') return { type: cmd.type, groupId: cmd.groupId };
        return { type: cmd.type };
    });
}

describe('every fixture dispatches exactly as declared', () => {
    for (const fixture of fixtures) {
        const expected = fixture.expect;
        if (!expected) continue;

        it(`${fixture.file} · ${fixture.name}`, () => {
            const h = harness(fixture.context);
            const report = executeNLResponse(fixture.expected, h.ports);

            if (expected.sends) {
                const actual = sendShapes(report.sent);
                expect(actual).toHaveLength(expected.sends.length);
                expected.sends.forEach((want, i) => {
                    expect(actual[i].type).toBe(want.type);
                    if (want.groupId !== undefined) expect(actual[i].groupId).toBe(want.groupId);
                    if (want.wire !== undefined) expect(actual[i].wire).toBe(want.wire);
                });
                // The report and the port must agree; a send recorded in one and
                // not the other would make every other assertion here worthless.
                expect(sendShapes(h.sent)).toEqual(actual);
            }

            if (expected.clarifies) {
                expect(report.clarification, 'expected a question').toBeDefined();
                expect(report.lines.some((l) => l.kind === 'ask')).toBe(true);
            } else {
                expect(report.clarification, 'did not expect a question').toBeUndefined();
            }

            if (expected.refusals !== undefined) {
                expect(report.refusals).toHaveLength(expected.refusals);
            }

            for (const fragment of expected.saysLike ?? []) {
                const all = report.lines.map((l) => l.text).join(' ⏎ ');
                expect(all, `no line contained "${fragment}"`).toContain(fragment);
            }
        });
    }

    it('the fixture set really does exercise multi-send fan-out', () => {
        // Guards the acceptance criterion itself: if every fixture asserted one
        // send, the loop above would pass while the fan-out was broken.
        const fanOut = fixtures.filter((f) =>
            (f.expect?.sends ?? []).filter((s) => s.type === 'GroupDirective').length >= 2);
        expect(fanOut.length).toBeGreaterThanOrEqual(1);
    });
});

describe('the acceptance case, spelled out', () => {
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

    it(`"${utterance}" ⇒ two GroupDirective sends`, () => {
        const h = harness('basin');
        const report = executeNLResponse(envelope, h.ports);

        expect(report.sent).toHaveLength(2);
        for (const cmd of report.sent) expect(cmd.type).toBe('GroupDirective');

        // Idle-first then nearest-to-Randtown: Chimera (idle, 900/1100) then
        // Warhound (idle, 2800/2800); busy Basilisk is not taken.
        expect(report.sent.map((c) => (c as { payload: { groupId: number } }).payload.groupId))
            .toEqual([1, 3]);
    });

    it('each directive carries the target coordinates and the priority band', () => {
        const h = harness('basin');
        const report = executeNLResponse(envelope, h.ports);
        for (const cmd of report.sent) {
            const payload = (cmd as { payload: { params: number[]; priority: number } }).payload;
            expect(payload.params).toEqual([1000, 0, 1000]);   // Randtown's centroid
            expect(payload.priority).toBe(50);                 // normal, the default band
        }
    });

    it('names each squad in the echo, so the player knows which two went', () => {
        const h = harness('basin');
        const report = executeNLResponse(envelope, h.ports);
        const text = report.lines.map((l) => l.text).join(' ');
        expect(text).toContain('Chimera Squad');
        expect(text).toContain('Warhound Squad');
        expect(text).not.toContain('Basilisk');
    });
});

describe('the one command path', () => {
    it('only ever sends the closed set of command types', () => {
        const allowed = new Set(['GroupDirective', 'StandingOrder', 'AIGuidance', 'LuaRulesMsg', 'OrgGroup']);
        for (const fixture of fixtures) {
            const h = harness(fixture.context, { ports: true });
            const report = executeNLResponse(fixture.expected, h.ports);
            for (const cmd of report.sent) {
                expect(allowed, `${fixture.name} sent ${cmd.type}`).toContain(cmd.type);
            }
        }
    });

    it('never sends a ConsoleCommand or a PlayerCommand', () => {
        // The admin/cheat paths. Nothing the NL layer can produce should reach
        // them — it commands at the directive layer, never the raw-unit or
        // console layer.
        for (const fixture of fixtures) {
            const h = harness(fixture.context, { ports: true });
            executeNLResponse(fixture.expected, h.ports);
            for (const cmd of h.sent) {
                expect(['ConsoleCommand', 'PlayerCommand']).not.toContain(cmd.type);
            }
        }
    });

    it('sends nothing at all when it asks a question', () => {
        for (const fixture of fixtures) {
            const h = harness(fixture.context, { ports: true });
            const report = executeNLResponse(fixture.expected, h.ports);
            if (report.clarification && fixture.expect?.sends?.length === 0) {
                expect(h.sent).toEqual([]);
            }
        }
    });
});

describe('clarifications', () => {
    it("a model's clarify question executes nothing", () => {
        const h = harness('basin');
        const report = executeNLResponse({
            clarify: { question: 'Which one?', options: ['A', 'B'] },
            actions: [],
        }, h.ports);
        expect(h.sent).toEqual([]);
        expect(report.clarification).toEqual({ question: 'Which one?', options: ['A', 'B'] });
        expect(report.lines[0]).toMatchObject({ kind: 'ask', options: ['A', 'B'] });
    });

    it('a resolver clarification carries the candidate names as chips', () => {
        const h = harness('ambiguous-forces');
        const report = executeNLResponse({
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'attack',
                    subject: { type: 'entity-ref', name: 'Chimera' },
                    target: { type: 'entity-ref', name: 'Northgate' },
                },
            }],
        }, h.ports);
        expect(h.sent).toEqual([]);
        expect(report.clarification?.options).toEqual(['Chimera Reserve', 'Chimera Squad']);
    });

    it('stops the plan at the ambiguous step, keeping what already happened', () => {
        const h = harness('ambiguous-forces');
        const report = executeNLResponse({
            actions: [
                { kind: 'guidance', guidance: { op: 'stance', value: 'defensive' } },
                {
                    kind: 'command',
                    intent: {
                        verb: 'secure',
                        subject: { type: 'entity-ref', name: 'Chimera' },
                        target: { type: 'entity-ref', name: 'Northgate' },
                    },
                },
                { kind: 'guidance', guidance: { op: 'roe', value: 'free' } },
            ],
        }, h.ports);
        // Action 1 landed, action 2 asked, action 3 never ran.
        expect(sendShapes(h.sent)).toEqual([
            { type: 'LuaRulesMsg', wire: 'cmd=guidance.stance&value=defensive' },
        ]);
        expect(report.clarification).toBeDefined();
    });

    it('a refusal does NOT stop the plan', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            actions: [
                {
                    kind: 'command',
                    intent: { verb: 'patrol', subject: { type: 'any' }, target: { type: 'entity-ref', name: 'Northgate' } },
                },
                { kind: 'guidance', guidance: { op: 'stance', value: 'aggressive' } },
            ],
        }, h.ports);
        expect(report.refusals).toHaveLength(1);
        expect(sendShapes(h.sent)).toEqual([
            { type: 'LuaRulesMsg', wire: 'cmd=guidance.stance&value=aggressive' },
        ]);
    });
});

describe('missing ports refuse by name', () => {
    const withoutPorts = (response: NLResponse) => {
        const h = harness('basin');
        const report = executeNLResponse(response, h.ports);
        return { h, report };
    };

    it('camera', () => {
        const { h, report } = withoutPorts({ actions: [{ kind: 'camera', camera: { op: 'fitMap' } }] });
        expect(h.sent).toEqual([]);
        expect(report.refusals[0]).toContain('not yet supported');
    });

    it('ui', () => {
        const { report } = withoutPorts({ actions: [{ kind: 'ui', ui: { op: 'fullscreen', panelId: 'minimap' } }] });
        expect(report.refusals[0]).toContain('not yet supported');
    });

    it('query', () => {
        const { report } = withoutPorts({ actions: [{ kind: 'query', query: { op: 'resources' } }] });
        expect(report.refusals[0]).toContain('not yet supported');
    });
});

describe('ports, once M3 injects them', () => {
    it('camera ops reach the port', () => {
        const h = harness('basin', { ports: true });
        executeNLResponse({
            actions: [
                { kind: 'camera', camera: { op: 'focus', targetRef: 'Northgate' } },
                { kind: 'camera', camera: { op: 'zoom', dir: 'in' } },
            ],
        }, h.ports);
        expect(h.cameraCalls).toEqual(['focus:Northgate', 'zoom:in']);
        expect(h.sent).toEqual([]);           // the camera is not a command
    });

    it('ui ops reach the registry, and an unknown panel refuses', () => {
        const h = harness('basin', { ports: true });
        const report = executeNLResponse({
            actions: [
                { kind: 'ui', ui: { op: 'open', panelId: 'objectives' } },
                { kind: 'ui', ui: { op: 'open', panelId: 'nope' } },
            ],
        }, h.ports);
        expect(h.uiCalls).toEqual(['open:objectives', 'open:nope']);
        expect(report.refusals[0]).toContain('"nope"');
    });

    it('a query answer is printed, and no-answer refuses honestly', () => {
        const h = harness('basin', { ports: true });
        const report = executeNLResponse({
            actions: [
                { kind: 'query', query: { op: 'count', class: 'tanks', side: 'own' } },
                { kind: 'query', query: { op: 'status', subjectRef: 'Chimera Squad' } },
            ],
        }, h.ports);
        expect(h.queryCalls).toEqual(['count', 'status']);
        expect(report.lines.some((l) => l.text === 'answer:count')).toBe(true);
        expect(report.refusals[0]).toContain("don't have an answer");
        expect(h.sent).toEqual([]);           // asking is never ordering
    });
});

describe('honest gaps', () => {
    it('an on-sight standing order refuses instead of firing immediately', () => {
        const h = harness('basin-selected');
        const report = executeNLResponse({
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'escort',
                    subject: { type: 'selection' },
                    target: { type: 'entity-ref', name: 'Slag Forge' },
                    standing: { onSight: 'Chimera Squad' },
                },
            }],
        }, h.ports);
        expect(h.sent).toEqual([]);
        expect(report.refusals[0]).toContain('on-sight trigger');
    });

    it('a command with no target refuses rather than aiming at the origin', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            actions: [{ kind: 'command', intent: { verb: 'attack', subject: { type: 'any' } } }],
        }, h.ports);
        expect(h.sent).toEqual([]);
        expect(report.refusals[0]).toContain('needs a place I know');
    });

    it('an idle-class order admits the filter has no wire slot', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'hold',
                    subject: { type: 'idle-filter', filterClass: 'tanks' },
                    target: { type: 'entity-ref', name: 'Slag Forge' },
                },
            }],
        }, h.ports);
        expect(report.sent).toHaveLength(1);
        expect(report.lines.map((l) => l.text).join(' '))
            .toContain('the idle-class filter has no wire slot yet');
    });

    it('creating a group is refused with the workaround named', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            actions: [{ kind: 'group', group: { op: 'create', name: 'Hammerfall' } }],
        }, h.ports);
        expect(h.sent).toEqual([]);
        expect(report.refusals[0]).toContain('org panel');
    });

    it('an order to the AI echoes what the STORE now holds', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'secure',
                    subject: { type: 'ai' },
                    target: { type: 'entity-ref', name: 'Northgate' },
                    priority: 'high',
                },
            }],
        }, h.ports);
        expect(report.sent[0].type).toBe('AIGuidance');
        // Not "directive issued": the guidance store takes no directives.
        expect(report.lines.map((l) => l.text).join(' ')).toContain('north_gate_ridge is now priority');
    });
});

describe('group rename', () => {
    it('rides the OrgGroup update case with empty add/remove lists', () => {
        const h = harness('basin');
        executeNLResponse({
            actions: [{ kind: 'group', group: { op: 'rename', groupRef: 'Chimera Squad', name: 'Hammerfall' } }],
        }, h.ports);
        expect(h.sent).toEqual([{
            type: 'OrgGroup', action: 'update', groupId: 1, addIds: [], removeIds: [], name: 'Hammerfall',
        }]);
    });
});

describe('the say line', () => {
    it('is printed before the actions it describes', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            say: 'Moving out.',
            actions: [{ kind: 'guidance', guidance: { op: 'stance', value: 'aggressive' } }],
        }, h.ports);
        expect(report.lines[0]).toMatchObject({ kind: 'system', text: 'Moving out.' });
        expect(report.lines[1].kind).toBe('ok');
    });

    it('is NOT printed when the run only asks a question', () => {
        // Observed live before the fix: "standing order set (team-wide)" printed
        // one line above "Which place did you mean?". `say` is written before
        // resolution runs, so it must not be trusted until something succeeds.
        const h = harness('ambiguous-places');
        const report = executeNLResponse({
            say: 'Attacking Randtown.',
            actions: [{
                kind: 'command',
                intent: { verb: 'attack', subject: { type: 'any' }, target: { type: 'entity-ref', name: 'Rand' } },
            }],
        }, h.ports);
        expect(report.lines.map((l) => l.kind)).toEqual(['ask']);
        expect(report.lines.some((l) => l.text.includes('Attacking Randtown'))).toBe(false);
    });

    it('is NOT printed when every action refuses', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            say: 'Patrolling Northgate.',
            actions: [{
                kind: 'command',
                intent: { verb: 'patrol', subject: { type: 'any' }, target: { type: 'entity-ref', name: 'Northgate' } },
            }],
        }, h.ports);
        expect(report.lines.map((l) => l.kind)).toEqual(['refused']);
    });

    it('IS printed when a later action succeeds after an earlier refusal', () => {
        const h = harness('basin');
        const report = executeNLResponse({
            say: 'Two things.',
            actions: [
                {
                    kind: 'command',
                    intent: { verb: 'patrol', subject: { type: 'any' }, target: { type: 'entity-ref', name: 'Northgate' } },
                },
                { kind: 'guidance', guidance: { op: 'stance', value: 'aggressive' } },
            ],
        }, h.ports);
        expect(report.lines.map((l) => l.kind)).toEqual(['refused', 'system', 'ok']);
    });
});
