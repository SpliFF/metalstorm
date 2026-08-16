/**
 * score.test.mjs — the eval scorer, tested by the ORDINARY hermetic suite.
 *
 * `npx vitest run` picks this up. That is on purpose and is not a violation of
 * "nothing under client/ or tests/ calls the Claude API": this file makes no
 * network call at all. It exercises `score.mjs`, which is pure by construction
 * — the harness that spends money (`run-eval.mjs`) is the part that stays out
 * of CI, and it is a separate file precisely so this one can be tested.
 *
 * PLAN-metalstorm-command-language.md §8, M7.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareToBaseline, scoreEnvelope, summarise } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, '../../client/src/ui/native-ui/nl-fixtures');

const defend = (name, target) => ({
    say: 'anything at all',
    actions: [{
        kind: 'command',
        intent: {
            verb: 'defend',
            subject: { type: 'entity-ref', name },
            target: { type: 'entity-ref', name: target },
        },
    }],
});

describe('scoreEnvelope', () => {
    it('scores an identical envelope as a pass', () => {
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), defend('Chimera Squad', 'Northgate'));
        expect(result.pass).toBe(true);
        expect(result.agreement).toBe(1);
    });

    it('ignores `say` — different prose, same envelope, still a pass', () => {
        const expected = defend('Chimera Squad', 'Northgate');
        const actual = { ...defend('Chimera Squad', 'Northgate'), say: 'Roger that, moving out.' };
        expect(scoreEnvelope(expected, actual).pass).toBe(true);
    });

    it('passes when `say` is missing entirely', () => {
        const actual = defend('Chimera Squad', 'Northgate');
        delete actual.say;
        expect(scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual).pass).toBe(true);
    });

    it('fails a wrong verb, and reports which field', () => {
        const actual = defend('Chimera Squad', 'Northgate');
        actual.actions[0].intent.verb = 'attack';
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual);
        expect(result.pass).toBe(false);
        expect(result.mismatches).toHaveLength(1);
        expect(result.mismatches[0].path).toBe('actions[0].intent.verb');
        expect(result.agreement).toBeGreaterThan(0.5);   // one field wrong, not a collapse
    });

    it('fails a hallucinated subject name', () => {
        const actual = defend('Chimaera Squadron', 'Northgate');
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual);
        expect(result.pass).toBe(false);
        expect(result.mismatches[0].path).toBe('actions[0].intent.subject.name');
    });

    it('does not punish `priority: normal` or `when: now` — the schema says they mean "omitted"', () => {
        const actual = defend('Chimera Squad', 'Northgate');
        actual.actions[0].intent.priority = 'normal';
        actual.actions[0].intent.when = { type: 'now' };
        expect(scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual).pass).toBe(true);
    });

    it('does punish a priority the fixture did not ask for', () => {
        const actual = defend('Chimera Squad', 'Northgate');
        actual.actions[0].intent.priority = 'urgent';
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual);
        expect(result.pass).toBe(false);
        expect(result.mismatches[0].kind).toBe('unexpected');
    });

    it('fails an extra action even when the expected one is right', () => {
        const actual = defend('Chimera Squad', 'Northgate');
        actual.actions.push({ kind: 'ui', ui: { op: 'open', panelId: 'minimap' } });
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual);
        expect(result.pass).toBe(false);
        expect(result.mismatches.some((m) => m.path === 'actions.length')).toBe(true);
    });

    it('fails a missing action', () => {
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), { actions: [] });
        expect(result.pass).toBe(false);
    });

    it('stops at the kind when the kind is wrong, rather than diffing incomparable payloads', () => {
        const actual = { actions: [{ kind: 'query', query: { op: 'count', class: 'tanks', side: 'own' } }] };
        const result = scoreEnvelope(defend('Chimera Squad', 'Northgate'), actual);
        expect(result.pass).toBe(false);
        expect(result.mismatches).toHaveLength(1);
        expect(result.mismatches[0].path).toBe('actions[0].kind');
    });

    it('treats clarify options as a set — chip order is not meaning', () => {
        const expected = { clarify: { question: 'Which?', options: ['Chimera Squad', 'Basilisk Squad'] }, actions: [] };
        const actual = { clarify: { question: 'Which one did you mean?', options: ['Basilisk Squad', 'Chimera Squad'] }, actions: [] };
        expect(scoreEnvelope(expected, actual).pass).toBe(true);
    });

    it('fails when the model answers instead of asking', () => {
        const expected = { clarify: { question: 'Which?', options: ['A', 'B'] }, actions: [] };
        const result = scoreEnvelope(expected, defend('A', 'Northgate'));
        expect(result.pass).toBe(false);
        expect(result.mismatches.some((m) => m.path === 'clarify')).toBe(true);
    });

    it('fails when the model asks instead of acting', () => {
        const actual = { clarify: { question: 'Which squad?', options: ['A'] }, actions: [] };
        expect(scoreEnvelope(defend('A', 'Northgate'), actual).pass).toBe(false);
    });

    it('scores a refusal on its kind alone — the wording is copy, not correctness', () => {
        const expected = { actions: [{ kind: 'refuse', reason: 'I have no idea where that is.' }] };
        const actual = { actions: [{ kind: 'refuse', reason: 'No such place on this map.' }] };
        expect(scoreEnvelope(expected, actual).pass).toBe(true);
    });

    it('does not accept a refusal where an order was expected', () => {
        const actual = { actions: [{ kind: 'refuse', reason: 'no' }] };
        expect(scoreEnvelope(defend('A', 'Northgate'), actual).pass).toBe(false);
    });

    it('scores a non-object (a parse failure) as zero, without throwing', () => {
        const result = scoreEnvelope(defend('A', 'B'), null);
        expect(result.pass).toBe(false);
        expect(result.agreement).toBe(0);
    });

    it('keeps multi-action ORDER significant — §1 says a failed step ends the rest', () => {
        const expected = {
            actions: [
                { kind: 'command', intent: { verb: 'hold', subject: { type: 'entity-ref', name: 'A' }, target: { type: 'entity-ref', name: 'X' } } },
                { kind: 'command', intent: { verb: 'secure', subject: { type: 'entity-ref', name: 'B' }, target: { type: 'entity-ref', name: 'Y' } } },
            ],
        };
        const swapped = { actions: [expected.actions[1], expected.actions[0]] };
        expect(scoreEnvelope(expected, swapped).pass).toBe(false);
        expect(scoreEnvelope(expected, expected).pass).toBe(true);
    });
});

describe('the golden fixtures themselves', () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json') && f !== 'contexts.json');

    it('are all present and non-empty', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    // The scorer's own sanity check. If a fixture's `expected` does not score a
    // perfect 1.0 against ITSELF, the scorer has a blind spot — an action kind
    // it does not know how to compare, a payload key it silently skips — and
    // every number the harness prints about that category is meaningless.
    for (const file of files) {
        it(`${file}: every expected envelope scores 1.0 against itself`, () => {
            const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
            const fixtures = parsed.fixtures ?? [];
            expect(fixtures.length).toBeGreaterThan(0);
            for (const fixture of fixtures) {
                expect(fixture.expected, `${file}: "${fixture.name}" has no expected envelope`).toBeTruthy();
                const result = scoreEnvelope(fixture.expected, fixture.expected);
                expect(result.pass, `${file}: "${fixture.name}" — ${JSON.stringify(result.mismatches)}`).toBe(true);
                expect(result.fields.length).toBeGreaterThan(1);
            }
        });
    }
});

describe('summarise', () => {
    const rows = [
        { category: 'commands.json', pass: true, agreement: 1 },
        { category: 'commands.json', pass: false, agreement: 0.5 },
        { category: 'guidance.json', pass: true, agreement: 1 },
        { category: 'guidance.json', pass: false, agreement: 0, error: 'HTTP 500' },
    ];

    it('reports a pass rate per category, not just overall', () => {
        const summary = summarise(rows);
        expect(summary.total).toBe(4);
        expect(summary.passed).toBe(2);
        expect(summary.passRate).toBe(0.5);
        expect(summary.categories.map((c) => c.category)).toEqual(['commands.json', 'guidance.json']);
        expect(summary.categories[0].passRate).toBe(0.5);
        expect(summary.categories[0].agreement).toBe(0.75);
    });

    it('counts transport errors separately from wrong answers', () => {
        expect(summarise(rows).errored).toBe(1);
    });

    it('handles an empty run without dividing by zero', () => {
        const summary = summarise([]);
        expect(summary.passRate).toBe(0);
        expect(summary.agreement).toBe(0);
        expect(summary.categories).toEqual([]);
    });
});

describe('compareToBaseline', () => {
    const baseline = summarise([
        { category: 'commands.json', pass: true, agreement: 1 },
        { category: 'commands.json', pass: true, agreement: 1 },
        { category: 'camera-ui-query.json', pass: true, agreement: 1 },
    ]);

    it('passes when nothing got worse', () => {
        expect(compareToBaseline(baseline, baseline).ok).toBe(true);
    });

    it('flags a category that lost a fixture', () => {
        const now = summarise([
            { category: 'commands.json', pass: true, agreement: 1 },
            { category: 'commands.json', pass: false, agreement: 0.6 },
            { category: 'camera-ui-query.json', pass: true, agreement: 1 },
        ]);
        const verdict = compareToBaseline(now, baseline);
        expect(verdict.ok).toBe(false);
        expect(verdict.regressions).toEqual([{ category: 'commands.json', was: 2, now: 1, of: 2 }]);
    });

    it('catches a trade — commands lost two, camera gained two, overall unchanged', () => {
        const now = summarise([
            { category: 'commands.json', pass: false, agreement: 0.5 },
            { category: 'commands.json', pass: false, agreement: 0.5 },
            { category: 'camera-ui-query.json', pass: true, agreement: 1 },
            { category: 'camera-ui-query.json', pass: true, agreement: 1 },
            { category: 'camera-ui-query.json', pass: true, agreement: 1 },
        ]);
        expect(now.passed).toBe(3);
        expect(now.passed).toBeGreaterThanOrEqual(baseline.passed);   // overall looks fine…
        expect(compareToBaseline(now, baseline).ok).toBe(false);      // …per-category is not
    });

    it('honours the tolerance when one is set', () => {
        const now = summarise([
            { category: 'commands.json', pass: true, agreement: 1 },
            { category: 'commands.json', pass: false, agreement: 0.6 },
            { category: 'camera-ui-query.json', pass: true, agreement: 1 },
        ]);
        expect(compareToBaseline(now, baseline, 1).ok).toBe(true);
        expect(compareToBaseline(now, baseline, 0).ok).toBe(false);
    });

    it('flags a category that vanished from the run', () => {
        const now = summarise([{ category: 'commands.json', pass: true, agreement: 1 }, { category: 'commands.json', pass: true, agreement: 1 }]);
        const verdict = compareToBaseline(now, baseline);
        expect(verdict.ok).toBe(false);
        expect(verdict.regressions[0]).toMatchObject({ category: 'camera-ui-query.json', missing: true });
    });
});
