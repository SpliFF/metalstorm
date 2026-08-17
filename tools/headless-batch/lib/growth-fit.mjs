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
// `reclaim` declares that a surface has a RECLAIMER — a mechanism in the server
// that periodically gives the container back — and names it. It is a
// declaration, never an inference: a live gauge that happens to fall (the Lua
// heap between collections) must not be read as bounded, because "it went down
// once" is what a leak with a GC in front of it looks like too. Only a surface
// whose reclaimer is written down here is eligible for the `reclaimed` verdict,
// and even then it is the trend of its PEAKS that rules — see `reclamation`.
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
    { key: 'param_keys',       path: ['growth', 'param_keys'],       kind: 'live',       unit: 'keys',  row: 'S1',
      reclaim: { by: 'the key-dictionary compaction (task 2b), which fires on the kKeyDictCompactMinDead = 512 dead-id floor — a COUNT, not a clock' } },
    { key: 'rules_params',     path: ['growth', 'rules_params'],     kind: 'live',       unit: 'params',row: 'S1/S2' },
    { key: 'unit_ids_used',    path: ['growth', 'unit_ids_used'],    kind: 'live',       unit: 'ids',   row: 'S5' },
    { key: 'unit_spawns',      path: ['growth', 'unit_spawns'],      kind: 'cumulative', unit: 'spawns',row: 'S5' },
    { key: 'standing_orders',  path: ['growth', 'standing_orders'],  kind: 'live',       unit: 'orders',row: 'S6',
      reclaim: { by: 'the standing-order TTL (task 2b), defaultTtlFrames = 108 000 = one SIMULATED hour', periodDays: 1 / 24 } },
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
    // How far a `reclaim` surface must fall below its running peak before the
    // fall is read as its reclaimer firing rather than as ordinary movement.
    // Measured: the 6-minute churn arm's `standing_orders` wobbles ±2 orders on
    // an ~80-order series (2-3%) as individual deadlines pass, and its real
    // TTL drawdown is 82 -> 70 (15%); `param_keys` compacts 1 049 -> 538 (51%).
    // 10% sits between the two by a wide margin in both directions. A floor too
    // low turns every sample into a "cycle" and the peak series into the raw
    // series; too high and a slow reclaimer never registers at all.
    reclaimDrawdownFraction: 0.1,
};

/**
 * Fill in every ruling parameter a caller did not supply.
 *
 * Callers legitimately pass partial rulings (a CLI that exposes two of the
 * knobs as flags, a test that varies one). Reading a missing knob then yields
 * `undefined`, and an arithmetic comparison against `undefined` is `false`
 * rather than an error — so the affected rule does not fail, it silently stops
 * applying. Measured: growth-report.mjs assembled its ruling field-by-field and
 * `reclaimDrawdownFraction` was undefined there, which made the sawtooth rule
 * inert through the CLI while every unit test (which passes DEFAULT_RULING)
 * passed.
 */
export const withRulingDefaults = (ruling) => ({ ...DEFAULT_RULING, ...(ruling ?? {}) });

/**
 * How much of a window's TAIL is examined when asking whether a slope is still
 * happening at the end of the arm. Half: large enough to carry its own error
 * bar on these sample counts (272-288 samples per arm → ~140 in the tail), and
 * small enough that a surface which stopped moving in the first quartile is
 * ruled on ~7 simulated hours of stillness rather than on 30 minutes of it.
 */
export const TAIL_FRACTION = 0.5;

/** The `flat` test, extracted so the tail can be ruled by the same rule as the window. */
function flatness(fit, ruling) {
    const significant = Number.isFinite(fit.stderr) && fit.stderr > 0
        ? Math.abs(fit.slope) > ruling.sigmas * fit.stderr
        : Math.abs(fit.slope) > 0;
    const scale = Math.abs(fit.base) > 0 ? Math.abs(fit.base) : 1;
    const clearsFloor = Math.abs(fit.slope) >= ruling.minRelSlopePerDay * scale;
    const why = !significant
        ? `|slope| ${fmt(Math.abs(fit.slope))} within ${ruling.sigmas}σ (σ=${fmt(fit.stderr)})`
        : `|slope| ${fmt(Math.abs(fit.slope))} under the ${(ruling.minRelSlopePerDay * 100).toFixed(1)}%-of-base floor`;
    return { flat: !significant || !clearsFloor, why };
}

