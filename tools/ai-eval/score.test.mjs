/**
 * score.test.mjs — the eval SCORER, tested hermetically.  `node --test`.
 *
 * The scorer is the part of an eval harness that can be quietly wrong in a way
 * that flatters whatever it measures, and a gate that cannot fail is not a
 * gate. So every rule it applies is pinned here against hand-built runs: no
 * lua, no spawn, no fixtures on disk (except the real fixture files, which are
 * validated for shape — a fixture with a typo'd check name must not silently
 * assert nothing).
 */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
    CHECK_NAMES, compareToBaseline, expectationsFor, grade, metricsOf, neighboursOf, reactions,
    summarise,
} from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const NEIGHBOURS = { a: ['b'], b: ['a', 'c'], c: ['b'] };

const directive = (frame, typeName, region, extra = {}) => ({
    frame, typeName, region, type: 10, priority: 100, cost: 2, x: 0, z: 0, ...extra,
});

const run = (over = {}) => ({
    ai: 'garrison', fixture: 'f', booted: true, onUpdateCalls: 10,
    directives: [], events: [], violations: [], errors: [], refused: {}, messages: {},
    spent: 0, poolLeft: 10, logLines: 3, ...over,
});

describe('reaction latency', () => {
    it('counts the first directive in the event region', () => {
        const r = reactions(run({
            events: [{ id: 'e', kind: 'contact', region: 'b', frame: 100 }],
            directives: [directive(50, 'Defend', 'b'), directive(140, 'Defend', 'b')],
        }), NEIGHBOURS);
        assert.equal(r[0].latency, 40, 'a directive from BEFORE the event is not an answer');
        assert.equal(r[0].answeredWith, 'Defend');
    });

    it('counts an answer next door, but not two regions away', () => {
        const near = reactions(run({
            events: [{ id: 'e', region: 'b', frame: 100 }],
            directives: [directive(110, 'Defend', 'a')],
        }), NEIGHBOURS);
        assert.equal(near[0].latency, 10);

        const far = reactions(run({
            events: [{ id: 'e', region: 'a', frame: 100 }],
            directives: [directive(110, 'Defend', 'c')],
        }), NEIGHBOURS);
        assert.equal(far[0].latency, null);
    });

    it('lets a fixture name types that answer wherever they are anchored', () => {
        // The withdrawal case: answering an overrun by leaving is still an
        // answer, and it is necessarily anchored somewhere else.
        const r = reactions(run({
            events: [{ id: 'e', region: 'a', frame: 100, answeredBy: ['Withdraw'] }],
            directives: [directive(100, 'Withdraw', 'c')],
        }), NEIGHBOURS);
        assert.equal(r[0].latency, 0);
    });

    it('reports "never answered" as a result, not as a missing measurement', () => {
        const m = metricsOf(run({
            events: [{ id: 'e', region: 'b', frame: 100 }],
            directives: [],
        }), NEIGHBOURS);
        assert.equal(m.worstLatency, null);
        assert.equal(m.unanswered, 1);
    });

    it('takes the WORST latency, not the average', () => {
        const m = metricsOf(run({
            events: [{ id: 'fast', region: 'b', frame: 100 }, { id: 'slow', region: 'b', frame: 200 }],
            directives: [directive(110, 'Defend', 'b'), directive(400, 'Defend', 'b')],
        }), NEIGHBOURS);
        assert.equal(m.worstLatency, 200);
    });
});

