#include <doctest/doctest.h>

#include "Server/GameOverState.h"
#include "Server/PostGamePolicy.h"

// task-victory-fix — regression coverage for the instant-gameover bug: a
// fresh Meridian direct-start room fired "Ally team 0 is victorious!" at
// frame ~60 because StateStreamer::CheckWinCondition's hardcoded
// last-team-standing fallback (teams 0/1, alive-unit-count == 0) fired before
// any Metalstorm side had spawned/counts as "eliminated" an AI/NullAI filler
// slot that never had a start unit to begin with.
//
// PLAN-metalstorm-teams.md §4: "GameOver conditions are objective/scenario
// -driven, never 'team has no players'" — so this fallback must never run
// for Metalstorm, cheat state notwithstanding.

TEST_CASE("ShouldRunEliminationFallback: metalstorm never runs the fallback") {
    CHECK_FALSE(ShouldRunEliminationFallback("metalstorm", /*cheatEnabled=*/false));
    CHECK_FALSE(ShouldRunEliminationFallback("metalstorm", /*cheatEnabled=*/true));
}

TEST_CASE("ShouldRunEliminationFallback: cheats disable the fallback for any game") {
    CHECK_FALSE(ShouldRunEliminationFallback("papertanks", /*cheatEnabled=*/true));
    CHECK_FALSE(ShouldRunEliminationFallback("", /*cheatEnabled=*/true));
}

TEST_CASE("ShouldRunEliminationFallback: non-metalstorm games without cheats still run it") {
    CHECK(ShouldRunEliminationFallback("papertanks", /*cheatEnabled=*/false));
}

// ── Post-game teardown (metalstorm-gameover-teardown, 2026-08-03) ──────────
// The bug these cover: declaring a winner was a notification and nothing more.
// The sim ran on past the declared frame (14610 → 26496+ on a live Meridian
// room), the objective generator kept spawning into a finished war (9 → 34),
// and a StandingOrderCreate posted after the win was accepted and charged.
// See PostGamePolicy.h.

TEST_CASE("GameOverRelay: retains the result for late joiners after the one-shot") {
    GameOverRelay relay;
    CHECK_FALSE(relay.IsDeclared());

    relay.Declare({4, 5, 6, 7}, /*frame=*/14610);
    CHECK(relay.IsDeclared());

    // The broadcast fires exactly once…
    std::vector<uint8_t> out;
    CHECK(relay.ConsumePending(out));
    CHECK(out == std::vector<uint8_t>{4, 5, 6, 7});
    out.clear();
    CHECK_FALSE(relay.ConsumePending(out));

    // …but the result stays readable, which is what lets a session that
    // authenticates after the win be told the game is over instead of being
    // handed a live-looking HUD.
    CHECK(relay.Winners() == std::vector<uint8_t>{4, 5, 6, 7});
    CHECK(relay.DeclaredFrame() == 14610);
}

TEST_CASE("GameOverRelay: first declaration wins, frame included") {
    GameOverRelay relay;
    relay.Declare({0}, /*frame=*/100);
    relay.Declare({1, 2}, /*frame=*/900);
    CHECK(relay.Winners() == std::vector<uint8_t>{0});
    CHECK(relay.DeclaredFrame() == 100);
}

TEST_CASE("postgame::RejectsClientPayload: sim-reaching verbs are refused") {
    // The exact verb caught being accepted *and charged* post-win live.
    CHECK(postgame::RejectsClientPayload(SpringWeb::ClientPayload_StandingOrderCreate));
    CHECK(postgame::RejectsClientPayload(SpringWeb::ClientPayload_PlayerCommand));
    CHECK(postgame::RejectsClientPayload(SpringWeb::ClientPayload_PlayerCommandBatch));
    CHECK(postgame::RejectsClientPayload(SpringWeb::ClientPayload_GroupDirective));
    CHECK(postgame::RejectsClientPayload(SpringWeb::ClientPayload_OrgGroupCreate));
    CHECK(postgame::RejectsClientPayload(SpringWeb::ClientPayload_LuaRulesMsg));
}

TEST_CASE("postgame::RejectsClientPayload: connection + view verbs still work") {
    // A late joiner must be able to authenticate — that is how it gets told
    // the game is over at all.
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_AuthRequest));
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_Handshake));
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_Ping));
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_ViewportUpdate));
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_SelectionState));
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_PlayerLeaveIntent));
}

TEST_CASE("postgame::RejectsClientPayload: admin console stays open for post-mortem") {
    // Classified Synced (it execs arbitrary Lua) but deliberately exempt —
    // it is admin-gated, and it is how spring-debug / the GM dashboard read a
    // finished game. Refusing it would make the observation window useless.
    CHECK(syncedinput::ClassifyClientPayload(SpringWeb::ClientPayload_ConsoleCommand) ==
          syncedinput::WireClass::Synced);
    CHECK_FALSE(postgame::RejectsClientPayload(SpringWeb::ClientPayload_ConsoleCommand));
}

TEST_CASE("postgame::RejectsClientPayload: every Synced verb but the console is gated") {
    // Coverage by construction rather than by list: the gate is derived from
    // the journal's classifier, so a synced verb added later is refused
    // post-game without anyone remembering to update this file. If that
    // derivation is ever replaced by a hand-maintained set, this fails.
    // ClientPayload_MAX is the last valid tag, not a past-the-end count.
    for (int tag = SpringWeb::ClientPayload_MIN; tag <= SpringWeb::ClientPayload_MAX; ++tag) {
        if (tag == SpringWeb::ClientPayload_ConsoleCommand) continue;
        const auto t = static_cast<uint8_t>(tag);
        const bool synced = syncedinput::ClassifyClientPayload(t) ==
                            syncedinput::WireClass::Synced;
        CHECK(postgame::RejectsClientPayload(t) == synced);
    }
}

TEST_CASE("postgame::ShouldExit: the observation window is bounded and inclusive") {
    CHECK_FALSE(postgame::ShouldExit(/*over=*/true, 179, 180));
    CHECK(postgame::ShouldExit(/*over=*/true, 180, 180));
    CHECK(postgame::ShouldExit(/*over=*/true, 9999, 180));
}

TEST_CASE("postgame::ShouldExit: never exits a game that is still being played") {
    CHECK_FALSE(postgame::ShouldExit(/*over=*/false, 9999, 180));
}

TEST_CASE("postgame::ShouldExit: a non-positive window disables the timer") {
    CHECK_FALSE(postgame::ShouldExit(/*over=*/true, 9999, 0));
    CHECK_FALSE(postgame::ShouldExit(/*over=*/true, 9999, -1));
}
