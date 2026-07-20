import { describe, it, expect, vi } from 'vitest';
import { EntityFxFence, lodForDistance, FENCE_LOD_CLOSE_ELMOS, FENCE_LOD_FAR_ELMOS } from './entity-fx-fence.js';

function fakeClock(start = 0) {
    let t = start;
    return {
        now: () => t,
        advance: (ms: number) => { t += ms; },
    };
}

describe('lodForDistance', () => {
    it('full below the close threshold', () => {
        expect(lodForDistance(0)).toBe('full');
        expect(lodForDistance(FENCE_LOD_CLOSE_ELMOS - 1)).toBe('full');
    });
    it('half between the two thresholds', () => {
        expect(lodForDistance(FENCE_LOD_CLOSE_ELMOS)).toBe('half');
        expect(lodForDistance(FENCE_LOD_FAR_ELMOS - 1)).toBe('half');
    });
    it('skip at/beyond the far threshold', () => {
        expect(lodForDistance(FENCE_LOD_FAR_ELMOS)).toBe('skip');
        expect(lodForDistance(999999)).toBe('skip');
    });
});

describe('EntityFxFence', () => {
    it('runs the callback and records cost when close and under budget', () => {
        const fence = new EntityFxFence(4);
        fence.beginFrame();
        const clock = fakeClock();
        const fn = vi.fn(() => clock.advance(0.5));
        const ran = fence.run('tank_medium', 1, 100, fn, clock.now);
        expect(ran).toBe(true);
        expect(fn).toHaveBeenCalledTimes(1);
        const dump = fence.dump();
        expect(dump.perDef).toHaveLength(1);
        expect(dump.perDef[0]).toMatchObject({ def: 'tank_medium', calls: 1, skippedLod: 0, skippedBudget: 0 });
        expect(dump.perDef[0].ms).toBeCloseTo(0.5, 5);
    });

    it('LOD gate: never runs beyond the far threshold', () => {
        const fence = new EntityFxFence(4);
        fence.beginFrame();
        const fn = vi.fn();
        const ran = fence.run('tank_medium', 1, 5000, fn);
        expect(ran).toBe(false);
        expect(fn).not.toHaveBeenCalled();
        expect(fence.dump().perDef[0]).toMatchObject({ skippedLod: 1, calls: 0 });
    });

    it('LOD gate: half rate alternates per entity in the medium band', () => {
        const fence = new EntityFxFence(4);
        const fn = vi.fn();
        const distance = (FENCE_LOD_CLOSE_ELMOS + FENCE_LOD_FAR_ELMOS) / 2;
        const runs: boolean[] = [];
        for (let i = 0; i < 4; i++) {
            fence.beginFrame();
            runs.push(fence.run('tank_medium', 7, distance, fn));
        }
        expect(runs).toEqual([true, false, true, false]);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('half-rate parity is independent per entity', () => {
        const fence = new EntityFxFence(4);
        const distance = (FENCE_LOD_CLOSE_ELMOS + FENCE_LOD_FAR_ELMOS) / 2;
        fence.beginFrame();
        const a = fence.run('tank_medium', 1, distance, () => {});
        const b = fence.run('tank_medium', 2, distance, () => {});
        // Both entities' first-ever call runs (each starts its own parity at false).
        expect(a).toBe(true);
        expect(b).toBe(true);
    });

    it('budget cap: further calls are skipped once the frame budget is spent', () => {
        // The fence checks "budget already exhausted" before running, not
        // a lookahead of the call's own cost (it can't know that in
        // advance) — so the call that exhausts the budget still runs, and
        // the *next* one is rejected. Two 0.8ms calls against a 1ms budget:
        // the first leaves 0.2ms (still runs the second), the second
        // drives it to -0.6ms, and only the third is rejected.
        const fence = new EntityFxFence(1 /* ms budget */);
        fence.beginFrame();
        const clock = fakeClock();
        const expensiveFn = () => clock.advance(0.8);

        expect(fence.run('a', 1, 0, expensiveFn, clock.now)).toBe(true);  // 0.8ms spent, 0.2 left
        expect(fence.run('b', 2, 0, expensiveFn, clock.now)).toBe(true);  // budget still >0 before this call; now -0.6
        expect(fence.run('c', 3, 0, expensiveFn, clock.now)).toBe(false); // budget already <=0
        const dump = fence.dump();
        const c = dump.perDef.find((r) => r.def === 'c')!;
        expect(c.skippedBudget).toBe(1);
        expect(c.calls).toBe(0);
    });

    it('budget resets every beginFrame()', () => {
        const fence = new EntityFxFence(1);
        const clock = fakeClock();
        fence.beginFrame();
        expect(fence.run('a', 1, 0, () => clock.advance(1.1), clock.now)).toBe(true); // drives budget to -0.1
        expect(fence.run('a', 1, 0, () => clock.advance(0.1), clock.now)).toBe(false); // already exhausted

        fence.beginFrame(); // new frame, fresh budget
        expect(fence.run('a', 1, 0, () => clock.advance(0.1), clock.now)).toBe(true);
    });

    it('warns exactly once per def across many frames/entities', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fence = new EntityFxFence(100);
        for (let i = 0; i < 5; i++) {
            fence.beginFrame();
            fence.run('tank_medium', 1, 0, () => {});
            fence.run('tank_medium', 2, 0, () => {});
        }
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('dump() ranks defs most-expensive-first', () => {
        const fence = new EntityFxFence(100);
        fence.beginFrame();
        const clock = fakeClock();
        fence.run('cheap_def', 1, 0, () => clock.advance(0.1), clock.now);
        fence.run('expensive_def', 2, 0, () => clock.advance(2.0), clock.now);
        const dump = fence.dump();
        expect(dump.perDef.map((r) => r.def)).toEqual(['expensive_def', 'cheap_def']);
        expect(dump.frames).toBe(1);
    });

    it('reset() clears stats, parity, and frame count', () => {
        const fence = new EntityFxFence(4);
        fence.beginFrame();
        fence.run('a', 1, 0, () => {});
        fence.reset();
        const dump = fence.dump();
        expect(dump.frames).toBe(0);
        expect(dump.perDef).toHaveLength(0);
    });
});
