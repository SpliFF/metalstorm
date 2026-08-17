// Unit tests for the S1 key census — PLAN-long-uptime T4-1e.
//
// The census answers "which keys", so what these assert is that the two
// populations with opposite consequences do not read alike: a ring slot minted
// once and reused forever must come out `static`, and a monotonic id or a
// per-player key must come out `growing`/`new` WITH its rate. A census that
// folded the two together would report a bounded dictionary and an unbounded
// one with the same line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    keyShape, censusKeys, censusChurn, formatCensus, censusFamily, formatFamilies,
} from '../lib/key-census.mjs';

test('a key shape folds digit runs and nothing else', () => {
    assert.equal(keyShape('objective_17_state'), 'objective_<n>_state');
    assert.equal(keyShape('objective_18_state'), 'objective_<n>_state');
    assert.equal(keyShape('war_state'), 'war_state');
    // Named tokens stay distinct: they come from the map and are bounded by it,
    // and folding them would hide the very distinction being drawn.
    assert.notEqual(keyShape('region_north_x'), keyShape('region_south_x'));
    // A multi-digit run is ONE token, not one per digit.
    assert.equal(keyShape('warlog_512_kind'), 'warlog_<n>_kind');
});

test('censusKeys groups by shape and reports the lowest member as the example', () => {
    const c = censusKeys(['objective_2_state', 'objective_1_state', 'war_state']);
    assert.equal(c.total, 3);
    assert.deepEqual(c.shapes.map((s) => [s.shape, s.count]), [
        ['objective_<n>_state', 2],
        ['war_state', 1],
    ]);
    assert.equal(c.shapes[0].example, 'objective_1_state');
});

/** Cycle records in the driver's shape. */
function cycles(...perCycleKeys) {
    const seen = new Set();
    return perCycleKeys.map((keys, i) => {
        const newKeys = keys.filter((k) => !seen.has(k));
        for (const k of keys) seen.add(k);
        return { cycle: i, rev: i + 1, size: seen.size, newKeys };
    });
}

test('a dictionary that never grows after the baseline reads static', () => {
    const ring = ['warlog_0_kind', 'warlog_1_kind', 'war_state'];
    const c = censusChurn(cycles(ring, ring, ring, ring));
    assert.equal(c.baselineKeys, 3);
    assert.equal(c.churnCycles, 3);
    assert.equal(c.mintedDuringWindow, 0);
    assert.equal(c.keysPerCycle, 0);
    assert.deepEqual(c.growing, []);
    assert.deepEqual(c.static.map((s) => s.shape).sort(),
        ['war_state', 'warlog_<n>_kind']);
});

test('a monotonic id family is reported as growing, with its per-cycle rate', () => {
    const c = censusChurn(cycles(
        ['war_state', 'objective_1_state'],
        ['war_state', 'objective_1_state', 'objective_2_state'],
        ['war_state', 'objective_1_state', 'objective_2_state', 'objective_3_state'],
    ));
    assert.equal(c.mintedDuringWindow, 2);
    assert.equal(c.churnCycles, 2);
    assert.equal(c.keysPerCycle, 1);
    assert.equal(c.growing.length, 1);
    const g = c.growing[0];
    assert.equal(g.shape, 'objective_<n>_state');
    assert.equal(g.verdict, 'growing');   // present in the baseline, gained after
    assert.equal(g.baselineCount, 1);
    assert.equal(g.minted, 2);
    assert.equal(g.perCycle, 1);
    assert.equal(g.activeCycles, 2);
    // `war_state` never moved, so it must not appear among the growing shapes.
    assert.equal(c.static.map((s) => s.shape).includes('war_state'), true);
});

test('a shape the churn itself introduces is `new`, not `growing`', () => {
    const c = censusChurn(cycles(
        ['war_state'],
        ['war_state', 'score_3_earned'],
        ['war_state', 'score_3_earned', 'score_4_earned'],
    ));
    assert.equal(c.growing.length, 1);
    assert.equal(c.growing[0].shape, 'score_<n>_earned');
    assert.equal(c.growing[0].verdict, 'new');
    assert.equal(c.growing[0].baselineCount, 0);
    assert.equal(c.growing[0].minted, 2);
});

test('the baseline cycle is not counted as churn', () => {
    // One cycle only: everything it saw is the world, and dividing by zero
    // later cycles must not produce a rate at all.
    const c = censusChurn(cycles(['objective_1_state', 'objective_2_state']));
    assert.equal(c.baselineKeys, 2);
    assert.equal(c.churnCycles, 0);
    assert.equal(c.keysPerCycle, 0);
    assert.deepEqual(c.growing, []);
});

