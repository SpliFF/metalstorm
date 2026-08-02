#include <doctest/doctest.h>

#include "Server/TeamLeaderSelect.h"

#include <vector>

// AI3 (PLAN-metalstorm-ai.md §1) — leader-selection policy for FireGameStart.
// AI slots are now real virtual players on their team, so an AI team leads
// itself (no more borrowing the host human via SetLeader). On a MIXED team
// (co-commander: an AI shares a human's team) the HUMAN must lead. This pins
// that policy; Simulation.cpp's FireGameStart calls the same helper.

using TeamLeaderSelect::Candidate;
using TeamLeaderSelect::SelectLeader;

static int pick(std::vector<Candidate> c) {
    return SelectLeader(c.begin(), c.end());
}

TEST_CASE("SelectLeader: full-side AI team is led by its own AI player") {
    // Only an AI on the team → the AI leads (never leaderless, never the host).
    CHECK(pick({{0, /*isAI=*/true}}) == 0);
    CHECK(pick({{3, true}, {5, true}}) == 3);  // lowest AI
}

TEST_CASE("SelectLeader: pure-human team is led by the lowest human") {
    CHECK(pick({{2, false}}) == 2);
    CHECK(pick({{2, false}, {4, false}}) == 2);
}

TEST_CASE("SelectLeader: mixed (co-commander) team is led by the HUMAN, not the AI") {
    // AI registered first (lower playerNum) must NOT outrank the human.
    CHECK(pick({{0, /*AI*/ true}, {2, /*human*/ false}}) == 2);
    // Human first, AI second — still the human.
    CHECK(pick({{2, false}, {6, true}}) == 2);
    // Two humans + an AI → lowest human.
    CHECK(pick({{0, true}, {3, false}, {8, false}}) == 3);
}

TEST_CASE("SelectLeader: empty team is honestly leaderless (-1)") {
    CHECK(pick({}) == -1);
}
