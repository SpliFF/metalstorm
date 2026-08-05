#include <doctest/doctest.h>

#include "Game/Players/PlayerHandler.h"

// PLAN-long-uptime S12 — a game must not die at its 251st authentication.
//
// `CPlayerHandler::players` is capacity-pinned to MAX_PLAYERS with the header
// invariant "must never be resized beyond MAX_PLAYERS!", and nothing ever
// erases from it: a disconnect resolves to `active = false`. The auth path
// used to append a row per authentication, so a reconnecting browser (the
// common case — it stores its lobby session token) consumed a slot per tab
// reload. In a debug build the 252nd auth trips AddPlayer's assert; in a
// release build it silently reallocates past the reserve.
//
// The fix is `HumanPlayer(name)`: a returning account resolves back to the row
// it already owns. These cases pin the lookup's semantics and, in the last
// case, the growth property that is the whole point.
//
// Every case starts from `ResetState()` — that is the state the game server
// runs a handler in, and it is what reserves the capacity AddPlayer asserts on.

namespace {

CPlayer human(const std::string& name, int team, int playerNum,
              bool spectator = false)
{
    CPlayer p;
    p.name      = name;
    p.team      = team;
    p.active    = true;
    p.playerNum = playerNum;
    p.spectator = spectator;
    return p;
}

CPlayer ai(const std::string& name, int team, int playerNum)
{
    CPlayer p = human(name, team, playerNum);
    p.isAI = true;
    return p;
}

} // namespace

TEST_CASE("HumanPlayer: an unknown account owns no row") {
    CPlayerHandler h;
    h.ResetState();
    CHECK(h.HumanPlayer("nobody") == -1);

    h.AddPlayer(human("alice", 0, 0));
    CHECK(h.HumanPlayer("nobody") == -1);
    CHECK(h.HumanPlayer("alice") == 0);
}

TEST_CASE("HumanPlayer: a DISCONNECTED account still owns its row") {
    // The case the whole fix exists for. PlayerLeft only clears `active`, and
    // a reconnect must land back on the same playerNum — every score_* and
    // authority_player_* rulesParam is keyed on it (S2).
    CPlayerHandler h;
    h.ResetState();
    h.AddPlayer(human("alice", 0, 0));
    h.PlayerLeft(0, /*reason=*/0);

    REQUIRE(h.Player(0)->active == false);
    CHECK(h.HumanPlayer("alice") == 0);
}

TEST_CASE("HumanPlayer: AI virtual players are never resolved as accounts") {
    // AI slots are real players here (a deliberate departure from stock
    // Spring) and hold their playerNum for the game's lifetime. They must not
    // be handed to an authenticating human even on a name collision.
    CPlayerHandler h;
    h.ResetState();
    h.AddPlayer(ai("AI:strategos@t4", 4, 0));
    h.AddPlayer(human("alice", 0, 1));

    CHECK(h.HumanPlayer("AI:strategos@t4") == -1);
    CHECK(h.HumanPlayer("alice") == 1);
    // Player(name) does NOT filter — the difference between the two is the
    // reason HumanPlayer exists rather than reusing it.
    CHECK(h.Player("AI:strategos@t4") == 0);
}

TEST_CASE("HumanPlayer: distinct accounts keep distinct rows") {
    CPlayerHandler h;
    h.ResetState();
    h.AddPlayer(human("alice", 0, 0));
    h.AddPlayer(human("bob", 1, 1));
    h.AddPlayer(human("carol", 2, 2, /*spectator=*/true));

    CHECK(h.HumanPlayer("alice") == 0);
    CHECK(h.HumanPlayer("bob") == 1);
    CHECK(h.HumanPlayer("carol") == 2);
    CHECK(h.ActivePlayers() == 3);
}

TEST_CASE("re-authenticating a returning account does not grow the roster") {
    // The regression itself, at the scale that used to kill the game.
    CPlayerHandler h;
    h.ResetState();
    h.AddPlayer(ai("AI:strategos@t4", 4, 0));
    h.AddPlayer(human("alice", 0, 1));
    REQUIRE(h.ActivePlayers() == 2);

    // 400 reconnects — well past MAX_PLAYERS (251), which is where the old
    // append-per-auth path aborted.
    for (int i = 0; i < 400; ++i) {
        h.PlayerLeft(1, /*reason=*/0);
        const int reused = h.HumanPlayer("alice");
        REQUIRE(reused == 1);
        h.AddPlayer(human("alice", 0, reused));
    }

    CHECK(h.ActivePlayers() == 2);          // still two rows
    CHECK(h.Player(1)->active == true);     // and the last one re-activated it
    CHECK(h.Player(1)->name == "alice");
    CHECK(h.Player(0)->isAI == true);        // the AI kept its slot throughout
}

TEST_CASE("a fresh account after 400 reconnects still gets the next slot") {
    // The counter-side of the reuse rule: reuse must not advance the
    // allocation cursor, or the next NEW player skips a slot — which is also
    // what a replay's player-number cross-check would report as a divergence.
    CPlayerHandler h;
    h.ResetState();
    int nextPlayerNum = 0;

    // The allocation rule the auth path applies, in full.
    auto authenticate = [&](const std::string& name, int team) {
        const int existing = h.HumanPlayer(name);
        const int pNum = (existing >= 0) ? existing : nextPlayerNum;
        if (pNum >= nextPlayerNum)
            nextPlayerNum = pNum + 1;
        h.AddPlayer(human(name, team, pNum));
        return pNum;
    };

    CHECK(authenticate("alice", 0) == 0);
    for (int i = 0; i < 400; ++i)
        CHECK(authenticate("alice", 0) == 0);

    CHECK(nextPlayerNum == 1);
    CHECK(authenticate("bob", 1) == 1);
    CHECK(h.ActivePlayers() == 2);
    CHECK(nextPlayerNum == 2);
}
