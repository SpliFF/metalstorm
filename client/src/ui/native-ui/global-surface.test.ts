// @vitest-environment happy-dom
/**
 * global-surface.test.ts — the ONE access point (DESIGN-DRILLDOWN.md §6)
 *
 * The rules worth pinning are the ones that make it "one access point" rather
 * than "a sixth panel": a tab onto nothing never renders, an access point with
 * nothing behind it never renders, Esc closes THIS and does not also reach
 * main.ts's quit dialog, and the surface leaves the DOM state it found.
 *
 * DOM assertions are blind to CSS — the live screenshots are the evidence for
 * appearance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    GLOBAL_TABS, GLOBAL_SURFACE_ID, globalSurface, parseMenuMount,
} from './global-surface.js';
import { focusModel } from './focus-model.js';
import { uiActionRegistry } from './ui-action-registry.js';

let dock: HTMLElement;
let host: HTMLElement;

beforeEach(() => {
    dock = document.createElement('div');
    host = document.createElement('div');
    document.body.append(dock, host);
    focusModel.clear();
});

afterEach(() => {
    globalSurface.dispose();
    dock.parentElement?.removeChild(dock);
    host.parentElement?.removeChild(host);
});

describe('the manifest seam', () => {
    it('reads a menu mount and refuses an unknown tab', () => {
        expect(parseMenuMount('menu:events')).toBe('events');
        expect(parseMenuMount('menu:pineapple')).toBeNull();
        expect(parseMenuMount('right')).toBeNull();
    });

    it('offers a pane per declared tab', () => {
        globalSurface.mount(dock, host);
        for (const tab of GLOBAL_TABS) {
            expect(globalSurface.paneFor(tab.id), tab.id).toBeTruthy();
        }
    });
});

describe('a tab onto nothing is a dead end', () => {
    it('hides every tab whose pane is empty', () => {
        globalSurface.mount(dock, host);
        globalSurface.settle();
        const shown = [...host.querySelectorAll('.nui-global__tab')]
            .filter((b) => !(b as HTMLButtonElement).hidden);
        expect(shown).toHaveLength(0);
    });

    it('hides the ACCESS POINT itself when nothing folded in', () => {
        // A button that opens an empty window is exactly the "the UI is broken"
        // signal this framework exists to remove.
        globalSurface.mount(dock, host);
        globalSurface.settle();
        expect((dock.querySelector('.nui-access__btn') as HTMLButtonElement).hidden).toBe(true);
    });

    it('shows a tab once a widget has mounted into its pane', () => {
        globalSurface.mount(dock, host);
        globalSurface.paneFor('events')!.append(document.createElement('div'));
        globalSurface.settle();

        const events = host.querySelector('.nui-global__tab[data-tab="events"]') as HTMLButtonElement;
        expect(events.hidden).toBe(false);
        expect((host.querySelector('.nui-global__tab[data-tab="reports"]') as HTMLButtonElement).hidden)
            .toBe(true);
        expect((dock.querySelector('.nui-access__btn') as HTMLButtonElement).hidden).toBe(false);
    });
});

describe('opening and closing', () => {
    beforeEach(() => {
        globalSurface.mount(dock, host);
        globalSurface.paneFor('events')!.append(document.createElement('div'));
        globalSurface.paneFor('objectives')!.append(document.createElement('div'));
        globalSurface.settle();
    });

    it('is closed at rest, and shows ONE pane when opened', () => {
        expect((host.querySelector('.nui-global') as HTMLElement).hidden).toBe(true);
        globalSurface.open('objectives');
        expect(globalSurface.isOpen()).toBe(true);
        const visible = [...host.querySelectorAll('.nui-global__pane')]
            .filter((p) => !(p as HTMLElement).hidden)
            .map((p) => (p as HTMLElement).dataset.tab);
        expect(visible).toEqual(['objectives']);
    });

    it('records itself on the focus model, so "close that" has a referent', () => {
        globalSurface.open('events');
        expect(focusModel.getState().openSurfaces).toContain(GLOBAL_SURFACE_ID);
        globalSurface.close();
        expect(focusModel.getState().openSurfaces).not.toContain(GLOBAL_SURFACE_ID);
    });

    it('toggles on Tab and closes on Esc, consuming BOTH', () => {
        // The consumption is the point: main.ts has a global Escape handler
        // that opens the quit dialog, and a surface that closes AND quits is
        // worse than one that does neither.
        const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
        document.dispatchEvent(tab);
        expect(globalSurface.isOpen()).toBe(true);
        expect(tab.defaultPrevented).toBe(true);

        const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        document.dispatchEvent(esc);
        expect(globalSurface.isOpen()).toBe(false);
        expect(esc.defaultPrevented).toBe(true);
    });

    it('leaves Escape alone while closed, so Esc still quits', () => {
        const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        document.dispatchEvent(esc);
        expect(esc.defaultPrevented).toBe(false);
    });

    it('never swallows Tab from a text field', () => {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
        input.dispatchEvent(tab);
        expect(globalSurface.isOpen()).toBe(false);
        expect(tab.defaultPrevented).toBe(false);
        input.parentElement?.removeChild(input);
    });

    it('is addressable by name, so a sentence reaches the TAB', () => {
        const result = uiActionRegistry.apply('open', 'diplomacy');
        expect(result.ok).toBe(true);
        expect(globalSurface.isOpen()).toBe(true);
    });
});

describe('the one permitted always-visible line', () => {
    beforeEach(() => {
        globalSurface.mount(dock, host);
        globalSurface.paneFor('objectives')!.append(document.createElement('div'));
        globalSurface.settle();
    });

    it('is hidden until something fills it', () => {
        expect((dock.querySelector('.nui-access__summary') as HTMLElement).hidden).toBe(true);
    });

    it('shows the victory state and drills into the objectives', () => {
        globalSurface.setSummaryLine('Raven Basin: contested — hold clock resets');
        const line = dock.querySelector('.nui-access__summary') as HTMLButtonElement;
        expect(line.hidden).toBe(false);
        expect(line.textContent).toContain('contested');
        line.click();
        expect(globalSurface.isOpen()).toBe(true);
    });

    it('hides again rather than saying nothing', () => {
        globalSurface.setSummaryLine('something');
        globalSurface.setSummaryLine(null);
        expect((dock.querySelector('.nui-access__summary') as HTMLElement).hidden).toBe(true);
    });
});

describe('lifetime', () => {
    it('leaves nothing behind, and unbinds its keys', () => {
        globalSurface.mount(dock, host);
        globalSurface.paneFor('events')!.append(document.createElement('div'));
        globalSurface.settle();
        globalSurface.dispose();

        expect(dock.querySelectorAll('.nui-access')).toHaveLength(0);
        expect(host.querySelectorAll('.nui-global')).toHaveLength(0);
        const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true });
        document.dispatchEvent(tab);
        expect(tab.defaultPrevented).toBe(false);
        expect(globalSurface.isOpen()).toBe(false);
    });
});
