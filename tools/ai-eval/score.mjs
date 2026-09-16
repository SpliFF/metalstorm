/**
 * score.mjs — turn a driver run into metrics, grade it against the fixture's
 * expectations, and say whether a matrix of runs regressed against a baseline.
 *
 * PURE: no fs, no spawn, no clock, no network. That split is deliberate and is
 * the same one tools/nl-eval draws — the scoring is the part of an eval harness
 * most likely to be quietly wrong in a way that flatters the thing measured, so
 * it is the part covered by the ordinary hermetic suite (`score.test.mjs`,
 * `node --test`). `run-eval.mjs` is the part that spawns processes.
 *
 * WHAT IS SCORED, and why those things:
 *   directives / spent  — what the SIM would have created and charged, not what
 *                         the AI asked for: the driver's numbers come out of
 *                         the fake engine's drain (E6 clamp, AllowDirectiveCreate).
 *   reaction latency    — frames from an event to the first directive anchored
 *                         in, or next to, the region the event happened in. The
 *                         one number that catches an LOD backoff that is wrong
 *                         while every unit test is green.
 *   violations          — any call to the per-unit verb. The strategic floor is
 *                         a design law; a law nobody measures is a preference.
 *   errors              — a tick that raised. The runtime pcalls onUpdate, so a
 *                         crashing AI looks alive and does nothing.
 */

// ── metrics ──────────────────────────────────────────────────────────────

/**
 * Does a directive count as a response to `event`?
 *
 * By default, spatially: anchored in the region the event happened in, or next
 * to it. That is the right rule for contact, and the wrong rule for a
 * withdrawal — which answers an overrun precisely by pointing AWAY from the
 * ground being lost, two regions off. So a fixture may name the types that
 * answer an event wherever they are anchored (`event.answeredBy`), and the
 * first run of this harness found that gap by scoring a garrison that
 * withdrew on the same frame as "450 frames late".
 */
function answers(directive, event, neighbours) {
    if ((event.answeredBy || []).includes(directive.typeName)) return true;
    const region = event.region;
    if (!region) return true;            // an event with no place: any answer counts
    if (!directive.region) return false;
    if (directive.region === region) return true;
    return (neighbours[region] || []).includes(directive.region);
}

/**
 * Reaction latency per event: frames from the event to the first directive
 * that answers it. `null` when the AI never answered — which is a legitimate
 * result, not a missing measurement, and is reported as such.
 */
export function reactions(run, neighbours = {}) {
    return (run.events || []).map((event) => {
        const hit = (run.directives || [])
            .filter((d) => d.frame >= event.frame && answers(d, event, neighbours))
            .sort((a, b) => a.frame - b.frame)[0];
        return {
            id: event.id,
            kind: event.kind,
            region: event.region ?? null,
            frame: event.frame,
            latency: hit ? hit.frame - event.frame : null,
            answeredWith: hit ? hit.typeName : null,
        };
    });
}

/** Adjacency, keyed by region, from the same regions.json the AI reads. */
export function neighboursOf(regionsJson) {
    const out = {};
    for (const r of regionsJson?.regions || []) out[r.key] = r.neighbors || [];
    return out;
}

export function metricsOf(run, neighbours = {}) {
    const byType = {};
    for (const d of run.directives || []) byType[d.typeName] = (byType[d.typeName] || 0) + 1;
    const react = reactions(run, neighbours);
    const answered = react.filter((r) => r.latency !== null);
    return {
        directives: (run.directives || []).length,
        spent: run.spent || 0,
        poolLeft: run.poolLeft ?? null,
        violations: (run.violations || []).length,
        errors: (run.errors || []).length,
        refusals: Object.values(run.refused || {}).reduce((a, b) => a + b, 0),
        messages: run.messages || {},
        onUpdateCalls: run.onUpdateCalls || 0,
        byType,
        reactions: react,
        // The headline: the SLOWEST answer, because an AI is judged by the
        // event it was late for, not by its average.
        worstLatency: answered.length ? Math.max(...answered.map((r) => r.latency)) : null,
        unanswered: react.length - answered.length,
    };
}

// ── checks ───────────────────────────────────────────────────────────────

