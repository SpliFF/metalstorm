/**
 * focus-model.test.ts — the one source of truth for what the player is attending to
 * (DESIGN-DRILLDOWN.md §3)
 *
 * Four properties are load-bearing and all four are pinned here:
 *
 *  1. **Resolution names things.** A selection that matches a group's roster is
 *     that group, not N unit ids — every rung of the ladder and the whole NL
 *     layer read `subjects`, so a resolution that fell back to raw ids would
 *     put "6 units" where a name belongs.
 *  2. **Partial selections still name the group**, flagged partial. This is the
 *     rule that differs from `matchSelectionToGroup`'s exact-set match, and the
 *     difference is deliberate.
 *  3. **A selection change retracts the drill-down** — except for the kinds
 *     that were never about the selection (objectives, places).
 *  4. **`nlFocus()` ships names, never ids.** The envelope is name-addressed;
 *     an id leaking into the model's view of the world is a resolver bypass.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    FocusModel, bindSelectionToFocus, focusRefKey, resolveSelectionSubjects,
    type FocusGroupLike, type FocusRef, type FocusStoreLike,
} from './focus-model.js';

const groups: FocusGroupLike[] = [
    { groupId: 7, name: '3rd Tanks', memberIds: [10, 11, 12], currentDirectiveId: 0 },
    { groupId: 8, name: 'Raven Flight', memberIds: [20, 21], currentDirectiveId: 44 },
];

const objective: FocusRef = { kind: 'objective', id: 3, label: 'Hold Raven Basin' };

describe('resolveSelectionSubjects', () => {
    it('an exact roster resolves to the group, by name', () => {
        const subjects = resolveSelectionSubjects([10, 11, 12], groups);
        expect(subjects).toHaveLength(1);
        expect(subjects[0].kind).toBe('squad');
        expect(subjects[0].label).toBe('3rd Tanks');
        expect(subjects[0].data?.partial).toBe(false);
    });

    it('a partial roster still resolves to the group, marked partial', () => {
        // The rule the directive forces: a player who box-selected four of six
        // tanks is looking at 3rd Tanks. Telling them "4 units" is the
        // spreadsheet reading.
        const subjects = resolveSelectionSubjects([10, 11], groups);
        expect(subjects[0].label).toBe('3rd Tanks');
        expect(subjects[0].data).toMatchObject({
            partial: true, selectedCount: 2, rosterCount: 3,
        });
        expect(subjects[0].unitIds).toEqual([10, 11]);
    });

    it('a selection spanning groups yields one subject each, plus the strays', () => {
        const subjects = resolveSelectionSubjects([10, 20, 99], groups);
        expect(subjects.map((s) => s.label)).toEqual(['3rd Tanks', 'Raven Flight', 'Unit 99']);
        expect(subjects[2].kind).toBe('unit');
    });

    it('ungrouped units get a ref but no invented name', () => {
        const subjects = resolveSelectionSubjects([98, 99], groups);
        expect(subjects).toHaveLength(1);
        expect(subjects[0].label).toBe('2 units');
        expect(subjects[0].kind).toBe('unit');
    });

    it('the anonymous ref key is order-independent, so re-selecting is not a move', () => {
        const a = resolveSelectionSubjects([99, 98], groups)[0];
        const b = resolveSelectionSubjects([98, 99], groups)[0];
        expect(focusRefKey(a)).toBe(focusRefKey(b));
    });

    it('a group with a live directive reads as tasked', () => {
        expect(resolveSelectionSubjects([20, 21], groups)[0].data?.tasked).toBe(true);
        expect(resolveSelectionSubjects([10, 11, 12], groups)[0].data?.tasked).toBe(false);
    });

    it('an empty selection resolves to nothing at all', () => {
        expect(resolveSelectionSubjects([], groups)).toEqual([]);
    });

    it('an empty group never claims a selection', () => {
        // A group whose members all died has memberIds: []. `every()` on an
        // empty array is true, so a naive exact-match would claim ANY selection
        // for it — a phantom squad name over someone else's units.
        const withEmpty = [...groups, { groupId: 9, name: 'Ghosts', memberIds: [] }];
        expect(resolveSelectionSubjects([98], withEmpty).map((s) => s.label)).toEqual(['Unit 98']);
    });
});

describe('drill / collapse', () => {
    it('only one context panel is open at a time', () => {
        const model = new FocusModel();
        const a: FocusRef = { kind: 'squad', id: 7, label: '3rd Tanks' };
        const b: FocusRef = { kind: 'squad', id: 8, label: 'Raven Flight' };
        model.drill(a);
        model.drill(b);
        expect(model.isDrilled(a)).toBe(false);
        expect(model.isDrilled(b)).toBe(true);
    });

    it('collapse is idempotent and notifies only on a real change', () => {
        const model = new FocusModel();
        const seen: number[] = [];
        model.subscribe((s) => seen.push(s.drilled ? 1 : 0));
        model.collapse();                                  // nothing open
        expect(seen).toEqual([]);
        model.drill({ kind: 'squad', id: 7, label: '3rd Tanks' });
        model.collapse();
        model.collapse();
        expect(seen).toEqual([1, 0]);
    });

    it('a selection change closes a squad drill-down', () => {
        const model = new FocusModel();
        const squad = resolveSelectionSubjects([10, 11, 12], groups)[0];
        model.setSelection([10, 11, 12], [squad]);
        model.drill(squad);
        model.setSelection([20, 21], resolveSelectionSubjects([20, 21], groups));
        expect(model.getState().drilled).toBeNull();
    });

    it('a selection change does NOT close an objective drill-down', () => {
        // Story 2's panel is about an objective, not about what is selected;
        // closing it because the player clicked a squad would make the two
        // stories fight each other.
        const model = new FocusModel();
        model.drill(objective);
        model.setSelection([10, 11, 12], resolveSelectionSubjects([10, 11, 12], groups));
        expect(model.getState().drilled).toEqual(objective);
    });

    it('a re-resolution that still contains the drilled squad keeps it open', () => {
        const model = new FocusModel();
        model.setSelection([10, 11, 12], resolveSelectionSubjects([10, 11, 12], groups));
        model.drill(model.getState().subjects[0]);
        // Same group, one member lost — a new subject object, same identity.
        model.setSelection([10, 11], resolveSelectionSubjects([10, 11], groups));
        expect(model.getState().drilled?.label).toBe('3rd Tanks');
    });
});

describe('notification', () => {
    it('an identical selection does not notify', () => {
        const model = new FocusModel();
        const notify = vi.fn();
        model.subscribe(notify);
        model.setSelection([10], resolveSelectionSubjects([10], groups));
        model.setSelection([10], resolveSelectionSubjects([10], groups));
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('a roster shrinking under the same group DOES notify', () => {
        // Same unit ids would be the only thing an id-comparison sees; the
        // chip's "4/6" has to change, so ref shape is part of the comparison.
        const model = new FocusModel();
        const notify = vi.fn();
        model.setSelection([10, 11, 12], resolveSelectionSubjects([10, 11, 12], groups));
        model.subscribe(notify);
        model.setSelection([10, 11], resolveSelectionSubjects([10, 11], groups));
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('one throwing subscriber does not stop the others', () => {
        const model = new FocusModel();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const second = vi.fn();
        model.subscribe(() => { throw new Error('boom'); });
        model.subscribe(second);
        model.drill(objective);
        expect(second).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});

describe('surfaces', () => {
    it('records open panels in order and closes idempotently', () => {
        const model = new FocusModel();
        model.openSurface('objectives-panel');
        model.openSurface('objectives-panel');
        model.openSurface('scoreboard-panel');
        expect(model.getState().openSurfaces).toEqual(['objectives-panel', 'scoreboard-panel']);
        model.closeSurface('objectives-panel');
        model.closeSurface('objectives-panel');
        expect(model.getState().openSurfaces).toEqual(['scoreboard-panel']);
    });
});

describe('nlFocus — the story-4 read', () => {
    it('ships kinds and labels, never ids or positions', () => {
        const model = new FocusModel();
        model.setSelection([10, 11, 12], [{
            kind: 'squad', id: 7, label: '3rd Tanks',
            unitIds: [10, 11, 12], position: { x: 900, z: 1200 },
        }]);
        const focus = model.nlFocus();
        const serialised = JSON.stringify(focus);
        expect(serialised).toContain('3rd Tanks');
        expect(serialised).not.toContain('900');
        expect(serialised).not.toContain('"id"');
        expect(focus.selectionCount).toBe(3);
    });

    it('the pronoun antecedent is the drilled ref when there is one', () => {
        const model = new FocusModel();
        model.setSelection([10], resolveSelectionSubjects([10], groups));
        model.drill(objective);
        expect(model.nlFocus().primary).toEqual({ kind: 'objective', label: 'Hold Raven Basin' });
    });

    it('there is no antecedent when several subjects are selected', () => {
        // "pull them back" over two named groups has no single answer, and
        // inventing one is how a voice interface issues the wrong order.
        const model = new FocusModel();
        model.setSelection([10, 20], resolveSelectionSubjects([10, 20], groups));
        expect(model.nlFocus().primary).toBeNull();
        expect(model.nlFocus().subjects).toHaveLength(2);
    });
});

describe('bindSelectionToFocus', () => {
    function fakeStore(): FocusStoreLike & { fire(): void; unitIds: number[] } {
        const listeners: Array<() => void> = [];
        const store = {
            unitIds: [] as number[],
            subscribe(_paths: string[], cb: () => void) {
                listeners.push(cb);
                return () => { listeners.splice(listeners.indexOf(cb), 1); };
            },
            getSelection: () => ({ unitIds: store.unitIds }),
            getOrgGroups: () => groups,
            fire: () => { for (const l of [...listeners]) l(); },
        };
        return store;
    }

    it('resolves immediately, so a late binding is not a frame behind', () => {
        const store = fakeStore();
        store.unitIds = [10, 11, 12];
        const model = new FocusModel();
        bindSelectionToFocus(store, model);
        expect(model.getState().subjects[0].label).toBe('3rd Tanks');
    });

    it('re-resolves on an org-group change with the selection unmoved', () => {
        // Subscribing to `selection` alone would leave a renamed group showing
        // its old name until the player clicked elsewhere.
        const store = fakeStore();
        store.unitIds = [10, 11, 12];
        const model = new FocusModel();
        bindSelectionToFocus(store, model);
        groups[0].name = 'Hammerfall';
        store.fire();
        expect(model.getState().subjects[0].label).toBe('Hammerfall');
        groups[0].name = '3rd Tanks';
    });

    it('unsubscribing stops further resolution', () => {
        const store = fakeStore();
        const model = new FocusModel();
        const stop = bindSelectionToFocus(store, model);
        stop();
        store.unitIds = [10, 11, 12];
        store.fire();
        expect(model.getState().subjects).toEqual([]);
    });
});