test('a rate is reported beside the timeline that decides what it means', () => {
    // The live shape (2026-08-14): everything is minted while the war starts up
    // and the dictionary is then flat for the rest of the window. The rate alone
    // describes a dictionary that is still growing; the quiet tail is what says
    // otherwise, so both must be in the reading.
    const c = censusChurn([
        { cycle: 0, rev: 1, size: 10, newKeys: ['a_1'] },
        { cycle: 1, rev: 2, size: 12, newKeys: ['a_2', 'a_3'] },
        { cycle: 2, rev: 2, size: 12, newKeys: [] },
        { cycle: 3, rev: 2, size: 12, newKeys: [] },
        { cycle: 4, rev: 2, size: 12, newKeys: [] },
    ]);
    assert.equal(c.keysPerCycle, 0.5);          // 2 keys / 4 later cycles
    assert.equal(c.lastMintingCycle, 1);
    assert.equal(c.quietTailCycles, 3);
    assert.deepEqual(c.mintedByCycle.map((m) => m.minted), [1, 2, 0, 0, 0]);
    assert.match(formatCensus(c), /last mint at cycle 1, then 3 cycle\(s\)/);
});

test('an empty census is a reading, not a crash', () => {
    const c = censusChurn([]);
    assert.equal(c.baselineCycle, null);
    assert.equal(c.baselineKeys, 0);
    assert.equal(c.churnCycles, 0);
    assert.equal(c.finalSize, 0);
    assert.match(formatCensus(c), /no shape gained a key/);
});

test('every revision observed is kept, so a compaction in-window is visible', () => {
    const c = censusChurn([
        { cycle: 0, rev: 7, size: 900, newKeys: ['a_1'] },
        { cycle: 1, rev: 8, size: 400, newKeys: [] },   // compaction: size fell
    ]);
    assert.deepEqual(c.revs, [7, 8]);
    assert.equal(c.finalSize, 400);
});

test('the formatted census names a growing shape and quotes its rate', () => {
    const c = censusChurn(cycles(
        ['objective_1_state'],
        ['objective_1_state', 'objective_2_state'],
    ));
    const text = formatCensus(c);
    assert.match(text, /GROWING objective_<n>_state/);
    assert.match(text, /1\.00\/cycle/);
});

// --- Monotonic-id families (T4-1c) ---------------------------------------
//
// A family is not a shape. `parley_1_kind` and `parley_1_duration` are two
// shapes and one proposal, and what a weeks-long campaign pays is per
// PROPOSAL — so the census that decides affordability has to divide by ids,
// not count keys.

test('a family census counts ids, not keys, and divides one by the other', () => {
    const f = censusFamily([
        'parley_1_kind', 'parley_1_state', 'parley_1_duration',
        'parley_2_kind', 'parley_2_state', 'parley_2_duration',
        'war_state', 'objective_9_state',
    ], 'parley');
    assert.equal(f.ids, 2);
    assert.equal(f.keys, 6);
    assert.equal(f.keysPerIdMean, 3);
    assert.equal(f.idMin, 1);
    assert.equal(f.idMax, 2);
    // A foreign family and a flat key are not this family's business.
    assert.deepEqual(f.fields.map((x) => x.field).sort(), ['duration', 'kind', 'state']);
});

test('a conditionally published field gives keys-per-id a RANGE', () => {
    // `counterOf` is published only for a counter-offer, so a mean alone would
    // describe a proposal that does not exist.
    const f = censusFamily([
        'parley_1_kind', 'parley_1_state',
        'parley_2_kind', 'parley_2_state', 'parley_2_counterOf',
    ], 'parley');
    assert.equal(f.keysPerIdMin, 2);
    assert.equal(f.keysPerIdMax, 3);
    assert.equal(f.keysPerIdMean, 2.5);
    assert.deepEqual(f.fields.find((x) => x.field === 'counterOf'), { field: 'counterOf', ids: 1 });
});

test('id count and id high-water are reported separately', () => {
    // `nextId` never reuses, so a gap means ids this census could not see —
    // an AI, a scenario, another seat. Reading idMax as a count would
    // attribute them to the observer.
    const f = censusFamily(['parley_1_kind', 'parley_40_kind'], 'parley');
    assert.equal(f.ids, 2);
    assert.equal(f.idMax, 40);
});

test('an empty family is reported as empty, never omitted', () => {
    const f = censusFamily(['war_state'], 'parley');
    assert.equal(f.ids, 0);
    assert.equal(f.keys, 0);
    assert.equal(f.idMax, null);
    assert.match(formatFamilies([f]), /parley_<n>_\*: no id minted/);
});

test('the formatted family quotes ids, keys-per-id and its fields', () => {
    const text = formatFamilies([censusFamily(
        ['parley_1_kind', 'parley_1_state', 'parley_2_kind', 'parley_2_state'], 'parley')]);
    assert.match(text, /2 id\(s\) \(1\.\.2\), 4 key\(s\) = 2\.0\/id/);
    assert.match(text, /kind×2/);
});