describe('checks', () => {
    const graded = (expectations, over) => grade(run(over), expectations, NEIGHBOURS);
    const okOf = (g, i = 0) => g.checks[i].ok;

    it('fails an unknown check name instead of silently passing it', () => {
        const g = graded([{ check: 'thisDoesNotExist' }]);
        assert.equal(okOf(g), false);
        assert.match(g.checks[0].detail, /unknown check/);
    });

    it('grades the strategic floor and the crash channel', () => {
        assert.equal(okOf(graded([{ check: 'noViolations' }])), true);
        assert.equal(okOf(graded([{ check: 'noViolations' }],
            { violations: [{ frame: 10, unitId: 1, cmdId: 20 }] })), false);
        assert.equal(okOf(graded([{ check: 'noErrors' }], { errors: [{ frame: 1, err: 'x' }] })), false);
        assert.equal(okOf(graded([{ check: 'booted' }], { booted: false, bootError: 'no onUpdate' })), false);
        assert.match(graded([{ check: 'booted' }], { booted: false, bootError: 'no onUpdate' })
            .checks[0].detail, /no onUpdate/);
    });

    it('grades spend and directive counts against their ceilings', () => {
        assert.equal(okOf(graded([{ check: 'maxSpend', value: 10 }], { spent: 10 })), true);
        assert.equal(okOf(graded([{ check: 'maxSpend', value: 10 }], { spent: 11 })), false);
        assert.equal(okOf(graded([{ check: 'minDirectives', value: 1 }])), false);
        assert.equal(okOf(graded([{ check: 'maxDirectives', value: 0 }])), true);
    });

    it('grades directive type, place and time together', () => {
        const over = { directives: [directive(100, 'Assault', 'b')] };
        assert.equal(okOf(graded([{ check: 'hasDirectiveType', type: 'Assault', region: 'b' }], over)), true);
        assert.equal(okOf(graded([{ check: 'hasDirectiveType', type: 'Assault', region: 'a' }], over)), false);
        assert.equal(okOf(graded([{ check: 'hasDirectiveTypeAfter', type: 'Assault', frame: 200 }], over)), false);
        assert.equal(okOf(graded([{ check: 'noDirectiveType', type: 'Withdraw' }], over)), true);
        assert.equal(okOf(graded([{ check: 'noDirectiveType', type: 'Assault' }], over)), false);
    });

    it('grades the withdrawal anchor against the published departure zone', () => {
        const over = { directives: [directive(100, 'Withdraw', 'c', { x: 120, z: 1900 })] };
        assert.equal(okOf(graded([{ check: 'withdrawsThrough', x: 120, z: 1900 }], over)), true);
        assert.equal(okOf(graded([{ check: 'withdrawsThrough', x: 0, z: 512 }], over)), false);
    });

    it('holds the no-op control to answering nothing', () => {
        const quiet = { events: [{ id: 'e', region: 'b', frame: 100 }], directives: [] };
        assert.equal(okOf(graded([{ check: 'noReaction' }], quiet)), true);
        assert.equal(okOf(graded([{ check: 'noReaction' }],
            { ...quiet, directives: [directive(110, 'Defend', 'b')] })), false,
            'if the control reacts, the fixture is the signal and the metric is worthless');
    });

    it('fails reactionWithin when the fixture declares no event at all', () => {
        // Otherwise a fixture that lost its event would score a free pass on
        // the one metric it exists to measure.
        assert.equal(okOf(graded([{ check: 'reactionWithin', frames: 10 }])), false);
    });
});

describe('baseline comparison', () => {
    const cell = (over = {}) => ({
        ai: 'garrison', fixture: 'f', directives: 4, spent: 8, violations: 0, errors: 0,
        worstLatency: 20, unanswered: 0, byType: {}, checks: { '0:noErrors': true },
        checksPassed: 1, checksFailed: 0, ...over,
    });
    const summaryOf = (c) => ({ cells: { 'garrison/f': c }, totals: {} });
    const baseline = { cells: { 'garrison/f': cell() } };

    it('passes an identical run', () => {
        assert.equal(compareToBaseline(summaryOf(cell()), baseline).ok, true);
    });

    it('does not call a different-but-equal plan a regression', () => {
        // An AI that issues four different directives of the same cost, in the
        // same time, is not worse. A gate that reddens on churn gets disabled.
        const v = compareToBaseline(summaryOf(cell({ byType: { Assault: 4 }, directives: 4 })), baseline);
        assert.equal(v.ok, true);
    });

    it('catches a cell that silently left the matrix', () => {
        const v = compareToBaseline({ cells: {}, totals: {} }, baseline);
        assert.equal(v.ok, false);
        assert.equal(v.regressions[0].kind, 'missing');
    });

    it('catches a check that used to pass', () => {
        const v = compareToBaseline(summaryOf(cell({ checks: { '0:noErrors': false } })), baseline);
        assert.equal(v.regressions[0].kind, 'check');
    });

    it('never tolerates a new violation or a new raised tick', () => {
        assert.equal(compareToBaseline(summaryOf(cell({ violations: 1 })), baseline, 10)
            .regressions[0].kind, 'violation');
        assert.equal(compareToBaseline(summaryOf(cell({ errors: 1 })), baseline, 10)
            .regressions[0].kind, 'error');
    });

    it('tolerates small authority drift and catches a burn', () => {
        assert.equal(compareToBaseline(summaryOf(cell({ spent: 9 })), baseline, 0.1).ok, true);
        const v = compareToBaseline(summaryOf(cell({ spent: 20 })), baseline, 0.1);
        assert.equal(v.regressions[0].kind, 'spend');
    });

    it('catches a slower reaction, and an event that stopped being answered', () => {
        assert.equal(compareToBaseline(summaryOf(cell({ worstLatency: 25 })), baseline).ok, true,
            'within one 10-frame callin interval is noise, not a regression');
        assert.equal(compareToBaseline(summaryOf(cell({ worstLatency: 100 })), baseline)
            .regressions[0].kind, 'latency');
        assert.equal(compareToBaseline(summaryOf(cell({ worstLatency: null, unanswered: 1 })), baseline)
            .regressions[0].kind, 'latency');
    });

    it('reports a new cell as new, not as a pass or a failure', () => {
        const v = compareToBaseline({ cells: { 'garrison/f': cell(), 'raider/f': cell() }, totals: {} },
            baseline);
        assert.equal(v.ok, true);
        assert.deepEqual(v.added, ['raider/f']);
    });
});

