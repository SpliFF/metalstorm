// Unit tests for the churn arm's verdict — PLAN-long-uptime T4-1.
//
// Everything asserted here is about the SHAPE of a verdict, so it runs without
// a server binary, a node addon or a network. The live half (a real window
// against a real headless run) is soak-churn-run.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    checkChurnWindow, checkClientSurfaces, compareChurnToControl,
    growthSeries, surfaceReading,
} from '../lib/churn-checks.mjs';

/** A dump whose growth block reads `values[i]` at snapshot i. */
function dumpWith(key, values) {
    return { snapshots: values.map((v, i) => ({ frame: i * 900, growth: { [key]: v } })) };
}

function mergeDumps(a, b) {
    return {
        snapshots: a.snapshots.map((s, i) => ({
            ...s, growth: { ...s.growth, ...(b.snapshots[i]?.growth ?? {}) },
        })),
    };
}

const goodVerdict = {
    cyclesAuthed: 6, cyclesFailed: 0, writeErrors: [],
    standingOrderPayloadType: 34,
    sentByPayload: { 34: 6, 22: 6 },
    seats: [
        { user: 'churn_soak_0', playerNum: 0, team: 1, role: 'player' },
        { user: 'churn_soak_1', playerNum: 1, team: 5, role: 'player' },
    ],
    serverErrorsByCode: {},
    failures: [],
};

test('a healthy churn window holds', () => {
    const r = checkChurnWindow(goodVerdict, { minCycles: 2, minDistinctSeats: 2 });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.equal(r.facts.ordersSent, 6);
    assert.equal(r.facts.distinctSeated, 2);
});

test('a window whose sessions were admitted UNSEATED fails, however clean the auth', () => {
    // The trap this exists for: a spectator authenticates perfectly (status OK,
    // playerNum assigned) and its StandingOrderCreate is refused with a 401,
    // because the server's gate is `session->team < 0`. A verdict that read
    // "auth ok" as "seated" would report the arm healthy while S6 could never
    // have moved.
    const spectators = {
        ...goodVerdict,
        seats: goodVerdict.seats.map((s) => ({ ...s, team: -1, role: 'spectator' })),
    };
    const r = checkChurnWindow(spectators, { minCycles: 2, minDistinctSeats: 2 });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /distinct seated/);
    assert.match(r.problems.join(' '), /401/);
});

test('a window that sent no standing order cannot claim S6 either way', () => {
    const noOrders = { ...goodVerdict, sentByPayload: { 22: 6 } };
    const r = checkChurnWindow(noOrders, { minCycles: 2, minDistinctSeats: 2 });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /no StandingOrderCreate/);
});

test('one connect is not a churn ladder', () => {
    const r = checkChurnWindow({ ...goodVerdict, cyclesAuthed: 1 }, { minCycles: 4, minDistinctSeats: 2 });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /only 1 cycle/);
});

test('a write that never left fails the window rather than being counted as sent', () => {
    const r = checkChurnWindow({ ...goodVerdict, writeErrors: ['stream broken'] },
        { minCycles: 2, minDistinctSeats: 2 });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /never left/);
});

test('a missing verdict fails rather than being read as an empty window', () => {
    // Not hypothetical: on 2026-08-14 the driver's own JSON was truncated at
    // the 8 KiB pipe buffer by `process.exit()` and the caller got a zero exit
    // status with unparseable stdout. The verdict must fail loudly, because
    // "no verdict" and "a window that did nothing" are the same shape here.
    const r = checkChurnWindow(null);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /no verdict/);
});

test('growthSeries skips unsampled fields instead of reading them as zero', () => {
    const dump = { snapshots: [{ growth: { param_keys: 4 } }, { /* no growth block */ }, { growth: {} }] };
    assert.deepEqual(growthSeries(dump, 'param_keys'), [4]);
    assert.deepEqual(surfaceReading(dump, 'standing_orders'), { samples: 0, peak: 0, final: 0 });
});

test('a surface reads by PEAK, so orders that expired before the last sample still count', () => {
    const dump = dumpWith('standing_orders', [0, 3, 5, 0]);
    const r = surfaceReading(dump, 'standing_orders');
    assert.equal(r.peak, 5);
    assert.equal(r.final, 0);
});

test('surfaces that stayed at zero WITH clients connected fail, naming the row', () => {
    const dump = mergeDumps(dumpWith('param_keys', [12, 40, 61]), dumpWith('standing_orders', [0, 0, 0]));
    const r = checkClientSurfaces(dump);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /standing_orders \(S6/);
    assert.equal(r.readings.param_keys.peak, 61);
});

test('a dump with no growth block at all is "never sampled", not "measured zero"', () => {
    const r = checkClientSurfaces({ snapshots: [{ frame: 0 }, { frame: 900 }] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /never sampled/);
});

test('the pair attributes movement only when the control stayed at zero', () => {
    const churn = mergeDumps(dumpWith('param_keys', [0, 40, 61]), dumpWith('standing_orders', [0, 2, 4]));
    const control = mergeDumps(dumpWith('param_keys', [0, 0, 0]), dumpWith('standing_orders', [0, 0, 0]));
    const r = compareChurnToControl(churn, control);
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.deepEqual(r.deltas.param_keys, { churnPeak: 61, controlPeak: 0 });
});

test('a control that moved on its own fails the pair — the arm is then not the cause', () => {
    const churn = mergeDumps(dumpWith('param_keys', [0, 40, 61]), dumpWith('standing_orders', [0, 2, 4]));
    const control = mergeDumps(dumpWith('param_keys', [0, 7, 9]), dumpWith('standing_orders', [0, 0, 0]));
    const r = compareChurnToControl(churn, control);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /NOBODY connected/);
});

test('a control with no samples fails rather than passing as an implicit zero', () => {
    const churn = mergeDumps(dumpWith('param_keys', [0, 40]), dumpWith('standing_orders', [0, 2]));
    const r = compareChurnToControl(churn, { snapshots: [] });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(' '), /never sampled/);
});
