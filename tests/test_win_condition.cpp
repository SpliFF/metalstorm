#include <doctest/doctest.h>

#include "Server/GameOverState.h"

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
