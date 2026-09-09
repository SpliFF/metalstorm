// @vitest-environment happy-dom
/**
 * focus-kinds.test.ts — hud-drilldown review (2026-09-10): the focus model's
 * hostile split, the hover channel, and the census re-resolve hook.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    FocusModel, bindSelectionToFocus, focusModel, refocusSelection,
    resolveSelectionSubjects, type FocusRef,
} from './focus-model.js';

const groups = [{ groupId: 7, name: '3rd Tanks', memberIds: [10, 11, 12], currentDirectiveId: 0 }];

describe('resolveSelectionSubjects — hostile units', () => {
    it('splits enemy units out of the loose remainder as an enemy-force ref', () => {
        const subjects = resolveSelectionSubjects([10, 11, 12, 40, 41, 50], groups, {
            isHostile: (id) => id >= 40 && id < 50,
        });
        expect(subjects.map((s) => s.kind)).toEqual(['squad', 'unit', 'enemy-force']);
        const enemy = subjects[2];
        expect(enemy.unitIds).toEqual([40, 41]);
        expect(enemy.label).toBe('2 enemy units');
        expect(enemy.data?.hostile).toBe(true);
        expect(subjects[1].unitIds).toEqual([50]);
    });

    it('a single enemy unit is "Enemy unit", and no isHostile means nothing is hostile', () => {
        const [only] = resolveSelectionSubjects([40], [], { isHostile: () => true });
        expect(only.kind).toBe('enemy-force');
        expect(only.label).toBe('Enemy unit');
        const [plain] = resolveSelectionSubjects([40], []);
        expect(plain.kind).toBe('unit');
    });

    it('nlFocus names an enemy force by kind and label only', () => {
        const model = new FocusModel();
        model.setSelection([40, 41], resolveSelectionSubjects([40, 41], [], { isHostile: () => true }));
        expect(model.nlFocus().primary).toEqual({ kind: 'enemy-force', label: '2 enemy units' });
    });
});

describe('hover — the weakest focus', () => {
    const tanks: FocusRef = { kind: 'squad', id: 7, label: '3rd Tanks' };
    const flight: FocusRef = { kind: 'squad', id: 8, label: 'Raven Flight' };

    it('is reported by nlFocus and never promoted to primary', () => {
        const model = new FocusModel();
        model.hover(tanks);
        expect(model.getHovered()).toBe(tanks);
        expect(model.nlFocus().hovered).toEqual({ kind: 'squad', label: '3rd Tanks' });
        expect(model.nlFocus().primary).toBeNull();
    });

    it('does NOT notify the main subscribers — hover must not redraw the HUD', () => {
        const model = new FocusModel();
        const main = vi.fn();
        const hover = vi.fn();
        model.subscribe(main);
        model.subscribeHover(hover);
        model.hover(tanks);
        model.hover(tanks);              // same ref: no second notification
        model.unhover(tanks);
        expect(main).not.toHaveBeenCalled();
        expect(hover).toHaveBeenCalledTimes(2);
        expect(model.getHovered()).toBeNull();
    });

    it('a late mouseleave from the old chip cannot clear the neighbour\'s hover', () => {
        const model = new FocusModel();
        model.hover(tanks);
        model.hover(flight);
        model.unhover(tanks);            // the stale leave
        expect(model.getHovered()).toBe(flight);
        model.unhover();                 // unscoped: clears whatever is there
        expect(model.getHovered()).toBeNull();
    });

    it('clear() drops the hover too', () => {
        const model = new FocusModel();
        model.hover(tanks);
        model.clear();
        expect(model.getHovered()).toBeNull();
    });
});

describe('refocusSelection — re-resolving when the census lands', () => {
    it('re-runs the SESSION binding with the resolvers\' current answer', () => {
        let hostile = false;
        const store = {
            subscribe: () => () => {},
            getSelection: () => ({ unitIds: [40] }),
            getOrgGroups: () => [],
        };
        const stop = bindSelectionToFocus(store, focusModel, { isHostile: () => hostile });
        expect(focusModel.getState().subjects[0].kind).toBe('unit');

        hostile = true;                  // the census answered
        refocusSelection();
        expect(focusModel.getState().subjects[0].kind).toBe('enemy-force');

        stop();
        hostile = false;
        refocusSelection();              // unbound: a no-op, not a stale re-resolve
        expect(focusModel.getState().subjects[0].kind).toBe('enemy-force');
        focusModel.clear();
    });

    it('keeps an AI drill open across a selection change', () => {
        const model = new FocusModel();
        model.drill({ kind: 'ai', id: 0, label: 'Strategos' });
        model.setSelection([10], resolveSelectionSubjects([10], groups));
        expect(model.getState().drilled?.kind).toBe('ai');
    });
});