/** The points in the last `fraction` of a series' own window, by x not by count. */
export function tailPoints(points, fraction = TAIL_FRACTION) {
    if (points.length === 0) return [];
    const xs = points.map((p) => p.days);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const cut = hi - (hi - lo) * fraction;
    return points.filter((p) => p.days >= cut);
}

/** x of the last strict increase in a series, or null if it never rose. */
export function lastRise(points) {
    for (let i = points.length - 1; i > 0; i--)
        if (points[i].value > points[i - 1].value) return points[i].days;
    return null;
}

/**
 * Is this series SATURATED — did it grow during the arm's opening ramp and then
 * stop, rather than grow at the fitted rate throughout?
 *
 * This exists because the first endless ladder (§12) failed the gate three
 * times and every one of the three was this artefact. `rss_kb` on the
 * normal-density arms rose 34 MB and 80 MB during the first simulated hour and
 * a half — staging 500 units, the pathfinder's caches, the first convoy cycle —
 * and then did not move for the remaining SEVEN simulated hours. A single
 * least-squares line through the whole window turns that into "25 438 kB per
 * simulated day, forever", which is both wrong and unfixable: no budget entry
 * can honestly license it, because the number is not a rate at all. It is a
 * step, divided by however long the arm happened to run — halve the window and
 * the reported "rate" doubles.
 *
 * The test is therefore asked on the TAIL, and only ever as a way to DOWNGRADE
 * a failure: whole-window numbers stay in the report exactly as fitted, and a
 * surface still rising at the end of the arm still fails. Returns null when the
 * tail cannot rule (too few samples, or the sampling is too lopsided to leave a
 * comparable window), which classify treats as "no saturation claim" and leaves
 * the failure standing.
 *
 * For a `watermark` the tail must additionally not have risen AT ALL, in raw
 * values: ru_maxrss is monotone, so one late step is a real allocation the
 * process never gave back and a 2σ test on a mostly-flat tail could absorb it.
 */
export function saturation(points, metric, ruling = DEFAULT_RULING, fraction = TAIL_FRACTION) {
    ruling = withRulingDefaults(ruling);
    const tail = tailPoints(points, fraction);
    if (tail.length < 3) return null;
    const window = fitLinear(points), tailFit = fitLinear(tail);
    if (!(window.span > 0) || !(tailFit.span >= 0.8 * fraction * window.span)) return null;

    const { flat, why } = flatness(tailFit, ruling);
    const rose = tail[tail.length - 1].value > tail[0].value;
    if (!flat) return null;
    if (metric.kind === 'watermark' && rose) return null;

    const rise = lastRise(points);
    const at = rise === null ? null : (rise - (window.span > 0 ? Math.min(...points.map((p) => p.days)) : 0)) / window.span;
    return { tailFit, tailFraction: fraction, lastRiseDays: rise, lastRiseAtFraction: at, why };
}

/**
 * Split a series into RECLAMATION CYCLES: the peak of each run-up, and the
 * drawdowns between them.
 *
 * A cycle ends at the first sample that has fallen `reclaimDrawdownFraction`
 * below the running peak since the last end; that peak is the cycle's peak, and
 * the next cycle starts from the falling sample. The last (possibly incomplete)
 * segment always contributes its own peak, so a series with one drawdown yields
 * two peaks — which is exactly the case the ruling below refuses to rule on.
 *
 * `drops` carries `{days, from, to}` per drawdown so a verdict can quote the
 * reclaimer being seen to fire rather than merely asserting it exists.
 */