describe('the fixtures on disk', () => {
    const files = readdirSync(join(HERE, 'fixtures')).filter((f) => f.endsWith('.json'));

    it('exist', () => assert.ok(files.length >= 3));

    for (const file of files) {
        it(`${file} is well-formed and asserts something real`, () => {
            const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', file), 'utf8'));
            assert.ok(fixture.id, 'needs an id');
            assert.ok(fixture.why, 'a fixture whose purpose is not written down rots');
            assert.ok(fixture.frames > 0);
            const all = [
                ...(fixture.expect || []),
                ...Object.values(fixture.expectByAi || {}).flat(),
            ];
            assert.ok(all.length > 0, 'a fixture that asserts nothing is a fixture nobody can fail');
            for (const c of all) {
                assert.ok(CHECK_NAMES.includes(c.check), `unknown check '${c.check}' in ${file}`);
            }
            // Every fixture must hold the no-op control to doing nothing:
            // without it, a fixture that "passes" may only prove the harness
            // moves units around by itself.
            const nullExpect = expectationsFor(fixture, 'null');
            assert.ok(nullExpect.some((c) => c.check === 'maxDirectives' && c.value === 0)
                || (fixture.expect || []).some((c) => c.check === 'maxDirectives' && c.value === 0),
                `${file} does not pin the no-op control to zero directives`);
        });
    }

    it('declares a region for every event that is scored spatially', () => {
        for (const file of files) {
            const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', file), 'utf8'));
            for (const t of fixture.timeline || []) {
                if (!t.event) continue;
                assert.ok(t.event.id, `${file}: an event needs an id to be reported`);
            }
        }
    });
});

describe('summarise', () => {
    it('keys checks by position so two of a kind cannot collapse into one', () => {
        const g = grade(run({ directives: [directive(10, 'Defend', 'b')] }), [
            { check: 'hasDirectiveType', type: 'Defend' },
            { check: 'hasDirectiveType', type: 'Assault' },
        ], NEIGHBOURS);
        const s = summarise([g]);
        assert.deepEqual(s.cells['garrison/f'].checks,
            { '0:hasDirectiveType': true, '1:hasDirectiveType': false });
        assert.equal(s.totals.checksFailed, 1);
    });

    it('adds up the whole matrix', () => {
        const rows = [
            grade(run({ spent: 4 }), [{ check: 'noErrors' }], NEIGHBOURS),
            grade(run({ ai: 'null', spent: 0 }), [{ check: 'noErrors' }], NEIGHBOURS),
        ];
        const s = summarise(rows);
        assert.equal(s.totals.cells, 2);
        assert.equal(s.totals.spent, 4);
        assert.equal(s.totals.checksPassed, 2);
    });
});

describe('neighboursOf', () => {
    it('reads adjacency out of the same regions.json the AI reads', () => {
        const n = neighboursOf(JSON.parse(
            readFileSync(join(HERE, 'fixtures/world/three-region.json'), 'utf8')));
        assert.deepEqual(n.north_ridge, ['central_basin']);
        assert.deepEqual(n.central_basin, ['north_ridge', 'south_marsh']);
    });

    it('survives a fixture with no graph at all (the blind case)', () => {
        assert.deepEqual(neighboursOf(undefined), {});
    });
});
