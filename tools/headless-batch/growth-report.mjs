#!/usr/bin/env node
// Growth report — PLAN-long-uptime task 4's offline half.
//
// Reads the stats dumps a soak ladder produced (either a batch driver's
// results JSONL or a list of dump files), fits `base + slope×days` to every
// §1 growth surface, and rules each slope against a declared budget file.
// Exits non-zero when any metric slopes without an explanation, which is the
// gate PLAN-long-uptime §2 asks for.
//
// The report answers a question the live dashboard cannot. §3's alarms fire
// on an ABSOLUTE reading — "this game is at 60% of the id space" — and a
// weeks-long campaign's characteristic failure is not being near a wall today,
// it is approaching one at a rate nobody measured. A slope is the only form in
// which that is visible before it matters.
//
// Usage:
//   node growth-report.mjs --jsonl <results.jsonl> [--budgets <budgets.json>]
//   node growth-report.mjs --dump <run-0.json> [--dump <run-1.json> ...]
//   ... [--json <out.json>] [--sigmas N] [--min-rel-slope F] [--no-gate]
//
// --budgets takes the file this tool also WRITES with --emit-budgets: run a
// ladder once, read the report, decide which slopes are legitimate, write the
// why, and every later run is gated against it. The `why` field is mandatory —
// a budget without a reason turns "explained by design" back into "allowed".
import { parseArgs } from 'node:util';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
    METRICS, DEFAULT_RULING, FAILING, INCONCLUSIVE, SEED_SPAN_FLOOR_FRACTION,
    seriesFromDump, fitLinear, classify, fmt, seedBudgets,
} from './lib/growth-fit.mjs';
import { checkFixtureNonVacuous } from './lib/fixture-checks.mjs';

async function loadDumps(values) {
    const dumps = [];
    for (const p of values.dump ?? []) {
        const abs = path.resolve(p);
        dumps.push({ label: path.basename(abs), params: null, dump: JSON.parse(await readFile(abs, 'utf8')) });
    }
    if (values.jsonl) {
        const text = await readFile(path.resolve(values.jsonl), 'utf8');
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            const row = JSON.parse(line);
            // A failed run is reported as a run that failed, never dropped —
            // a ladder that crashed at simulated hour 3 is the single most
            // interesting thing a soak can produce and must not vanish into a
            // report that only lists the arms that finished.
            dumps.push({
                label: row.params ? JSON.stringify(row.params) : `run-${row.index}`,
                params: row.params ?? null,
                ok: row.ok,
                exitCode: row.exitCode,
                dump: row.dump,
            });
        }
    }
    return dumps;
}

function renderArm(arm) {
    const lines = [];
    const d = arm.dump;
    if (!d) {
        lines.push(`  NO DUMP (exit ${arm.exitCode}) — the run produced no stats file; nothing can be ruled.`);
        return { lines, results: [], hardFail: true };
    }

    const simDays = (d.gameSeconds ?? 0) / 86400;
    lines.push(`  status=${d.status} frame=${d.frame} simDays=${simDays.toFixed(3)} wall=${d.wallSeconds}s snapshots=${d.snapshots?.length ?? 0}`);
    if (d.wallSeconds > 0 && simDays > 0)
        lines.push(`  cost: ${(d.wallSeconds / simDays / 60).toFixed(1)} wall-minutes per simulated day`);

    // A soak arm that simulated nothing produces the flattest, cleanest report
    // in this file, and the determinism gate already shipped once on exactly
    // that (30 snapshots of an empty world, PLAN-headless / fixture-checks.mjs).
    // Slopes off a world with no units, no damage and no deaths are not
    // evidence of a bound, so the premise is checked before the fits are
    // believed and a vacuous arm fails the gate rather than passing it.
    const vac = checkFixtureNonVacuous(d);
    lines.push(`  content: peak units=${vac.measured.units} damage=${fmt(vac.measured.damage)} deaths=${vac.measured.deaths}` +
        (vac.ok ? '' : `\n  VACUOUS — ${vac.problems.join('; ')}`));

    const series = seriesFromDump(d);
    const results = METRICS.map((m) => classify(m, fitLinear(series[m.key]), arm.budgets?.[m.key], arm.ruling));

    const w = Math.max(...METRICS.map((m) => m.key.length));
    for (const r of results) {
        const mark = FAILING.has(r.verdict) ? 'FAIL' : INCONCLUSIVE.has(r.verdict) ? '????' : ' ok ';
        const base = fmt(r.fit.base);
        const slope = fmt(r.fit.slope);
        lines.push(
            `  ${mark} ${r.key.padEnd(w)} [${r.row}] base=${base}${r.unit} slope=${slope}${r.unit}/${r.clock}-day ` +
            `r2=${fmt(r.fit.r2)} n=${r.fit.n}  ${r.verdict}: ${r.note}`);
    }
    return { lines, results, hardFail: !vac.ok, vacuity: vac };
}