export function reclaimCycles(points, ruling = DEFAULT_RULING) {
    ruling = withRulingDefaults(ruling);
    const peaks = [], drops = [];
    if (points.length === 0) return { peaks, drops };
    let peak = points[0];
    for (const p of points) {
        if (p.value > peak.value) { peak = p; continue; }
        if (peak.value > 0 && p.value <= peak.value * (1 - ruling.reclaimDrawdownFraction)) {
            peaks.push(peak);
            drops.push({ days: p.days, from: peak.value, to: p.value });
            peak = p;
        }
    }
    peaks.push(peak);
    return { peaks, drops };
}

/**
 * Is this series a SAWTOOTH held down by its own reclaimer, rather than growth?
 *
 * `saturation` above answers "did it stop?"; this answers the other shape §14
 * put in front of the gate, which is a surface that never stops and is bounded
 * anyway. S6 ramps ~1 order per churn cycle and the TTL retires the oldest, so
 * the live count settles at ≈ churn-rate × TTL; S1 interns keys until 512 are
 * dead and then compacts. Both fit as growth over any window and neither is.
 *
 * **The rule is that a sawtooth is bounded if and only if its PEAKS are.** The
 * fitted line through the raw series is a property of where in the cycle the
 * window started and ended; the peak envelope is not. So the peaks become the
 * series and the same flatness test rules them.
 *
 * Three outcomes, and the middle one is the honest answer to most real arms:
 *
 *   reclaimed    — ≥2 drawdowns (≥3 peaks) and the peak envelope fits flat or
 *                  falling. The reclaimer is keeping up. A pass.
 *   one-cycle    — the reclaimer was seen to fire, but once. Two peaks always
 *                  fit a line exactly (the same trap `too-short` exists for),
 *                  and one cycle cannot say whether the next peak comes back
 *                  higher. NOT a pass, and NOT a failure: the arm is too short,
 *                  which is a fact about the arm.
 *   peaks-rising — the reclaimer fires and the peaks climb through it anyway.
 *                  That is a leak with a collector in front of it, and the
 *                  failure stands with the envelope quoted.
 *
 * Returns null for a metric that declares no reclaimer, or one whose reclaimer
 * was never observed to fire inside the window — in both cases there is no
 * claim to make and the caller's existing ruling stands untouched.
 */
export function reclamation(points, metric, ruling = DEFAULT_RULING) {
    ruling = withRulingDefaults(ruling);
    if (!metric?.reclaim || !points || points.length < 3) return null;
    const { peaks, drops } = reclaimCycles(points, ruling);
    if (drops.length === 0) return null;
    if (peaks.length < 3) return { shape: 'one-cycle', peaks, drops, peakFit: null, why: null };
    const peakFit = fitLinear(peaks);
    const { flat, why } = flatness(peakFit, ruling);
    if (flat || peakFit.slope < 0) return { shape: 'reclaimed', peaks, drops, peakFit, why };
    return { shape: 'peaks-rising', peaks, drops, peakFit, why };
}

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
 *   saturated   — the whole-window slope would have failed, but the surface
 *                 stopped moving inside the arm: the last half of the window
 *                 fits flat (and for a watermark did not rise at all). A
 *                 bounded step, not a rate. Passes; see `saturation`.
 *   reclaimed   — the whole-window slope would have failed, but the surface is
 *                 a sawtooth under a declared reclaimer and its PEAK ENVELOPE
 *                 is flat or falling over ≥2 cycles. Passes; see `reclamation`.
 *   one-cycle   — the declared reclaimer was observed to fire exactly once, so
 *                 the peak envelope is two points and cannot be ruled on. NOT
 *                 a pass; the arm needs a longer window.
 *   explained   — sloping, and a budget entry accounts for it and is not
 *                 exceeded.
 *   over-budget — sloping, budgeted, and above the budgeted rate + tolerance.
 *   unexplained — sloping with no budget entry. This is the failure §2 names.
 *
 * `budget` (optional) is `{ slopePerDay, tolerance?, why }`. `why` is required
 * for a budget to count: §2's gate is "slope explained by design", and a bare
 * number with no reason attached is how a soak gate stops being one.
 *
 * `points` (optional) is the same series `fit` was fitted from. Supplying it
 * enables the `saturated` verdict, which is the only thing it is used for — a
 * caller that omits it gets the pre-§12 ruling exactly, including the failures
 * §12 showed were artefacts.
 */
