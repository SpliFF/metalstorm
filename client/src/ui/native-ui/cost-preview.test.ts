/**
 * cost-preview.test.ts — Tests for command composer cost preview
 * (PLAN-metalstorm-scripting.md task 5) and Subject two-way sync (task 4).
 */

import { describe, it, expect } from 'vitest';
import {
    orderClassForEchelon,
    previewDirectiveCost,
    matchSelectionToGroup,
    type CostModelLike,
    type OrgGroupLike,
} from './cost-preview.js';

describe('orderClassForEchelon', () => {
    it('maps Army to the directive rate', () => {
        expect(orderClassForEchelon('Army')).toBe('directive');
    });

    it('maps Platoon to the group_op rate', () => {
        expect(orderClassForEchelon('Platoon')).toBe('group_op');
    });

    it('falls back Squad to group_op (v0 has no dedicated squad-directive rate)', () => {
        expect(orderClassForEchelon('Squad')).toBe('group_op');
    });
});

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

    it('returns null for non-GroupDirective compiled messages', () => {
        const model = fakeModel({ group_op: 0.5 });
        expect(previewDirectiveCost('StandingOrder', group, model, 100, 100)).toBeNull();
        expect(previewDirectiveCost('AIGuidance', group, model, 100, 100)).toBeNull();
    });

    it('returns null when there is no matching org group (idle-filter/unresolved subject)', () => {
        const model = fakeModel({ group_op: 0.5 });
        expect(previewDirectiveCost('GroupDirective', null, model, 100, 100)).toBeNull();
    });

    it('returns null when the cost model has no spec loaded for the order class', () => {
        const model = fakeModel({}); // empty order_class table
        expect(previewDirectiveCost('GroupDirective', group, model, 100, 100)).toBeNull();
    });

    it('computes cost using the group echelon order class and reports affordable', () => {
        const model = fakeModel({ group_op: 0.5 });
        const preview = previewDirectiveCost('GroupDirective', group, model, 30, 50);
        // ceil(40 * 1.0 * 0.5 * 1.0) = 20
        expect(preview).toEqual({ cost: 20, affordable: true, shortfall: 0 });
    });

    it('reports the exact shortfall when pools cannot cover the cost', () => {
        const armyGroup: OrgGroupLike = { ...group, echelon: 'Army' };
        const model = fakeModel({ directive: 1.0 });
        const preview = previewDirectiveCost('GroupDirective', armyGroup, model, 5, 10);
        // ceil(40 * 1.0 * 1.0 * 1.0) = 40; have 15; short by 25
        expect(preview).toEqual({ cost: 40, affordable: false, shortfall: 25 });
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
