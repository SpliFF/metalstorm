/**
 * free-text-accelerator.test.ts — Tests for the command-composer keyword
 * accelerator (PLAN-metalstorm-scripting.md task 7)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acceleratorFill, type AcceleratorSearchIndex } from './free-text-accelerator.js';
import type { NamedEntity } from './named-entity-index.js';
import { NamedEntityIndex } from './named-entity-index.js';
import { ClassVocabulary } from './class-vocabulary.js';

function buildIndex(entities: NamedEntity[]): AcceleratorSearchIndex {
    const idx = new NamedEntityIndex();
    for (const e of entities) idx.add(e);
    return idx;
}

/**
 * The accelerator parses against whatever vocabulary it is handed, so these
 * tests hand it the REAL shipped one (`data/games/metalstorm/ui/class-
 * vocabulary.json`) rather than a convenient stub — a fixture would let the
 * parser and the game drift apart again, one indirection further out.
 * `class-vocabulary.test.ts` separately pins that file to the unit defs.
 */
const VOCABULARY = ClassVocabulary.fromData(JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..',
         'data', 'games', 'metalstorm', 'ui', 'class-vocabulary.json'),
    'utf8',
)));

const MERIDIAN: NamedEntity = { id: 'meridian', type: 'city', name: 'Meridian City', x: 100, z: 200 };
const NORTH_BASIN: NamedEntity = { id: 'north-basin', type: 'region', name: 'North Basin', x: 10, z: 20 };
const THIRD_ARMOURED: NamedEntity = { id: 7, type: 'group', name: '3rd Armoured', x: 0, z: 0 };
const OBJECTIVE: NamedEntity = { id: 3, type: 'objective', name: 'Radio Tower', x: 5, z: 5 };

