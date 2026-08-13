import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    METRICS, DEFAULT_RULING, FAILING, INCONCLUSIVE,
    seriesFromDump, fitLinear, classify, reportDump, SECONDS_PER_DAY, seedBudgets,
    saturation,
} from '../lib/growth-fit.mjs';

const metric = (key) => METRICS.find((m) => m.key === key);

// Build a dump whose snapshots advance one simulated day at a time, with the
// named growth counters taking the given per-sample values.
function dumpOf(values, { field = 'rules_params', startDay = 0 } = {}) {
    return {
        status: 'frame-limit',
        snapshots: values.map((v, i) => ({
            frame: (startDay + i) * SECONDS_PER_DAY * 30,
            gameSeconds: (startDay + i) * SECONDS_PER_DAY,
            rssKb: 100, luaHeapKb: 100, dbBytes: 4096,
            growth: {
                rss_kb: 100, lua_heap_kb: 100, param_keys: 0, param_keys_rev: 1,
                rules_params: 0, unit_ids_used: 0, unit_ids_max: 32000,
                unit_spawns: 0, standing_orders: 0, players: 2, players_max: 251,
                [field]: v,
            },
        })),
    };
}

test('fitLinear recovers an exact line', () => {
    const fit = fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 100 + 7 * d })));
    assert.equal(fit.n, 5);
    assert.ok(Math.abs(fit.base - 100) < 1e-9);
    assert.ok(Math.abs(fit.slope - 7) < 1e-9);
    assert.ok(Math.abs(fit.r2 - 1) < 1e-9);
    assert.ok(fit.stderr < 1e-9);
});

test('fitLinear refuses a slope it cannot determine', () => {
    // Fewer than 3 points has no residual degrees of freedom for a stderr...
    assert.ok(Number.isNaN(fitLinear([{ days: 0, value: 1 }, { days: 1, value: 2 }]).stderr));
    // ...and every sample at the same simulated time determines no line at all.
    const same = fitLinear([0, 0, 0].map(() => ({ days: 2, value: 5 })));
    assert.ok(Number.isNaN(same.slope));
    assert.equal(same.base, 5);
    // A zero-length series must not produce a confident-looking zero.
    assert.equal(fitLinear([]).n, 0);
});

test('a flat live counter passes; a rising one with no budget fails', () => {
    const flat = classify(metric('rules_params'), fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 200 }))), undefined);
    assert.equal(flat.verdict, 'flat');

    const rising = classify(metric('rules_params'), fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 200 + 60 * d }))), undefined);
    assert.equal(rising.verdict, 'unexplained');
    assert.ok(FAILING.has(rising.verdict));
});

// The gate PLAN-long-uptime §2 states is "slope explained by design ... or
// zero". A budget with a number and no reason is neither, and the whole value
// of the gate is that somebody had to write the reason down.
test('a budget without a `why` does not explain anything', () => {
    const fit = fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 200 + 60 * d })));
    assert.equal(classify(metric('rules_params'), fit, { slopePerDay: 60 }).verdict, 'unexplained');
    assert.equal(classify(metric('rules_params'), fit, { slopePerDay: 60, why: 'one objective per hour, S1' }).verdict, 'explained');
});

test('a budgeted metric that outruns its budget is over-budget, not explained', () => {
    const fit = fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 200 + 200 * d })));
    const r = classify(metric('rules_params'), fit, { slopePerDay: 60, tolerance: 10, why: 'objective churn' });
    assert.equal(r.verdict, 'over-budget');
    assert.ok(FAILING.has(r.verdict));
});

// M24's lesson applied to a slope: a counter that oscillates will fit some
// line through any handful of samples, and believing it is how a soak report
// starts inventing leaks. The synced Lua heap really does swing 4-11 MB.
test('an oscillating counter does not manufacture a slope', () => {
    const noisy = [4000, 11000, 5000, 9000, 6000, 10000, 4500].map((v, i) => ({ days: i, value: v }));
    const r = classify(metric('lua_heap_kb'), fitLinear(noisy), undefined);
    assert.equal(r.verdict, 'flat');
    assert.match(r.note, /within 2σ/);
});

