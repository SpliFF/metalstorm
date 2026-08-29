/**
 * objective-model.test.ts — the client's read of the objective board (U1)
 *
 * What this pins is the half of the feature a screenshot cannot show: that the
 * parser matches `game_objectives.lua`'s published contract exactly, that the
 * ranking puts the right three chips on screen out of a five-objective board,
 * and that a state change is announced once and only when we actually observed
 * it. The way it LOOKS is the live screenshots' job — a DOM assertion is blind
 * to CSS, and so is this file.
 */

import { describe, it, expect } from 'vitest';
import {
    MAX_OBJECTIVE_CHIPS, URGENT_FRAMES,
    completedByUs, createObjectiveAnnouncer, framesRemaining, isJoint, isResolved,
    parseObjectives, rankObjectives, resolvePlace, visibleTo,
    type ObjectiveRecord,
} from './objective-model.js';

function params(entries: Record<string, number | string>): Map<string, number | string> {
    return new Map(Object.entries(entries));
}

/** The exact shape `publish()` writes for `crossing_standoff`'s victory
 *  objective, field for field. */
const RAVEN_BASIN = {
    objective_count: 5,
    objective_1_type: 'control',
    objective_1_scope: 'strategic',
    objective_1_state: 'active',
    objective_1_reward: 300,
    objective_1_team: -1,
    objective_1_progress: 0.42,
    objective_1_victory: 1,
    objective_1_source: 'scripted',
    objective_1_region: 'raven_basin',
};

describe('parseObjectives', () => {
    it('reads every published field, coercing exactly the numeric ones', () => {
        const [o] = parseObjectives(params(RAVEN_BASIN));
        expect(o).toMatchObject({
            id: 1, type: 'control', scope: 'strategic', state: 'active',
            reward: 300, team: -1, progress: 0.42, victory: 1,
            source: 'scripted', region: 'raven_basin',
        });
        // Strings stay strings; the type tag must not become NaN.
        expect(typeof o.type).toBe('string');
        expect(typeof o.reward).toBe('number');
    });

    it('renames completed_by, the one wire field whose name differs', () => {
        const [o] = parseObjectives(params({
            objective_count: 1, objective_1_type: 'control',
            objective_1_state: 'complete', objective_1_completed_by: 1,
        }));
        expect(o.completedBy).toBe(1);
        expect((o as Record<string, unknown>).completed_by).toBeUndefined();
    });

    it('treats objective_count as a HIGH-WATER MARK and skips the gaps', () => {
        // id 2 was burned by a rejected Create; id 3 is retention-expired and
        // has no fields left. Neither may render as an empty row.
        const list = parseObjectives(params({
            objective_count: 4,
            objective_1_type: 'control', objective_1_state: 'active',
            objective_3_progress: 0.5,                 // a field with no type
            objective_4_type: 'protect', objective_4_state: 'active',
        }));
        expect(list.map((o) => o.id)).toEqual([1, 4]);
    });

    it('ignores ids past the high-water mark rather than trusting the key', () => {
        const list = parseObjectives(params({
            objective_count: 1,
            objective_1_type: 'control',
            objective_9_type: 'kill',
        }));
        expect(list.map((o) => o.id)).toEqual([1]);
    });

    it('returns nothing when the gadget has published no count at all', () => {
        expect(parseObjectives(params({ region_raven_basin_name: 'Raven Basin' }))).toEqual([]);
    });
});

