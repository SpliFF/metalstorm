/**
 * free-text-accelerator.test.ts — Tests for the command-composer keyword
 * accelerator (PLAN-metalstorm-scripting.md task 7)
 */

import { describe, it, expect } from 'vitest';
import { acceleratorFill, type AcceleratorSearchIndex } from './free-text-accelerator.js';
import type { NamedEntity } from './named-entity-index.js';
import { NamedEntityIndex } from './named-entity-index.js';

function buildIndex(entities: NamedEntity[]): AcceleratorSearchIndex {
    const idx = new NamedEntityIndex();
    for (const e of entities) idx.add(e);
    return idx;
}

const MERIDIAN: NamedEntity = { id: 'meridian', type: 'city', name: 'Meridian City', x: 100, z: 200 };
const NORTH_BASIN: NamedEntity = { id: 'north-basin', type: 'region', name: 'North Basin', x: 10, z: 20 };
const THIRD_ARMOURED: NamedEntity = { id: 7, type: 'group', name: '3rd Armoured', x: 0, z: 0 };
const OBJECTIVE: NamedEntity = { id: 3, type: 'objective', name: 'Radio Tower', x: 5, z: 5 };

describe('acceleratorFill', () => {
    it('fills verb + target + priority from the plan\'s own worked example (§2)', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('attack meridian high', index);
        expect(result.verb).toBe('attack');
        expect(result.priority).toBe(75);
        expect(result.target?.shape).toBe('entity');
        expect(result.target?.entity?.id).toBe('meridian');
        expect(result.unmatched).toEqual([]);
    });

    it('resolves a group subject positioned before the verb', () => {
        const index = buildIndex([THIRD_ARMOURED, MERIDIAN]);
        const result = acceleratorFill('3rd armoured attack meridian high', index);
        expect(result.subject).toEqual({ type: 'group', groupId: 7 });
        expect(result.target?.entity?.id).toBe('meridian');
        expect(result.verb).toBe('attack');
        expect(result.priority).toBe(75);
    });

    it('"contested" borrows regionId from the resolved region-type target', () => {
        const index = buildIndex([NORTH_BASIN]);
        const result = acceleratorFill('defend north basin when contested', index);
        expect(result.verb).toBe('defend');
        expect(result.target?.entity?.id).toBe('north-basin');
        expect(result.when).toEqual({ type: 'region-contested', regionId: 'north-basin' });
    });

    it('does not fabricate a region-contested condition without a region-type target', () => {
        // Objective is a valid Target entity type but not region-like — the
        // condition must NOT be silently invented from a non-region target.
        const index = buildIndex([OBJECTIVE]);
        const result = acceleratorFill('secure radio tower when contested', index);
        expect(result.target?.entity?.id).toBe(3);
        expect(result.when).toBeNull();
    });

    it('fills "under attack" with no target needed', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('hold when under attack', index);
        expect(result.verb).toBe('hold');
        expect(result.when).toEqual({ type: 'under-attack' });
    });

    it('fills an idle-filter subject from the closed class vocabulary', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('idle armour attack meridian', index);
        expect(result.subject).toEqual({ type: 'idle-filter', filterClass: 'armour' });
        expect(result.target?.entity?.id).toBe('meridian');
    });

    it('fills an ai subject', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('ai attack meridian urgent', index);
        expect(result.subject).toEqual({ type: 'ai' });
        expect(result.priority).toBe(100);
    });

    it('ignores unrecognised words rather than guessing, and reports them', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('attack somewhere-unknown please', index);
        expect(result.verb).toBe('attack');
        expect(result.target).toBeNull();
        expect(result.unmatched).toEqual(['somewhere-unknown', 'please']);
    });

    it('never sets priority from a raw number (band words only)', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('attack 42', index);
        expect(result.priority).toBeNull();
        // "42" is not a recognised keyword — surfaced as unmatched, not
        // silently coerced into a priority value.
        expect(result.unmatched).toEqual(['42']);
    });

    it('does not confuse the verb "attack" with the "under attack" condition', () => {
        const index = buildIndex([MERIDIAN]);
        const result = acceleratorFill('attack meridian when under attack', index);
        expect(result.verb).toBe('attack');
        expect(result.when).toEqual({ type: 'under-attack' });
    });

    it('returns an empty result for blank input', () => {
        const index = buildIndex([]);
        const result = acceleratorFill('   ', index);
        expect(result.verb).toBeNull();
        expect(result.subject).toBeNull();
        expect(result.target).toBeNull();
        expect(result.priority).toBeNull();
        expect(result.when).toBeNull();
        expect(result.unmatched).toEqual([]);
    });
});
