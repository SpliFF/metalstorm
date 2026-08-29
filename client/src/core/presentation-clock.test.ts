import { describe, it, expect } from 'vitest';
import { PresentationClock } from './presentation-clock.js';

// GAME_SPEED = 30 → 0.03 frames/ms at 1× speed.
const FPMS = 0.03;

describe('PresentationClock', () => {
    it('anchors to the first observed frame (no clock → no latency bias)', () => {
        const c = new PresentationClock();
        expect(c.isAnchored).toBe(false);
        c.observeFrame(100, 1000);
        expect(c.isAnchored).toBe(true);
        // E anchors at baseFrame; D auto = floor (oneWay 0 + jitter 0 + stride 3 → 4).
        expect(c.E).toBeCloseTo(100, 5);
        expect(c.displayDelayFrames).toBe(4);
        expect(c.P).toBeCloseTo(96, 5);
    });

    it('advances E by wall-dt × framesPerMs on tick', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        c.tick(1100); // +100 ms
        expect(c.E).toBeCloseTo(100 + 100 * FPMS, 5); // 103
        expect(c.P).toBeCloseTo(103 - 4, 5);           // 99
    });

    it('freezes the cursor when paused (speedFactor 0)', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        c.setSpeedFactor(0);
        c.tick(2000); // 1 s later, but paused
        expect(c.E).toBeCloseTo(100, 5); // unchanged
    });

    it('counts reorders and does not pull the cursor backward', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        c.observeFrame(103, 1100);
        const before = c.E;
        c.observeFrame(101, 1200); // late/reordered (< newest 103)
        const stats = c.getStats();
        expect(stats.reorderCount).toBe(1);
        expect(stats.newestFrame).toBe(103);
        expect(c.E).toBeGreaterThanOrEqual(before - 0.01); // not yanked back
    });

    it('detects loss from a stride gap', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        // Expected next ~103; jump to 112 → missed ~3 packets (3,6,9 → 3).
        c.observeFrame(112, 1100);
        expect(c.getStats().lossCount).toBeGreaterThanOrEqual(2);
    });

    it('converts frames↔ms at the current speed', () => {
        const c = new PresentationClock();
        expect(c.frameToMs(3)).toBeCloseTo(100, 5);   // 3 frames @30Hz = 100 ms
        expect(c.msToFrames(100)).toBeCloseTo(3, 5);
        c.setSpeedFactor(2);
        expect(c.frameToMs(6)).toBeCloseTo(100, 5);    // 2× → twice as fast
    });

    // ai-visual-debug V2: single-stepping moves the server by a handful of
    // frames — far below SNAP_FRAMES — and a paused clock cannot tick the
    // error away (framesPerMs 0). Without an explicit snap the cursor sits
    // behind the state the step just produced, which is a stale pose in
    // every filmed shot.
    it('snapToNewest closes a sub-snap-threshold gap the PLL would only creep at', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        c.setSpeedFactor(0);              // paused, as sim_step leaves it
        c.observeFrame(106, 1500);        // stepped 6 frames
        // The PLL only took 10% of the 6-frame error.
        expect(c.E).toBeCloseTo(100.6, 5);
        const jumped = c.snapToNewest();
        expect(jumped).toBeCloseTo(5.4, 5);
        expect(c.E).toBeCloseTo(106, 5);
        expect(c.getStats().correctionCount).toBeGreaterThan(0);
    });

    it('snapToNewest is a no-op before the first snapshot anchors the clock', () => {
        const c = new PresentationClock();
        expect(c.snapToNewest()).toBe(0);
        expect(c.isAnchored).toBe(false);
        expect(c.E).toBe(0);
    });

    it('honours a manual display-delay override', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        c.setManualDelayFrames(10);
        expect(c.displayDelayFrames).toBe(10);
        expect(c.P).toBeCloseTo(90, 5);
        c.setManualDelayFrames(null); // back to auto
        expect(c.displayDelayFrames).toBe(4);
    });

    it('reset clears anchor and stats', () => {
        const c = new PresentationClock();
        c.observeFrame(100, 1000);
        c.observeFrame(103, 1100);
        c.reset();
        expect(c.isAnchored).toBe(false);
        expect(c.getStats().newestFrame).toBe(0);
    });
});
