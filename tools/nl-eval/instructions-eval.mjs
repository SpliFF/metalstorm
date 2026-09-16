/**
 * instructions-eval.mjs — score `nl-instructions.md` against the corpus, and
 * compare a candidate rewrite to the shipped one
 * (2026-09-10 nl-commands review)
 *
 * Offline: it reads the shipped schema, the fixture corpus and the document
 * itself off disk, and calls nothing. See `score-instructions.mjs` for what the
 * number means — and, more importantly, what it does not.
 *
 *     node tools/nl-eval/instructions-eval.mjs
 *     node tools/nl-eval/instructions-eval.mjs --candidate path/to/draft.md
 *     node tools/nl-eval/instructions-eval.mjs --save-baseline
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreInstructions, compareInstructions } from './score-instructions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const UI_DIR = join(ROOT, 'data/games/metalstorm/ui');
const FIXTURE_DIR = join(ROOT, 'client/src/ui/native-ui/nl-fixtures');
const INSTRUCTIONS = join(UI_DIR, 'nl-instructions.md');
const BASELINE = join(HERE, 'instructions-baseline.json');

function flag(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : fallback;
}

/**
 * The closed vocabularies, read from the SHIPPED schema rather than restated.
 *
 * Restating them here is the mistake this whole directory has already made once
 * (see the README): a second copy of the contract drifts, and then every number
 * is about a contract nobody ships.
 */
export function loadContract() {
    const schema = JSON.parse(readFileSync(join(UI_DIR, 'nl-response.schema.json'), 'utf8'));

    // Two shapes carry a closed vocabulary here: `enum` for a list (verbs,
    // priorities) and `const` for a discriminator (each action variant's
    // `kind`, each op's `op`). Collecting only the first is how the first draft
    // of this reported every action kind as "stale" — the schema names them,
    // just not with the keyword the walk looked for.
    const byKey = new Map();
    const push = (key, values) => {
        const into = byKey.get(key) ?? new Set();
        for (const v of values) into.add(v);
        byKey.set(key, into);
    };
    const walk = (node, key) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node.enum)) push(key, node.enum.filter((v) => typeof v === 'string'));
        if (typeof node.const === 'string') push(key, [node.const]);
        for (const [k, v] of Object.entries(node)) {
            if (!v || typeof v !== 'object') continue;
            // `properties` / `anyOf` / `items` are structure, not names: the key
            // that matters is the property whose schema we are descending into.
            const next = ['properties', 'anyOf', 'allOf', 'oneOf', 'items', 'then', 'else']
                .includes(k) || /^\d+$/.test(k) ? key : k;
            walk(v, next);
        }
    };
    walk(schema, '');

    const of = (key) => [...(byKey.get(key) ?? [])];
    const only = (key, allowed) => of(key).filter((v) => allowed.includes(v));
    const OPS = of('op');
    return {
        kinds: of('kind'),
        verbs: of('verb'),
        // `type` is shared by subjects, targets and when-conditions, so each is
        // narrowed to the members the envelope's own TS union declares. Those
        // three lists are asserted against `nl-envelope.ts` by
        // `score-instructions.test.mjs`, which is what stops them drifting.
        subjectTypes: only('type', ['entity-ref', 'class-count', 'idle-filter', 'selection', 'any', 'ai']),
        targetTypes: only('type', ['entity-ref', 'point', 'area-around']),
        whenTypes: only('type', ['now', 'under-attack', 'region-contested', 'objective-complete', 'strength-below']),
        queryOps: OPS.filter((o) => ['count', 'locate', 'status', 'resources', 'objectives', 'events'].includes(o)),
        guidanceOps: OPS.filter((o) => ['stance', 'paint', 'lock', 'delegate', 'fund', 'roe', 'veto'].includes(o)),
        cameraOps: OPS.filter((o) => ['focus', 'follow', 'fitMap', 'zoom', 'saveView', 'loadView'].includes(o)),
        uiOps: OPS.filter((o) => ['open', 'close', 'toggle', 'fullscreen'].includes(o)),
        groupOps: OPS.filter((o) => ['create', 'rename'].includes(o)),
    };
}

