#include <doctest/doctest.h>

#include "Server/WarSummary.h"

// PLAN-metalstorm-lobby.md §4, task 6 — the per-war digest the browser lists.
//
// The digest is a value function of three inputs the sim holds (its player
// rows, its region params, its frame) and one the room holds (`war_sides`),
// which is what makes it testable without a sim at all. Two properties carry
// the weight:
//
//   * a side with nobody on it is still a side — it is the row a player
//     looking for a war is looking FOR, and a summary built from "teams that
//     have players" would hide exactly those;
//   * the decoder refuses anything it cannot vouch for, because the browser's
//     degraded state (lobby-derived numbers only) is already correct for a
//     war whose server is down, and a half-read digest is not.

namespace {

WarSides TwoSides() {
    WarSides s;
    s.push_back({"compact", 0});
    s.push_back({"union", 1});
    return s;
}

WarSummaryPlayer Human(int team) { return {team, false, false, true}; }
WarSummaryPlayer Ai(int team)    { return {team, false, true,  true}; }
WarSummaryPlayer Spectator()     { return {-1,   true,  false, true}; }

}  // namespace

TEST_CASE("BuildWarSummary counts humans and AIs per declared side") {
    const auto s = BuildWarSummary(
        TwoSides(),
        {Human(0), Human(0), Ai(0), Human(1), Spectator(), Spectator()},
        {}, 1200, 90);

    REQUIRE(s.sides.size() == 2);
    CHECK(s.sides[0].faction == "compact");
    CHECK(s.sides[0].team == 0);
    CHECK(s.sides[0].humans == 2);
    CHECK(s.sides[0].ais == 1);
    CHECK(s.sides[1].faction == "union");
    CHECK(s.sides[1].humans == 1);
    CHECK(s.sides[1].ais == 0);
    CHECK(s.spectators == 2);
    CHECK(s.frame == 1200);
    CHECK(s.uptimeSec == 90);
}

TEST_CASE("a side nobody is on is still published") {
    // The whole point of the browser: the empty side is the joinable one.
    const auto s = BuildWarSummary(TwoSides(), {Human(0)}, {}, 0, 0);
    REQUIRE(s.sides.size() == 2);
    CHECK(s.sides[1].faction == "union");
    CHECK(s.sides[1].humans == 0);
}

TEST_CASE("inactive players and off-side teams are not counted") {
    WarSummaryPlayer gone = Human(0);
    gone.active = false;
    // team 4 is not a declared side (a scenario's civilian/gaia team); it
    // must not create a third row or be counted into either real one.
    const auto s = BuildWarSummary(TwoSides(), {gone, Human(4)}, {}, 0, 0);
    REQUIRE(s.sides.size() == 2);
    CHECK(s.sides[0].humans == 0);
    CHECK(s.sides[1].humans == 0);
}

TEST_CASE("a spectator is never counted against a side") {
    // A spectator's team is -1, so this only bites if the team lookup runs
    // first — which is why the builder checks `spectator` before it.
    WarSummaryPlayer specOnTeam = Spectator();
    specOnTeam.team = 0;   // a stale team on a spectator row
    const auto s = BuildWarSummary(TwoSides(), {specOnTeam}, {}, 0, 0);
    CHECK(s.sides[0].humans == 0);
    CHECK(s.spectators == 1);
}

TEST_CASE("an AI spectator is not a viewer") {
    WarSummaryPlayer aiSpec = Ai(-1);
    aiSpec.spectator = true;
    const auto s = BuildWarSummary(TwoSides(), {aiSpec}, {}, 0, 0);
    CHECK(s.spectators == 0);
}

TEST_CASE("region control splits into per-side, contested and neutral") {
    const std::vector<WarSummaryRegion> regions = {
        {0, false}, {0, true}, {1, false}, {-1, false}, {-1, true}, {4, false},
    };
    const auto s = BuildWarSummary(TwoSides(), {}, regions, 0, 0);
    CHECK(s.control.total == 6);
    CHECK(s.control.contested == 2);
    CHECK(s.control.neutral == 2);
    CHECK(s.sides[0].regions == 2);
    CHECK(s.sides[1].regions == 1);
    // The team-4 region belongs to no declared side: counted in `total`, and
    // deliberately not in `neutral` — somebody holds it.
}

TEST_CASE("encode round-trips through decode") {
    const auto in = BuildWarSummary(
        TwoSides(), {Human(0), Ai(1), Spectator()},
        {{0, true}, {-1, false}}, 4242, 3600);
    WarSummary out;
    REQUIRE(DecodeWarSummary(EncodeWarSummary(in), out));
    REQUIRE(out.sides.size() == 2);
    CHECK(out.sides[0].faction == "compact");
    CHECK(out.sides[0].humans == 1);
    CHECK(out.sides[0].regions == 1);
    CHECK(out.sides[1].ais == 1);
    CHECK(out.spectators == 1);
    CHECK(out.frame == 4242);
    CHECK(out.uptimeSec == 3600);
    CHECK(out.control.total == 2);
    CHECK(out.control.contested == 1);
    CHECK(out.control.neutral == 1);
}

TEST_CASE("the decoder refuses what it cannot vouch for") {
    WarSummary out;
    CHECK_FALSE(DecodeWarSummary("", out));
    CHECK_FALSE(DecodeWarSummary("not json", out));
    CHECK_FALSE(DecodeWarSummary("[]", out));
    // A version this build does not know: guessing at the fields would be a
    // misread population, which is worse than no population.
    CHECK_FALSE(DecodeWarSummary(R"({"v":99,"sides":[]})", out));
    // Right version, no sides array — a war with no sides is a legacy room,
    // and an absent array is a malformed row, not an empty war.
    CHECK_FALSE(DecodeWarSummary(R"({"v":1,"frame":3})", out));
}

TEST_CASE("a decoded summary with no control block reads as no regions") {
    // A map with no regions gadget publishes nothing to scan, and the browser
    // shows no control line rather than "0 regions contested".
    WarSummary out;
    REQUIRE(DecodeWarSummary(R"({"v":1,"sides":[],"frame":7})", out));
    CHECK(out.control.total == 0);
    CHECK(out.frame == 7);
}