// ...but a genuine leak buried in the same amount of noise must still be seen.
test('a real slope under the same noise is still caught', () => {
    const leaky = [4000, 11000, 5000, 9000, 6000, 10000, 4500].map((v, i) => ({ days: i, value: v + 20000 * i }));
    const r = classify(metric('lua_heap_kb'), fitLinear(leaky), undefined);
    assert.equal(r.verdict, 'unexplained');
});

test('a tiny slope on a large base is under the floor', () => {
    // 5 units/day on a base of 10000 is 0.05%/day — a perfect fit, and still
    // not the finding this gate exists for.
    const r = classify(metric('rules_params'), fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 10000 + 5 * d }))), undefined);
    assert.equal(r.verdict, 'flat');
    assert.match(r.note, /floor/);
});

test('a cumulative counter is allowed to rise, and a live one is not', () => {
    const pts = [0, 1, 2, 3, 4].map((d) => ({ days: d, value: 500 + 400 * d }));
    assert.equal(classify(metric('unit_spawns'), fitLinear(pts), undefined).verdict, 'explained');
    assert.equal(classify(metric('unit_ids_used'), fitLinear(pts), undefined).verdict, 'unexplained');
});

test('a cumulative metric is not failed by a half-written budget entry', () => {
    const pts = [0, 1, 2, 3, 4].map((d) => ({ days: d, value: 500 + 400 * d }));
    // No `why` → falls back to the cumulative default, never `unexplained`.
    assert.equal(classify(metric('unit_spawns'), fitLinear(pts), { slopePerDay: 10 }).verdict, 'explained');
    // A complete entry does become an enforceable rate ceiling.
    assert.equal(classify(metric('unit_spawns'), fitLinear(pts), { slopePerDay: 10, tolerance: 1, why: 'AI build rate' }).verdict, 'over-budget');
});

test('a falling live counter is reclamation, not a finding', () => {
    const r = classify(metric('param_keys'), fitLinear([0, 1, 2, 3, 4].map((d) => ({ days: d, value: 900 - 150 * d }))), undefined);
    assert.equal(r.verdict, 'flat');
    assert.match(r.note, /reclamation/);
});

// The §10.2 third-arm rule: an old binary's dump has no growth object, and the
// report must say "no samples" rather than fitting a flat line through zeroes
// it invented.
test('a pre-task-4 dump yields no-samples, never a clean flat line', () => {
    const old = { status: 'frame-limit', snapshots: [0, 1, 2].map((d) => ({ frame: d * 2592000, gameSeconds: d * SECONDS_PER_DAY, rssKb: 100, luaHeapKb: 100 })) };
    const results = reportDump(old);
    const params = results.find((r) => r.key === 'rules_params');
    assert.equal(params.verdict, 'no-samples');
    assert.ok(INCONCLUSIVE.has(params.verdict));
    // dbBytes is likewise absent from an old dump.
    assert.equal(results.find((r) => r.key === 'db_bytes').verdict, 'no-samples');
});

// The first real ladder's `param_keys` reading: 30 samples, every one 0,
// because a headless run has no client sessions for StateStreamer to intern
// keys for. Calling that `flat` would certify S1's bound off a run that never
// minted a key.
test('a counter that read zero at every sample is no-signal, not flat', () => {
    const r = reportDump(dumpOf([0, 0, 0, 0, 0], { field: 'param_keys' })).find((x) => x.key === 'param_keys');
    assert.equal(r.verdict, 'no-signal');
    assert.ok(INCONCLUSIVE.has(r.verdict));
    assert.ok(!FAILING.has(r.verdict));
    assert.match(r.note, /never exercised/);

    // A counter that held steady at a real value IS flat — the distinction is
    // the whole point, and it is not "did the slope come out zero".
    const held = reportDump(dumpOf([240, 240, 240, 240, 240])).find((x) => x.key === 'rules_params');
    assert.equal(held.verdict, 'flat');
});

test('a two-snapshot dump is too-short, which is not a pass', () => {
    const r = reportDump(dumpOf([200, 260])).find((x) => x.key === 'rules_params');
    assert.equal(r.verdict, 'too-short');
    assert.ok(INCONCLUSIVE.has(r.verdict));
    assert.ok(!FAILING.has(r.verdict));
});

test('seriesFromDump measures SIMULATED days, not wall time', () => {
    const d = dumpOf([1, 2, 3]);
    d.snapshots.forEach((s) => { s.wallSeconds = 9999; });
    const s = seriesFromDump(d).rules_params;
    assert.deepEqual(s.map((p) => p.days), [0, 1, 2]);
});