export function classify(metric, fit, budget, ruling = DEFAULT_RULING, points = null) {
    ruling = withRulingDefaults(ruling);
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
    const { flat, why } = flatness(fit, ruling);

    // Only ever consulted below, and only to downgrade a FAILING verdict: a
    // surface that is still moving at the end of the arm fails on its
    // whole-window slope exactly as before.
    const sat = points ? saturation(points, metric, ruling) : null;
    const saturated = () => {
        const s = sat;
        // "Last rise" is only a fact about a MONOTONE series. A live gauge
        // oscillates, so its last sample is up as often as not and the clause
        // would read "last rise at 100% of the window" on a surface whose whole
        // second half is flat — the opposite of what the verdict says. Quoted
        // for a watermark, where it names the frame the growth stopped at.
        const at = metric.kind === 'watermark'
            ? (s.lastRiseAtFraction === null ? 'never rose'
                : `last rise at ${(s.lastRiseAtFraction * 100).toFixed(0)}% of the window (${fmt(s.lastRiseDays)} ${clock}-day)`)
            : 'the growth is in the opening ramp';
        return mk('saturated',
            `whole-window slope ${fmt(fit.slope)}/${clock}-day is a bounded STEP, not a rate: ${at}, ` +
            `and the last ${(s.tailFraction * 100).toFixed(0)}% of the window fits flat (${s.why}, n=${s.tailFit.n})` +
            (metric.kind === 'watermark' ? ' with no rise at all in raw values' : ''));
    };

    // The second shape §14 put in front of the gate: a surface that never
    // stops and is bounded anyway. Consulted at the same two sites as `sat`,
    // after it — a surface that stepped and stopped is better described as a
    // step, and `param_keys` on a short arm is exactly that.
    const rec = points ? reclamation(points, metric, ruling) : null;
    const drops = () => rec.drops.map((d) => `${fmt(d.from)}->${fmt(d.to)}`).join(', ');
    const reclaimed = () => mk('reclaimed',
        `whole-window slope ${fmt(fit.slope)}/${clock}-day is a SAWTOOTH under ${metric.reclaim.by}: ` +
        `${rec.drops.length} reclamation(s) (${drops()}) and the peak envelope over ${rec.peaks.length} cycles ` +
        `is flat or falling (${rec.why}, n=${rec.peakFit.n}) — the reclaimer is keeping up`);
    const oneCycle = () => mk('one-cycle',
        `${metric.reclaim.by} fired ONCE inside this window (${drops()}), so the peak envelope is ` +
        `${rec.peaks.length} points and any line through it is exact by construction — a second cycle is ` +
        `what would rule this${Number.isFinite(metric.reclaim.periodDays)
            ? `; the mechanism's period is ${fmt(metric.reclaim.periodDays)} ${clock}-day against this arm's ${fmt(fit.span)}`
            : ''}`);
    // A reclaimer that fires while the peaks climb through it is a leak with a
    // collector in front of it. The failure stands; the envelope is quoted so
    // the next reader does not have to re-derive it.
    const risingNote = () => ` — its declared reclaimer (${metric.reclaim.by}) fired ${rec.drops.length}×, ` +
        `and the peak envelope still rises at ${fmt(rec.peakFit.slope)}/${clock}-day across ${rec.peaks.length} cycles`;
    /**
     * The shape verdicts, in the order they may downgrade a failure — and the
     * order is load-bearing in both places:
     *
     *  - `reclaimed` outranks `saturated` because a ruled sawtooth's tail
     *    often DOES fit flat (it ends wherever the last cycle left it), and
     *    `saturated`'s explanation — "the growth is in the opening ramp" — is
     *    then simply false. The more specific claim, with the mechanism named
     *    and its cycles counted, is the one worth reporting.
     *  - `saturated` outranks `one-cycle`, because a surface that stopped
     *    moving is a bounded step whatever happened before it stopped, and
     *    downgrading that to "cannot rule" over one dip would lose a pass the
     *    gate already had.
     */
    const shaped = () => {
        if (rec?.shape === 'reclaimed') return reclaimed();
        if (sat) return saturated();
        if (rec?.shape === 'one-cycle') return oneCycle();
        return null;
    };

    if (flat) {
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

    // A budget carries the window it was fitted over (`basisSpanDays`, written
    // by `seedBudgets`), and an arm whose own window is a small fraction of it
    // is not measuring the same thing. This is the seeding rule applied to the
    // verdict, and it has to be both: without it, the first real ladder's three
    // short arms — wars that ENDED inside their opening ramp — reported
    // `rules_params` at up to 45 864/sim-day against a 25/sim-day steady-state
    // budget and turned the gate red on every run, which is how a gate gets
    // switched off. `too-short` is not a pass; it says the arm cannot rule.
    // Some surfaces have a period, and a window shorter than one period cannot
    // rule them however good the fit looks. `db_bytes` is the measured case:
    // SQLite's wal_autocheckpoint folds the -wal sidecar back into the main file
    // roughly every 31 wall-minutes, so a 25-minute arm fits the ramp at
    // r2 = 1.00 and reports 195 MB/wall-day for a database whose real rate is
    // 38. An absolute floor is the only thing that catches that: the basis
    // fraction below is relative, and half of a period is still no periods.
    // (PLAN-persistence's wind cycle is the same lesson from the other end — a
    // passing round-trip says nothing about state whose period exceeds the
    // window.)
    if (Number.isFinite(budget?.minSpanDays) && fit.span < budget.minSpanDays)
        return mk('too-short', `window ${fmt(fit.span)} ${clock}-day is under this metric's declared minimum of ${fmt(budget.minSpanDays)} ${clock}-day — shorter than one cycle of whatever drives it`);

    const basis = budget?.basisSpanDays;
    if (Number.isFinite(basis) && basis > 0 && fit.span < SEED_SPAN_FLOOR_FRACTION * basis)
        return mk('too-short', `window ${fmt(fit.span)} ${clock}-day is under ${(SEED_SPAN_FLOOR_FRACTION * 100).toFixed(0)}% of the budget's ${fmt(basis)}-${clock}-day basis — the rule that refuses this arm as a seed refuses it as a verdict`);

    if (!budget || !budget.why) {
        const shape = shaped();
        if (shape) return shape;
        return mk('unexplained',
            (budget ? 'budget entry has no `why`; §2 requires the slope be EXPLAINED, not merely allowed' : 'no budget entry accounts for this slope')
            + (rec?.shape === 'peaks-rising' ? risingNote() : ''));
    }

    const tol = budget.tolerance ?? Math.abs(budget.slopePerDay) * 0.25;
    if (fit.slope > budget.slopePerDay + tol) {
        // Checked AFTER the budget, so a licensed surface keeps reporting
        // `explained` and its number keeps being compared: a step that fits
        // under its own budget is not news. Only a breach gets the second look.
        const shape = shaped();
        if (shape) return shape;
        return mk('over-budget', `${fmt(fit.slope)}/day vs budget ${fmt(budget.slopePerDay)} ±${fmt(tol)} — ${budget.why}`
            + (rec?.shape === 'peaks-rising' ? risingNote() : ''));
    }
    return mk('explained', `${fmt(fit.slope)}/day within budget ${fmt(budget.slopePerDay)} ±${fmt(tol)} — ${budget.why}`);
}

/** Verdicts that fail the soak gate. */
export const FAILING = new Set(['unexplained', 'over-budget']);
/** Verdicts that mean the run could not rule — reported, but not a pass. */
export const INCONCLUSIVE = new Set(['no-samples', 'no-signal', 'too-short', 'one-cycle']);

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
    return METRICS.map((m) => classify(m, fitLinear(series[m.key]), budgets[m.key], ruling, series[m.key]));
}

