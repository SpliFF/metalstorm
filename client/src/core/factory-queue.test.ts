import { describe, it, expect } from 'vitest';
import { groupFactoryQueueRuns } from './factory-queue.js';
import type { UnitOrderInfo } from './connection.js';

/** Minimal order builder — only cmdId/tag matter to the grouping logic. */
function order(cmdId: number, tag: number): UnitOrderInfo {
    return { cmdId, tag, params: [], options: 0, timeout: 0 };
}

describe('groupFactoryQueueRuns', () => {
    it('returns no runs for an empty queue', () => {
        expect(groupFactoryQueueRuns([])).toEqual([]);
    });

    it('groups a single build order into a one-count run', () => {
        expect(groupFactoryQueueRuns([order(-408, 1)]))
            .toEqual([{ defId: 408, tags: [1], pending: 0 }]);
    });

    it('groups consecutive same-defId build orders into one run', () => {
        const runs = groupFactoryQueueRuns([order(-408, 1), order(-408, 2), order(-408, 3)]);
        expect(runs).toEqual([{ defId: 408, tags: [1, 2, 3], pending: 0 }]);
    });

    it('preserves queue order across different defIds', () => {
        const runs = groupFactoryQueueRuns([
            order(-408, 1), order(-408, 2),
            order(-549, 3),
            order(-408, 4),
        ]);
        expect(runs).toEqual([
            { defId: 408, tags: [1, 2], pending: 0 },
            { defId: 549, tags: [3], pending: 0 },
            { defId: 408, tags: [4], pending: 0 },
        ]);
    });

    it('skips non-build orders without splitting a run', () => {
        // A WAIT (cmdId 5) inserted between two batches of the same unit
        // shouldn't fragment them into separate rows.
        const runs = groupFactoryQueueRuns([order(-408, 1), order(5, 2), order(-408, 3)]);
        expect(runs).toEqual([{ defId: 408, tags: [1, 3], pending: 0 }]);
    });

    it('returns no runs when the queue has only non-build orders', () => {
        expect(groupFactoryQueueRuns([order(5, 1), order(0, 2)])).toEqual([]);
    });

    // PLAN-latency L4.2 — the panel now reads the merged view, so a run can
    // carry optimistic orders whose tag is PendingActionRegistry's synthetic
    // negative placeholder. Those count towards the row but must never reach
    // `tags`, which is the CMD.REMOVE anchor list.
    describe('optimistic (merged-view) orders', () => {
        it('counts a negative-tag order as pending, not cancellable', () => {
            expect(groupFactoryQueueRuns([order(-408, -1)]))
                .toEqual([{ defId: 408, tags: [], pending: 1 }]);
        });

        it('treats tag 0 as pending too — server tags start at 1', () => {
            expect(groupFactoryQueueRuns([order(-408, 0)]))
                .toEqual([{ defId: 408, tags: [], pending: 1 }]);
        });

        it('splits a run into its confirmed and pending halves', () => {
            // Two confirmed builds plus one we have only just sent: the row
            // shows ×3 but can cancel only the two the server acknowledged.
            const runs = groupFactoryQueueRuns([
                order(-408, 7), order(-408, 8), order(-408, -3),
            ]);
            expect(runs).toEqual([{ defId: 408, tags: [7, 8], pending: 1 }]);
        });

        it('keeps pending orders in their own run when the defId differs', () => {
            const runs = groupFactoryQueueRuns([order(-408, 7), order(-549, -3)]);
            expect(runs).toEqual([
                { defId: 408, tags: [7], pending: 0 },
                { defId: 549, tags: [], pending: 1 },
            ]);
        });
    });
});