// ...except for a surface whose writer is paced by the wall clock. The metrics
// row cadence is steady_clock-based, so on an uncapped ladder (130 simulated
// days per wall day here) fitting db_bytes against simulated days would divide
// the real growth rate by 130 and pass a database with no retention at all.
test('a wall-clocked metric is fitted against WALL days, not simulated ones', () => {
    const d = dumpOf([1, 2, 3]);
    // Three snapshots one simulated day apart, but only 60 wall seconds apart:
    // 8 kB per wall-minute is 11.8 MB/wall-day, and 0.09 MB/simulated-day.
    d.snapshots.forEach((s, i) => { s.wallSeconds = 60 * i; s.dbBytes = 4096 + 8192 * i; });

    const perWall = seriesFromDump(d).db_bytes;
    assert.deepEqual(perWall.map((p) => p.days), [0, 60 / 86400, 120 / 86400]);

    const r = classify(metric('db_bytes'), fitLinear(perWall), undefined);
    assert.equal(r.clock, 'wall');
    // 8192 B per 60 s = 11.8 MB/wall-day — the rate a realtime campaign sees.
    assert.ok(Math.abs(r.fit.slope - 8192 * 1440) < 1);
    assert.match(r.note, /wall-day window/);
    // Sim-clocked metrics keep the simulated axis and say so.
    assert.equal(classify(metric('rules_params'), fitLinear(seriesFromDump(d).rules_params), undefined).clock, 'sim');
});

test('gameSeconds is derived from the frame when absent', () => {
    const d = dumpOf([1, 2, 3]);
    d.snapshots.forEach((s) => { delete s.gameSeconds; });
    assert.deepEqual(seriesFromDump(d).rules_params.map((p) => p.days), [0, 1, 2]);
});

test('a watermark that never moved is labelled as weak evidence', () => {
    const r = classify(metric('rss_kb'), fitLinear([0, 1, 2, 3].map((d) => ({ days: d, value: 872976 }))), undefined);
    assert.equal(r.verdict, 'flat');
    assert.match(r.note, /watermark can only rise/);
});

// A wall-ceiling stop is the normal end of a soak ladder, and it produces a
// slope-per-day fitted over a window far shorter than a day. The number is
// still the right one to compare arms with; it must not read as if the ladder
// measured a day.
test('a slope fitted over a sub-day window is flagged as extrapolated', () => {
    const shortWindow = [0, 1, 2, 3, 4].map((i) => ({ days: i * 0.01, value: 200 + 60 * i * 0.01 }));
    const r = classify(metric('rules_params'), fitLinear(shortWindow), undefined);
    assert.equal(r.verdict, 'unexplained');
    assert.match(r.note, /×25 extrapolation/);

    // A full-length window carries no such caveat.
    const full = [0, 1, 2, 3, 4].map((d) => ({ days: d, value: 200 + 60 * d }));
    assert.doesNotMatch(classify(metric('rules_params'), fitLinear(full), undefined).note, /extrapolation/);
});

test('the ruling parameters are actually honoured', () => {
    const pts = [0, 1, 2, 3, 4].map((d) => ({ days: d, value: 1000 + 12 * d }));
    // Default floor is 1% of base = 10/day, so 12/day clears it and fails.
    assert.equal(classify(metric('rules_params'), fitLinear(pts), undefined, DEFAULT_RULING).verdict, 'unexplained');
    // Raise the floor to 5% of base and the same series is flat.
    assert.equal(classify(metric('rules_params'), fitLinear(pts), undefined, { sigmas: 2, minRelSlopePerDay: 0.05 }).verdict, 'flat');
});

// --- budget seeding -------------------------------------------------------
// The seed is what turns one soak run into the gate every later run is judged
// by, so a seeding rule that picks the wrong arm is a silently permanent
// mis-calibration.

const armOf = (label, entries) => ({
    label,
    results: entries.map(([key, slope, span, verdict = 'unexplained']) => ({
        key, verdict, fit: { slope, span, base: 100, n: 8, stderr: 0, r2: 1, maxAbs: 100 },
    })),
});

