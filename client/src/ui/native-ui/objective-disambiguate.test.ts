/**
 * objective-disambiguate.test.ts — the duplicate-title defect U1 recorded and
 * U2/U3/U4 each left open: three "Hold Raven Basin" on one stack.
 */

import { describe, it, expect } from 'vitest';
import { disambiguateTitles, type ObjectiveRecord } from './objective-model.js';

const rec = (over: Partial<ObjectiveRecord> & { id: number }): ObjectiveRecord =>
    ({ type: 'control', region: 'basin', ...over }) as ObjectiveRecord;

const title = (o: ObjectiveRecord) => `Hold ${o.region}`;

describe('disambiguateTitles', () => {
    it('leaves unique titles alone', () => {
        const q = disambiguateTitles([rec({ id: 1 }), rec({ id: 2, region: 'ridge' })], title);
        expect(q.size).toBe(0);
    });

    it('names the victory objective and qualifies the rest by reward', () => {
        // crossing_standoff's real case: one scripted victory ⬡300 and two
        // generated control objectives ⬡115 on the same region.
        const q = disambiguateTitles([
            rec({ id: 1, victory: 1, reward: 300, source: 'scripted' }),
            rec({ id: 2, reward: 115, source: 'systemic' }),
            rec({ id: 3, reward: 115, source: 'systemic' }),
        ], title);
        expect(q.get(1)).toBe('(victory)');
        // Same origin and same reward: only an ordinal separates them.
        expect(q.get(2)).toBe('(#1)');
        expect(q.get(3)).toBe('(#2)');
    });

    it('prefers origin, then reward, then ordinal', () => {
        const byOrigin = disambiguateTitles([
            rec({ id: 1, source: 'scripted' }), rec({ id: 2, source: 'bounty' }),
        ], title);
        expect(byOrigin.get(1)).toBe('(scripted)');
        expect(byOrigin.get(2)).toBe('(bounty)');

        const byReward = disambiguateTitles([
            rec({ id: 1, source: 'systemic', reward: 80 }), rec({ id: 2, source: 'systemic', reward: 120 }),
        ], title);
        expect(byReward.get(1)).toBe('(⬡80)');
        expect(byReward.get(2)).toBe('(⬡120)');
    });

    it('is stable in id order regardless of input order', () => {
        const a = disambiguateTitles([rec({ id: 9 }), rec({ id: 4 })], title);
        const b = disambiguateTitles([rec({ id: 4 }), rec({ id: 9 })], title);
        expect(a.get(4)).toBe('(#1)');
        expect(b.get(4)).toBe('(#1)');
        expect(a.get(9)).toBe('(#2)');
    });
});