describe('eligibility', () => {
    const mine: ObjectiveRecord = { id: 1, type: 'protect', team: 0 };
    const theirs: ObjectiveRecord = { id: 2, type: 'protect', team: 1 };
    const open: ObjectiveRecord = { id: 3, type: 'control', team: -1 };
    const widened: ObjectiveRecord = { id: 4, type: 'control', team: 1, team2: 0 };

    it('shows an open race to everyone and a team objective to its team', () => {
        expect(visibleTo(open, 0)).toBe(true);
        expect(visibleTo(mine, 0)).toBe(true);
        expect(visibleTo(theirs, 0)).toBe(false);
    });

    it('shows a parley-widened objective to the team the widening exists for', () => {
        // D59: the sim's own eligibility gate is `forTeam or forTeam2`, so
        // hiding it here would hide it from the only team it was widened to.
        expect(visibleTo(widened, 0)).toBe(true);
        expect(isJoint(widened)).toBe(true);
        expect(isJoint(open)).toBe(false);
    });

    it('reads an open race we did not win as not ours', () => {
        expect(completedByUs({ id: 1, type: 'control', completedBy: 1 }, 0)).toBe(false);
        expect(completedByUs({ id: 1, type: 'control', completedBy: 0 }, 0)).toBe(true);
        expect(completedByUs({ id: 1, type: 'control' }, 0)).toBe(true);
    });
});

describe('framesRemaining', () => {
    it('counts down from an absolute expiry frame', () => {
        expect(framesRemaining({ id: 1, type: 'protect', expire: 18000 }, 12000)).toBe(6000);
    });

    it('refuses to count down before the clock has answered', () => {
        // Frame 0 is "the scene feed has not spoken yet", not "the match just
        // started" — counting from it shows a wildly wrong deadline.
        expect(framesRemaining({ id: 1, type: 'protect', expire: 18000 }, 0)).toBeNull();
    });

    it('is null for an objective with no expiry, and clamps a passed one', () => {
        expect(framesRemaining({ id: 1, type: 'control' }, 900)).toBeNull();
        expect(framesRemaining({ id: 1, type: 'protect', expire: 100 }, 900)).toBe(0);
    });
});

describe('resolvePlace', () => {
    const resolvers = {
        region: (key: string) =>
            key === 'raven_basin' ? { name: 'Raven Basin', x: 4480, z: 4480 } : undefined,
        nearest: () => ({ name: 'Storm Sound', x: 896, z: 4480 }),
    };

    it('names a region hint exactly, never approximately', () => {
        const place = resolvePlace({ id: 1, type: 'control', region: 'raven_basin' }, resolvers);
        expect(place).toEqual({ name: 'Raven Basin', x: 4480, z: 4480, approximate: false });
    });

    it('marks a coordinate hint approximate — it is a unit position, not a place', () => {
        const place = resolvePlace({ id: 2, type: 'protect', x: 993, z: 4694 }, resolvers);
        expect(place).toMatchObject({ name: 'Storm Sound', x: 993, z: 4694, approximate: true });
    });

    it('returns null for a region key the index has not seen — not a guess', () => {
        // A wrong position would send the camera somewhere wrong; null greys
        // "Go there" out with a reason instead.
        expect(resolvePlace({ id: 3, type: 'control', region: 'nowhere' }, resolvers)).toBeNull();
        expect(resolvePlace({ id: 4, type: 'kill' }, resolvers)).toBeNull();
    });
});

