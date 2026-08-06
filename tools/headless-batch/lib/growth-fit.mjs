// growth-fit — the pure half of the soak growth report (PLAN-long-uptime
// task 4). Takes a `--headless-run` stats dump's snapshot series, extracts one
// point series per growth surface, fits `base + slope×days`, and rules on each
// slope against a declared budget.
//
// The gate PLAN-long-uptime §2 asks for is: "every metric fits base +
// slope×days with slope explained by design (e.g. S2's per-player keys) or
// zero. An unexplained positive slope fails the soak." Two things that
// sentence leaves implicit and this module makes explicit, because getting
// either wrong turns the gate into noise:
//
//   1. **A slope is not a number, it is a number with an uncertainty.** The
//      synced Lua heap oscillates 4-11 MB on a live Metalstorm game (§10.2),
//      so a 6-point series through it will produce a large apparent slope of
//      either sign purely from where the samples landed in the GC cycle. A
//      fitted slope is only claimed here when it clears BOTH a t-like
//      significance test against its own standard error AND an absolute floor
//      — the same discipline PLAN-perf's M24 arrived at from the other end
//      ("take a same-arm noise-control pair before believing any delta").
//
//   2. **Some of these counters are SUPPOSED to slope.** `unit_spawns` is a
//      lifetime total of slot assignments; a campaign in which it stops
//      rising is a campaign in which nothing is being built. Ruling it a leak
//      would train everyone to ignore the report. Each metric therefore
//      declares a `kind`, and only `live` metrics — the ones §1 argued are
//      bounded — are gated on a zero slope.
//
// Pure: no fs, no process, no engine. Unit-tested by test/growth-fit.test.mjs.

/** Sim frames per game second — GAME_SPEED, the one engine constant here. */
export const GAME_SPEED = 30;
export const SECONDS_PER_DAY = 86400;

// The metric set, in report order. `path` is where the value lives in a
// snapshot row; `kind` decides how a slope is judged:
//
//   live       — a container §1 claims is bounded. A positive slope is a
//                finding unless a budget explains it.
//   cumulative — a lifetime total. Always slopes; the budget is a rate ceiling,
//                and a slope of zero is reported but never failed.
//   watermark  — monotone non-decreasing by construction (ru_maxrss). Slopes
//                like `live` but can never fall, so a flat reading is weak
//                evidence and is labelled as such rather than called clean.
//
// `unit` is display-only. `row` names the PLAN-long-uptime §1 row so a failing
// line points at the argument it falsifies.
//
// `clock` says which axis a surface actually grows along, and it is not a
// formatting detail — it decides whether the fitted number means anything.
// Everything the SIM owns (params, ids, orders, the Lua heap) advances per sim
// frame, so an uncapped ladder compresses it and a slope per SIMULATED day is
// the campaign-relevant rate. But `GameMetricsWriter::DueForWrite` is
// `steady_clock`-based (GameMetrics.cpp:111) — one metric row per 60 WALL
// seconds regardless of how fast the sim runs — and the S8/S9 retention sweeps
// task 2b landed are hourly on the same wall clock. Fitting those against
// simulated days divides the real rate by the acceleration factor (~130x here)
// and reports a database growing 130x slower than it will in production: a
// false pass, in the one direction a gate must never fail. `clock: 'wall'`
// metrics are therefore fitted against WALL days, which is the rate a
// realtime campaign will actually see.
export const METRICS = [
    { key: 'rss_kb',           path: ['growth', 'rss_kb'],           kind: 'watermark',  unit: 'kB',    row: 'S4' },
    { key: 'lua_heap_kb',      path: ['growth', 'lua_heap_kb'],      kind: 'live',       unit: 'kB',    row: 'S4' },
    { key: 'param_keys',       path: ['growth', 'param_keys'],       kind: 'live',       unit: 'keys',  row: 'S1' },
    { key: 'rules_params',     path: ['growth', 'rules_params'],     kind: 'live',       unit: 'params',row: 'S1/S2' },
    { key: 'unit_ids_used',    path: ['growth', 'unit_ids_used'],    kind: 'live',       unit: 'ids',   row: 'S5' },
    { key: 'unit_spawns',      path: ['growth', 'unit_spawns'],      kind: 'cumulative', unit: 'spawns',row: 'S5' },
    { key: 'standing_orders',  path: ['growth', 'standing_orders'],  kind: 'live',       unit: 'orders',row: 'S6' },
    { key: 'players',          path: ['growth', 'players'],          kind: 'live',       unit: 'rows',  row: 'S12' },
    { key: 'db_bytes',         path: ['dbBytes'],                    kind: 'live',       unit: 'B',     row: 'S8', clock: 'wall' },
];

