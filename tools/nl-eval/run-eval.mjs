#!/usr/bin/env node
/**
 * run-eval.mjs — play the golden fixtures through the real prompt and score
 * what comes back.
 *
 * PLAN-metalstorm-command-language.md §8, milestone M7. The scoring itself
 * lives in `score.mjs` and is unit-tested by the ordinary hermetic suite; this
 * file is the part that spends money, and it is the ONLY place in the repo
 * allowed to make a live API call.
 *
 * NEEDS A KEY AND COSTS MONEY. Excluded from CI on purpose — the unit suites
 * (`npx vitest run`, `spring-tests`) contain no live API call and must not
 * grow one. Without a key this exits 0 rather than failing, so an accidental
 * invocation is a no-op instead of a red build for the wrong reason.
 *
 *   SPRING_NL_API_KEY=sk-ant-... node tools/nl-eval/run-eval.mjs
 *   node tools/nl-eval/run-eval.mjs --dry-run          # no key, no call
 *   node tools/nl-eval/run-eval.mjs --model claude-haiku-4-5 --effort low
 *   node tools/nl-eval/run-eval.mjs --baseline build/nl-eval/baseline.json
 *   node tools/nl-eval/run-eval.mjs --save-baseline
 */

import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareToBaseline, scoreEnvelope, summarise } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const UI_DIR = join(ROOT, 'data/games/metalstorm/ui');
const FIXTURE_DIR = join(ROOT, 'client/src/ui/native-ui/nl-fixtures');
const REPORT_DIR = join(ROOT, 'build/nl-eval');

const API_URL = 'https://api.anthropic.com/v1/messages';

// ── the config knobs (M7: "make the model a config knob") ──
//
// Same names and same precedence as the proxy reads them (NlProxy.cpp), so a
// sweep here and a deployment there cannot disagree about what was measured.
// The DEFAULTS are the proxy's defaults, deliberately: an eval that silently
// measures a different model than production ships is worse than no eval.

function flag(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    return fallback;
}

const MODEL = flag('model', (process.env.SPRING_NL_MODEL || '').trim() || 'claude-opus-5');
const EFFORT = flag('effort', (process.env.SPRING_NL_EFFORT || '').trim() || 'low');
const CONCURRENCY = Math.max(1, Number(flag('concurrency', '4')) || 4);
const REPEAT = Math.max(1, Number(flag('repeat', '1')) || 1);
const ONLY = flag('only', '');
const BASELINE_PATH = flag('baseline', '');
const TOLERANCE = Number(flag('tolerance', '0')) || 0;
const SAVE_BASELINE = process.argv.includes('--save-baseline');
const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