/**
 * How short an arm's window may be, as a fraction of the longest arm's window
 * for the same metric, before its slope is refused as a budget seed. See
 * `seedBudgets`.
 */
export const SEED_SPAN_FLOOR_FRACTION = 0.25;

/**
 * Seed a budget skeleton from a ruled report: one entry per FAILING metric,
 * `why: null` so the file cannot pass the gate until a human writes the reason.
 *
 * `arms` is `[{ label, results }]` as growth-report.mjs assembles it.
 *
 * Two rules, and the second one was a live defect first.
 *
 *   1. **Only metrics that actually failed get an entry.** Seeding a budget for
 *      a metric already ruled `flat` writes that arm's noise into the file as a
 *      permanently permitted slope, and the gate would then pass a later run
 *      that genuinely slopes by that much. A budget is a licence; licences are
 *      only issued where one was needed.
 *
 *   2. **Largest-slope-wins, but only among arms whose window is comparable.**
 *      The churn arm stresses these surfaces hardest, so a skeleton seeded off
 *      the baseline arm alone is too tight for the ladder it has to gate —
 *      hence largest wins. But the first real ladder (task 4) produced four
 *      arms spanning 0.0033 to 0.265 simulated days, because three of them
 *      ENDED (Meridian Basin's victory objective is terminal) and their last
 *      samples sit in the war's opening ramp. Those arms reported
 *      `rules_params` at 45 864/sim-day against the long arm's 25/sim-day —
 *      the same surface, a ×1800 disagreement, entirely an artefact of a ×300
 *      extrapolation off a 5-minute window. Largest-wins across that set
 *      issues a licence three orders of magnitude looser than the steady state,
 *      which is the one direction a gate must never fail. So an arm whose
 *      window is under `SEED_SPAN_FLOOR_FRACTION` of the longest arm's window
 *      for that metric is not eligible to raise the number, and every arm
 *      dropped is returned in `dropped` — a seeding rule that silently ignored
 *      arms would be indistinguishable from one that never saw them.
 */
