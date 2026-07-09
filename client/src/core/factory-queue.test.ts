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
            .toEqual([{ defId: 408, tags: [1] }]);
    });

    it('groups consecutive same-defId build orders into one run', () => {
        const runs = groupFactoryQueueRuns([order(-408, 1), order(-408, 2), order(-408, 3)]);
        expect(runs).toEqual([{ defId: 408, tags: [1, 2, 3] }]);
    });

    it('preserves queue order across different defIds', () => {
        const runs = groupFactoryQueueRuns([
            order(-408, 1), order(-408, 2),
            order(-549, 3),
            order(-408, 4),
        ]);
        expect(runs).toEqual([
            { defId: 408, tags: [1, 2] },
            { defId: 549, tags: [3] },
            { defId: 408, tags: [4] },
        ]);
    });

    it('skips non-build orders without splitting a run', () => {
        // A WAIT (cmdId 5) inserted between two batches of the same unit
        // shouldn't fragment them into separate rows.
        const runs = groupFactoryQueueRuns([order(-408, 1), order(5, 2), order(-408, 3)]);
        expect(runs).toEqual([{ defId: 408, tags: [1, 3] }]);
    });

    it('returns no runs when the queue has only non-build orders', () => {
        expect(groupFactoryQueueRuns([order(5, 1), order(0, 2)])).toEqual([]);
    });
});