describe('rankObjectives', () => {
    // crossing_standoff's real board for team 0, at a frame where the protect
    // objective is close to lapsing.
    const board: ObjectiveRecord[] = [
        { id: 1, type: 'control', region: 'raven_basin', reward: 300, victory: 1, progress: 0, state: 'active' },
        { id: 2, type: 'control', region: 'marrow_watch', reward: 110, progress: 0, state: 'active' },
        { id: 3, type: 'control', region: 'storm_sound', reward: 110, progress: 0, state: 'active' },
        { id: 4, type: 'control', region: 'ash_verge', reward: 110, progress: 0.31, state: 'active' },
        { id: 5, type: 'protect', team: 0, reward: 120, expire: 18000, progress: 1, state: 'active' },
    ];

    it('puts the war-ending objective first, always', () => {
        expect(rankObjectives(board, { frame: 900 })[0].id).toBe(1);
    });

    it('promotes an objective that is about to lapse over an untouched one', () => {
        const late = rankObjectives(board, { frame: 18000 - URGENT_FRAMES / 2 });
        expect(late.slice(0, 2).map((o) => o.id)).toEqual([1, 5]);
    });

    it('promotes what is underway over what has not been started', () => {
        const early = rankObjectives(board, { frame: 900 });
        expect(early.slice(0, 2).map((o) => o.id)).toEqual([1, 4]);
        // ...and the three untouched tacticals fall behind the chip cap, which
        // is the whole reason the overflow line exists.
        expect(early.slice(0, MAX_OBJECTIVE_CHIPS).map((o) => o.id)).not.toContain(2);
    });

    it('promotes something that just changed above ordinary status', () => {
        const ranked = rankObjectives(board, { frame: 900, changedIds: new Set([2]) });
        expect(ranked[1].id).toBe(2);
    });

    it('keeps a resolved outcome on screen so a loss is seen before it clears', () => {
        const withLoss = board.map((o) => (o.id === 3 ? { ...o, state: 'failed' } : o));
        expect(rankObjectives(withLoss, { frame: 900 })[1].id).toBe(3);
        expect(isResolved({ id: 3, type: 'control', state: 'failed' })).toBe(true);
        expect(isResolved({ id: 3, type: 'control', state: 'active' })).toBe(false);
    });

    it('is a total order — equal scores break by id, never by input order', () => {
        const a = rankObjectives(board, { frame: 900 }).map((o) => o.id);
        const b = rankObjectives(board.slice().reverse(), { frame: 900 }).map((o) => o.id);
        expect(a).toEqual(b);
    });
});

describe('createObjectiveAnnouncer', () => {
    const active = (id: number, extra: Partial<ObjectiveRecord> = {}): ObjectiveRecord =>
        ({ id, type: 'control', state: 'active', reward: 110, ...extra });

    it('syncs on the first read instead of replaying the match as news', () => {
        const announcer = createObjectiveAnnouncer();
        expect(announcer.ingest([active(1), active(2)], 0)).toEqual([]);
    });

    it('announces an objective that appears after we are synced', () => {
        const announcer = createObjectiveAnnouncer();
        announcer.ingest([active(1)], 0);
        const events = announcer.ingest([active(1), active(2)], 0);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ id: 2, kind: 'appeared' });
    });

    it('separates winning an open race from losing one', () => {
        const announcer = createObjectiveAnnouncer();
        announcer.ingest([active(1), active(2)], 0);
        const events = announcer.ingest([
            { ...active(1), state: 'complete', completedBy: 0 },
            { ...active(2), state: 'complete', completedBy: 1 },
        ], 0);
        expect(events.map((e) => e.kind)).toEqual(['complete', 'lost-race']);
    });

    it('announces failure and expiry as themselves', () => {
        const announcer = createObjectiveAnnouncer();
        announcer.ingest([active(1), active(2)], 0);
        const events = announcer.ingest([
            { ...active(1), state: 'failed' },
            { ...active(2), state: 'expired' },
        ], 0);
        expect(events.map((e) => e.kind)).toEqual(['failed', 'expired']);
    });

    it('announces each transition exactly once', () => {
        const announcer = createObjectiveAnnouncer();
        announcer.ingest([active(1)], 0);
        expect(announcer.ingest([{ ...active(1), state: 'complete' }], 0)).toHaveLength(1);
        expect(announcer.ingest([{ ...active(1), state: 'complete' }], 0)).toEqual([]);
    });

    it('does not announce an objective first seen already resolved', () => {
        // Mounting mid-retention-window is history, not news.
        const announcer = createObjectiveAnnouncer();
        announcer.ingest([active(1)], 0);
        expect(announcer.ingest([active(1), { ...active(9), state: 'failed' }], 0)).toEqual([]);
    });

    it('snapshots the record, so a notice survives the params being cleared', () => {
        const announcer = createObjectiveAnnouncer();
        const live = active(1);
        announcer.ingest([live], 0);
        const [event] = announcer.ingest([{ ...live, state: 'failed', progress: 0.47 }], 0);
        expect(event.record).toMatchObject({ reward: 110, progress: 0.47 });
        expect(announcer.ingest([], 0)).toEqual([]);   // retention expiry: silent
        expect(event.record.reward).toBe(110);
    });
});
