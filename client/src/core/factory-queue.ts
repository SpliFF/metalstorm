/**
 * Pure grouping logic for the native FactoryQueuePanel (PLAN-playable.md G4).
 * Split out of game-processor.ts so the run-grouping algorithm is unit-
 * testable without a Babylon/worker context (same reasoning as
 * metal-spots.ts's findMetalSpots/nearestMetalSpot).
 */
import type { UnitOrderInfo } from './connection.js';

export interface FactoryQueueRun {
    defId: number;
    tags: number[];
}

/**
 * Group a unit's command-queue orders into consecutive same-defId build runs.
 * Only cmdId<0 (build) orders count — same convention gpRecomputeBuildTiles
 * decodes (-cmdId is the unit-def id). Non-build orders (e.g. a WAIT a player
 * inserted between batches) are skipped rather than splitting a run: Spring's
 * FactoryCAI stacks repeated identical build commands one slot each, so this
 * mirrors what the player actually queued rather than fragmenting it on
 * incidental state-toggle commands.
 */
export function groupFactoryQueueRuns(orders: readonly UnitOrderInfo[]): FactoryQueueRun[] {
    const runs: FactoryQueueRun[] = [];
    for (const o of orders) {
        if (o.cmdId >= 0) continue;
        const defId = -o.cmdId;
        const last = runs[runs.length - 1];
        if (last && last.defId === defId) last.tags.push(o.tag);
        else runs.push({ defId, tags: [o.tag] });
    }
    return runs;
}
