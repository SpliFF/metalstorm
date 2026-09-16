// @vitest-environment happy-dom
/**
 * hud.test.ts — `updateHUD` runs at frame rate from the scene-state message;
 * it must not touch the DOM when nothing it reports has changed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { updateHUD, selectionReadout, resetHUDWriteCache } from './hud.js';

function mountReadouts() {
    document.body.innerHTML =
        '<span id="hud-entities"></span><span id="hud-frame"></span><span id="hud-selected"></span>';
    resetHUDWriteCache();
}

describe('updateHUD write discipline', () => {
    beforeEach(mountReadouts);

    it('formats the selection readout', () => {
        expect(selectionReadout([])).toBe('No selection');
        expect(selectionReadout([42])).toBe('Selected: unit 42');
        expect(selectionReadout([1, 2, 3])).toBe('Selected: 3 units');
    });

    it('writes once, then not again for identical input', () => {
        // The element is looked up only when a write is about to happen, so
        // the lookup count IS the write count.
        const lookups = vi.spyOn(document, 'getElementById');
        const selectedLookups = () =>
            lookups.mock.calls.filter(([id]) => id === 'hud-selected').length;

        updateHUD(10, 1, [42]);
        updateHUD(10, 2, [42]);        // frame moved; selection did not
        updateHUD(10, 3, [42]);
        expect(selectedLookups()).toBe(1);
        expect(document.getElementById('hud-selected')!.textContent).toBe('Selected: unit 42');
        lookups.mockClear();

        updateHUD(10, 4, [42, 43]);
        expect(selectedLookups()).toBe(1);
        lookups.mockRestore();
    });

    it('survives a missing element without caching a write it never made', () => {
        document.body.innerHTML = '';
        resetHUDWriteCache();
        expect(() => updateHUD(1, 1, [])).not.toThrow();
        mountReadouts();
        updateHUD(1, 1, []);
        expect(document.getElementById('hud-selected')!.textContent).toBe('No selection');
    });
});