test('a budget seed is issued only where a metric actually failed', () => {
    const { seed } = seedBudgets([armOf('a', [
        ['rules_params', 60, 1],
        ['lua_heap_kb', 5000, 1, 'flat'],
        ['unit_spawns', 900, 1, 'explained'],
    ])]);
    assert.deepEqual(Object.keys(seed), ['rules_params']);
    assert.equal(seed.rules_params.why, null);
});

test('the largest slope wins among arms of comparable window', () => {
    const { seed, dropped } = seedBudgets([
        armOf('baseline', [['rules_params', 60, 1]]),
        armOf('churn', [['rules_params', 150, 0.8]]),
    ]);
    assert.equal(seed.rules_params.slopePerDay, 150);
    assert.deepEqual(dropped, []);
});

// The first real ladder: three arms ended in the war's opening ramp at ~0.003
// simulated days and reported rules_params at 45 864/sim-day; the one arm that
// ran on reported 25/sim-day over 0.265. Largest-wins across that set licenses
// a slope 1800x the steady state.
test('a short arm cannot raise the budget over a long one', () => {
    const { seed, dropped } = seedBudgets([
        armOf('long', [['rules_params', 25, 0.265]]),
        armOf('short', [['rules_params', 45864, 0.0033]]),
    ]);
    assert.equal(seed.rules_params.slopePerDay, 25);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].label, 'short');
    assert.equal(dropped[0].key, 'rules_params');
});

test('the span floor is per metric, not per arm', () => {
    // The same arm can be the long one for a wall-clocked metric and the short
    // one for a sim-clocked metric, because a frozen sim keeps burning wall
    // time — exactly what a war that ended does.
    const { seed } = seedBudgets([
        armOf('ended', [['rules_params', 45864, 0.0033], ['db_bytes', 1e8, 0.017]]),
        armOf('ran-on', [['rules_params', 25, 0.265], ['db_bytes', 9e7, 0.017]]),
    ]);
    assert.equal(seed.rules_params.slopePerDay, 25);
    assert.equal(seed.db_bytes.slopePerDay, 1e8);
});

// A budget's `basisSpanDays` is what lets a later run tell "this arm disagrees
// with the budget" from "this arm never measured the same window".
test('an arm far shorter than the budget basis cannot be ruled over-budget', () => {
    const budget = { slopePerDay: 25, tolerance: 12, basisSpanDays: 0.265, why: 'steady state' };
    const short = [0, 1, 2, 3].map((i) => ({ days: i * 0.001, value: 300 + 45864 * i * 0.001 }));
    const r = classify(metric('rules_params'), fitLinear(short), budget);
    assert.equal(r.verdict, 'too-short');
    assert.ok(INCONCLUSIVE.has(r.verdict));
    assert.match(r.note, /basis/);

    // A comparable window is still ruled — the check must not swallow the gate.
    const long = [0, 1, 2, 3].map((i) => ({ days: i * 0.09, value: 300 + 45864 * i * 0.09 }));
    assert.equal(classify(metric('rules_params'), fitLinear(long), budget).verdict, 'over-budget');
});

test('a budget with no basis still gates, as before', () => {
    const budget = { slopePerDay: 25, tolerance: 12, why: 'steady state' };
    const short = [0, 1, 2, 3].map((i) => ({ days: i * 0.001, value: 300 + 45864 * i * 0.001 }));
    assert.equal(classify(metric('rules_params'), fitLinear(short), budget).verdict, 'over-budget');
});

test('the seed records the window it was fitted over', () => {
    const { seed } = seedBudgets([armOf('long', [['rules_params', 25, 0.265]])]);
    assert.equal(seed.rules_params.basisSpanDays, 0.265);
});

// db_bytes measured: the WAL sawtooths on a ~31-wall-minute checkpoint cycle, so
// a 25-minute arm fits the ramp at r2 = 1.00 and reports five times the real
// rate. A relative floor cannot catch that; half a period is still no periods.
test('a window shorter than the metric\'s declared period cannot be ruled', () => {
    const budget = { slopePerDay: 37.77e6, tolerance: 18.9e6, basisSpanDays: 0.0382, minSpanDays: 0.0215, why: 'sawtooth' };
    const ramp = [0, 1, 2, 3].map((i) => ({ days: i * 0.005, value: 4.3e5 + 195.7e6 * i * 0.005 }));
    const r = classify(metric('db_bytes'), fitLinear(ramp), budget);
    assert.equal(r.verdict, 'too-short');
    assert.match(r.note, /declared minimum/);

    // Past one cycle the same budget rules normally.
    const full = [0, 1, 2, 3].map((i) => ({ days: i * 0.013, value: 4.3e5 + 37e6 * i * 0.013 }));
    assert.equal(classify(metric('db_bytes'), fitLinear(full), budget).verdict, 'explained');
});

