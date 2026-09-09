// @vitest-environment happy-dom
/**
 * drilldown-keyboard.test.ts — hud-drilldown review (2026-09-10): Esc returns
 * focus to the chip that opened the panel, chips report hover, and a chip
 * names the panel it discloses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDrilldown, detailRow } from './drilldown.js';
import { FocusModel, type FocusRef } from './focus-model.js';
import { cameraPortHolder } from './camera-port.js';

const squad: FocusRef = { kind: 'squad', id: 7, label: '3rd Tanks', unitIds: [10] };

beforeEach(() => {
    document.body.replaceChildren();
    cameraPortHolder.install({ call: () => {}, pose: () => null });
});
afterEach(() => cameraPortHolder.clear());

function make() {
    const model = new FocusModel();
    const handle = createDrilldown({
        ref: squad,
        model,
        summary: () => ({ title: '3rd Tanks' }),
        detail: (host) => { host.append(detailRow('Roster', '1')); },
        actions: () => [{ id: 'halt', label: 'Halt', run: () => {} }],
    });
    document.body.append(handle.el);
    const chip = handle.el.querySelector('.nui-dd__chip') as HTMLButtonElement;
    return { handle, model, chip };
}

const esc = () => new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });

describe('Esc and keyboard focus', () => {
    it('returns focus to the chip when Esc closes a panel the player had tabbed into', () => {
        const { handle, chip } = make();
        chip.click();
        const action = handle.el.querySelector('[data-action-id="halt"]') as HTMLButtonElement;
        action.focus();
        expect(document.activeElement).toBe(action);

        document.dispatchEvent(esc());
        expect(handle.isExpanded()).toBe(false);
        expect(document.activeElement).toBe(chip);
    });

    it('leaves focus alone when it was never inside the panel', () => {
        const { handle } = make();
        handle.expand();
        const elsewhere = document.createElement('button');
        document.body.append(elsewhere);
        elsewhere.focus();
        document.dispatchEvent(esc());
        expect(handle.isExpanded()).toBe(false);
        expect(document.activeElement).toBe(elsewhere);
    });

    it('names the panel it discloses', () => {
        const { handle, chip } = make();
        const panel = handle.el.querySelector('.nui-dd__panel') as HTMLElement;
        expect(panel.id).toBeTruthy();
        expect(chip.getAttribute('aria-controls')).toBe(panel.id);
    });
});

describe('hover reporting', () => {
    it('mouseenter/leave and focus/blur drive the model\'s hover', () => {
        const { model, chip, handle } = make();
        chip.dispatchEvent(new MouseEvent('mouseenter'));
        expect(model.getHovered()?.label).toBe('3rd Tanks');
        chip.dispatchEvent(new MouseEvent('mouseleave'));
        expect(model.getHovered()).toBeNull();
        chip.focus();
        expect(model.getHovered()?.label).toBe('3rd Tanks');
        handle.dispose();
        expect(model.getHovered()).toBeNull();
    });
});
