#!/usr/bin/env node
/**
 * run-eval.mjs — run every AI plugin against every fixture, score what the
 * engine would have done, and fail if it got worse.
 *
 * docs/reviews/2026-09-10/ai-framework.md task 4. The harness is hermetic: no
 * server, no build, no network, no GPU — one `lua` process per (AI, fixture)
 * cell against ai/lib/testing/fake_engine.lua. That is why it can be a gate
 * (`make test-ai-eval`) and not a nightly.
 *
 *   node tools/ai-eval/run-eval.mjs                     # run + gate vs baseline.json
 *   node tools/ai-eval/run-eval.mjs --only garrison     # one AI
 *   node tools/ai-eval/run-eval.mjs --fixture contact-reaction
 *   node tools/ai-eval/run-eval.mjs --save-baseline     # after a deliberate change
 *   node tools/ai-eval/run-eval.mjs --no-gate           # report only
 *   node tools/ai-eval/run-eval.mjs --json build/ai-eval/run.json
 *
 * EXIT CODES:  0 ok · 1 a fixture expectation failed · 2 a regression against
 * the baseline · 3 the harness itself could not run (no lua, driver crashed).
 *
 * THE CONTROL: content/engine/ai/null is in the matrix on purpose and must
 * score zero on everything. If the no-op AI ever "reacts", the fixture is the
 * signal and the measurement is worthless — that is a harness bug and it is
 * cheaper to have it fail loudly here than to trust a number for a month.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareToBaseline, expectationsFor, grade, neighboursOf, summarise } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const FIXTURE_DIR = join(HERE, 'fixtures');
const BASELINE = join(HERE, 'baseline.json');
const REPORT_DIR = join(ROOT, 'build/ai-eval');

/** The matrix's AI side. A plugin folder is anything with a manifest. */
const AI_DIRS = [
    'data/games/metalstorm/ai/garrison',
    'data/games/metalstorm/ai/strategos',
    'content/engine/ai/null',            // the control — must score zero
];

function flag(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    return fallback;
}

const ONLY = flag('only', '');
const ONLY_FIXTURE = flag('fixture', '');
const LUA = flag('lua', process.env.LUA || 'lua');
const TOLERANCE = Number(flag('tolerance', '0.1'));
const SAVE_BASELINE = process.argv.includes('--save-baseline');
const GATE = !process.argv.includes('--no-gate');
const JSON_OUT = flag('json', '');
const VERBOSE = process.argv.includes('--verbose');

// ── preflight ────────────────────────────────────────────────────────────

const luaProbe = spawnSync(LUA, ['-v'], { encoding: 'utf8' });
if (luaProbe.error) {
    console.error(`ai-eval: no \`${LUA}\` on PATH. The driver is plain Lua — `
        + 'install lua (brew install lua / apt install lua5.4) or pass --lua <path>.');
    process.exit(3);
}

const fixtureFiles = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
if (!fixtureFiles.length) {
    console.error(`ai-eval: no fixtures in ${FIXTURE_DIR}`);
    process.exit(3);
}

// ── run the matrix ───────────────────────────────────────────────────────

const rows = [];
const failures = [];
let harnessError = false;