const CHECKS = {
    booted: (m, c, run) => [run.booted === true,
        run.bootError || 'the entry buffer never ran a tick'],
    noViolations: (m) => [m.violations === 0,
        `${m.violations} call(s) to the per-unit verb — directives are the only actuation path`],
    noErrors: (m) => [m.errors === 0, `${m.errors} tick(s) raised`],
    maxSpend: (m, c) => [m.spent <= c.value, `spent ${m.spent}, ceiling ${c.value}`],
    minSpend: (m, c) => [m.spent >= c.value, `spent ${m.spent}, floor ${c.value}`],
    minDirectives: (m, c) => [m.directives >= c.value, `${m.directives} directives, floor ${c.value}`],
    maxDirectives: (m, c) => [m.directives <= c.value, `${m.directives} directives, ceiling ${c.value}`],
    hasDirectiveType: (m, c, run) => {
        const hit = (run.directives || []).filter((d) => d.typeName === c.type
            && (!c.region || d.region === c.region));
        return [hit.length > 0, `no ${c.type}${c.region ? ` in ${c.region}` : ''}`];
    },
    hasDirectiveTypeAfter: (m, c, run) => {
        const hit = (run.directives || []).filter((d) => d.typeName === c.type
            && d.frame >= c.frame && (!c.region || d.region === c.region));
        return [hit.length > 0,
            `no ${c.type}${c.region ? ` in ${c.region}` : ''} after frame ${c.frame}`];
    },
    noDirectiveType: (m, c, run) => {
        const hit = (run.directives || []).filter((d) => d.typeName === c.type);
        return [hit.length === 0, `${hit.length} × ${c.type}, expected none`];
    },
    reactionWithin: (m, c) => {
        if (!m.reactions.length) return [false, 'the fixture declares no event to react to'];
        const late = m.reactions.filter((r) => r.latency === null || r.latency > c.frames);
        return [late.length === 0, late.map((r) => `${r.id}: `
            + (r.latency === null ? 'never answered' : `${r.latency} frames > ${c.frames}`)).join('; ')];
    },
    noReaction: (m) => [m.unanswered === m.reactions.length,
        'the control answered an event — the metric is measuring the harness, not the AI'],
    withdrawsThrough: (m, c, run) => {
        const hit = (run.directives || []).filter((d) => d.typeName === 'Withdraw'
            && Math.abs(d.x - c.x) <= (c.slack ?? 1) && Math.abs(d.z - c.z) <= (c.slack ?? 1));
        return [hit.length > 0, `no Withdraw anchored on (${c.x}, ${c.z})`];
    },
    sendsMessage: (m, c) => [(m.messages[c.cmd] || 0) > 0, `no ${c.cmd} message`],
};

/** The check vocabulary, so a fixture typo is an error and not a silent pass. */
export const CHECK_NAMES = Object.keys(CHECKS).sort();

/**
 * Grade one run. `expectations` is the fixture's universal list concatenated
 * with its per-AI list. An unknown check name FAILS — a fixture that asserts
 * nothing because of a typo is worse than a fixture with no assertions.
 */
export function grade(run, expectations, neighbours = {}) {
    const m = metricsOf(run, neighbours);
    const checks = (expectations || []).map((c) => {
        const fn = CHECKS[c.check];
        if (!fn) {
            return { check: c.check, ok: false, detail: `unknown check '${c.check}' `
                + `(known: ${CHECK_NAMES.join(', ')})`, why: c.why };
        }
        const [ok, detail] = fn(m, c, run);
        return { check: c.check, ok, detail: ok ? null : detail, why: c.why };
    });
    return {
        ai: run.ai,
        fixture: run.fixture,
        metrics: m,
        checks,
        passed: checks.filter((c) => c.ok).length,
        failed: checks.filter((c) => !c.ok).length,
    };
}

/** Expectations for one AI: the fixture's universal list + its per-AI list. */
export function expectationsFor(fixture, ai) {
    return [...(fixture.expect || []), ...((fixture.expectByAi || {})[ai] || [])];
}

// ── the matrix ───────────────────────────────────────────────────────────

const cellKey = (ai, fixture) => `${ai}/${fixture}`;

