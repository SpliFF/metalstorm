/**
 * cost-preview.test.ts — Tests for command composer cost preview
 * (PLAN-metalstorm-scripting.md task 5) and Subject two-way sync (task 4).
 */

import { describe, it, expect } from 'vitest';
import {
    previewDirectiveCost,
    matchSelectionToGroup,
    type CostModelLike,
    type OrgGroupLike,
} from './cost-preview.js';

describe('previewDirectiveCost', () => {
    const group: OrgGroupLike = { groupId: 1, echelon: 'Platoon', memberIds: [10, 11], baseCostSum: 40 };

    // Mirrors authority-cost.js's real formula shape: ceil(base_k * baseCost * regionMod * classMod * costScale).
    function fakeModel(orderClass: Record<string, number>): CostModelLike {
        return {
            predict(p) {
                const classMod = orderClass[p.orderClassKey];
                if (classMod === undefined) return null;
                return Math.ceil(p.baseCost * p.regionMod * classMod * p.costScale);
            },
            canAfford(cost, playerPool, teamPool) {
                return playerPool + teamPool >= cost;
            },
        };
    }

    it('returns null for AIGuidance (advisory, never a spend)', () => {
        const model = fakeModel({ directive: 1.0, standing: 1.2 });
        expect(previewDirectiveCost('AIGuidance', group, model, 100, 100)).toBeNull();
    });

    it('returns null when the cost model has no spec loaded for the order class', () => {
        const model = fakeModel({}); // empty order_class table
        expect(previewDirectiveCost('GroupDirective', group, model, 100, 100)).toBeNull();
    });

    it('computes cost from the group roster under the directive class and reports affordable', () => {
        const model = fakeModel({ directive: 1.0 });
        const preview = previewDirectiveCost('GroupDirective', group, model, 30, 50);
        // ceil(40 * 1.0 * 1.0 * 1.0) = 40
        expect(preview).toEqual({ cost: 40, affordable: true, shortfall: 0 });
    });

    it('reports the exact shortfall when pools cannot cover the cost', () => {
        const model = fakeModel({ directive: 1.0 });
        const preview = previewDirectiveCost('GroupDirective', group, model, 5, 10);
        // ceil(40 * 1.0 * 1.0 * 1.0) = 40; have 15; short by 25
        expect(preview).toEqual({ cost: 40, affordable: false, shortfall: 25 });
    });

    it('rounds a fractional shortfall UP to whole authority (D49)', () => {
        // The pools are float32 rulesParam reads, so their sum is fractional and
        // carries float32 debris: this printed `short by 12.449996948242188` in
        // three player-facing strings. Ceil, not round: the number is displayed
        // as what you still need, and 27.55 short means 28 covers it while 27
        // leaves the order refused.
        const model = fakeModel({ directive: 1.0 });
        const preview = previewDirectiveCost('GroupDirective', group, model, 12.550003051757812, 0);
        expect(preview).toEqual({ cost: 40, affordable: false, shortfall: 28 });
    });

    it('charges a flat base=1 standing fee for a condition-scoped GroupDirective (no group)', () => {
        const model = fakeModel({ standing: 1.2 });
        const preview = previewDirectiveCost('GroupDirective', null, model, 100, 100);
        // ceil(1 * 1.0 * 1.2 * 1.0) = 2
        expect(preview).toEqual({ cost: 2, affordable: true, shortfall: 0 });
    });

    it('charges the same flat base=1 standing fee for a StandingOrder message', () => {
        const model = fakeModel({ standing: 1.2 });
        const preview = previewDirectiveCost('StandingOrder', null, model, 1, 0);
        // ceil(1 * 1.0 * 1.2 * 1.0) = 2; have 1; short by 1
        expect(preview).toEqual({ cost: 2, affordable: false, shortfall: 1 });
    });
});

describe('matchSelectionToGroup', () => {
    const groups: OrgGroupLike[] = [
        { groupId: 1, echelon: 'Platoon', memberIds: [10, 11, 12], baseCostSum: 30 },
        { groupId: 2, echelon: 'Squad', memberIds: [20, 21], baseCostSum: 10 },
    ];

    it('returns null for an empty selection', () => {
        expect(matchSelectionToGroup([], groups)).toBeNull();
    });

    it('matches a selection that is an exact set match for a group roster', () => {
        expect(matchSelectionToGroup([11, 10, 12], groups)).toBe(1);
        expect(matchSelectionToGroup([20, 21], groups)).toBe(2);
    });

    it('returns null for a partial overlap rather than guessing', () => {
        expect(matchSelectionToGroup([10, 11], groups)).toBeNull(); // subset of group 1
        expect(matchSelectionToGroup([10, 11, 12, 99], groups)).toBeNull(); // superset
    });

    it('returns null when the selection matches no group at all', () => {
        expect(matchSelectionToGroup([999], groups)).toBeNull();
    });
});
