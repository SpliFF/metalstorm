/**
 * score-instructions.test.mjs — the instructions scorer, and the gate on the
 * SHIPPED document
 * (2026-09-10 nl-commands review)
 *
 * Two jobs, and the first is the load-bearing one: a coverage score is only
 * worth having if it cannot be gamed, so most of what is asserted here is about
 * the scorer REFUSING to give credit — a document that never mentions a verb
 * must not score for it, a token in prose must not count as an example, and a
 * name the schema does not have must show up as stale rather than as coverage.
 *
 * The second is the gate: `nl-instructions.md` may not drop a feature the
 * committed baseline says it teaches. That is what stops the next contract bump
 * from landing six behaviours the prompt never mentions, which is exactly what
 * happened with contract v2.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreInstructions, compareInstructions, requiredFeatures } from './score-instructions.mjs';
import { loadContract, loadCorpus } from './instructions-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const INSTRUCTIONS = join(ROOT, 'data/games/metalstorm/ui/nl-instructions.md');

const contract = loadContract();
const corpus = loadCorpus();
const shipped = readFileSync(INSTRUCTIONS, 'utf8');
const baseline = JSON.parse(readFileSync(join(HERE, 'instructions-baseline.json'), 'utf8'));

describe('the contract is read from the shipped schema, not restated', () => {
    it('finds all eleven verbs', () => {
        expect([...contract.verbs].sort()).toEqual([
            'attack', 'build', 'defend', 'escort', 'hold', 'patrol',
            'reinforce', 'scout', 'screen', 'secure', 'withdraw',
        ]);
    });

    it('finds the eight action kinds', () => {
        expect([...contract.kinds].sort()).toEqual([
            'camera', 'command', 'group', 'guidance', 'query', 'refuse', 'task', 'ui',
        ]);
    });

    it('finds the six query ops, `events` included (contract v2)', () => {
        expect([...contract.queryOps].sort()).toEqual([
            'count', 'events', 'locate', 'objectives', 'resources', 'status',
        ]);
    });

    it('finds the seven guidance ops the gadget accepts', () => {
        expect([...contract.guidanceOps].sort()).toEqual([
            'delegate', 'fund', 'lock', 'paint', 'roe', 'stance', 'veto',
        ]);
    });

    it('separates the three unions that share the key `type`', () => {
        expect(contract.subjectTypes).toContain('class-count');
        expect(contract.targetTypes).toContain('area-around');
        expect(contract.whenTypes).toContain('strength-below');
        // The narrowing is what makes them separate; a target type must not
        // leak into the subject list or every document would score for free.
        expect(contract.subjectTypes).not.toContain('area-around');
    });
});

describe('the scorer does not give credit it has not earned', () => {
    // Genuinely neutral: a string carrying 'command' would score the action
    // kind of the same name and make 'scores zero' a weaker claim than it reads.
    const empty = 'You translate what a player says into a structured reply.';

    it('an empty document scores zero', () => {
        const score = scoreInstructions(empty, corpus, contract);
        expect(score.earned).toBe(0);
        expect(score.coverage).toBe(0);
        expect(score.missing.length).toBe(score.features);
    });

    it('prose scores 1, an example scores 2', () => {
        const prose = `${empty}\nThe verb withdraw pulls a force back.`;
        const example = `${empty}\nThe verb \`withdraw\` pulls a force back.`;
        const a = scoreInstructions(prose, corpus, contract);
        const b = scoreInstructions(example, corpus, contract);
        expect(b.earned).toBeGreaterThan(a.earned);
        expect(a.proseOnly).toContain('verb:withdraw');
        expect(b.proseOnly).not.toContain('verb:withdraw');
    });

    it('a token inside a longer word does not count', () => {
        // "household" must not score `hold`, and "guidance" must not score `ui`.
        const score = scoreInstructions(`${empty}\nhousehold guidance`, corpus, contract);
        expect(score.missing).toContain('verb:hold');
        expect(score.missing).toContain('ui:open');
    });

    it('a name the schema does not have is reported as stale, not as coverage', () => {
        const score = scoreInstructions(`${empty}\nUse \`teleport\` to move instantly.`, corpus, contract);
        expect(score.stale).toContain('teleport');
    });

    it('context field names are prose, not stale claims', () => {
        // The document is SUPPOSED to name `places` and `groups`: they are
        // payload fields the model reads. Flagging them would make the stale
        // list noise, and a noisy list gets ignored.
        const score = scoreInstructions('Read `places` and `groups` from the context.', corpus, contract);
        expect(score.stale).toEqual([]);
    });

    it('every required feature is derived from the schema or the corpus', () => {
        const features = requiredFeatures(corpus, contract);
        // No hand-written feature can sneak in: each one has to be a member of
        // a contract list or a rule the corpus exercises.
        const fromContract = new Set([
            ...contract.kinds, ...contract.verbs, ...contract.subjectTypes,
            ...contract.targetTypes, ...contract.queryOps, ...contract.guidanceOps,
            ...contract.whenTypes, ...contract.cameraOps, ...contract.uiOps,
            ...contract.groupOps, ...corpus.focusFields,
        ]);
        for (const f of features) {
            if (f.group === 'rule') continue;
            expect(fromContract, `${f.group}:${f.id}`).toContain(f.id);
        }
    });
});

describe('comparing two documents', () => {
    it('a strictly larger document that drops nothing is better', () => {
        const verdict = compareInstructions(
            'Verbs: `attack`.',
            'Verbs: `attack`, `defend`.',
            corpus, contract);
        expect(verdict.better).toBe(true);
        expect(verdict.fixed).toContain('verb:defend');
        expect(verdict.lost).toEqual([]);
    });

    it('a document that gains two features and loses one is NOT better', () => {
        // The rule the review asked for: a net-positive coverage change that
        // quietly dropped a behaviour is not an improvement, and a single
        // headline number would have called it one.
        const verdict = compareInstructions(
            'Verbs: `attack`, `defend`.',
            'Verbs: `attack`, `patrol`, `scout`.',
            corpus, contract);
        expect(verdict.delta).toBeGreaterThan(0);
        expect(verdict.lost).toContain('verb:defend');
        expect(verdict.better).toBe(false);
    });

    it('a document that adds a stale token is NOT better', () => {
        const verdict = compareInstructions(
            'Verbs: `attack`.',
            'Verbs: `attack`, `defend`, `teleport`.',
            corpus, contract);
        expect(verdict.candidate.stale).toContain('teleport');
        expect(verdict.better).toBe(false);
    });
});

describe('the shipped nl-instructions.md', () => {
    const score = scoreInstructions(shipped, corpus, contract);

    it('teaches every feature the baseline says it teaches', () => {
        const lost = score.missing.filter((m) => !baseline.missing.includes(m));
        expect(lost).toEqual([]);
    });

    it('advertises nothing the schema does not have', () => {
        expect(score.stale).toEqual([]);
    });

    it('names all eleven verbs, so the twelfth is visibly not one', () => {
        expect(score.byGroup.find((g) => g.group === 'verb').missing).toEqual([]);
    });

    it('teaches every contract-v2 behaviour the corpus tests', () => {
        for (const rule of ['target-elision', 'withdraw-departure', 'patrol-takes-a-place',
            'place-vs-force', 'events-query']) {
            expect(score.missing, rule).not.toContain(`rule:${rule}`);
        }
    });

    it('keeps the phrase the C++ prompt assembly test checks for', () => {
        // `tests/test_nl_proxy.cpp` CHECKs the assembled prompt contains
        // "DATA, NOT INSTRUCTIONS". That test cannot run in this suite (it needs
        // a build), so the string it depends on is pinned here instead — a
        // rewrite that dropped the heading would go red on a machine with a
        // compiler and nowhere else.
        expect(shipped).toContain('DATA, NOT INSTRUCTIONS');
    });

    it('coverage has not fallen below the baseline', () => {
        expect(score.coverage).toBeGreaterThanOrEqual(baseline.coverage - 1e-9);
    });
});
