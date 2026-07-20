import { describe, it, expect } from 'vitest';
import { DefCache } from './def-cache.js';
import type { UnitDefInfo, WeaponDefInfo } from './connection.js';

// PLAN-quickstart.md §3.2 (Part B — resync): reconnect creates a fresh
// server-side ClientSession, so it re-streams defs the client already has.
// DefCache must accept duplicate pushes as a no-op — notifying listeners ONLY
// for genuinely new ids — so a resync doesn't re-trigger model reloads for
// every already-known def. These tests lock that idempotency.

const unit = (defId: number): UnitDefInfo => ({ defId } as unknown as UnitDefInfo);
const weap = (defId: number): WeaponDefInfo => ({ defId } as unknown as WeaponDefInfo);

describe('DefCache idempotency (resync duplicate-push)', () => {
    it('notifies once for a new unit def, not again on a duplicate push', () => {
        const cache = new DefCache();
        const seen: number[][] = [];
        cache.onUnitDefs((defs) => seen.push(defs.map((d) => d.defId)));

        cache.addUnitDefs([unit(1), unit(2)]);
        cache.addUnitDefs([unit(1), unit(2)]);   // full duplicate — a resync re-push
        cache.addUnitDefs([unit(2), unit(3)]);   // partial overlap

        // First push: [1,2]. Second push: no callback (all known). Third: [3].
        expect(seen).toEqual([[1, 2], [3]]);
        expect(cache.getAllUnitDefs().map((d) => d.defId).sort()).toEqual([1, 2, 3]);
    });

    it('keeps the first-seen def object on a duplicate id (accept + no-op)', () => {
        const cache = new DefCache();
        const first = unit(5);
        const second = unit(5);
        cache.addUnitDefs([first]);
        cache.addUnitDefs([second]);
        expect(cache.getUnitDef(5)).toBe(first);   // not replaced by the dup
    });

    it('applies the same idempotency to weapon defs', () => {
        const cache = new DefCache();
        const seen: number[][] = [];
        cache.onWeaponDefs((defs) => seen.push(defs.map((d) => d.defId)));
        cache.addWeaponDefs([weap(10)]);
        cache.addWeaponDefs([weap(10)]);
        cache.addWeaponDefs([weap(10), weap(11)]);
        expect(seen).toEqual([[10], [11]]);
    });
});
