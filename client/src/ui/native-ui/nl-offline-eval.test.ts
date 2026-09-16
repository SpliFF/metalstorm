/**
 * nl-offline-eval.test.ts — the eval that is allowed to be a GATE
 * (PLAN-metalstorm-command-language.md §8; 2026-09-10 nl-commands review)
 *
 * `tools/nl-eval/run-eval.mjs` scores the model. It needs a key, it spends
 * money on every run, and it is excluded from CI — so it can report, but it can
 * never gate. This suite is the half that can: every golden fixture through the
 * OFFLINE producers, scored by the same `scoreEnvelope` the model arm uses,
 * against a baseline committed beside it.
 *
 * Three properties make it a legitimate gate rather than a nice graph:
 *
 *  1. **No network, no key, no clock, no randomness.** Same inputs, same
 *     numbers, every run, on every machine.
 *  2. **The same scorer as the model arm.** A scoring rule that flattered the
 *     offline path and not the model would make the two arms incomparable, and
 *     comparing them is the point.
 *  3. **Per-category pass counts, not an overall rate.** A change that trades
 *     six working camera verbs for six newly-working queries leaves a total
 *     flat; `compareToBaseline` catches it.
 *
 * Refreshing the baseline is a deliberate act with a diff to review:
 *
 *     NL_OFFLINE_BASELINE=write npx vitest run src/ui/native-ui/nl-offline-eval.test.ts
 *
 * The recording the CLI replays (`--fake offline-parser`) is written by the
 * same switch, so the numbers a human reads in the terminal and the numbers CI
 * enforces come from one run of one code path.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineCorpus, shapeOf, rate } from './nl-fixtures/offline-corpus.test-support.js';
// The scorer lives with the model arm on purpose: one definition of "the same
// envelope", shared by the thing that spends money and the thing that gates.
import { scoreEnvelope, summarise, compareToBaseline } from '../../../../tools/nl-eval/score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const BASELINE_PATH = join(REPO, 'tools', 'nl-eval', 'offline-baseline.json');
const RECORDING_PATH = join(REPO, 'tools', 'nl-eval', 'offline-recording.json');

const WRITE = process.env.NL_OFFLINE_BASELINE === 'write';

const rows = runOfflineCorpus();

/**
 * The rows the score is computed over.
 *
 * A fixture carrying `offlineSkip` is one whose `expected` is a deliberate
 * MODEL mistake, kept so the executor's answer to it can be pinned. It still
 * runs — a producer that throws on it is still a bug — but it is not scored,
 * because marking a deterministic producer down for reading the sentence
 * correctly would make the number mean less every time such a fixture is added.
 */
const scorable = rows.filter((r) => !r.offlineSkip);
const scored = scorable.map((row) => {
    const score = scoreEnvelope(row.expected, row.actual);
    return {
        category: row.category,
        name: row.name,
        utterance: row.utterance,
        context: row.context,
        source: row.source,
        ...(row.fastPathRule ? { fastPathRule: row.fastPathRule } : {}),
        refusedOffline: row.refusedOffline,
        ...(row.invalid ? { invalid: row.invalid } : {}),
        pass: score.pass,
        agreement: score.agreement,
        mismatches: score.mismatches.map((m: { path: string }) => m.path),
    };
});

const summary = summarise(scored);
const shape = shapeOf(scorable);

/** The committed numbers, in the shape `compareToBaseline` reads plus the two
 *  producer-shape numbers it knows nothing about. */
const current = {
    generatedBy: 'nl-offline-eval.test.ts',
    arm: 'offline',
    total: summary.total,
    passed: summary.passed,
    passRate: rate(summary.passRate),
    agreement: rate(summary.agreement),
    categories: summary.categories.map((c: {
        category: string; total: number; passed: number; errored: number;
        passRate: number; agreement: number;
    }) => ({
        category: c.category,
        total: c.total,
        passed: c.passed,
        errored: c.errored,
        passRate: rate(c.passRate),
        agreement: rate(c.agreement),
    })),
    fastPath: {
        claimed: shape.fastPath,
        rate: rate(shape.fastPathRate),
        byRule: shape.byRule,
    },
    offline: {
        refused: shape.refusedOffline,
        coverage: rate(shape.offlineCoverage),
        /** How many fixtures opted out, and why, so the exemption list cannot
         *  grow without a diff. */
        skipped: rows.filter((r) => r.offlineSkip).length,
        /** Envelopes the offline producer built that its own validator rejects
         *  — a producer defect, measured rather than hidden. */
        invalid: scored.filter((r) => r.invalid).length,
        invalidSentences: scored.filter((r) => r.invalid).map((r) => r.utterance).sort(),
    },
};

