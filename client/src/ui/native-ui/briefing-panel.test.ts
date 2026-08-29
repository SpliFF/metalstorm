// @vitest-environment happy-dom
/**
 * briefing-panel.test.ts — the story and the clock, still reachable
 * (battle-clarity U3, DESIGN-DRILLDOWN.md §6)
 *
 * The interesting assertions are about the two things this fixes rather than
 * adds: the briefing SURVIVES the splash being dismissed, and the par time
 * becomes a comparison instead of a target once the battle is running.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import briefingPanel, { parPhrase, formatClock, REFRESH_MS } from './briefing-panel.js';
import { uiStore } from './ui-store.js';
import type { WidgetContext } from './widget-loader.js';

let mount: HTMLElement;

const ctx = (): WidgetContext => ({
    store: uiStore,
    mount,
    identity: { playerId: 0, teamId: 0, accountId: 0 },
});

beforeEach(() => {
    vi.useFakeTimers();
    uiStore.clear();
    mount = document.createElement('div');
    document.body.append(mount);
});

afterEach(() => {
    briefingPanel.dispose();
    mount.parentElement?.removeChild(mount);
    uiStore.clear();
    vi.useRealTimers();
});

describe('the par clock', () => {
    it('formats the same way the boot splash does', () => {
        expect(formatClock(615)).toBe('10:15');
        expect(formatClock(0)).toBe('0:00');
    });

    it('reads as a comparison while there is time, and as an overrun after', () => {
        expect(parPhrase(442, 720)).toBe('7:22 elapsed of 12:00 par');
        expect(parPhrase(802, 720)).toBe('13:22 elapsed — 1:22 past par (12:00)');
    });

    it('says only what it knows when the scenario published no par', () => {
        // A par timer that invents a target is worse than one that admits it
        // has none — the player would march on it.
        expect(parPhrase(442, undefined)).toBe('7:22 elapsed');
    });
});

describe('the panel', () => {
    it('says WHY it is empty rather than rendering a blank tab', () => {
        briefingPanel.init(ctx());
        expect(mount.querySelector('.nui-log__empty')!.textContent)
            .toContain('shipped no briefing');
    });

    it('renders the story, the advice and the live clock', () => {
        uiStore.setBriefing({
            title: 'Crossing Standoff',
            subtitle: 'Raven Basin',
            story: 'The bridge is the war.\n\nHold it and the basin follows.',
            tips: ['Keep artillery behind the ridge.'],
            parTimeSec: 720,
        });
        uiStore.setGameFrame(30 * 442);
        briefingPanel.init(ctx());

        expect(mount.querySelector('.nui-briefing__title')!.textContent).toBe('Crossing Standoff');
        // Blank lines separate paragraphs — the same contract the authored
        // briefing blocks rely on in `briefing.ts`.
        expect(mount.querySelectorAll('.nui-briefing__para')).toHaveLength(2);
        expect(mount.querySelectorAll('.nui-briefing__tips li')).toHaveLength(1);
        expect(mount.querySelector('.nui-briefing__clock')!.textContent)
            .toBe('7:22 elapsed of 12:00 par');
    });

    it('re-reads the clock on its own slow tick', () => {
        uiStore.setBriefing({ tips: [], parTimeSec: 720 });
        uiStore.setGameFrame(0);
        briefingPanel.init(ctx());
        expect(mount.querySelector('.nui-briefing__clock')!.textContent)
            .toBe('0:00 elapsed of 12:00 par');

        uiStore.setGameFrame(30 * 60);
        vi.advanceTimersByTime(REFRESH_MS);
        expect(mount.querySelector('.nui-briefing__clock')!.textContent)
            .toBe('1:00 elapsed of 12:00 par');
    });

    it('leaves nothing behind on dispose', () => {
        briefingPanel.init(ctx());
        briefingPanel.dispose();
        expect(mount.querySelectorAll('.nui-briefing')).toHaveLength(0);
    });
});