/** Collapse graded rows into the comparable, diffable shape a baseline holds. */
export function summarise(rows) {
    const cells = {};
    for (const r of rows) {
        cells[cellKey(r.ai, r.fixture)] = {
            ai: r.ai,
            fixture: r.fixture,
            directives: r.metrics.directives,
            spent: r.metrics.spent,
            violations: r.metrics.violations,
            errors: r.metrics.errors,
            worstLatency: r.metrics.worstLatency,
            unanswered: r.metrics.unanswered,
            byType: r.metrics.byType,
            // Keyed by POSITION as well as name: a fixture may assert the same
            // kind of thing twice (two directive types), and two checks that
            // collapse into one key are one check silently not gated.
            checks: Object.fromEntries(r.checks.map((c, i) => [`${i}:${c.check}`, c.ok])),
            checksPassed: r.passed,
            checksFailed: r.failed,
        };
    }
    return {
        cells,
        totals: {
            cells: rows.length,
            checksPassed: rows.reduce((a, r) => a + r.passed, 0),
            checksFailed: rows.reduce((a, r) => a + r.failed, 0),
            violations: rows.reduce((a, r) => a + r.metrics.violations, 0),
            errors: rows.reduce((a, r) => a + r.metrics.errors, 0),
            spent: rows.reduce((a, r) => a + r.metrics.spent, 0),
        },
    };
}

/**
 * Compare a summary to a stored baseline.
 *
 * A regression is a thing that got WORSE, never merely a thing that changed —
 * an AI that issues a different but equally good plan must not turn the gate
 * red, or the gate gets disabled and then nothing is measured at all:
 *   * a cell present in the baseline and absent now (a fixture or AI silently
 *     dropped out of the matrix — the classic way an eval goes quiet);
 *   * a check that passed and now fails;
 *   * a new violation or a new error, ever, tolerance or not;
 *   * authority spend above baseline × (1 + tolerance);
 *   * a worst-case reaction slower than baseline by more than one tick
 *     interval (10 frames), or an event that was answered and now is not.
 */
export function compareToBaseline(summary, baseline, tolerance = 0.1) {
    const regressions = [];
    const SLACK_FRAMES = 10;      // AIRuntimePool::tickInterval — below this is noise

    for (const [key, was] of Object.entries(baseline.cells || {})) {
        const now = summary.cells[key];
        if (!now) {
            regressions.push({ cell: key, kind: 'missing',
                detail: 'in the baseline, absent from this run' });
            continue;
        }
        for (const [check, ok] of Object.entries(was.checks || {})) {
            if (ok && now.checks[check] === false) {
                regressions.push({ cell: key, kind: 'check', detail: `${check} passed, now fails` });
            }
        }
        if (now.violations > was.violations) {
            regressions.push({ cell: key, kind: 'violation',
                detail: `${was.violations} → ${now.violations} per-unit calls` });
        }
        if (now.errors > was.errors) {
            regressions.push({ cell: key, kind: 'error',
                detail: `${was.errors} → ${now.errors} raised ticks` });
        }
        if (now.spent > Math.max(was.spent * (1 + tolerance), was.spent + 1)) {
            regressions.push({ cell: key, kind: 'spend',
                detail: `${was.spent} → ${now.spent} authority (tolerance ${tolerance})` });
        }
        if (was.worstLatency !== null && was.worstLatency !== undefined) {
            if (now.worstLatency === null || now.worstLatency === undefined) {
                regressions.push({ cell: key, kind: 'latency',
                    detail: `answered in ${was.worstLatency} frames, now never answers` });
            } else if (now.worstLatency > was.worstLatency + SLACK_FRAMES) {
                regressions.push({ cell: key, kind: 'latency',
                    detail: `${was.worstLatency} → ${now.worstLatency} frames` });
            }
        }
        if (now.unanswered > (was.unanswered || 0)) {
            regressions.push({ cell: key, kind: 'unanswered',
                detail: `${was.unanswered || 0} → ${now.unanswered} events left unanswered` });
        }
    }

    const added = Object.keys(summary.cells).filter((k) => !(baseline.cells || {})[k]);
    return { ok: regressions.length === 0, regressions, added };
}
