import { describe, it, expect, vi } from 'vitest';
import { EventScheduler, COSMETIC_STALE_FRAMES } from './event-scheduler.js';

describe('EventScheduler', () => {
    it('fires nothing before the cursor reaches the scheduled frame', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(10, 'combatFx', () => fired.push(10));
        s.drain(9);
        expect(fired).toEqual([]);
        expect(s.size).toBe(1);
        s.drain(10);
        expect(fired).toEqual([10]);
        expect(s.size).toBe(0);
    });

    it('drains in ascending frame order regardless of schedule order', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(30, 'sound', () => fired.push(30));
        s.schedule(10, 'impact', () => fired.push(10));
        s.schedule(20, 'destroy', () => fired.push(20));
        s.drain(100);
        expect(fired).toEqual([10, 20, 30]);
    });

    it('preserves schedule order (FIFO) among same-frame events', () => {
        const s = new EventScheduler();
        const fired: string[] = [];
        s.schedule(5, 'combatFx', () => fired.push('a'));
        s.schedule(5, 'combatFx', () => fired.push('b'));
        s.schedule(5, 'combatFx', () => fired.push('c'));
        s.schedule(5, 'combatFx', () => fired.push('d'));
        s.drain(5);
        expect(fired).toEqual(['a', 'b', 'c', 'd']);
    });

    it('fires past-due events immediately on the next drain', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        // Cursor is already at 100 when a frame-40 event arrives (e.g. after a
        // stall, or before the clock anchored). It must fire next drain.
        s.schedule(40, 'destroy', () => fired.push(40));
        s.drain(100);
        expect(fired).toEqual([40]);
        expect(s.size).toBe(0);
    });

    it('drops cosmetic events staler than the staleness horizon', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        // Hidden-tab scenario: FX queued at frame 10, next drain happens
        // only after refocus with the cursor far past the horizon.
        s.schedule(10, 'combatFx', () => fired.push(10));
        s.schedule(12, 'sound', () => fired.push(12));
        s.schedule(14, 'impact', () => fired.push(14));
        s.drain(14 + COSMETIC_STALE_FRAMES + 1); // past the horizon of all three
        expect(fired).toEqual([]);   // dropped without firing
        expect(s.size).toBe(0);      // …but removed from the queue
    });

    it('always fires state-critical events no matter how stale', () => {
        const s = new EventScheduler();
        const fired: string[] = [];
        s.schedule(10, 'destroy', () => fired.push('destroy'));
        s.schedule(10, 'losReveal', () => fired.push('losReveal'));
        s.schedule(10, 'combatFx', () => fired.push('combatFx'));
        s.drain(10_000); // hours past the horizon
        expect(fired).toEqual(['destroy', 'losReveal']);
        expect(s.size).toBe(0);
    });

    it('fires fresh cosmetic events at or within the staleness horizon', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(10, 'combatFx', () => fired.push(10));
        // Exactly at the horizon boundary — still fires (drop is strictly >).
        s.drain(10 + COSMETIC_STALE_FRAMES);
        expect(fired).toEqual([10]);
    });

    it('interleaves late-arriving earlier frames correctly across drains', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(10, 'impact', () => fired.push(10));
        s.drain(12);
        expect(fired).toEqual([10]);
        // A frame-11 event arrives after the cursor already passed it — past
        // due, fires on the next drain even though it is "in the past".
        s.schedule(11, 'impact', () => fired.push(11));
        s.schedule(20, 'impact', () => fired.push(20));
        s.drain(15);
        expect(fired).toEqual([10, 11]);
        s.drain(25);
        expect(fired).toEqual([10, 11, 20]);
    });

    it('freezes while the cursor is frozen (pause) and resumes after', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(50, 'combatFx', () => fired.push(50));
        // Cursor frozen at 48 across several render frames (paused → P holds).
        s.drain(48);
        s.drain(48);
        s.drain(48);
        expect(fired).toEqual([]);
        // Unpause — cursor advances past the frame.
        s.drain(51);
        expect(fired).toEqual([50]);
    });

    it('window() returns future events in (P, E], sorted, without firing them', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(5, 'losReveal', () => fired.push(5));   // past/at cursor
        s.schedule(12, 'losReveal', () => fired.push(12)); // in window
        s.schedule(30, 'losReveal', () => fired.push(30)); // in window
        s.schedule(99, 'losReveal', () => fired.push(99)); // beyond E
        const w = s.window(10, 40);
        expect(w.map((e) => e.frame)).toEqual([12, 30]);
        expect(w.every((e) => e.kind === 'losReveal')).toBe(true);
        // Peeking neither fires nor removes.
        expect(fired).toEqual([]);
        expect(s.size).toBe(4);
    });

    it('window() excludes the boundary P and includes the boundary E', () => {
        const s = new EventScheduler();
        s.schedule(10, 'impact', () => {});
        s.schedule(20, 'impact', () => {});
        const w = s.window(10, 20);
        expect(w.map((e) => e.frame)).toEqual([20]); // >P (exclusive), <=E
    });

    it('clear() drops all pending events', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        s.schedule(10, 'combatFx', () => fired.push(10));
        s.schedule(20, 'combatFx', () => fired.push(20));
        s.clear();
        expect(s.size).toBe(0);
        s.drain(1000);
        expect(fired).toEqual([]);
    });

    it('a throwing handler is caught and does not abort the drain', () => {
        const s = new EventScheduler();
        const fired: number[] = [];
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        s.schedule(10, 'combatFx', () => { throw new Error('boom'); });
        s.schedule(10, 'combatFx', () => fired.push(2));
        s.drain(10);
        expect(fired).toEqual([2]);       // second handler still ran
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('handles a large heap in correct order (stress)', () => {
        const s = new EventScheduler();
        const frames = [7, 3, 9, 1, 4, 1, 8, 2, 6, 5, 3, 0];
        const fired: number[] = [];
        for (const f of frames) s.schedule(f, 'impact', () => fired.push(f));
        s.drain(50); // within the cosmetic staleness horizon of every frame
        expect(fired).toEqual([...frames].sort((a, b) => a - b));
    });
});
