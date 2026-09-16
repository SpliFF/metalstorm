/**
 * offline-corpus.test-support.ts — the whole golden corpus through the OFFLINE
 * producers, with no network anywhere
 * (PLAN-metalstorm-command-language.md §8; 2026-09-10 nl-commands review)
 *
 * `tools/nl-eval/run-eval.mjs` measures the MODEL: it needs a key, it spends
 * money, and it is excluded from CI on purpose. That leaves the question it
 * cannot answer in a gate — *how much of the corpus does this client understand
 * with the proxy switched off?* — measured by nobody.
 *
 * This file answers it. Fixture in, envelope out, scored against the same
 * `expected` the model is scored against, by the same scorer
 * (`tools/nl-eval/score.mjs`). It is pure computation over files already in the
 * tree: no fetch, no clock, no key, no randomness. That is what lets it be a
 * GATE rather than a report — an LLM-judged arm may exist alongside it and can
 * never be one.
 *
 * What a run reports, and why each number is separate:
 *
 *  - **pass rate per category** — one per fixture file, because that is how the
 *    fixtures are already grouped by behaviour. An overall rate hides a change
 *    that trades six working camera verbs for six newly-working queries.
 *  - **fast-path absorption** — the fraction the deterministic grammar
 *    (`nl-fast-path.ts`) claimed outright, so the round trip never happens.
 *    This is a LATENCY number and must never be read as a quality one: the fast
 *    path is designed to decline, and a rise in absorption is only good news if
 *    the pass rate held.
 *  - **offline coverage** — the fraction the offline producer answered with
 *    something other than a refusal. A sentence it refuses is one the player
 *    only gets with the proxy up.
 *
 * The three are reported separately because they move independently, and a
 * single headline number would let any two of them hide the third.
 */

import { acceleratorToEnvelope } from '../nl-client.js';
import { fastPathParse, type FastPathRule } from '../nl-fast-path.js';
import { bindFocusReferences, focusViewFromContext } from '../nl-focus.js';
import type { NLResponse } from '../nl-envelope.js';
import { validateNLResponse } from '../nl-envelope.js';
import type { ClassVocabulary } from '../class-vocabulary.js';
import {
    buildFixtureWorld, DEFAULT_PANELS,
    type FixtureContext, type FixtureWorld,
} from './fixture-world.js';
import { loadContexts, loadFixtures, loadVocabulary, type LoadedFixture } from './load-fixtures.test-support.js';

/** One fixture, run offline. */
export interface OfflineRow {
    /** `contract-v2.json` — the scorer's category key. */
    category: string;
    name: string;
    utterance: string;
    context: string;
    expected: NLResponse;
    /** What the offline stack actually produced, focus-bound. */
    actual: NLResponse;
    /** Which producer claimed it. */
    source: 'fast-path' | 'offline-parser';
    /** Set when the fast path claimed it. */
    fastPathRule?: FastPathRule;
    /** True when `actual` is nothing but refusals — the offline stack did not
     *  understand the sentence at all. */
    refusedOffline: boolean;
    /** The envelope failed the contract. A producer bug, and always a fail. */
    invalid?: string;
    /** Present ⇒ excluded from the offline score, with this as the reason. See
     *  `NLFixture.offlineSkip`. */
    offlineSkip?: string;
}

/** Spoken panel name → registry id, for the M3 local patterns. Built from the
 *  board's own panel list so a context that declares its own panels is served
 *  by the same map the registry was built from. */
function panelResolver(context: FixtureContext): (name: string) => string | null {
    const byName = new Map<string, string>();
    for (const panel of context.panels ?? DEFAULT_PANELS) {
        byName.set(panel.label.toLowerCase(), panel.id);
        byName.set(panel.id.toLowerCase(), panel.id);
        for (const alias of panel.aliases ?? []) byName.set(alias.toLowerCase(), panel.id);
    }
    return (name) => byName.get(name.toLowerCase().replace(/^the\s+/, '')) ?? null;
}