async function main() {
    const { values } = parseArgs({
        options: {
            jsonl: { type: 'string' },
            dump: { type: 'string', multiple: true },
            budgets: { type: 'string' },
            json: { type: 'string' },
            'emit-budgets': { type: 'string' },
            sigmas: { type: 'string' },
            'min-rel-slope': { type: 'string' },
            'no-gate': { type: 'boolean', default: false },
        },
    });

    if (!values.jsonl && !(values.dump ?? []).length) {
        console.error('growth-report: need --jsonl <results.jsonl> or one or more --dump <file>');
        process.exit(2);
    }

    const ruling = {
        sigmas: values.sigmas ? Number(values.sigmas) : DEFAULT_RULING.sigmas,
        minRelSlopePerDay: values['min-rel-slope'] ? Number(values['min-rel-slope']) : DEFAULT_RULING.minRelSlopePerDay,
    };
    const budgets = values.budgets ? JSON.parse(await readFile(path.resolve(values.budgets), 'utf8')) : {};

    const arms = await loadDumps(values);
    console.log(`growth-report: ${arms.length} arm(s), ruling sigmas=${ruling.sigmas} floor=${(ruling.minRelSlopePerDay * 100).toFixed(1)}%/day`);

    let failures = 0, inconclusive = 0;
    const jsonOut = [];
    for (const arm of arms) {
        console.log(`\n[${arm.label}]`);
        arm.budgets = budgets;
        arm.ruling = ruling;
        const { lines, results, hardFail, vacuity } = renderArm(arm);
        for (const l of lines) console.log(l);
        if (hardFail) failures++;
        for (const r of results) {
            if (FAILING.has(r.verdict)) failures++;
            if (INCONCLUSIVE.has(r.verdict)) inconclusive++;
        }
        jsonOut.push({ label: arm.label, params: arm.params, vacuity: vacuity ?? null, results });
    }

    if (values['emit-budgets']) {
        // Seed a budget file from the observed slopes, with `why: null` on every
        // entry so the file cannot pass the gate until a human has written down
        // why each slope is legitimate. This is the "record budgets after the
        // first green run" step of §2 made into a step you cannot accidentally
        // skip. The rules (failing metrics only; largest slope wins, but only
        // among arms whose window is comparable) live in `seedBudgets` so they
        // are unit-testable — see lib/growth-fit.mjs for why each exists.
        const { seed, dropped } = seedBudgets(jsonOut);
        // No silent caps: an arm refused as a seed is reported, because a
        // seeding rule that quietly ignored arms reads exactly like one that
        // never saw them.
        for (const d of dropped)
            console.log(`growth-report: seed ignores ${d.key}=${fmt(d.slope)}/day from [${d.label}] — its ${fmt(d.span)}-day window is under ${(SEED_SPAN_FLOOR_FRACTION * 100).toFixed(0)}% of the longest arm's ${fmt(d.longestSpan)}-day window for that metric`);
        await writeFile(path.resolve(values['emit-budgets']), JSON.stringify(seed, null, 2) + '\n');
        console.log(`\ngrowth-report: budget skeleton -> ${values['emit-budgets']} (every \`why\` is null; fill them in or the gate stays red)`);
    }

    if (values.json)
        await writeFile(path.resolve(values.json), JSON.stringify(jsonOut, null, 2) + '\n');

    console.log(`\ngrowth-report: ${failures} failing, ${inconclusive} inconclusive across ${arms.length} arm(s)`);
    if (failures > 0 && !values['no-gate']) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