const apiKey = (process.env.SPRING_NL_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();

/**
 * USD per million tokens, list price. Cache reads are 0.1x input and cache
 * writes 1.25x input (5-minute TTL, which is what `cache_control: ephemeral`
 * gives us) — that ratio is the whole reason §3 puts the schema and vocabulary
 * behind a cache breakpoint, so the run reports it rather than assuming it.
 *
 * A model missing from this table still runs; it just reports no dollar figure
 * rather than a made-up one.
 */
const PRICES = {
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
};

function usdFor(model, usage) {
    const p = PRICES[model];
    if (!p) return null;
    const m = 1e-6;
    return (usage.inputTokens * p.in
        + usage.outputTokens * p.out
        + usage.cacheReadTokens * p.in * 0.1
        + usage.cacheWriteTokens * p.in * 1.25) * m;
}

// ── the prompt, assembled from the SAME FILES NlProxy.cpp reads ──
//
// This used to be a JS paraphrase of C++ string literals, on the theory that a
// re-implementation was safer than a copy. It was not: M5 rewrote the rules of
// engagement in C++ and this file kept the M4 wording, so the two ended up
// 4 KB apart and every number this harness printed was about a prompt
// production does not send. The prose now lives in `ui/nl-instructions.md`
// (pillar 5 — one vocabulary, many consumers) and both sides read those bytes.
//
// What is still duplicated is the two-line schema header below and the
// vocabulary table's layout. `--dry-run` prints the assembled byte count, and
// `tests/test_nl_proxy.cpp` prints the C++ one from the same files; equal
// numbers mean equal prompts.

const instructions = readFileSync(join(UI_DIR, 'nl-instructions.md'), 'utf8');
const schemaJson = readFileSync(join(UI_DIR, 'nl-response.schema.json'), 'utf8').trimEnd();
const vocabulary = JSON.parse(readFileSync(join(UI_DIR, 'class-vocabulary.json'), 'utf8'));

/**
 * A byte-for-byte port of `NlProxy::BuildVocabularyTable`. The sort and the
 * dedupe are load-bearing on both sides: this text sits inside the cached
 * prefix, so a different order is a cache miss on every utterance.
 *
 * The first version of this function omitted the dedupe and the whole ROLE
 * PHRASES block, which is 301 of the bytes that used to separate the two
 * prompts. Keep them in step; the byte counts printed by `--dry-run` and by
 * `tests/test_nl_proxy.cpp` are how you check.
 */
function vocabularyTable(vocab) {
    const uniqueSorted = (xs) => [...new Set(xs)].sort();
    let out = '';

    if (vocab.classes && typeof vocab.classes === 'object') {
        out += 'UNIT CLASSES (the `class` field takes the key on the left):\n';
        for (const key of Object.keys(vocab.classes).sort()) {
            const entry = vocab.classes[key];
            if (!entry || typeof entry !== 'object') continue;
            out += `  ${key}${entry.display ? ` — ${entry.display}` : ''}`;
            const words = uniqueSorted([
                ...(typeof entry.plural === 'string' ? [entry.plural] : []),
                ...(Array.isArray(entry.synonyms) ? entry.synonyms.filter((w) => typeof w === 'string') : []),
            ]);
            if (words.length) out += ` (also called: ${words.join(', ')})`;
            out += '\n';
        }
    }

    const roleKeys = Object.keys(vocab.roles ?? {}).sort();
    if (roleKeys.length) {
        out += 'ROLE PHRASES (map to the classes listed):\n';
        for (const key of roleKeys) {
            const matched = uniqueSorted(
                (vocab.roles[key]?.matches ?? [])
                    .filter((m) => m && typeof m.class === 'string')
                    .map((m) => m.class),
            );
            out += `  "${key}" -> ${matched.join(', ')}\n`;
        }
    }

    return out;
}

// Assembled in the same order and with the same separators as
// `NlProxy::BuildSystemPrompt`: instructions, blank line, vocabulary table,
// blank line, schema header, schema, trailing newline.
const SYSTEM_PROMPT = `${instructions}${instructions.endsWith('\n') ? '' : '\n'}\n`
    + `${vocabularyTable(vocabulary)}\n`
    + 'THE SCHEMA\n'
    + '\n'
    + 'Your entire reply is one object matching this JSON Schema:\n'
    + '\n'
    + `${schemaJson}\n`;

// ── fixtures ──
//
// The golden files are `{_comment, fixtures: [...]}` and each fixture's
// `context` is a KEY into contexts.json, whose entries are the client-side
// superset (region keys, group ids, coordinates). The model must never see
// those, so the board is projected down to the §2 wire payload here — the same
// shape `nl-context.ts` builds in the browser. Feeding the raw fixture context
// would be measuring a prompt production never sends.

const CONTEXTS = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contexts.json'), 'utf8'));

const DEFAULT_PANELS = [
    'ai-command-panel', 'minimap', 'objectives-panel', 'parley-panel', 'scoreboard-panel',
];

/** contexts.json entry → the §2 payload (names only, sorted, no ids). */
function wireContext(key) {
    const board = CONTEXTS[key];
    if (!board) throw new Error(`fixture names context "${key}", which contexts.json does not define`);

    const groups = (board.groups ?? []).map((g) => ({
        n: g.n, cls: g.cls, sz: g.size + (g.attach?.n ?? 0), state: g.busy ? 'tasked' : 'idle',
    })).sort((a, b) => a.n.localeCompare(b.n));

    const counts = {};
    for (const g of board.groups ?? []) {
        counts[g.cls] = (counts[g.cls] ?? 0) + g.size;
        if (g.attach) counts[g.attach.cls] = (counts[g.attach.cls] ?? 0) + g.attach.n;
    }
    for (const u of board.visible ?? []) {
        if (u.side === 'own') counts[u.cls] = (counts[u.cls] ?? 0) + 1;
    }

    return {
        places: (board.places ?? [])
            .map((p) => ({ n: p.n, t: p.t }))
            .sort((a, b) => a.n.localeCompare(b.n)),
        groups,
        enemies: [],
        objectives: (board.objectives ?? []).map((o) => o.n).sort(),
        classes: Object.keys(counts).sort(),
        panels: (board.panels ?? []).length
            ? board.panels.map((p) => p.id).sort()
            : DEFAULT_PANELS,
        self: {
            selection: board.selection ? 1 : 0,
            counts,
        },
    };
}

function loadFixtures() {
    if (!existsSync(FIXTURE_DIR)) return [];
    return readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'contexts.json')
        .filter((f) => !ONLY || f.includes(ONLY))
        .flatMap((f) => {
            const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8'));
            return (parsed.fixtures ?? [])
                .filter((e) => e && typeof e.utterance === 'string' && e.context)
                .map((e) => ({ ...e, category: f, wire: wireContext(e.context) }));
        });
}