/**
 * Run ONE fixture through the offline stack, in the order `runUtterance` tries
 * them: the deterministic fast path first, then the offline parser.
 *
 * Deliberately the PRODUCER half only — no executor, no ports, no sends. What
 * is being measured is whether the sentence became the right envelope; whether
 * that envelope then dispatches correctly is `nl-executor.test.ts`'s question
 * and is asserted there against the same fixtures. Measuring both here would
 * conflate "did not understand" with "understood, and the board refused".
 */
export function runOffline(
    fixture: LoadedFixture, world: FixtureWorld, context: FixtureContext,
    vocabulary: ClassVocabulary,
): OfflineRow {
    const focus = focusViewFromContext(context.focus);
    const base = {
        index: world.index,
        vocabulary,
        selectionGroupId: world.deps.selectionGroupId ?? null,
        groupLabel: (id: number) =>
            world.groups.find((g) => g.groupId === id)?.name ?? `Group ${id}`,
        ...(focus ? { focus } : {}),
    };

    const claim = fastPathParse(fixture.utterance, {
        resolver: world.resolver,
        index: world.index,
        ...(focus ? { focus } : {}),
        selectionGroupId: world.deps.selectionGroupId ?? null,
    });

    let actual: NLResponse;
    let source: OfflineRow['source'];
    let rule: FastPathRule | undefined;
    if (claim) {
        actual = claim.response;
        source = 'fast-path';
        rule = claim.rule;
    } else {
        const parsed = acceleratorToEnvelope(fixture.utterance, {
            ...base,
            patterns: { vocabulary, resolvePanel: panelResolver(context) },
        });
        // The same binder the proxy path runs — a pronoun means the same thing
        // whichever producer wrote it, which is the whole argument for the
        // envelope contract.
        actual = bindFocusReferences(parsed.response, focus).response;
        source = 'offline-parser';
    }

    const validation = validateNLResponse(actual, { vocabulary });

    return {
        category: fixture.file,
        name: fixture.name,
        utterance: fixture.utterance,
        context: fixture.context,
        expected: fixture.expected,
        actual,
        source,
        ...(rule ? { fastPathRule: rule } : {}),
        refusedOffline: actual.actions.length > 0
            && actual.actions.every((a) => a.kind === 'refuse'),
        ...(validation.ok ? {} : { invalid: validation.errors[0] }),
        ...(fixture.offlineSkip ? { offlineSkip: fixture.offlineSkip } : {}),
    };
}

/** Every fixture, offline. Deterministic: same inputs, same rows, every run. */
export function runOfflineCorpus(): OfflineRow[] {
    const vocabulary = loadVocabulary();
    const contexts = loadContexts();
    const rows: OfflineRow[] = [];
    for (const fixture of loadFixtures()) {
        const context = contexts[fixture.context];
        const world = buildFixtureWorld(context, vocabulary);
        try {
            rows.push(runOffline(fixture, world, context, vocabulary));
        } finally {
            // A camera fixture may have started a follow interval.
            world.cameraPort.dispose();
        }
    }
    return rows;
}

/** The absorption and coverage halves of the report, which `score.mjs` has no
 *  business knowing about — it scores envelopes, not producers. */
export interface OfflineShape {
    total: number;
    fastPath: number;
    fastPathRate: number;
    byRule: Record<string, number>;
    refusedOffline: number;
    offlineCoverage: number;
}

export function shapeOf(rows: readonly OfflineRow[]): OfflineShape {
    const byRule: Record<string, number> = {};
    let fastPath = 0;
    let refused = 0;
    for (const row of rows) {
        if (row.source === 'fast-path') {
            fastPath += 1;
            byRule[row.fastPathRule ?? 'unknown'] = (byRule[row.fastPathRule ?? 'unknown'] ?? 0) + 1;
        }
        if (row.refusedOffline) refused += 1;
    }
    const total = rows.length;
    return {
        total,
        fastPath,
        fastPathRate: total === 0 ? 0 : fastPath / total,
        byRule,
        refusedOffline: refused,
        offlineCoverage: total === 0 ? 0 : (total - refused) / total,
    };
}

/** Round a rate to the precision a committed baseline can be compared at
 *  without churning on floating-point noise. */
export const rate = (n: number): number => Math.round(n * 1000) / 1000;