/** Which time axis a metric's slope is quoted against. Defaults to sim. */
export const clockOf = (metric) => (metric.clock === 'wall' ? 'wall' : 'sim');

function pick(obj, path) {
    let v = obj;
    for (const k of path) {
        if (v == null || typeof v !== 'object') return undefined;
        v = v[k];
    }
    return typeof v === 'number' ? v : undefined;
}

/**
 * Pull one `{days, value}` series per metric out of a stats dump.
 *
 * `days` is SIMULATED days (gameSeconds / 86400) for every sim-clocked metric,
 * never wall time: the whole point of an uncapped ladder is that a simulated
 * month costs hours, and a slope per wall-day would be a property of the
 * machine. The exception is a `clock: 'wall'` metric, whose writer is paced by
 * `steady_clock` and for which the machine's clock IS the growth driver — see
 * METRICS.
 *
 * A snapshot missing the `growth` object entirely (a dump written by a
 * pre-task-4 binary) yields empty series rather than zeroes — the report then
 * says "no samples" instead of drawing a flat line through data that does not
 * exist. That is the same rule §10.2's third arm established for `extra_json`.
 */
export function seriesFromDump(dump) {
    const snaps = Array.isArray(dump?.snapshots) ? dump.snapshots : [];
    const out = {};
    for (const m of METRICS) {
        const wallClocked = clockOf(m) === 'wall';
        const pts = [];
        for (const s of snaps) {
            const value = pick(s, m.path);
            if (value === undefined) continue;
            const seconds = wallClocked
                ? (typeof s.wallSeconds === 'number' ? s.wallSeconds : undefined)
                : (typeof s.gameSeconds === 'number' ? s.gameSeconds
                    : typeof s.frame === 'number' ? s.frame / GAME_SPEED
                    : undefined);
            if (seconds === undefined) continue;
            pts.push({ days: seconds / SECONDS_PER_DAY, value });
        }
        out[m.key] = pts;
    }
    return out;
}

/**
 * Ordinary least squares of `value = base + slope × days`, plus the standard
 * error of the slope. `stderr` is NaN for n < 3 (no residual degrees of
 * freedom) — callers must treat that as "cannot rule", not as "significant".
 */
export function fitLinear(points) {
    const n = points.length;
    // `maxAbs` is carried because a series that read zero at every sample is a
    // different fact from a series that held steady at some value, and the fit
    // alone cannot tell them apart (both are base=0-slope or flat). See
    // classify's `no-signal`.
    const maxAbs = points.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0);
    if (n === 0) return { n: 0, base: NaN, slope: NaN, stderr: NaN, r2: NaN, span: 0, maxAbs };
    if (n === 1) return { n, base: points[0].value, slope: NaN, stderr: NaN, r2: NaN, span: 0, maxAbs };

    let sx = 0, sy = 0;
    for (const p of points) { sx += p.days; sy += p.value; }
    const mx = sx / n, my = sy / n;

    let sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
        const dx = p.days - mx, dy = p.value - my;
        sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }

    // Every sample at the same x (a dump with one snapshot repeated, or a
    // cadence that never advanced): no line is determined. Report the mean as
    // the base and refuse a slope rather than dividing by zero into Infinity.
    if (sxx === 0) return { n, base: my, slope: NaN, stderr: NaN, r2: NaN, span: 0, maxAbs };

    const slope = sxy / sxx;
    const base = my - slope * mx;

    let sse = 0;
    for (const p of points) {
        const resid = p.value - (base + slope * p.days);
        sse += resid * resid;
    }
    const stderr = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : NaN;
    const r2 = syy === 0 ? 1 : Math.max(0, 1 - sse / syy);
    const span = Math.max(...points.map((p) => p.days)) - Math.min(...points.map((p) => p.days));

    return { n, base, slope, stderr, r2, span, maxAbs };
}

