import { describe, expect, it } from 'vitest';
import { decideRoomTransition, RoomState, type RoomViewState } from './room-transition.js';

// PLAN-endtoend.md D25 — after a war finished, the room view kept reading
// "Loading" and kept offering "Rejoin Game" against a port whose subprocess
// had exited; pressing it mounted an empty game shell with no way back.
//
// The cause was not the button. Entering a game stops the room stream, and
// nothing restarted it, so every fact the room view rendered was the fact it
// had at kickoff. These cases pin the decision the stream drives.

const IN_LOBBY: RoomViewState = { gameStartedForRoomId: null, inGame: false, detached: false };
const PLAYED_ROOM_7: RoomViewState = { gameStartedForRoomId: 7, inGame: false, detached: false };
const IN_GAME_ROOM_7: RoomViewState = { gameStartedForRoomId: 7, inGame: true, detached: false };
const PARKED_ROOM_7: RoomViewState = { gameStartedForRoomId: 7, inGame: false, detached: true };

describe('decideRoomTransition', () => {
    it('enters the game the first time a room goes Active with a port', () => {
        expect(decideRoomTransition(7, RoomState.Active, 9100, IN_LOBBY)).toBe('enter-game');
    });

    it('enters on Loading too — the room need not reach Active first', () => {
        expect(decideRoomTransition(7, RoomState.Loading, 9100, IN_LOBBY)).toBe('enter-game');
    });

    it('does not re-enter while the game surface already owns the screen', () => {
        // The double-fire guard: attachSession's background /api/rooms and a
        // direct setCurrentRoomFromJson both land here in quick succession.
        expect(decideRoomTransition(7, RoomState.Active, 9100, IN_GAME_ROOM_7)).toBe('stay-in-game');
    });

    it('refreshes the room instead of re-entering when the player is back in the lobby', () => {
        // D25's core case. The war is over but PostGamePolicy keeps the
        // subprocess alive ~180 s, so the room is still Active with a live
        // port. Re-hiding the lobby here left a blank page; freezing the view
        // here left the dead "Rejoin Game" button.
        expect(decideRoomTransition(7, RoomState.Active, 9100, PLAYED_ROOM_7)).toBe('refresh-room');
    });

    it('still enters a DIFFERENT room after playing one', () => {
        expect(decideRoomTransition(8, RoomState.Active, 9100, PLAYED_ROOM_7)).toBe('enter-game');
    });

    it('never drags a parked (detached) session back into the game', () => {
        expect(decideRoomTransition(7, RoomState.Active, 9100, PARKED_ROOM_7)).toBe('refresh-room');
    });

    it('treats a recycled room as the game being gone, not as pregame noise', () => {
        // The lobby resets a finished room to Filling when the subprocess
        // exits (RoomManager::ResetRoomForNextGame) — a finished war is a
        // *pregame* room and never reaches Ended. The old `state >= 5` test
        // missed exactly this, which is why the reconnect creds and the start
        // guard were never cleared, and why the parked-worker dispose hook
        // (E4) only ever fired via its 10-minute TTL.
        expect(decideRoomTransition(7, RoomState.Filling, 0, PLAYED_ROOM_7))
            .toBe('refresh-room-game-gone');
    });

    it('also reports game-gone for the explicit Ended state', () => {
        expect(decideRoomTransition(7, RoomState.Ended, 0, PLAYED_ROOM_7))
            .toBe('refresh-room-game-gone');
    });

    it('reports game-gone for a parked session too, so E4 can dispose the worker', () => {
        expect(decideRoomTransition(7, RoomState.Filling, 0, PARKED_ROOM_7))
            .toBe('refresh-room-game-gone');
    });

    it('does not enter a running room that has no port yet, and does not clear creds', () => {
        // Start requested, subprocess has not published its port. The next
        // update carries it.
        expect(decideRoomTransition(7, RoomState.Loading, 0, IN_LOBBY)).toBe('refresh-room');
    });

    it('re-arms after a recycle, so a second game in the same room is entered', () => {
        const afterRecycle: RoomViewState = { gameStartedForRoomId: null, inGame: false, detached: false };
        expect(decideRoomTransition(7, RoomState.Active, 9101, afterRecycle)).toBe('enter-game');
    });

    it('leaves a pregame room alone apart from clearing dead creds', () => {
        expect(decideRoomTransition(7, RoomState.ReadyCheck, 0, IN_LOBBY))
            .toBe('refresh-room-game-gone');
    });

    // PLAN-persistence Q-P3 — the Rejoin button resumed a war and did not enter
    // it. The server half was perfect (`resuming the war from frame 6966` →
    // `resuming` → `back`); the browser landed on the room screen because the
    // war had been visited once already in this page session, so the rule above
    // read it as a skirmish winding down. A page reload rescued it, which is why
    // every earlier fire — each a fresh page — missed it.
    describe('a persistent war revisited in one page session', () => {
        const ASKED_TO_REJOIN_7: RoomViewState = {
            gameStartedForRoomId: 7, inGame: false, detached: false,
            rejoinRequestedRoomId: 7,
        };

        it('re-enters a live war the player has explicitly asked to rejoin', () => {
            expect(decideRoomTransition(7, RoomState.Active, 9100, ASKED_TO_REJOIN_7, 'persistent'))
                .toBe('enter-game');
        });

        it('does NOT re-enter on a passive update with no request behind it', () => {
            // The regression the intent flag exists to prevent: a war broadcasts
            // on a ~5 s tick (task 6), so without this a player who quit to the
            // lobby would be dragged back in by the next one, forever.
            expect(decideRoomTransition(7, RoomState.Active, 9100, PLAYED_ROOM_7, 'persistent'))
                .toBe('refresh-room');
        });

        it('does not re-enter a SKIRMISH on the same explicit request', () => {
            // A skirmish is played once and winds down; D25's dead-shell bug is
            // that state. Only a war is a world that outlives the visit.
            expect(decideRoomTransition(7, RoomState.Active, 9100, ASKED_TO_REJOIN_7, 'skirmish'))
                .toBe('refresh-room');
        });

        it('treats a room with no session kind on the wire as a skirmish', () => {
            expect(decideRoomTransition(7, RoomState.Active, 9100, ASKED_TO_REJOIN_7))
                .toBe('refresh-room');
        });

        it('honours a request for a DIFFERENT war than the update describes', () => {
            const askedFor8: RoomViewState = {
                gameStartedForRoomId: 7, inGame: false, detached: false,
                rejoinRequestedRoomId: 8,
            };
            expect(decideRoomTransition(7, RoomState.Active, 9100, askedFor8, 'persistent'))
                .toBe('refresh-room');
        });

        it('still never drags a parked session back in, request or not', () => {
            const parkedAndAsked: RoomViewState = {
                gameStartedForRoomId: 7, inGame: false, detached: true,
                rejoinRequestedRoomId: 7,
            };
            expect(decideRoomTransition(7, RoomState.Active, 9100, parkedAndAsked, 'persistent'))
                .toBe('refresh-room');
        });

        it('stays in the game when the request races the update that entered', () => {
            const inGameAndAsked: RoomViewState = {
                gameStartedForRoomId: 7, inGame: true, detached: false,
                rejoinRequestedRoomId: 7,
            };
            expect(decideRoomTransition(7, RoomState.Active, 9100, inGameAndAsked, 'persistent'))
                .toBe('stay-in-game');
        });

        it('does not enter a war whose resumed process has not published a port', () => {
            // The `resuming` window: the lobby has forked the server and the
            // port is not up. `canJoin` is false on that toast for the same
            // reason (war-notice), but the room row can still arrive first.
            expect(decideRoomTransition(7, RoomState.Loading, 0, ASKED_TO_REJOIN_7, 'persistent'))
                .toBe('refresh-room');
        });

        it('reports game-gone for a war that is not running, request and all', () => {
            expect(decideRoomTransition(7, RoomState.Filling, 0, ASKED_TO_REJOIN_7, 'persistent'))
                .toBe('refresh-room-game-gone');
        });
    });
});
