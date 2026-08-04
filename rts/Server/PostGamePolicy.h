// PostGamePolicy — what a game server stops doing once the match is over.
//
// WHY THIS EXISTS: `Spring.GameOver` used to be a *notification* and nothing
// else. GameOverRelay handed the winners to StateStreamer, StateStreamer
// broadcast one `GameInfo{game_over}`, both clients drew the right overlay —
// and then the server carried on as if nothing had happened. Observed live on
// Meridian Basin (2026-08-03, main @ee3395b1cd): the win was declared at frame
// 14610 and the sim was still ticking at frame 26496 seven wall-clock minutes
// later, the objective generator had grown the board from 9 objectives to 34,
// authority pools kept accruing, and a `StandingOrderCreate` posted after the
// win was still accepted *and charged*. The overlay was the only thing that
// had ended; the match had not.
//
// THE DESIGN CALL: game over freezes the world. The sim stops advancing at the
// frame the win was declared (server_main's SimFrame gate), the per-tick
// broadcast pipeline stops after the game-over GameInfo (StateStreamer::Tick),
// every sim-reaching client verb is refused (RejectsClientPayload below), and
// the process exits after a bounded observation window (ShouldExit below),
// releasing its port. The alternative — keep simulating and gate each producer
// individually — was rejected: it is unbounded whack-a-mole (the generator and
// the authority income were only two of the producers found), and it leaves
// the sim diverging from the final state the clients were shown as "the
// result". A frozen world is the only state that stays true to the overlay.
//
// The two predicates here are pure so they can be tested without a live sim;
// tests/test_win_condition.cpp owns the coverage.
#pragma once

#include <cstdint>

#include "SyncedInputJournal.h"
#include "protocol_generated.h"

namespace postgame {

/// Default length of the post-game observation window, in wall-clock seconds.
/// Long enough that a player who wants to look at the final board before
/// clicking "Return to Lobby" is not evicted mid-look; short enough that a
/// finished room does not hold its port for the rest of the day. Overridable
/// per-server (`--postgame-exit-seconds`, `SPRING_POSTGAME_EXIT_SECONDS`);
/// <= 0 disables the timer and leaves the frozen server up until the normal
/// idle-exit path collects it.
inline constexpr int kDefaultExitSeconds = 180;

/// True when an inbound client verb must be refused because the match is over.
///
/// Built on the journal's existing wire classification rather than a second
/// hand-maintained list: `WireClass::Synced` is already defined as "these
/// reach the sim", and the sim is frozen, so applying one would mutate state
/// the clients have been told is final. Deriving the gate from that switch
/// means a newly added synced verb is refused post-game *by construction* —
/// which is exactly how `StandingOrderCreate` slipped through when the gate
/// was client-side only (the overlay covering the screen), a check any
/// scripted or reconnecting client walks straight past.
///
/// `ConsoleCommand` is the one deliberate exception. It is admin-only
/// (ClientMessageHandler checks `session->role != "admin"`) and it is the
/// channel spring-debug / the GM dashboard inspect a finished game through;
/// refusing it would make the post-game state unobservable, which is the
/// opposite of what the observation window is for.
inline bool RejectsClientPayload(uint8_t payloadType) {
    if (payloadType == SpringWeb::ClientPayload_ConsoleCommand)
        return false;
    return syncedinput::ClassifyClientPayload(payloadType) ==
           syncedinput::WireClass::Synced;
}

/// Bounded post-game observation window: true once a finished server has been
/// sitting frozen for `windowSeconds` and should shut down (releasing its
/// port, and clearing its `game_status` row on the way out).
///
/// `windowSeconds <= 0` disables the timer. Kept as a predicate rather than
/// inlined into the tick loop so the boundary is testable — the live loop only
/// supplies the clock.
inline bool ShouldExit(bool gameOverDeclared, int secondsSinceGameOver,
                       int windowSeconds) {
    return gameOverDeclared && windowSeconds > 0 &&
           secondsSinceGameOver >= windowSeconds;
}

} // namespace postgame