// §12 measured, and all three of the first endless ladder's gate failures were
// this: a surface that steps during the war's opening ramp and then never moves
// again is fitted, over the whole window, as though it were still stepping.
// `rss_kb` rose 34 MB in the first simulated hour and a half and then sat still
// for seven simulated hours; the line through that says 25 438 kB/sim-day, a
// number no budget entry can honestly license because halving the window would
// double it.
test('a surface that stepped once and stopped is saturated, not unexplained', () => {
    // 40 samples over 0.4 sim-day. Rises for the first tenth, then flat.
    const pts = Array.from({ length: 40 }, (_, i) => {
        const days = i * 0.01;
        return { days, value: 1_050_000 + Math.min(i, 4) * 8000 };
    });
    // Without the series, classify rules exactly as it did before §12.
    assert.equal(classify(metric('rss_kb'), fitLinear(pts), undefined).verdict, 'unexplained');

    const r = classify(metric('rss_kb'), fitLinear(pts), undefined, DEFAULT_RULING, pts);
    assert.equal(r.verdict, 'saturated');
    assert.ok(!FAILING.has(r.verdict) && !INCONCLUSIVE.has(r.verdict), 'saturated is a pass');
    assert.match(r.note, /bounded STEP, not a rate/);
    assert.match(r.note, /last rise at 10% of the window/);
    assert.match(r.note, /no rise at all in raw values/);
});

test('a surface still rising at the end of the arm still fails', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ days: i * 0.01, value: 1_050_000 + i * 800 }));
    assert.equal(classify(metric('rss_kb'), fitLinear(pts), undefined, DEFAULT_RULING, pts).verdict, 'unexplained');
});

// A watermark cannot fall, so one late allocation the process never gives back
// is a real finding even when the tail's FIT is flat — here a 1 MB step under
// the 1%-of-base floor, which the floor would otherwise wave through. Raw values
// decide for a watermark; a live gauge is ruled on its tail slope, because it
// oscillates by design (§10.2) and a step that small is inside its noise.
test('a watermark that steps again inside the tail is not saturated', () => {
    const pts = Array.from({ length: 40 }, (_, i) => {
        const days = i * 0.01;
        return { days, value: 1_050_000 + Math.min(i, 4) * 8000 + (i >= 35 ? 1000 : 0) };
    });
    assert.equal(classify(metric('rss_kb'), fitLinear(pts), undefined, DEFAULT_RULING, pts).verdict, 'unexplained');

    const live = classify(metric('lua_heap_kb'), fitLinear(pts), undefined, DEFAULT_RULING, pts);
    assert.equal(live.verdict, 'saturated');
    assert.doesNotMatch(live.note, /raw values/);
});

// Saturation may only DOWNGRADE a failure. A licensed surface keeps reporting
// `explained` with its number, so a step that fits under its own budget is
// still compared against it rather than quietly re-labelled.
test('saturation never overrides a budget that already explains the slope', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ days: i * 0.01, value: 500 + Math.min(i, 4) * 2 }));
    const budget = { slopePerDay: 25, tolerance: 12, why: 'objective params ramp' };
    assert.equal(classify(metric('rules_params'), fitLinear(pts), budget, DEFAULT_RULING, pts).verdict, 'explained');
});

test('a tail too small to carry an error bar makes no saturation claim', () => {
    // 3 samples: the tail half holds 2, which cannot be fitted with an error bar.
    const pts = [0, 1, 2].map((i) => ({ days: i * 0.1, value: 1000 + Math.min(i, 1) * 300 }));
    assert.equal(saturation(pts, metric('rss_kb')), null);
    // So the ruling is whatever it was before §12 — the claim is never invented.
    assert.equal(classify(metric('rss_kb'), fitLinear(pts), undefined, DEFAULT_RULING, pts).verdict,
        classify(metric('rss_kb'), fitLinear(pts), undefined).verdict);
});
