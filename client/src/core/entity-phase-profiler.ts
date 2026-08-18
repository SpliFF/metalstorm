/**
 * Entity-phase cost split (PLAN-perf M27) — measurement only, off by default.
 *
 * `entity` is one phase timer in FrameProfiler, and M26 proved the interesting
 * money is no longer inside `SquadManager.update()`: at 1 396 squads with zero
 * drawn members, 67 % of the phase is outside it, and of the 0.565 µs/squad
 * marginal only ~0.20 µs is the manager's loop. The manager cannot time what
 * runs around it, so the split has to live where the phase does — in the
 * render loop (game-processor.ts), which owns every call between gpMark(0) and
 * gpMark(1).
 *
 * The slices are the phase's own call list, not a guess at where the cost is:
 * the interpolation tick, the three parts of the squad tick (per-squad pose
 * sync, manager update, backend flush), the impostor flush, and the
 * presentation-event drain. `other` is the residual, so the slices always sum
 * to the measured phase wall time and nothing hides.
 *
 * Two conventions carried in from M24/M25, both of which cost a milestone when
 * they were missing: the report keeps the FRAME COUNT (so a window that never
 * ran is visibly empty rather than silently dividing by one) and the mean
 * SQUAD and ENTITY populations of the window, because a per-squad number
 * quoted without the band it was measured over is not a number.
 */

/** Total ms per slice since the last arm, plus the population sums used to
 *  turn the totals into per-squad marginals. Owned by game-processor.ts and
 *  summed once per render frame while armed. */
export interface EntityPhaseAccumulator {
    frames: number;
    /** entityRenderer.tick() — presentation clock + interpolate every unit. */
    interp: number;
    /** The per-squad pose sync loop (getEntityPose + syncPose), which runs
     *  per squad per frame OUTSIDE update() and which M26 could not see. */
    squadPose: number;
    /** gpSquadSystem.update(dt) — the term M26 priced at 0.20 µs/squad. */
    squadUpdate: number;
    /** gpSquadBackend.flush() — per pool, not per squad. */
    squadFlush: number;
    /** impostorRenderer.render() — the impostor-tier thin-instance flush. */
    impostor: number;
    /** Presentation-event drain + prefetch (scheduled explosions, deaths…). */
    events: number;
    /** Wall time of the whole phase (gpMark(0) → gpMark(1)). */
    total: number;
    /** Sum over frames of the live squad count (÷ frames = the band). */
    squadSum: number;
    /** Sum over frames of the live routed-entity count (÷ frames = the band). */
    entitySum: number;
}

export function createEntityPhaseAccumulator(): EntityPhaseAccumulator {
    return {
        frames: 0, interp: 0, squadPose: 0, squadUpdate: 0, squadFlush: 0,
        impostor: 0, events: 0, total: 0, squadSum: 0, entitySum: 0,
    };
}

export function resetEntityPhaseAccumulator(a: EntityPhaseAccumulator): void {
    a.frames = 0; a.interp = 0; a.squadPose = 0; a.squadUpdate = 0;
    a.squadFlush = 0; a.impostor = 0; a.events = 0; a.total = 0;
    a.squadSum = 0; a.entitySum = 0;
}

export interface EntityPhaseReport {
    frames: number;
    /** Mean live squad / entity counts over the window — the band every
     *  per-squad number below is quoted over. */
    squads: number;
    entities: number;
    /** Per-frame means, ms. `other` is total minus the named slices. */
    ms: {
        interp: number; squadPose: number; squadUpdate: number;
        squadFlush: number; impostor: number; events: number;
        other: number; total: number;
    };
    /** The same slices as µs per squad per frame — only meaningful for the
     *  ones that are actually per-squad, which is why the table names which.
     *  Null when the window held no squads (dividing by zero squads is how a
     *  "per-squad cost" gets invented). */
    usPerSquad: Record<string, number> | null;
    /** Pre-formatted human-readable table (log this). */
    table: string;
}

const SLICES = ['interp', 'squadPose', 'squadUpdate', 'squadFlush',
    'impostor', 'events', 'other'] as const;

/** Which slices scale with the squad population. `interp` and `impostor` walk
 *  entities, `events` walks a queue; presenting their µs/squad would invite
 *  exactly the average-as-marginal error M25 and M26 were spent on. */
const PER_SQUAD = new Set<string>(['squadPose', 'squadUpdate']);

export function buildEntityPhaseReport(a: EntityPhaseAccumulator): EntityPhaseReport {
    const f = Math.max(1, a.frames);
    const named = a.interp + a.squadPose + a.squadUpdate + a.squadFlush
        + a.impostor + a.events;
    const ms = {
        interp: a.interp / f,
        squadPose: a.squadPose / f,
        squadUpdate: a.squadUpdate / f,
        squadFlush: a.squadFlush / f,
        impostor: a.impostor / f,
        events: a.events / f,
        other: (a.total - named) / f,
        total: a.total / f,
    };
    const squads = a.squadSum / f;
    const entities = a.entitySum / f;
    let usPerSquad: Record<string, number> | null = null;
    if (squads > 0) {
        usPerSquad = {};
        for (const k of SLICES) {
            if (PER_SQUAD.has(k)) usPerSquad[k] = (ms[k] * 1000) / squads;
        }
    }
    const lines: string[] = [];
    lines.push(`entity-phase split — ${a.frames} frames, `
        + `${squads.toFixed(0)} squads / ${entities.toFixed(0)} entities (window means)`);
    if (a.frames === 0) {
        lines.push('  (no frames sampled — arm, run the window, then dump)');
    } else {
        lines.push(`  entity total        ${ms.total.toFixed(3)} ms/frame`);
        for (const k of SLICES) {
            const per = usPerSquad && PER_SQUAD.has(k)
                ? `  ${usPerSquad[k].toFixed(3)} µs/squad` : '';
            lines.push(`    ${k.padEnd(16)}${ms[k].toFixed(3)}${per}`);
        }
    }
    return { frames: a.frames, squads, entities, ms, usPerSquad, table: lines.join('\n') };
}
