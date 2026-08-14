// Churn-arm checks — PLAN-long-uptime.md **T4-1** (ladder 2).
//
// The claim this arm exists to make checkable is T4-2's: S1 (`param_keys`) and
// S6 (`standing_orders`) are not *bounded* on a headless ladder, they are
// **unexercised**. `StateStreamer::BroadcastRulesParams` returns at
// `GetClientCount() == 0` before the interning block, and a standing order can
// only be created by a session with a team — so both containers read 0 at
// every sample of every client-less run, and the growth report correctly calls
// that `no-signal` rather than a bound.
//
// Which means a churn arm's verdict has three parts, and all three are
// necessary:
//
//  1. **The churn happened** — cycles authenticated, bytes left, seats were
//     real. A window whose sessions never got in produces a dump that looks
//     exactly like the client-less one.
//  2. **The surfaces moved** — S1/S6 read non-zero at some sample. This is the
//     no-signal flip, and it is the whole point of the arm.
//  3. **The control did not** — the SAME fixture with nobody connecting must
//     still read 0. Without it, an S1 that turned out to be interned by the
//     sim itself would read as the harness's doing.
//
// Pure functions over a parsed dump / verdict object (no fs, no spawn), the
// same pure-core split fixture-checks.mjs and matrix.mjs use.

/** Growth keys this arm rules, with the PLAN-long-uptime row each belongs to. */
export const CLIENT_SURFACES = [
    { key: 'param_keys', row: 'S1', what: 'interned rulesParams keys' },
    { key: 'standing_orders', row: 'S6', what: 'live standing orders' },
];

/** Every sampled value of one growth counter, in snapshot order. Missing
 *  fields are skipped rather than read as 0 — a dump from a pre-task-4 binary
 *  has no `growth` object at all, and "not sampled" must not become "measured
 *  zero" (the rule seriesFromDump follows for the same reason). */
export function growthSeries(dump, key) {
    const out = [];
    for (const s of dump?.snapshots ?? []) {
        const v = s?.growth?.[key];
        if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
    return out;
}

/** Peak and final reading of one counter. Peak because a standing order can
 *  expire: a window that created 40 orders which all timed out before the last
 *  snapshot ends at 0, and that run exercised S6 more than one that ended
 *  holding a single order, not less. */
export function surfaceReading(dump, key) {
    const series = growthSeries(dump, key);
    return {
        samples: series.length,
        peak: series.reduce((m, v) => Math.max(m, v), 0),
        final: series.length ? series[series.length - 1] : 0,
    };
}

/**
 * Part 1 — the churn window itself. `minCycles` is what the caller asked for;
 * an arm that ran for the whole window and completed one cycle is a slow
 * server, not a churn ladder, and must not be allowed to satisfy part 2 on the
 * strength of a single connect.
 */
export function checkChurnWindow(verdict, { minCycles = 2, minDistinctSeats = 1 } = {}) {
    const problems = [];
    if (!verdict) return { ok: false, problems: ['the churn driver produced no verdict'], facts: {} };

    const authed = verdict.cyclesAuthed ?? 0;
    const failed = verdict.cyclesFailed ?? 0;
    const soTag = verdict.standingOrderPayloadType;
    const sent = verdict.sentByPayload ?? {};
    const ordersSent = soTag === undefined || soTag === null ? 0 : (sent[String(soTag)] ?? 0);
    const seats = verdict.seats ?? [];
    // A seat is what makes S6 reachable at all (the 401 branch is
    // `session->team < 0`), so "seated" is asserted, not assumed from an OK
    // auth — a spectator authenticates perfectly well.
    const seated = seats.filter((s) => (s?.team ?? -1) >= 0);
    const distinctSeated = new Set(seated.map((s) => s.user)).size;

    if (authed < minCycles) problems.push(`only ${authed} cycle(s) authenticated, wanted ${minCycles}`);
    if (failed > 0) problems.push(`${failed} cycle(s) failed: ${(verdict.failures ?? []).slice(0, 3).join('; ')}`);
    if ((verdict.writeErrors ?? []).length) {
        problems.push(`${verdict.writeErrors.length} write(s) never left the client`);
    }
    if (ordersSent < 1) {
        problems.push('no StandingOrderCreate was sent — S6 could not have moved either way');
    }
    if (distinctSeated < minDistinctSeats) {
        problems.push(`${distinctSeated} distinct seated account(s), wanted ${minDistinctSeats} `
            + '(an unseated session is refused with 401 and can never create a standing order)');
    }
    return {
        ok: problems.length === 0,
        problems,
        facts: {
            cyclesAuthed: authed, cyclesFailed: failed, ordersSent,
            seatedCycles: seated.length, distinctSeated,
            serverErrorsByCode: verdict.serverErrorsByCode ?? {},
        },
    };
}

/**
 * Part 2 — the surfaces. Reports every counter's reading and fails on the ones
 * that stayed at zero, naming the row so the reader is sent to the plan and
 * not to this file.
 */
export function checkClientSurfaces(dump, { surfaces = CLIENT_SURFACES } = {}) {
    const problems = [];
    const readings = {};
    if (!dump) return { ok: false, problems: ['the churn arm produced no stats dump'], readings };
    for (const s of surfaces) {
        const r = surfaceReading(dump, s.key);
        readings[s.key] = r;
        if (r.samples === 0) {
            problems.push(`${s.key} (${s.row}) was never sampled — the dump carries no growth block`);
        } else if (r.peak === 0) {
            problems.push(`${s.key} (${s.row}, ${s.what}) read 0 at all ${r.samples} samples `
                + 'even with clients connected — still no-signal, so this ladder rules nothing');
        }
    }
    return { ok: problems.length === 0, problems, readings };
}

/**
 * Part 3 — the matched control. Same fixture, same binary, nobody connecting.
 * Its job is to fail if a surface would have moved anyway: a non-zero control
 * does not mean the churn arm is wrong, it means the arm is not what moved it,
 * and the difference is what the plan gets to quote.
 */
export function compareChurnToControl(churnDump, controlDump, { surfaces = CLIENT_SURFACES } = {}) {
    const problems = [];
    const deltas = {};
    for (const s of surfaces) {
        const churn = surfaceReading(churnDump, s.key);
        const control = surfaceReading(controlDump, s.key);
        deltas[s.key] = { churnPeak: churn.peak, controlPeak: control.peak };
        if (control.samples === 0) {
            problems.push(`the control arm never sampled ${s.key} — the pair cannot be compared`);
        } else if (control.peak !== 0) {
            problems.push(`${s.key} (${s.row}) peaked at ${control.peak} with NOBODY connected — `
                + 'this surface is not driven by client churn and the arm is not evidence about it');
        } else if (churn.peak <= control.peak) {
            problems.push(`${s.key} (${s.row}) did not exceed its control (${churn.peak} vs ${control.peak})`);
        }
    }
    return { ok: problems.length === 0, problems, deltas };
}
