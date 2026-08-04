import { describe, it, expect } from 'vitest';
import {
    describeReplayEntry, parseWatchFrame, type ReplayListing,
} from './replay-browser.js';

const base: ReplayListing = {
    file: 'room-42-p9100.msr',
    bytes: 17_195,
    ok: true,
    game: 'metalstorm',
    map: 'meridian_basin',
    room_id: 42,
    recorded_at: '2026-08-04T18:30:00Z',
    start_frame: -1,
    end_frame: 6150,
    truncated: false,
    codec: 'none',
    records: 151,
    hash_points: 20,
    checkpoints: 0,
    players: [{ username: 't2a_north', team: 0, start_pos: 0 }],
    ai_slots: [{ ai_id: 'strategos', team: 4, start_pos: 1 }],
    outcome: { declared: true, frame: 6150, winning_ally_teams: [4] },
};

describe('describeReplayEntry', () => {
    it('shows map, duration, roster and who won', () => {
        const m = describeReplayEntry(base);
        expect(m.title).toBe('meridian_basin · metalstorm');
        expect(m.duration).toBe('3:25');
        expect(m.outcome).toBe('team 4 won');
        expect(m.players).toBe('t2a_north, AI:strategos');
        expect(m.watchLabel).toBe('Watch');
        expect(m.disabled).toBe(false);
    });

    it('distinguishes a game with no result from a recording that was cut off', () => {
        // The two look identical in the container — no outcome block — and
        // mean completely different things to someone choosing what to watch.
        const stopped = describeReplayEntry({ ...base, outcome: { declared: false } });
        expect(stopped.outcome).toBe('no result');

        const crashed = describeReplayEntry({
            ...base, outcome: { declared: false }, truncated: true,
        });
        expect(crashed.outcome).toBe('recording cut short');
        expect(crashed.detail).toContain('truncated');
    });

    it('reads a draw and a multi-team win', () => {
        expect(describeReplayEntry({
            ...base, outcome: { declared: true, frame: 10, winning_ally_teams: [] },
        }).outcome).toBe('draw');
        expect(describeReplayEntry({
            ...base, outcome: { declared: true, frame: 10, winning_ally_teams: [0, 2] },
        }).outcome).toBe('teams 0, 2 won');
    });

    it('warns up front that a replay without checkpoints only seeks forward', () => {
        // T4b-1: the bar refuses a backward seek. A viewer should not learn
        // that by clicking.
        expect(describeReplayEntry(base).detail).toContain('forward seek only');
        expect(describeReplayEntry({ ...base, checkpoints: 3 }).detail)
            .not.toContain('forward seek only');
    });

    it('flags a recording that cannot be verified', () => {
        expect(describeReplayEntry({ ...base, hash_points: 0 }).detail)
            .toContain('no hash track');
        expect(describeReplayEntry(base).detail).not.toContain('no hash track');
    });

    it('keeps an unreadable file as a visible, unwatchable row', () => {
        const m = describeReplayEntry({
            file: 'broken.msr', bytes: 12, ok: false,
            error: 'not a replay file (bad magic): broken.msr',
        });
        expect(m.disabled).toBe(true);
        expect(m.outcome).toBe('unreadable');
        expect(m.detail).toContain('bad magic');
        expect(m.title).toBe('broken.msr');
    });

    it('offers to join an existing cast rather than start a second server', () => {
        expect(describeReplayEntry({ ...base, watching_room: 7 }).watchLabel)
            .toBe('Join cast');
    });

    it('falls back to the filename when the header carries no map', () => {
        const m = describeReplayEntry({ ...base, map: '', game: '' });
        expect(m.title).toBe('room-42-p9100.msr');
    });

    it('says nothing about duration when there are no frames to measure', () => {
        const m = describeReplayEntry({ ...base, start_frame: 0, end_frame: 0 });
        expect(m.duration).toBe('');
        expect(m.detail).not.toContain('0:00');
    });
});

describe('parseWatchFrame', () => {
    it('takes a positive integer', () => {
        expect(parseWatchFrame('5217')).toBe(5217);
    });
    it('treats anything else as the start of the recording', () => {
        // A bad deep link should still play the game the person came for.
        expect(parseWatchFrame(null)).toBe(0);
        expect(parseWatchFrame('')).toBe(0);
        expect(parseWatchFrame('-3')).toBe(0);
        expect(parseWatchFrame('abc')).toBe(0);
        expect(parseWatchFrame('0')).toBe(0);
    });
});