/** Default ruling parameters. Overridable per run; see growth-report.mjs. */
export const DEFAULT_RULING = {
    // How many standard errors a slope must clear before it is believed at
    // all. 2 is the usual ~95% convention and is the right severity for a
    // gate that a human reads rather than one that pages someone.
    sigmas: 2,
    // Absolute floor, as a fraction of the series' own base value, below which
    // a slope is called flat however significant it is. A perfectly clean
    // counter drifting 0.1% per simulated day is not the leak this gate is
    // hunting, and a soak long enough to resolve it does not exist.
    minRelSlopePerDay: 0.01,
};

/**
 * Rule on one metric's fit.
 *
 * Verdicts:
 *   no-samples  — the dump carried nothing for this metric.
 *   no-signal   — the metric was sampled and read ZERO at every sample. The
 *                 container was never exercised by this ladder, so the run is
 *                 not evidence that it is bounded; NOT a pass.
 *   too-short   — fewer than 3 points, or every point at the same x. A slope
 *                 cannot be ruled on; NOT a pass.
 *   flat        — slope indistinguishable from zero (by sigma or by floor).
 *   explained   — sloping, and a budget entry accounts for it and is not
 *                 exceeded.
 *   over-budget — sloping, budgeted, and above the budgeted rate + tolerance.
 *   unexplained — sloping with no budget entry. This is the failure §2 names.
 *
 * `budget` (optional) is `{ slopePerDay, tolerance?, why }`. `why` is required
 * for a budget to count: §2's gate is "slope explained by design", and a bare
 * number with no reason attached is how a soak gate stops being one.
 */
