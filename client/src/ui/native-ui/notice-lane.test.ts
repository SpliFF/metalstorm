// @vitest-environment happy-dom
/**
 * notice-lane.test.ts — the rules that make a lane a lane and not a feed.
 *
 * The directive's hard requirement is that awareness DECAYS. Everything here is
 * about leaving: how long a notice stays, how many may share the screen, and
 * the one case where staying is right (the player is reading it).
 *
 * DOM assertions are blind to CSS — the live screenshots in the step report are
 * the evidence for appearance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNoticeLane, MAX_NOTICES, NOTICE_MS } from './notice-lane.js';
import { focusModel } from './focus-model.js';

let host: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    focusModel.clear();
});

afterEach(() => {
    host.replaceChildren();
    host.parentElement?.removeChild(host);
    vi.useRealTimers();
});

const notices = (): HTMLElement[] => [...host.querySelectorAll('.nui-toast')] as HTMLElement[];

describe('a notice decays', () => {
    it('leaves on its own', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'a', text: 'First contact' });
        expect(notices()).toHaveLength(1);

        vi.advanceTimersByTime(NOTICE_MS + 600);
        expect(notices()).toHaveLength(0);
        expect(lane.size()).toBe(0);
        lane.dispose();
    });

    it('honours a per-notice ttl, so one source can be quieter than another', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'short', text: 'short', ttlMs: 1000 });
        lane.push({ key: 'long', text: 'long', ttlMs: 8000 });
        vi.advanceTimersByTime(2000);
        expect(notices().map((n) => n.dataset.noticeKey)).toEqual(['long']);
        lane.dispose();
    });
});

describe('a notice does not pile up', () => {
    it('caps the stack and drops the OLDEST', () => {
        const lane = createNoticeLane(host);
        for (let i = 0; i < MAX_NOTICES + 3; i++) lane.push({ key: `n${i}`, text: `n${i}` });
        expect(lane.size()).toBe(MAX_NOTICES);
        expect(notices()[0].dataset.noticeKey).toBe('n3');
        lane.dispose();
    });

    it('replaces rather than stacks when the same key comes back', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'same', text: 'one' });
        lane.push({ key: 'same', text: 'two' });
        expect(lane.size()).toBe(1);
        expect(notices()[0].textContent).toBe('two');
        lane.dispose();
    });
});

describe('a notice may be a rung of the ladder', () => {
    const spec = (label: string) => ({
        ref: { kind: 'area' as const, id: label, label, position: { x: 10, z: 20 } },
        summary: () => ({ title: label, state: 'under fire' }),
        detail: (h: HTMLElement) => { h.append(document.createTextNode('detail')); },
    });

    it('renders as a chip that drills, not as a line of text', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'm1', drilldown: spec('Tanks under fire') });

        const chip = host.querySelector('.nui-toast--drill .nui-dd__chip') as HTMLElement;
        expect(chip).toBeTruthy();
        expect(chip.textContent).toContain('Tanks under fire');

        chip.click();
        expect(host.querySelector('.nui-dd__panel')!.textContent).toContain('detail');
        lane.dispose();
    });

    it('does not expire while its panel is open — the panel would vanish mid-read', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'm1', drilldown: spec('Squad lost') });
        (host.querySelector('.nui-dd__chip') as HTMLElement).click();

        vi.advanceTimersByTime(NOTICE_MS * 3);
        expect(lane.size()).toBe(1);

        // Collapsing hands the clock back, and it starts from NOW rather than
        // from when the notice arrived.
        (host.querySelector('.nui-dd__chip') as HTMLElement).click();
        vi.advanceTimersByTime(NOTICE_MS + 600);
        expect(lane.size()).toBe(0);
        lane.dispose();
    });

    it('takes its whole chip out of the DOM when it goes', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'm1', drilldown: spec('Kills') });
        vi.advanceTimersByTime(NOTICE_MS + 600);
        expect(host.querySelectorAll('.nui-dd')).toHaveLength(0);
        lane.dispose();
    });
});

describe('lifetime', () => {
    it('leaves nothing behind on dispose', () => {
        const lane = createNoticeLane(host);
        lane.push({ key: 'a', text: 'a' });
        lane.dispose();
        expect(host.querySelectorAll('.nui-toasts')).toHaveLength(0);
        // A disposed lane must not accept new work — a widget that re-mounts
        // holds a fresh lane, and the old one's timer is gone.
        lane.push({ key: 'b', text: 'b' });
        expect(lane.size()).toBe(0);
    });
});
