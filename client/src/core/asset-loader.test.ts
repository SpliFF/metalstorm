import { describe, it, expect } from 'vitest';
import { AssetLoader, LoadPriority } from './asset-loader.js';

/** Resolves on next call, driven manually so tests control exact ordering
 *  instead of racing real timers. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
}

describe('AssetLoader dedupe', () => {
    it('invokes the task once for concurrent requests to the same key', async () => {
        const loader = new AssetLoader(4);
        let calls = 0;
        const task = () => { calls++; return Promise.resolve('tmpl'); };

        const [a, b] = await Promise.all([
            loader.schedule('unit:1', LoadPriority.P2, task),
            loader.schedule('unit:1', LoadPriority.P2, task),
        ]);

        expect(calls).toBe(1);
        expect(a).toBe('tmpl');
        expect(b).toBe('tmpl');
    });

    it('re-runs the task for a key requested again after it settles', async () => {
        const loader = new AssetLoader(4);
        let calls = 0;
        const task = () => { calls++; return Promise.resolve(calls); };

        const first = await loader.schedule('unit:1', LoadPriority.P2, task);
        const second = await loader.schedule('unit:1', LoadPriority.P2, task);

        expect(first).toBe(1);
        expect(second).toBe(2);
    });

    it('does not dedupe a rejected in-flight request into a permanent failure', async () => {
        const loader = new AssetLoader(4);
        const failing = () => Promise.reject(new Error('boom'));
        await expect(loader.schedule('unit:1', LoadPriority.P2, failing)).rejects.toThrow('boom');

        const ok = () => Promise.resolve('recovered');
        await expect(loader.schedule('unit:1', LoadPriority.P2, ok)).resolves.toBe('recovered');
    });
});

describe('AssetLoader priority ordering', () => {
    it('runs queued requests in priority order once the pool frees up', async () => {
        const loader = new AssetLoader(1); // one slot — forces queueing
        const order: string[] = [];
        const blocker = deferred<void>();

        // Occupies the single slot immediately.
        const p0 = loader.schedule('blocker', LoadPriority.P2, () =>
            blocker.promise.then(() => { order.push('blocker'); }));

        // These three queue up behind the busy slot, in low-to-high priority
        // submission order (P3, P0, P1) — assert the pump reorders them.
        const p1 = loader.schedule('low', LoadPriority.P3, () =>
            Promise.resolve().then(() => { order.push('low'); }));
        const p2 = loader.schedule('urgent', LoadPriority.P0, () =>
            Promise.resolve().then(() => { order.push('urgent'); }));
        const p3 = loader.schedule('mid', LoadPriority.P1, () =>
            Promise.resolve().then(() => { order.push('mid'); }));

        expect(loader.pendingCount).toBe(3);

        blocker.resolve();
        await Promise.all([p0, p1, p2, p3]);

        expect(order).toEqual(['blocker', 'urgent', 'mid', 'low']);
    });

    it('raisePriority reorders a still-queued request ahead of others', async () => {
        const loader = new AssetLoader(1);
        const order: string[] = [];
        const blocker = deferred<void>();

        const busy = loader.schedule('blocker', LoadPriority.P2, () =>
            blocker.promise.then(() => { order.push('blocker'); }));
        const a = loader.schedule('a', LoadPriority.P3, () =>
            Promise.resolve().then(() => { order.push('a'); }));
        const b = loader.schedule('b', LoadPriority.P3, () =>
            Promise.resolve().then(() => { order.push('b'); }));

        // 'b' was submitted after 'a' at the same priority; raise it above
        // 'a' (as build-placement would for a def already queued at a lower
        // priority) and confirm it now runs first.
        loader.raisePriority('b', LoadPriority.P0);

        blocker.resolve();
        await Promise.all([busy, a, b]);

        expect(order).toEqual(['blocker', 'b', 'a']);
    });

    it('never lowers the priority of an already-queued request', async () => {
        const loader = new AssetLoader(1);
        const order: string[] = [];
        const blocker = deferred<void>();

        const busy = loader.schedule('blocker', LoadPriority.P2, () =>
            blocker.promise.then(() => { order.push('blocker'); }));
        const urgent = loader.schedule('urgent', LoadPriority.P0, () =>
            Promise.resolve().then(() => { order.push('urgent'); }));
        // A second, less-urgent request for the same key must not demote it.
        loader.raisePriority('urgent', LoadPriority.P4);
        const other = loader.schedule('other', LoadPriority.P1, () =>
            Promise.resolve().then(() => { order.push('other'); }));

        blocker.resolve();
        await Promise.all([busy, urgent, other]);

        expect(order).toEqual(['blocker', 'urgent', 'other']);
    });
});

describe('AssetLoader concurrency cap', () => {
    it('never runs more than poolSize tasks at once', async () => {
        const loader = new AssetLoader(2);
        let concurrent = 0;
        let maxConcurrent = 0;
        const gates = Array.from({ length: 6 }, () => deferred<void>());

        const runs = gates.map((g, i) => loader.schedule(`k${i}`, LoadPriority.P2, async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await g.promise;
            concurrent--;
        }));

        // Only the pool-size worth of tasks should have started.
        expect(loader.activeCount).toBe(2);
        gates.forEach((g) => g.resolve());
        await Promise.all(runs);

        expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
});

describe('AssetLoader.prewarm', () => {
    it('fires the task without requiring the caller to await it', async () => {
        const loader = new AssetLoader(4);
        let called = false;
        const done = new Promise<void>((resolve) => {
            loader.prewarm('warm:1', () => { called = true; resolve(); return Promise.resolve(); });
        });
        await done;
        expect(called).toBe(true);
    });

    it('swallows a rejection instead of producing an unhandled rejection', async () => {
        const loader = new AssetLoader(4);
        loader.prewarm('warm:fail', () => Promise.reject(new Error('nope')));
        // Give the microtask queue a turn; no throw means the rejection
        // was handled internally.
        await new Promise((r) => setTimeout(r, 0));
    });

    it('does not duplicate a prewarm already in flight', async () => {
        const loader = new AssetLoader(4);
        let calls = 0;
        const gate = deferred<void>();
        loader.prewarm('warm:dup', () => { calls++; return gate.promise; });
        loader.prewarm('warm:dup', () => { calls++; return gate.promise; });
        gate.resolve();
        await new Promise((r) => setTimeout(r, 0));
        expect(calls).toBe(1);
    });
});