export function classify(metric, fit, budget, ruling = DEFAULT_RULING) {
    // A slope is quoted per DAY on the metric's own clock, and a ladder that
    // only covered a simulated hour is reporting a 24× extrapolation off a
    // lever arm it never measured. That is legitimate — it is the only way to compare arms of
    // different lengths — but it must be visible on the line, because a soak
    // cut short by its wall ceiling produces exactly this and the number looks
    // identical to one from a full run.
    const clock = clockOf(metric);
    const lever = fit.span > 0 && fit.span < 1 ? ` [×${(1 / fit.span).toFixed(0)} extrapolation from a ${fmt(fit.span)}-${clock}-day window]` : '';
    const mk = (verdict, note) => ({ key: metric.key, kind: metric.kind, row: metric.row, unit: metric.unit, clock, fit, budget: budget ?? null, verdict, note: note + (INCONCLUSIVE.has(verdict) ? '' : lever) });

    if (fit.n === 0) return mk('no-samples', 'metric absent from every snapshot');
    // A counter that read zero on every sample fits the flattest line there
    // is, and reporting that as `flat` is how a soak certifies a surface it
    // never touched. The first real ladder produced exactly this for
    // `param_keys` (S1): a headless run has no client sessions, so
    // StateStreamer interns no keys, and the dictionary this plan spent a
    // milestone bounding sat at 0 for the whole run. "Zero forever" is the
    // signature of an unexercised surface, not of a bounded one, and the
    // difference decides whether §1's argument was tested or merely restated.
    if (fit.maxAbs === 0)
        return mk('no-signal', `read 0 at all ${fit.n} samples — this ladder never exercised the surface, so it is not evidence of a bound`);
    // n < 3 is ruled out BEFORE the slope is looked at, not after. Two points
    // always fit a line exactly, so `slope` is finite, `r2` is 1 and the
    // residual error is zero — a two-sample series looks like the most
    // confident reading in the report and is the least. The stderr is NaN
    // precisely because there are no degrees of freedom left to estimate it.
    if (fit.n < 3)
        return mk('too-short', `${fit.n} sample(s); need 3 for a slope with an error bar`);
    if (!Number.isFinite(fit.slope))
        return mk('too-short', 'every sample at the same simulated time');

    // A zero stderr from n >= 3 is a genuinely perfect fit (a counter stepping
    // by a fixed amount every sample), so the slope is believed on its own.
    const significant = Number.isFinite(fit.stderr) && fit.stderr > 0
        ? Math.abs(fit.slope) > ruling.sigmas * fit.stderr
        : Math.abs(fit.slope) > 0;
    const scale = Math.abs(fit.base) > 0 ? Math.abs(fit.base) : 1;
    const clearsFloor = Math.abs(fit.slope) >= ruling.minRelSlopePerDay * scale;

    if (!significant || !clearsFloor) {
        const why = !significant
            ? `|slope| ${fmt(Math.abs(fit.slope))} within ${ruling.sigmas}σ (σ=${fmt(fit.stderr)})`
            : `|slope| ${fmt(Math.abs(fit.slope))} under the ${(ruling.minRelSlopePerDay * 100).toFixed(1)}%-of-base floor`;
        return mk('flat', metric.kind === 'watermark'
            ? `${why} — but a watermark can only rise, so flat here means "never grew", not "returns memory"`
            : why);
    }

    // A falling live counter is a container being reclaimed. That is the fix
    // working, not a finding — S1 compaction and the gadget archives are both
    // supposed to produce exactly this.
    if (fit.slope < 0)
        return mk('flat', `falling ${fmt(fit.slope)}/day — reclamation, not growth`);

    // A lifetime total rising is the design, so it is explained by default and
    // only a budget WITH a reason can turn it into a rate ceiling. Checked
    // before the `why` rule below, so a half-written budget entry downgrades a
    // cumulative metric to its default reading rather than failing it — the
    // gate must not invent a finding out of a malformed budget file.
    if (metric.kind === 'cumulative' && !budget?.why)
        return mk('explained', 'lifetime total; rising is the design. No rate budget declared');

    if (!budget || !budget.why)
        return mk('unexplained', budget ? 'budget entry has no `why`; §2 requires the slope be EXPLAINED, not merely allowed' : 'no budget entry accounts for this slope');

    const tol = budget.tolerance ?? Math.abs(budget.slopePerDay) * 0.25;
    if (fit.slope > budget.slopePerDay + tol)
        return mk('over-budget', `${fmt(fit.slope)}/day vs budget ${fmt(budget.slopePerDay)} ±${fmt(tol)} — ${budget.why}`);
    return mk('explained', `${fmt(fit.slope)}/day within budget ${fmt(budget.slopePerDay)} ±${fmt(tol)} — ${budget.why}`);
}

/** Verdicts that fail the soak gate. */
export const FAILING = new Set(['unexplained', 'over-budget']);
/** Verdicts that mean the run could not rule — reported, but not a pass. */
export const INCONCLUSIVE = new Set(['no-samples', 'no-signal', 'too-short']);

export function fmt(v) {
    if (!Number.isFinite(v)) return 'n/a';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return v.toFixed(0);
    if (a >= 1) return v.toFixed(2);
    return v.toPrecision(3);
}

/** Fit + rule every metric of one dump. */
export function reportDump(dump, budgets = {}, ruling = DEFAULT_RULING) {
    const series = seriesFromDump(dump);
    return METRICS.map((m) => classify(m, fitLinear(series[m.key]), budgets[m.key], ruling));
}