function requestBody(fixture) {
    return {
        model: MODEL,
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        output_config: {
            effort: EFFORT,
            format: { type: 'json_schema', schema: JSON.parse(schemaJson) },
        },
        system: [{
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
        }],
        messages: [
            // History alternates user/assistant, oldest first — the same
            // shape NlProxy.cpp builds from the request's `history` field.
            // A `history` fixture is a clarification round-trip: the
            // question the game asked is in there, and the utterance is the
            // answer to it.
            ...(fixture.history ?? []).map((content, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content,
            })),
            {
                role: 'user',
                content: `<context>\n${JSON.stringify(fixture.wire)}\n</context>\n\n`
                    + `The player said:\n${fixture.utterance}\n`,
            },
        ],
    };
}

const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function readUsage(json) {
    const u = json?.usage ?? {};
    return {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
}

async function ask(fixture) {
    const started = Date.now();
    let resp;
    try {
        resp = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': apiKey,
            },
            body: JSON.stringify(requestBody(fixture)),
        });
    } catch (e) {
        // A transport failure is the one case where the latency number is
        // meaningless — a DNS failure "responds" in 3 ms. Report it, but the
        // percentiles below drop errored rows so they cannot flatter the p50.
        return { ms: Date.now() - started, error: `transport: ${e.message}`, usage: EMPTY_USAGE };
    }

    const ms = Date.now() - started;
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }

    if (!resp.ok) {
        // The upstream error body can echo the request; keep a short prefix
        // only, and never the key (which is a header, not a body field, but
        // the habit is what keeps it that way).
        const why = json?.error?.message ? String(json.error.message).slice(0, 160) : text.slice(0, 160);
        return { ms, error: `HTTP ${resp.status}: ${why}`, usage: readUsage(json) };
    }

    // Check stop_reason before reading content — a refusal carries an empty or
    // partial content array, and indexing [0] on one throws.
    if (json?.stop_reason === 'refusal') {
        return { ms, error: 'model refused the turn', usage: readUsage(json) };
    }

    const body = (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
        return { ms, envelope: JSON.parse(body), usage: readUsage(json) };
    } catch {
        return { ms, error: 'structured output was not parseable JSON', usage: readUsage(json) };
    }
}