for (const file of fixtureFiles) {
    if (ONLY_FIXTURE && !file.startsWith(ONLY_FIXTURE)) continue;
    const fixturePath = join(FIXTURE_DIR, file);
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    // The scorer needs adjacency to decide whether a directive answers an
    // event "in or next to" a region — from the SAME graph the AI reads.
    const regionsJson = typeof fixture.regions === 'string'
        ? JSON.parse(readFileSync(join(ROOT, fixture.regions), 'utf8'))
        : fixture.regions;
    const neighbours = neighboursOf(regionsJson);

    for (const aiDir of AI_DIRS) {
        const ai = aiDir.split('/').pop();
        if (ONLY && ai !== ONLY) continue;

        const proc = spawnSync(LUA, [join(HERE, 'driver.lua'),
            '--ai', join(ROOT, aiDir), '--fixture', fixturePath],
            { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
        if (proc.status !== 0) {
            harnessError = true;
            console.error(`ai-eval: driver failed for ${ai}/${fixture.id} `
                + `(exit ${proc.status})\n${proc.stderr || proc.stdout}`);
            continue;
        }
        let run;
        try {
            run = JSON.parse(proc.stdout);
        } catch (err) {
            harnessError = true;
            console.error(`ai-eval: driver emitted unparseable JSON for ${ai}/${fixture.id}: `
                + `${err.message}\n${proc.stdout.slice(0, 400)}`);
            continue;
        }
        const row = grade(run, expectationsFor(fixture, ai), neighbours);
        rows.push(row);
        if (row.failed) failures.push(row);
    }
}

if (harnessError) process.exit(3);
if (!rows.length) {
    console.error('ai-eval: the matrix is empty — check --only / --fixture.');
    process.exit(3);
}

// ── report ───────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log('');
console.log(`${pad('fixture', 24)}${pad('ai', 12)}${num('dirs', 5)}${num('spent', 6)}`
    + `${num('react', 7)}${num('viol', 5)}${num('err', 4)}  checks`);
console.log('-'.repeat(80));
let lastFixture = null;
for (const r of rows) {
    const m = r.metrics;
    const react = m.reactions.length
        ? (m.worstLatency === null ? '—' : `${m.worstLatency}f`)
        : '.';
    console.log(`${pad(r.fixture === lastFixture ? '' : r.fixture, 24)}${pad(r.ai, 12)}`
        + `${num(m.directives, 5)}${num(m.spent, 6)}${num(react, 7)}${num(m.violations, 5)}`
        + `${num(m.errors, 4)}  ${r.failed ? `${r.passed} ok, ${r.failed} FAILED` : `${r.passed} ok`}`);
    lastFixture = r.fixture;
    if (VERBOSE) {
        for (const [type, n] of Object.entries(m.byType).sort()) {
            console.log(`${' '.repeat(36)}    ${type} × ${n}`);
        }
        for (const rx of m.reactions) {
            console.log(`${' '.repeat(36)}    event ${rx.id} @${rx.frame} → `
                + (rx.latency === null ? 'never answered' : `${rx.latency}f (${rx.answeredWith})`));
        }
    }
}
console.log('');

const summary = summarise(rows);
const report = {
    generator: 'tools/ai-eval/run-eval.mjs',
    ais: AI_DIRS,
    fixtures: fixtureFiles,
    ...summary,
};

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(join(REPORT_DIR, 'latest.json'), `${JSON.stringify({ ...report, rows }, null, 2)}\n`);
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ ...report, rows }, null, 2)}\n`);

for (const r of failures) {
    for (const c of r.checks.filter((x) => !x.ok)) {
        console.error(`FAIL ${r.ai}/${r.fixture}: ${c.check} — ${c.detail}`
            + (c.why ? `\n       (${c.why})` : ''));
    }
}

if (SAVE_BASELINE) {
    writeFileSync(BASELINE, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`ai-eval: baseline written to ${BASELINE}`);
}

// ── the gate ─────────────────────────────────────────────────────────────

let exitCode = failures.length ? 1 : 0;

if (GATE && !SAVE_BASELINE) {
    if (!existsSync(BASELINE)) {
        console.error(`ai-eval: no baseline at ${BASELINE}. Run once with --save-baseline.`);
        exitCode = Math.max(exitCode, 3);
    } else {
        const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
        const verdict = compareToBaseline(summary, baseline, TOLERANCE);
        if (verdict.added.length) {
            console.log(`ai-eval: new cells (not gated until the baseline is updated): `
                + verdict.added.join(', '));
        }
        if (!verdict.ok) {
            for (const reg of verdict.regressions) {
                console.error(`REGRESSION ${reg.cell} [${reg.kind}] ${reg.detail}`);
            }
            console.error('ai-eval: the AI got worse. Re-baseline only if the change was the point.');
            exitCode = 2;
        } else {
            console.log(`ai-eval: no regression vs baseline (tolerance ${TOLERANCE}).`);
        }
    }
}

console.log(`ai-eval: ${summary.totals.cells} cells, `
    + `${summary.totals.checksPassed} checks passed, ${summary.totals.checksFailed} failed, `
    + `${summary.totals.violations} floor violations, ${summary.totals.errors} raised ticks.`);

process.exit(exitCode);
