import { describe, expect, it } from 'vitest';
import { resolveRoomSeat, roomSeatStatus, type RoomSeatQuery } from './room-seat.js';

// PLAN-persistence Q-P3, second half. A player resumed into their war was
// rendered "Spectator" on the room screen and offered **Enlist**, for a war
// whose own join-preview row said `enlisted: true, seat: restored`. The room
// screen was labelling off `is_spectator`, which on a RUNNING room means "not
// seated by the lobby" — true of every fighter the game server seated itself.

const base: RoomSeatQuery = {
    running: false, isWar: false, mine: true, isSpectatorFlag: false,
};

describe('resolveRoomSeat', () => {
    it('reads the flag for a pre-game room, where the lobby did the seating', () => {
        expect(resolveRoomSeat({ ...base, isSpectatorFlag: true })).toBe('spectator');
        expect(resolveRoomSeat({ ...base, isSpectatorFlag: false })).toBe('fighter');
    });

    it('reads the flag for a running skirmish — its roster was fixed at spawn', () => {
        expect(resolveRoomSeat({ ...base, running: true, isSpectatorFlag: true }))
            .toBe('spectator');
    });

    it('calls a resumed war fighter a fighter, against the flag', () => {
        // The defect, exactly: the flag says spectator, the preview says the
        // account holds this seat.
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, isSpectatorFlag: true,
            preview: { will_fight: true, enlisted: true },
        })).toBe('fighter');
    });

    it('trusts `enlisted` even when a fresh join would be declined', () => {
        // A full side turns away a new volunteer, never the veteran already
        // holding the seat (task 4's capacity rule) — so `will_fight: false`
        // with a binding is still a fighter.
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, isSpectatorFlag: true,
            preview: { will_fight: false, enlisted: true },
        })).toBe('fighter');
    });

    it('honours a chosen watch over any seating rule', () => {
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, isSpectatorFlag: true,
            preview: { will_fight: true, enlisted: true, watching: true },
        })).toBe('spectator');
    });

    it('calls a declined account a spectator — the one true case in a war', () => {
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, isSpectatorFlag: true,
            preview: { will_fight: false },
        })).toBe('spectator');
    });

    it('cannot answer for ANOTHER player in a running war', () => {
        // Nothing publishes per-player seats for a live war: the war summary
        // carries counts, not identities (task 6). `unknown` is the honest
        // answer, and rendering it as "Spectator" is the bug one row over.
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, mine: false, isSpectatorFlag: true,
        })).toBe('unknown');
    });

    it('falls back to the flag for a war with no preview', () => {
        // `join-preview` is an enrichment and its failure is swallowed by
        // design, so a war with no row must behave exactly as it did before.
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, isSpectatorFlag: true,
        })).toBe('spectator');
        expect(resolveRoomSeat({
            ...base, running: true, isWar: true, isSpectatorFlag: false,
        })).toBe('fighter');
    });
});

describe('roomSeatStatus', () => {
    it('says Fighting for a seated player in a running room', () => {
        expect(roomSeatStatus('fighter', false, true)).toBe('Fighting');
    });

    it('keeps the pre-game ready wording', () => {
        expect(roomSeatStatus('fighter', true, false)).toBe('✓ Ready');
        expect(roomSeatStatus('fighter', false, false)).toBe('—');
    });

    it('says Spectator for a spectator either side of kickoff', () => {
        expect(roomSeatStatus('spectator', false, true)).toBe('Spectator');
        expect(roomSeatStatus('spectator', true, false)).toBe('Spectator');
    });

    it('claims nothing for an unknown seat', () => {
        expect(roomSeatStatus('unknown', true, true)).toBe('—');
    });
});