export function seedBudgets(arms, { spanFloorFraction = SEED_SPAN_FLOOR_FRACTION } = {}) {
    const failing = [];
    for (const arm of arms)
        for (const r of arm.results ?? [])
            if (FAILING.has(r.verdict) && Number.isFinite(r.fit?.slope) && r.fit.slope > 0)
                failing.push({ label: arm.label, r });

    const longestSpan = {};
    for (const { r } of failing)
        longestSpan[r.key] = Math.max(longestSpan[r.key] ?? 0, r.fit.span ?? 0);

    const seed = {};
    const dropped = [];
    for (const { label, r } of failing) {
        const floor = (longestSpan[r.key] ?? 0) * spanFloorFraction;
        if ((r.fit.span ?? 0) < floor) {
            dropped.push({ key: r.key, label, span: r.fit.span ?? 0, longestSpan: longestSpan[r.key], slope: r.fit.slope });
            continue;
        }
        if (seed[r.key] && seed[r.key].slopePerDay >= r.fit.slope) continue;
        seed[r.key] = {
            slopePerDay: Number(r.fit.slope.toPrecision(4)),
            tolerance: Number((Math.abs(r.fit.slope) * 0.5).toPrecision(4)),
            // The window this number was fitted over, carried so a later run
            // can tell whether its own arm measured the same thing — see
            // `classify`'s basis check. A budget without it still gates; it
            // just cannot refuse an incomparable arm.
            basisSpanDays: Number((r.fit.span ?? 0).toPrecision(3)),
            why: null,
        };
    }
    return { seed, dropped };
}