/** Run `jobs` with at most `limit` in flight, preserving input order. */
async function pooled(jobs, limit, run) {
    const out = new Array(jobs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
        for (;;) {
            const i = next; next += 1;
            if (i >= jobs.length) return;
            out[i] = await run(jobs[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[i];
}

// ═══════════════════════════════════ run ═══════════════════════════════════

const fixtures = loadFixtures();
if (fixtures.length === 0) {
    console.error(`nl-eval: no fixtures under ${FIXTURE_DIR} — the loader is broken.`);
    process.exit(1);
}

const jobs = REPEAT === 1
    ? fixtures
    : Array.from({ length: REPEAT }, () => fixtures).flat();

console.log(`nl-eval: ${fixtures.length} fixtures × ${REPEAT} = ${jobs.length} calls`);
// Byte length, not `.length`: JS counts UTF-16 code units and the prompt is
// full of em dashes, so `.length` reported 72 fewer than the C++ side for a
// byte-identical prompt — which looks exactly like real drift.
const promptBytes = Buffer.byteLength(SYSTEM_PROMPT, 'utf8');

/**
 * FNV-1a over the prompt's UTF-8 bytes, matching the one
 * `tests/test_nl_proxy.cpp` prints for the C++ assembly. Equal byte counts
 * would be circumstantial; an equal hash is the claim itself — the prompt the
 * proxy sends and the prompt this harness scores are the same document. If
 * these two ever differ, every number below is about a prompt production does
 * not send, and that is the failure mode this whole file exists to avoid.
 */
function fnv1a(text) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(text, 'utf8')) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16);
}
const promptHash = fnv1a(SYSTEM_PROMPT);

// `--dump-prompt <path>` writes the assembled prompt out, so a hash mismatch
// against the C++ side is a `diff` rather than a guess.
const DUMP_PROMPT = flag('dump-prompt', '');
if (DUMP_PROMPT) {
    mkdirSync(dirname(resolve(DUMP_PROMPT)), { recursive: true });
    writeFileSync(DUMP_PROMPT, SYSTEM_PROMPT);
    console.log(`nl-eval: prompt written to ${DUMP_PROMPT}`);
}
console.log(`nl-eval: model ${MODEL}, effort ${EFFORT}, concurrency ${CONCURRENCY}, `
    + `system prompt ${promptBytes} bytes, fnv1a=${promptHash}`);

if (dryRun) {
    const rounds = fixtures.filter((f) => f.history?.length).length;
    console.log(`nl-eval: ${rounds} of them are clarification round-trips (carry history)`);
    const byCategory = new Map();
    for (const f of fixtures) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
    for (const [category, n] of [...byCategory].sort()) console.log(`  ${String(n).padStart(4)}  ${category}`);
    console.log(`nl-eval: sample wire context (${fixtures[0].context}):`);
    console.log(JSON.stringify(fixtures[0].wire, null, 2));
    if (verbose) {
        console.log('nl-eval: request body for the first fixture:');
        console.log(JSON.stringify(requestBody(fixtures[0]), null, 2).slice(0, 4000));
    }
    console.log('nl-eval: --dry-run, no API call made.');
    process.exit(0);
}

if (!apiKey) {
    console.log('nl-eval: no SPRING_NL_API_KEY / ANTHROPIC_API_KEY set — nothing to do.');
    console.log('nl-eval: this harness makes real API calls; see tools/nl-eval/README.md.');
    process.exit(0);
}

const startedAt = new Date().toISOString();
const results = await pooled(jobs, CONCURRENCY, async (fixture) => {
    const answer = await ask(fixture);
    const scored = answer.envelope
        ? scoreEnvelope(fixture.expected, answer.envelope)
        : { pass: false, agreement: 0, mismatches: [] };
    return {
        category: fixture.category,
        name: fixture.name ?? fixture.utterance,
        utterance: fixture.utterance,
        ms: answer.ms,
        error: answer.error ?? null,
        usage: answer.usage,
        pass: scored.pass,
        agreement: scored.agreement,
        mismatches: scored.mismatches.map((m) => ({ path: m.path, expected: m.expected, actual: m.actual })),
        envelope: answer.envelope ?? null,
    };
});

for (const r of results) {
    const label = r.error ? `ERR ` : (r.pass ? 'ok  ' : 'MISS');
    const detail = r.error
        ? ` ${r.error}`
        : (r.pass ? '' : ` ${(r.agreement * 100).toFixed(0)}% · ${r.mismatches.map((m) => m.path).join(', ')}`);
    console.log(`  ${label} ${String(r.ms).padStart(5)}ms  ${r.utterance.slice(0, 52).padEnd(52)}${detail}`);
}

// ── the dashboards (M7: latency/cost per run) ──
//
// Errored calls are excluded from the latency percentiles: a 401 that comes
// back in 300 ms would drag a p50 down and make a slow model look fast, which
// is precisely the number the haiku decision turns on.

const latencies = results.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
const usage = results.reduce((acc, r) => ({
    inputTokens: acc.inputTokens + r.usage.inputTokens,
    outputTokens: acc.outputTokens + r.usage.outputTokens,
    cacheReadTokens: acc.cacheReadTokens + r.usage.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens + r.usage.cacheWriteTokens,
}), { ...EMPTY_USAGE });

const summary = summarise(results);
const spendUsd = usdFor(MODEL, usage);
const latency = {
    n: latencies.length,
    min: latencies[0] ?? null,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies[latencies.length - 1] ?? null,
};

console.log('');
console.log(`nl-eval: ${summary.passed}/${summary.total} exact `
    + `(${(summary.passRate * 100).toFixed(1)}%), mean field agreement ${(summary.agreement * 100).toFixed(1)}%`
    + (summary.errored ? `, ${summary.errored} errored` : ''));
console.log('nl-eval: per category —');
for (const c of summary.categories) {
    const bar = `${c.passed}/${c.total}`.padEnd(8);
    console.log(`  ${c.category.padEnd(24)} ${bar} ${(c.passRate * 100).toFixed(0).padStart(3)}%  `
        + `agreement ${(c.agreement * 100).toFixed(0)}%${c.errored ? `  (${c.errored} errored)` : ''}`);
}
console.log('');
// `n/a` rather than `nullms` when every call errored — the first bogus-key run
// printed "p50 nullms", which reads like a bug in the timing rather than the
// honest "no successful call was timed".
const ms = (v) => (v === null ? 'n/a' : `${v}ms`);
console.log(`nl-eval: latency  p50 ${ms(latency.p50)}  p95 ${ms(latency.p95)}  `
    + `(min ${ms(latency.min)}, max ${ms(latency.max)}, n=${latency.n}, concurrency ${CONCURRENCY})`);
console.log(`nl-eval: tokens   in ${usage.inputTokens}  out ${usage.outputTokens}  `
    + `cache read ${usage.cacheReadTokens}  cache write ${usage.cacheWriteTokens}`);
console.log(`nl-eval: spend    ${spendUsd === null ? `unknown (no price for ${MODEL})` : `$${spendUsd.toFixed(4)} this run, $${(spendUsd / Math.max(1, results.length)).toFixed(5)} per utterance`}`);

// The plan's own tuning rule (§7 M7), stated by the harness rather than left
// to whoever reads the number: drop to haiku if p50 > ~1.5 s.
if (latency.p50 !== null) {
    if (latency.p50 > 1500 && MODEL !== 'claude-haiku-4-5') {
        console.log(`nl-eval: p50 ${latency.p50}ms is over the plan's ~1500ms bar — `
            + 're-run with --model claude-haiku-4-5 and compare the pass rate before switching.');
    } else if (latency.p50 <= 1500) {
        console.log(`nl-eval: p50 ${latency.p50}ms is inside the plan's ~1500ms bar; ${MODEL} stays.`);
    }
}

// ── the report ──

const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    model: MODEL,
    effort: EFFORT,
    concurrency: CONCURRENCY,
    repeat: REPEAT,
    systemPromptBytes: promptBytes,
    systemPromptHash: promptHash,
    ...summary,
    latency,
    usage,
    spendUsd,
    rows: results,
};

mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = join(REPORT_DIR, `report-${startedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(REPORT_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`nl-eval: report ${reportPath}`);

if (SAVE_BASELINE) {
    const baselinePath = join(REPORT_DIR, 'baseline.json');
    writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`nl-eval: baseline written to ${baselinePath}`);
}

// ── the regression gate ──

if (BASELINE_PATH) {
    if (!existsSync(BASELINE_PATH)) {
        console.error(`nl-eval: --baseline ${BASELINE_PATH} does not exist. `
            + 'Run once with --save-baseline first.');
        process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const verdict = compareToBaseline(summary, baseline, TOLERANCE);
    console.log('');
    console.log(`nl-eval: gate vs ${BASELINE_PATH} `
        + `(${baseline.model} @ ${baseline.effort}, ${verdict.overall.was} passing) `
        + `→ ${verdict.overall.now} passing, tolerance ${TOLERANCE}`);
    if (!verdict.ok) {
        for (const r of verdict.regressions) {
            console.error(`  REGRESSION ${r.category}: ${r.was}/${r.of} → ${r.now === null ? 'absent' : `${r.now}/${r.of}`}`);
        }
        console.error('nl-eval: the prompt or vocabulary got worse. §8 says that is not allowed.');
        process.exit(2);
    }
    console.log('nl-eval: no category regressed.');
}