/** What the corpus exercises — categories and the focus fields its boards
 *  actually carry, so a rule is only required once something tests it. */
export function loadCorpus() {
    const categories = readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'contexts.json')
        .sort();
    const contexts = JSON.parse(readFileSync(join(FIXTURE_DIR, 'contexts.json'), 'utf8'));
    const focusFields = new Set();
    for (const [key, board] of Object.entries(contexts)) {
        if (key.startsWith('_') || !board.focus) continue;
        for (const field of Object.keys(board.focus)) focusFields.add(field);
        for (const brief of [board.focus.primary, board.focus.drilled, ...(board.focus.subjects ?? [])]) {
            for (const field of Object.keys(brief ?? {})) focusFields.add(field);
        }
    }
    return { categories, focusFields: [...focusFields].sort() };
}

function report(label, score) {
    console.log(`\n${label}`);
    console.log(`  ${score.bytes} bytes · ${score.taught}/${score.features} features taught `
        + `(${score.exemplified} shown in an example) · coverage ${(score.coverage * 100).toFixed(1)}%`);
    for (const g of score.byGroup) {
        const pct = g.available === 0 ? 0 : (g.earned / g.available) * 100;
        console.log(`    ${g.group.padEnd(9)} ${String(g.total).padStart(3)} features  ${pct.toFixed(0).padStart(3)}%`
            + (g.missing.length ? `  missing: ${g.missing.join(', ')}` : ''));
    }
    if (score.stale.length) console.log(`    STALE (not in the schema): ${score.stale.join(', ')}`);
}

// ─────────────────────────────── the CLI ───────────────────────────────
//
// Guarded: `score-instructions.test.mjs` imports `loadContract`/`loadCorpus`
// from here, and an unguarded body would print a report and possibly
// `process.exit` in the middle of a test run — which it did, exactly once,
// before this guard existed.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    const contract = loadContract();
    const corpus = loadCorpus();
    const shipped = readFileSync(INSTRUCTIONS, 'utf8');
    const candidatePath = flag('candidate', '');

    if (candidatePath) {
        const candidate = readFileSync(resolve(candidatePath), 'utf8');
        const verdict = compareInstructions(shipped, candidate, corpus, contract);
        report('shipped  nl-instructions.md', verdict.shipped);
        report(`candidate ${candidatePath}`, verdict.candidate);
        console.log(`\ndelta ${(verdict.delta * 100).toFixed(1)} points`);
        if (verdict.fixed.length) console.log(`  now taught: ${verdict.fixed.join(', ')}`);
        if (verdict.lost.length) console.log(`  LOST: ${verdict.lost.join(', ')}`);
        console.log(verdict.better
            ? '\nThe candidate covers more and drops nothing — safe to swap.'
            : '\nThe candidate is NOT an improvement by this measure. Do not swap on it.');
        process.exit(verdict.better ? 0 : 3);
    }

    const score = scoreInstructions(shipped, corpus, contract);
    report('nl-instructions.md', score);

    if (process.argv.includes('--save-baseline')) {
        writeFileSync(BASELINE, `${JSON.stringify({
            note: 'Coverage of the contract by nl-instructions.md, measured offline by '
                + 'tools/nl-eval/score-instructions.mjs. A DOCUMENTATION number, not a '
                + 'model-accuracy one — see that file’s header.',
            ...score,
        }, null, 2)}\n`);
        console.log(`\nbaseline written to ${BASELINE}`);
    } else if (existsSync(BASELINE)) {
        const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
        const lost = score.missing.filter((m) => !base.missing.includes(m));
        console.log(`\ngate vs ${BASELINE}: coverage ${(base.coverage * 100).toFixed(1)}% → `
            + `${(score.coverage * 100).toFixed(1)}%`);
        if (lost.length) {
            console.error(`  REGRESSION — no longer taught: ${lost.join(', ')}`);
            process.exit(2);
        }
        console.log('  nothing the baseline taught has been dropped.');
    }
}