if (WRITE) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    // The replay recording: everything the CLI needs to print the same
    // dashboard without a TypeScript toolchain. Per-fixture, so a human can
    // see WHICH sentence moved, not just that the number did.
    writeFileSync(RECORDING_PATH, `${JSON.stringify({
        arm: 'offline',
        note: 'Emitted by nl-offline-eval.test.ts under NL_OFFLINE_BASELINE=write. '
            + 'Replayed by `node tools/nl-eval/run-eval.mjs --fake offline-parser`.',
        rows: scorable.map((r) => ({
            category: r.category,
            name: r.name,
            utterance: r.utterance,
            context: r.context,
            source: r.source,
            ...(r.fastPathRule ? { fastPathRule: r.fastPathRule } : {}),
            refusedOffline: r.refusedOffline,
            expected: r.expected,
            actual: r.actual,
        })),
    }, null, 2)}\n`);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

describe('the offline eval corpus', () => {
    it('covers at least 60 fixtures beyond the original set', () => {
        // The review's target. The corpus is the whole fixture set; what is
        // asserted here is that the contract-v2 boards really did get their
        // cases written, rather than the total drifting up on other work.
        const v2 = scored.filter((r) =>
            ['contract-v2.json', 'focus-elision.json', 'injection.json'].includes(r.category));
        expect(v2.length).toBeGreaterThanOrEqual(60);
    });

    it('the count of envelopes the offline stack emits INVALID is pinned', () => {
        // Not zero, and the number is the finding. The offline parser hands on
        // the player's own words as a ref (deliberately — see `nl-client.ts`),
        // and a sentence carrying a colon or a stray comma inside what it takes
        // for a name produces a ref the envelope charset rejects. The console
        // already turns that into a visible refusal at execution rather than a
        // silent failure, so the player is never misled; what is wrong is that
        // the producer built it at all instead of refusing by name.
        //
        // Pinned rather than asserted-away so the next fire can fix it and
        // watch this number fall, and so it cannot quietly rise meanwhile.
        expect(scored.filter((r) => r.invalid).length).toBe(baseline.offline.invalid);
    });

    it('an invalid envelope is always scored as a failure, never skipped', () => {
        for (const row of scored.filter((r) => r.invalid)) expect(row.pass, row.name).toBe(false);
    });

    it('is deterministic — two runs of the same corpus agree exactly', () => {
        const again = runOfflineCorpus();
        expect(again.map((r) => JSON.stringify(r.actual)))
            .toEqual(rows.map((r) => JSON.stringify(r.actual)));
    });
});

describe('the gate', () => {
    it('no category lost ground against the committed baseline', () => {
        const { regressions } = compareToBaseline(summary, baseline, 0);
        // Printed as the category and the counts, because "3 regressions" with
        // no names is a failure message you have to re-run the suite to read.
        expect(regressions.map((r: { category: string; was: number; now: number | null; of: number }) =>
            `${r.category}: ${r.was} → ${r.now} of ${r.of}`)).toEqual([]);
    });

    it('the headline numbers match the baseline exactly', () => {
        // Tolerance zero, and deliberately: this arm has no model in it, so a
        // number that moved is a CODE change and wants a reviewed diff — the
        // opposite of the model arm, where a one-fixture flap is noise.
        expect({ passed: current.passed, total: current.total })
            .toEqual({ passed: baseline.passed, total: baseline.total });
    });

    it('fast-path absorption matches the baseline, per rule', () => {
        // Absorption is a latency number, not a quality one — it is pinned so a
        // change to the grammar shows up as a diff rather than as a quiet
        // widening of what skips the model.
        expect(current.fastPath).toEqual(baseline.fastPath);
    });

    it('offline coverage matches the baseline', () => {
        expect(current.offline).toEqual(baseline.offline);
    });
});

describe('what the numbers mean', () => {
    it('the fast path claims nothing it gets wrong', () => {
        // The central safety property. The fast path is allowed to decline any
        // sentence it likes; what it may never do is claim one and be wrong,
        // because a claimed sentence never reaches the model to be corrected.
        const wrong = scored.filter((r) => r.source === 'fast-path' && !r.pass);
        expect(wrong.map((r) => `${r.category} · ${r.name} (${r.mismatches.join(', ')})`))
            .toEqual([]);
    });

    it('the fast path never claims a sentence with a pronoun it had to guess', () => {
        // Elision and deixis are confirm-gated readings (U4). The fast path may
        // still claim them — the gate is downstream — but a claim whose rule is
        // an elision must have had a drilled place to elide INTO, never an
        // empty focus.
        const elided = scorable.filter((r) => r.fastPathRule === 'verb-elided');
        for (const row of elided) {
            const action = row.actual.actions[0];
            expect(action.kind, row.name).toBe('command');
            if (action.kind === 'command') expect(action.intent.target, row.name).toBeDefined();
        }
    });

    it('a sentence the offline stack refuses is one the proxy is needed for', () => {
        // Not an assertion about quality — a snapshot of the honest gap, so a
        // change that widens it is visible. The names are in the baseline.
        expect(current.offline.refused).toBeLessThanOrEqual(scorable.length);
    });
});
