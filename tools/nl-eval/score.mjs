/**
 * score.mjs — field-level agreement between an `expected` NLResponse and what
 * the model actually returned. PLAN-metalstorm-command-language.md §8, M7.
 *
 * Pure: no fs, no network, no clock. That is deliberate — the scoring is the
 * part of the eval harness most likely to be wrong in a way that silently
 * flatters the prompt, so it is unit-tested (`score.test.mjs`) by the ordinary
 * hermetic suite while the harness that *calls* it stays out of CI.
 *
 * `say` is ignored, per §8: it is prose and prose does not diff usefully. So
 * are the other two prose fields — `clarify.question` and a refusal's
 * `reason`. What is scored is the machine-readable shape: which actions, in
 * which order, with which slots filled.
 */

/**
 * Fields the model may emit that mean exactly what omitting them means. The
 * schema says so in as many words ("Omit it (or use `now`)"), so counting an
 * explicit `priority: "normal"` as a miss would score a correct envelope wrong.
 * Everything NOT on this list is a real disagreement when it appears
 * unexpectedly — a stray `count`, an invented `when`, an extra key.
 */
function isAbsentEquivalent(key, value) {
    if (key === 'priority') return value === 'normal';
    if (key === 'when') return isPlainObject(value)
        && Object.keys(value).length === 1 && value.type === 'now';
    return false;
}

/** The payload key each action kind carries, and whether it is prose. */
const PAYLOAD_KEY = {
    command: 'intent',
    guidance: 'guidance',
    camera: 'camera',
    ui: 'ui',
    query: 'query',
    group: 'group',
    // `refuse` carries only `reason`, which is prose. A refusal therefore
    // scores on its kind alone: the model refused where it should have, or it
    // did not. WHY it refused is a copy question, not a correctness one.
    refuse: null,
};

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Order-insensitive string-set equality, used for `clarify.options`. */
function sameSet(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const left = [...a].map(String).sort();
    const right = [...b].map(String).sort();
    return left.every((v, i) => v === right[i]);
}

/**
 * Walk `expected` and `actual` in step, appending one entry to `out` per
 * compared leaf. A leaf is a scalar; objects recurse; arrays of scalars are
 * compared whole (the only arrays in the schema are `options` and
 * `regionRefs`, both order-significant except where noted by the caller).
 */
function compare(path, expected, actual, out) {
    if (isPlainObject(expected)) {
        if (!isPlainObject(actual)) {
            out.push({ path, expected, actual, ok: false, kind: 'shape' });
            return;
        }
        for (const key of Object.keys(expected)) {
            compare(`${path}.${key}`, expected[key], actual[key], out);
        }
        // Keys the model added that the fixture did not ask for. Skipped when
        // the value is the documented no-op (see isAbsentEquivalent).
        for (const key of Object.keys(actual)) {
            if (key in expected) continue;
            if (isAbsentEquivalent(key, actual[key])) continue;
            out.push({
                path: `${path}.${key}`, expected: undefined, actual: actual[key],
                ok: false, kind: 'unexpected',
            });
        }
        return;
    }

    if (Array.isArray(expected)) {
        const ok = Array.isArray(actual)
            && expected.length === actual.length
            && expected.every((v, i) => JSON.stringify(v) === JSON.stringify(actual[i]));
        out.push({ path, expected, actual, ok, kind: 'value' });
        return;
    }

    out.push({ path, expected, actual, ok: expected === actual, kind: 'value' });
}

function compareAction(index, expected, actual, out) {
    const path = `actions[${index}]`;
    if (!isPlainObject(actual)) {
        out.push({ path, expected: expected.kind, actual: undefined, ok: false, kind: 'missing' });
        return;
    }

    const kindOk = expected.kind === actual.kind;
    out.push({ path: `${path}.kind`, expected: expected.kind, actual: actual.kind, ok: kindOk, kind: 'value' });
    // A wrong kind makes the payload incomparable — `intent` versus `query`
    // share no fields — so stop here rather than emit a wall of noise that
    // makes one error look like eight.
    if (!kindOk) return;

    const key = PAYLOAD_KEY[expected.kind];
    if (!key) return;                       // refuse: kind is the whole score
    if (expected[key] === undefined) return;
    compare(`${path}.${key}`, expected[key], actual[key], out);
}

/**
 * Score one fixture. Returns the leaf-level detail plus the two headline
 * numbers: `agreement` (0..1, how much of the envelope was right) and `pass`
 * (everything was right). The gate uses `pass`; `agreement` is what tells you
 * whether a prompt change broke one field or fell off a cliff.
 */
