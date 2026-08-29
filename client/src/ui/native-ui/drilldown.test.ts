// @vitest-environment happy-dom
/**
 * drilldown.test.ts — the container primitive (DESIGN-DRILLDOWN.md §4)
 *
 * DOM assertions are blind to CSS, so this file does NOT try to prove the thing
 * looks right — the live screenshots in the step report do that. What it pins
 * is the behaviour the design depends on and that a future edit could quietly
 * break:
 *
 *  1. the rung-1 stat cap is ENFORCED, not just documented;
 *  2. at most one context panel is open, arbitrated by the focus model;
 *  3. Esc closes this and is swallowed, so it never also reaches main.ts's
 *     global handler and opens the quit dialog behind the closing panel;
 *  4. a collapsed drilldown holds no detail DOM;
 *  5. dispose leaves no document-level listener and no stale drill.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDrilldown, detailRow, detailReference, SUMMARY_MAX_STATS } from './drilldown.js';
import { FocusModel, type FocusRef } from './focus-model.js';
import { cameraPortHolder } from './camera-port.js';

const squad: FocusRef = {
    kind: 'squad', id: 7, label: '3rd Tanks', unitIds: [10, 11, 12],
};
const other: FocusRef = { kind: 'squad', id: 8, label: 'Raven Flight', unitIds: [20] };

let calls: Array<{ method: string; args: unknown[] }>;

beforeEach(() => {
    document.body.replaceChildren();
    calls = [];
    cameraPortHolder.install({
        call: (method, args) => calls.push({ method, args: args ?? [] }),
        pose: () => null,
    });
});

afterEach(() => cameraPortHolder.clear());

function make(overrides: Partial<Parameters<typeof createDrilldown>[0]> = {}) {
    const model = new FocusModel();
    const handle = createDrilldown({
        ref: squad,
        summary: () => ({ title: '3rd Tanks', state: 'idle', stats: [{ label: 'Units', value: '3' }] }),
        detail: (host) => { host.append(detailRow('Roster', '3 selected')); },
        model,
        ...overrides,
    });
    document.body.append(handle.el);
    return { handle, model };
}

const chipOf = (el: HTMLElement) => el.querySelector('.nui-dd__chip') as HTMLButtonElement;
const panelOf = (el: HTMLElement) => el.querySelector('.nui-dd__panel') as HTMLElement;

describe('rung 1 — the summary chip', () => {
    it('renders the name, the state word and the stats', () => {
        const { handle } = make();
        expect(handle.el.querySelector('.nui-dd__title')?.textContent).toBe('3rd Tanks');
        expect(handle.el.querySelector('.nui-dd__state')?.textContent).toBe('idle');
        expect(handle.el.querySelectorAll('.nui-dd__stat')).toHaveLength(1);
    });

    it('truncates past the stat cap and says so once', () => {
        // The directive's complaint is a UI that shows everything at once. A
        // cap that lives only in prose erodes one well-meaning field at a time.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { handle } = make({
            summary: () => ({
                title: '3rd Tanks',
                stats: Array.from({ length: 6 }, (_, i) => ({ label: `s${i}`, value: String(i) })),
            }),
        });
        expect(handle.el.querySelectorAll('.nui-dd__stat')).toHaveLength(SUMMARY_MAX_STATS);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('hides the state slot rather than leaving an empty pill', () => {
        const { handle } = make({ summary: () => ({ title: '3rd Tanks' }) });
        expect((handle.el.querySelector('.nui-dd__state') as HTMLElement).hidden).toBe(true);
    });

    it('carries a go-there affordance when the ref is travellable', () => {
        const { handle } = make();
        const go = handle.el.querySelector('.nui-go-there') as HTMLButtonElement;
        expect(go).not.toBeNull();
        expect(go.disabled).toBe(false);
    });

    it('omits the affordance entirely for a ref with nowhere to go', () => {
        const { handle } = make({ ref: { kind: 'area', id: 'nowhere', label: 'Nowhere' } });
        expect(handle.el.querySelector('.nui-go-there')).toBeNull();
    });

    it('go-there does not also toggle the chip it sits next to', () => {
        const { handle } = make();
        (handle.el.querySelector('.nui-go-there') as HTMLButtonElement).click();
        expect(handle.isExpanded()).toBe(false);
        expect(calls[0].method).toBe('cameraSnapToUnit');
    });
});

describe('rung 2 — the context panel', () => {
    it('a click expands, and drives the focus model', () => {
        const { handle, model } = make();
        chipOf(handle.el).click();
        expect(handle.isExpanded()).toBe(true);
        expect(panelOf(handle.el).hidden).toBe(false);
        expect(model.isDrilled(squad)).toBe(true);
        expect(chipOf(handle.el).getAttribute('aria-expanded')).toBe('true');
    });

    it('holds no detail DOM while collapsed', () => {
        const { handle } = make();
        expect(handle.el.querySelector('.nui-dd__fact')).toBeNull();
        chipOf(handle.el).click();
        expect(handle.el.querySelector('.nui-dd__fact')).not.toBeNull();
        chipOf(handle.el).click();
        expect(handle.el.querySelector('.nui-dd__fact')).toBeNull();
    });

    it('opening a second drilldown closes the first', () => {
        // Two open panels is a dashboard, and a dashboard is the spreadsheet.
        const model = new FocusModel();
        const a = createDrilldown({
            ref: squad, model,
            summary: () => ({ title: 'A' }), detail: () => {},
        });
        const b = createDrilldown({
            ref: other, model,
            summary: () => ({ title: 'B' }), detail: () => {},
        });
        document.body.append(a.el, b.el);
        a.expand();
        b.expand();
        expect(a.isExpanded()).toBe(false);
        expect(b.isExpanded()).toBe(true);
    });

    it('the model losing the drill closes the panel', () => {
        // e.g. a selection change under an open squad panel.
        const { handle, model } = make();
        handle.expand();
        model.collapse();
        expect(handle.isExpanded()).toBe(false);
    });

    it('refresh re-reads the detail while open and only the summary while closed', () => {
        let n = 0;
        const detail = vi.fn((host: HTMLElement) => { host.textContent = `detail ${n}`; });
        const { handle } = make({ summary: () => ({ title: `T${n}` }), detail });
        n = 1;
        handle.refresh();
        expect(handle.el.querySelector('.nui-dd__title')?.textContent).toBe('T1');
        expect(detail).not.toHaveBeenCalled();
        handle.expand();
        n = 2;
        handle.refresh();
        expect(handle.el.querySelector('.nui-dd__body')?.textContent).toBe('detail 2');
    });
});

describe('rung 3 — actions', () => {
    it('renders the action row last, and runs the action', () => {
        const run = vi.fn();
        const { handle } = make({
            actions: () => [{ id: 'halt', label: 'Halt', run }],
        });
        handle.expand();
        const panel = panelOf(handle.el);
        expect(panel.lastElementChild?.className).toContain('nui-dd__actions');
        (panel.querySelector('[data-action-id="halt"]') as HTMLButtonElement).click();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('a disabled action carries the reason as its tooltip', () => {
        // A greyed button with no explanation is the same dead end as a button
        // that silently does nothing.
        const { handle } = make({
            actions: () => [{
                id: 'halt', label: 'Halt', disabled: true,
                hint: 'Nothing selected to halt', run: () => {},
            }],
        });
        handle.expand();
        const btn = handle.el.querySelector('[data-action-id="halt"]') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.title).toBe('Nothing selected to halt');
    });

    it('hides the action row when there are no actions', () => {
        const { handle } = make();
        handle.expand();
        expect((handle.el.querySelector('.nui-dd__actions') as HTMLElement).hidden).toBe(true);
    });
});

describe('escape', () => {
    it('closes the open panel and is swallowed before the global handler', () => {
        const globalEsc = vi.fn();
        window.addEventListener('keydown', globalEsc);      // stands in for main.ts's
        const { handle } = make();
        handle.expand();
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect(handle.isExpanded()).toBe(false);
        expect(globalEsc).not.toHaveBeenCalled();
        window.removeEventListener('keydown', globalEsc);
    });

    it('is left alone while collapsed, so Esc still quits', () => {
        const globalEsc = vi.fn();
        window.addEventListener('keydown', globalEsc);
        make();
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect(globalEsc).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', globalEsc);
    });
});

describe('dispose', () => {
    it('drops the keydown listener, the drill and the DOM', () => {
        const globalEsc = vi.fn();
        const { handle, model } = make();
        handle.expand();
        handle.dispose();
        expect(model.getState().drilled).toBeNull();
        expect(handle.el.isConnected).toBe(false);

        window.addEventListener('keydown', globalEsc);
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        expect(globalEsc).toHaveBeenCalledTimes(1);   // nothing swallowed it
        window.removeEventListener('keydown', globalEsc);
    });

    it('is idempotent', () => {
        const { handle } = make();
        handle.dispose();
        expect(() => handle.dispose()).not.toThrow();
    });
});

describe('detail helpers', () => {
    it('detailRow renders a labelled fact', () => {
        const row = detailRow('Roster', '3 of 6 selected');
        expect(row.querySelector('.nui-dd__fact-label')?.textContent).toBe('Roster');
        expect(row.querySelector('.nui-dd__fact-value')?.textContent).toBe('3 of 6 selected');
    });

    it('detailReference travels on the ground-anchored op', () => {
        const row = detailReference('Near', { x: 900, z: 1200 }, { note: 'Raven Basin' });
        document.body.append(row);
        (row.querySelector('.nui-go-there') as HTMLButtonElement).click();
        expect(calls[0].method).toBe('cameraSnapToGround');
        expect(calls[0].args.slice(0, 2)).toEqual([900, 1200]);
    });
});
