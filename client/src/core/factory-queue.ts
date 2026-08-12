/**
 * Pure grouping logic for the native FactoryQueuePanel (PLAN-playable.md G4).
 * Split out of game-processor.ts so the run-grouping algorithm is unit-
 * testable without a Babylon/worker context (same reasoning as
 * metal-spots.ts's findMetalSpots/nearestMetalSpot).
 */
import type { UnitOrderInfo } from './connection.js';

export interface FactoryQueueRun {
    defId: number;
    /** Server-assigned tags in the run, oldest→newest. **Cancellable orders
     *  only** — see `pending`. */
    tags: number[];
    /** PLAN-latency L4.2: how many orders in this run are *optimistic* — sent
     *  by us and merged in by `PendingActionRegistry`, not yet present in a
     *  server snapshot. They are deliberately kept out of `tags`: their tag is
     *  a synthetic negative placeholder, and feeding one back to the server as
     *  a `CMD.REMOVE` anchor would address nothing. So the row counts them
     *  (`count` = `tags.length + pending`) but can only cancel the confirmed
     *  ones — which is the honest state, and self-corrects within a round trip. */
    pending: number;
}

/**
 * Group a unit's command-queue orders into consecutive same-defId build runs.
 * Only cmdId<0 (build) orders count — same convention gpRecomputeBuildTiles
 * decodes (-cmdId is the unit-def id). Non-build orders (e.g. a WAIT a player
 * inserted between batches) are skipped rather than splitting a run: Spring's
 * FactoryCAI stacks repeated identical build commands one slot each, so this
 * mirrors what the player actually queued rather than fragmenting it on
 * incidental state-toggle commands.
 *
 * Since L4.2 this runs over the *merged* view (snapshot + outstanding
 * optimistic orders), so a `tag <= 0` order is one of ours: server tags are
 * always >= 1, and `PendingActionRegistry` stamps its unconfirmed entries with
 * `-id` precisely so they are distinguishable here.
 */
export function groupFactoryQueueRuns(orders: readonly UnitOrderInfo[]): FactoryQueueRun[] {
    const runs: FactoryQueueRun[] = [];
    for (const o of orders) {
        if (o.cmdId >= 0) continue;
        const defId = -o.cmdId;
        let last = runs[runs.length - 1];
        if (!last || last.defId !== defId) {
            last = { defId, tags: [], pending: 0 };
            runs.push(last);
        }
        if (o.tag > 0) last.tags.push(o.tag);
        else last.pending++;
    }
    return runs;
}