export function scoreEnvelope(expected, actual) {
    const fields = [];

    if (!isPlainObject(actual)) {
        return {
            pass: false, agreement: 0, fields: [],
            mismatches: [{ path: '', expected: 'an envelope', actual, ok: false, kind: 'shape' }],
        };
    }

    // ── clarify ──
    const wantClarify = isPlainObject(expected.clarify);
    const gotClarify = isPlainObject(actual.clarify);
    fields.push({
        path: 'clarify', expected: wantClarify, actual: gotClarify,
        ok: wantClarify === gotClarify, kind: 'value',
    });
    if (wantClarify && gotClarify) {
        // `question` is prose. `options` is a menu, and a menu in a different
        // order is the same menu — the client renders them as chips, and the
        // resolver matches by name.
        if (expected.clarify.options !== undefined) {
            fields.push({
                path: 'clarify.options',
                expected: expected.clarify.options, actual: actual.clarify.options,
                ok: sameSet(expected.clarify.options, actual.clarify.options), kind: 'value',
            });
        }
        if (expected.clarify.pick !== undefined || actual.clarify.pick !== undefined) {
            fields.push({
                path: 'clarify.pick',
                expected: expected.clarify.pick, actual: actual.clarify.pick,
                ok: expected.clarify.pick === actual.clarify.pick, kind: 'value',
            });
        }
    }

    // ── actions ──
    const wantActions = Array.isArray(expected.actions) ? expected.actions : [];
    const gotActions = Array.isArray(actual.actions) ? actual.actions : [];
    fields.push({
        path: 'actions.length', expected: wantActions.length, actual: gotActions.length,
        ok: wantActions.length === gotActions.length, kind: 'value',
    });
    for (let i = 0; i < wantActions.length; i += 1) {
        compareAction(i, wantActions[i], gotActions[i], fields);
    }
    for (let i = wantActions.length; i < gotActions.length; i += 1) {
        fields.push({
            path: `actions[${i}]`, expected: undefined, actual: gotActions[i]?.kind,
            ok: false, kind: 'unexpected',
        });
    }

    const mismatches = fields.filter((f) => !f.ok);
    return {
        pass: mismatches.length === 0,
        agreement: fields.length === 0 ? 1 : (fields.length - mismatches.length) / fields.length,
        fields,
        mismatches,
    };
}

/**
 * Roll per-fixture scores up into the per-category pass rate the milestone
 * asks for. `category` is the fixture file it came from — `commands.json`,
 * `clarify-refuse.json` and so on — because that is how the fixtures are
 * already grouped by behaviour, and a per-category rate is what tells you
 * WHICH capability a prompt change broke.
 */
export function summarise(rows) {
    const byCategory = new Map();
    for (const row of rows) {
        const key = row.category ?? 'uncategorised';
        if (!byCategory.has(key)) {
            byCategory.set(key, { category: key, total: 0, passed: 0, errored: 0, agreementSum: 0 });
        }
        const bucket = byCategory.get(key);
        bucket.total += 1;
        if (row.error) bucket.errored += 1;
        if (row.pass) bucket.passed += 1;
        bucket.agreementSum += row.agreement ?? 0;
    }

    const categories = [...byCategory.values()]
        .map((b) => ({
            category: b.category,
            total: b.total,
            passed: b.passed,
            errored: b.errored,
            passRate: b.total === 0 ? 0 : b.passed / b.total,
            agreement: b.total === 0 ? 0 : b.agreementSum / b.total,
        }))
        .sort((a, b) => a.category.localeCompare(b.category));

    const total = rows.length;
    const passed = rows.filter((r) => r.pass).length;
    return {
        total,
        passed,
        errored: rows.filter((r) => r.error).length,
        passRate: total === 0 ? 0 : passed / total,
        agreement: total === 0 ? 0 : rows.reduce((s, r) => s + (r.agreement ?? 0), 0) / total,
        categories,
    };
}

/**
 * The regression gate (§8: "prompt/vocab changes must not regress").
 *
 * Compares a fresh summary against a stored baseline and returns the
 * regressions. Deliberately compares PASS COUNTS per category, not the overall
 * rate: an overall rate can hold steady while a prompt change trades six
 * working camera verbs for six newly-working queries, and that is exactly the
 * silent drift the gate exists to catch. `tolerance` is a per-category slack in
 * fixtures (default 0 — any lost fixture is a regression), because the model is
 * not deterministic and a one-fixture flap on a 112-fixture run is noise, not
 * news, once you have measured how much it actually flaps.
 */
export function compareToBaseline(summary, baseline, tolerance = 0) {
    const regressions = [];
    const before = new Map((baseline.categories ?? []).map((c) => [c.category, c]));

    for (const now of summary.categories) {
        const then = before.get(now.category);
        if (!then) continue;                 // new category: nothing to regress from
        if (now.passed < then.passed - tolerance) {
            regressions.push({
                category: now.category,
                was: then.passed,
                now: now.passed,
                of: now.total,
            });
        }
    }

    for (const [category, then] of before) {
        if (!summary.categories.some((c) => c.category === category)) {
            regressions.push({ category, was: then.passed, now: null, of: then.total, missing: true });
        }
    }

    return {
        ok: regressions.length === 0,
        regressions,
        overall: { was: baseline.passed ?? 0, now: summary.passed },
    };
}