describe('acceleratorFill', () => {
    it('fills verb + target + priority from the plan\'s own worked example (§2)', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('attack meridian high', index, VOCABULARY);
        expect(result.verb).toBe('attack');
        expect(result.priority).toBe(75);
        expect(result.target?.shape).toBe('entity');
        expect(result.target?.entity?.id).toBe('meridian');
        expect(result.unmatched).toEqual([]);
    });

    it('resolves a group subject positioned before the verb', () => {
        const index = buildIndex([THIRD_ARMOURED, MERIDIAN]);
        const result = acceleratorFill('3rd armoured attack meridian high', index, VOCABULARY);
        expect(result.subject).toEqual({ type: 'group', groupId: 7 });
        expect(result.target?.entity?.id).toBe('meridian');
        expect(result.verb).toBe('attack');
        expect(result.priority).toBe(75);
    });

    it('"contested" borrows regionId from the resolved region-type target', () => {
        const index = buildIndex([NORTH_BASIN]);
        const result = acceleratorFill('defend north basin when contested', index, VOCABULARY);
        expect(result.verb).toBe('defend');
        expect(result.target?.entity?.id).toBe('north-basin');
        expect(result.when).toEqual({ type: 'region-contested', regionId: 'north-basin' });
    });

    it('does not fabricate a region-contested condition without a region-type target', () => {
        // Objective is a valid Target entity type but not region-like — the
        // condition must NOT be silently invented from a non-region target.
        const index = buildIndex([OBJECTIVE]);
        const result = acceleratorFill('secure radio tower when contested', index, VOCABULARY);
        expect(result.target?.entity?.id).toBe(3);
        expect(result.when).toBeNull();
    });

    it('fills "under attack" with no target needed', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('hold when under attack', index, VOCABULARY);
        expect(result.verb).toBe('hold');
        expect(result.when).toEqual({ type: 'under-attack' });
    });

    it('fills an idle-filter subject, canonicalised to the sim\'s ms_class', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('idle armour attack meridian', index, VOCABULARY);
        // "armour" is what the player says; `tanks` is what customparams
        // says. The slot carries the sim's word, never the player's.
        expect(result.subject).toEqual({ type: 'idle-filter', filterClass: 'tanks' });
        expect(result.subjectScale).toBeNull();
        expect(result.target?.entity?.id).toBe('meridian');
        expect(result.unmatched).toEqual([]);
    });

    it('resolves the class the old hand-kept list got wrong', () => {
        const index = buildIndex([MERIDIAN]);
        // IDLE_CLASSES shipped "statics"; the def's ms_class is
        // "staticdefense", so this used to fill a class the sim has no units of.
        const result = acceleratorFill('idle statics hold meridian', index, VOCABULARY);
        expect(result.subject).toEqual({ type: 'idle-filter', filterClass: 'staticdefense' });
    });

    it('fills a class the old hand-kept list never had', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('idle civilians withdraw meridian', index, VOCABULARY);
        expect(result.subject).toEqual({ type: 'idle-filter', filterClass: 'civilians' });
    });

    it('takes the longest class phrase and reports the scale it named', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('idle heavy tanks attack meridian', index, VOCABULARY);
        expect(result.subject).toEqual({ type: 'idle-filter', filterClass: 'tanks' });
        // Parse-only until the M1 envelope carries scale — surfaced, not
        // silently widened to "all tanks".
        expect(result.subjectScale).toBe(3);
        expect(result.unmatched).toEqual([]);
    });

    it('resolves a role that collapses to exactly one class', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('idle workers build meridian', index, VOCABULARY);
        expect(result.subject).toEqual({ type: 'idle-filter', filterClass: 'engineers' });
    });

    it('refuses to guess a branch of a multi-class role', () => {
        const index = buildIndex([MERIDIAN]);
        // "air defense" = staticdefense s2+ ∪ fighters. `filterClass` holds one
        // class, so picking one would be a guess — the words stay unclaimed
        // and visible instead (the M1 envelope carries roles properly).
        const result = acceleratorFill('idle air defense attack meridian', index, VOCABULARY);
        expect(result.subject).toBeNull();
        expect(result.unmatched).toEqual(['idle', 'air', 'defense']);
    });

    it('reports an unknown class instead of inventing one', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('idle zeppelins attack', index, VOCABULARY);
        expect(result.subject).toBeNull();
        expect(result.unmatched).toContain('zeppelins');
    });

    it('resolves no class at all against an empty vocabulary', () => {
        const index = buildIndex([MERIDIAN]);
        // No hidden built-in list: a game that ships no vocabulary loses
        // keyword class coverage rather than silently using stale constants.
        const result = acceleratorFill('idle tanks attack meridian', index, ClassVocabulary.empty());
        expect(result.subject).toBeNull();
        expect(result.unmatched).toEqual(['idle', 'tanks']);
        expect(result.verb).toBe('attack');
    });

    it('fills an ai subject', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('ai attack meridian urgent', index, VOCABULARY);
        expect(result.subject).toEqual({ type: 'ai' });
        expect(result.priority).toBe(100);
    });

    it('ignores unrecognised words rather than guessing, and reports them', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('attack somewhere-unknown please', index, VOCABULARY);
        expect(result.verb).toBe('attack');
        expect(result.target).toBeNull();
        expect(result.unmatched).toEqual(['somewhere-unknown', 'please']);
    });

    it('resolves a target with a filler word riding along, and reports the filler', () => {
        const index = buildIndex([NORTH_BASIN]);
        // The index matches by substring, so "north basin quickly" as one
        // query finds nothing — shorter spans are tried until one resolves.
        const result = acceleratorFill('defend north basin quickly', index, VOCABULARY);
        expect(result.target?.entity?.id).toBe('north-basin');
        expect(result.unmatched).toEqual(['quickly']);
    });

    it('prefers the longest matching name over a shorter one inside it', () => {
        const NORTH: NamedEntity = { id: 'north', type: 'region', name: 'North', x: 0, z: 0 };
        const index = buildIndex([NORTH, NORTH_BASIN]);
        const result = acceleratorFill('defend north basin', index, VOCABULARY);
        expect(result.target?.entity?.id).toBe('north-basin');
        expect(result.unmatched).toEqual([]);
    });

    it('never sets priority from a raw number (band words only)', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('attack 42', index, VOCABULARY);
        expect(result.priority).toBeNull();
        // "42" is not a recognised keyword — surfaced as unmatched, not
        // silently coerced into a priority value.
        expect(result.unmatched).toEqual(['42']);
    });

    it('does not confuse the verb "attack" with the "under attack" condition', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('attack meridian when under attack', index, VOCABULARY);
        expect(result.verb).toBe('attack');
        expect(result.when).toEqual({ type: 'under-attack' });
    });

    it('returns an empty result for blank input', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('   ', index, VOCABULARY);
        expect(result.verb).toBeNull();
        expect(result.subject).toBeNull();
        expect(result.target).toBeNull();
        expect(result.priority).toBeNull();
        expect(result.when).toBeNull();
        expect(result.unmatched).toEqual([]);
    });
});
