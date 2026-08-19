#include <doctest/doctest.h>

#include "Server/DynamicJoin.h"
#include "Server/RoomManager.h"
#include "Server/WarSides.h"

// PLAN-metalstorm-lobby.md §2.1/§2.3, task 2 — dynamic join.
//
// Task 1 let a persistent war fire GameStart without waiting for its roster.
// That start was pointless on its own: an account the lobby never put in
// `--player` resolved to team -1 and landed on the spectator path, so a war
// that started without its roster could never gain anyone.
//
// What these tests pin down:
//
//  1. **The seat rule is faction-determined, never chosen.** §2.3 is explicit
//     that a player joins the side belonging to `users.faction_id` and is
//     never reassigned across factions by a balancer. So an account with no
//     faction, or one whose faction this war does not field, is not seated
//     "somewhere" — it is declined, and falls back to spectating.
//  2. **A skirmish never admits.** Its roster is its whole cast: it was
//     sized, seated and start-gated on that list. Reading the rule off
//     `waitsForRoster` instead of the kind would have leaked war behaviour to
//     any skirmish that happened to launch with an empty roster, which is
//     `SessionStartsGameAtSetup`'s second term.
//  3. **Declining is not refusing.** Every non-admit outcome leaves the
//     connection on the pre-existing spectator seat that
//     PLAN-metalstorm-onboarding.md §4 depends on. That is also the
//     correction to §2.1's own premise, which says auth "rejects any username
//     not in that roster" — it has not for a long time.
//  4. **One decoder for `war_sides`.** The lobby seats a room slot from it and
//     the game server now seats a dynamic joiner from it, in two different
//     processes. Two hand-rolled parsers is the shape that lets a faction be
//     admitted on team 0 in one process and refused in the other, so
//     `GameRoom::SideTeams()` and the game server share `ParseWarSides`.

TEST_CASE("war_sides has one decoder, and GameRoom uses it") {
    const WarSides sides = ParseWarSides("compact:0,union:1");
    REQUIRE(sides.size() == 2);
    CHECK(sides[0].first == "compact");
    CHECK(sides[0].second == 0);
    CHECK(sides[1].first == "union");
    CHECK(sides[1].second == 1);

    // The room's own accessor must agree entry-for-entry with the free
    // function the game server calls — that parity is the whole reason the
    // parse moved out of the class.
    GameRoom room;
    room.modOptions["war_sides"] = "compact:0,union:1";
    CHECK(room.SideTeams() == sides);
    CHECK(room.TeamForFaction("union") == TeamForFactionIn(sides, "union"));
}

TEST_CASE("war_sides: malformed entries are dropped individually, not fatally") {
    // A nameless entry is not a side however parseable its number looks; a
    // non-numeric team must not become atoi's 0 and collide with a real side;
    // a duplicate team is ignored rather than shadowing the first claimant.
    const WarSides sides =
        ParseWarSides(":3,compact:0,union:x,rogue:0,severed:2");
    REQUIRE(sides.size() == 2);
    CHECK(sides[0].first == "compact");
    CHECK(sides[0].second == 0);
    CHECK(sides[1].first == "severed");
    CHECK(sides[1].second == 2);
    // The surviving entries keep the teams they declared — a dropped entry
    // must never renumber its neighbours.
    CHECK(TeamForFactionIn(sides, "severed") == 2);
    CHECK_FALSE(TeamForFactionIn(sides, "union").has_value());
    CHECK_FALSE(TeamForFactionIn(sides, "rogue").has_value());
}

TEST_CASE("war_sides: an absent spec is no sides, never {0,1}") {
    // A legacy room's teams have no faction names. Falling back to {0,1} here
    // would let the faction seating rule fire on a room that never declared a
    // side, seating an account on a team by position.
    CHECK(ParseWarSides("").empty());
    CHECK(ParseWarSides("garbage").empty());
    CHECK_FALSE(TeamForFactionIn(ParseWarSides(""), "compact").has_value());
}

// ── The decision ────────────────────────────────────────────────────────────

static const WarSides kCrossing = ParseWarSides("compact:0,union:1");

TEST_CASE("dynamic join: a war seats a non-roster account on its faction's side") {
    const auto d = DecideDynamicJoin(SessionKind::PersistentWar, "union",
                                     kCrossing, /*humansOnSide=*/0,
                                     WAR_SIDE_CAPACITY_DEFAULT);
    CHECK(d.outcome == DynamicJoinOutcome::Admit);
    CHECK(d.Admitted());
    CHECK(d.team == 1);

    // The other faction gets the other side — the seat follows the account,
    // not the order it arrived in.
    CHECK(DecideDynamicJoin(SessionKind::PersistentWar, "compact", kCrossing,
                            0, WAR_SIDE_CAPACITY_DEFAULT).team == 0);
}

TEST_CASE("dynamic join: a skirmish never admits, whatever the faction says") {
    const auto d = DecideDynamicJoin(SessionKind::Skirmish, "union", kCrossing,
                                     0, WAR_SIDE_CAPACITY_DEFAULT);
    CHECK(d.outcome == DynamicJoinOutcome::NotAWar);
    CHECK_FALSE(d.Admitted());
    // Declined decisions carry no team. A caller that forgets to branch on
    // Admitted() must seat a spectator, never team 0.
    CHECK(d.team == -1);
}

TEST_CASE("dynamic join: a factionless account is declined, not placed") {
    // Dev accounts, `/api/rooms/direct` manifest accounts and pre-faction
    // legacy accounts all have an empty faction. §2.3 gives the choice to the
    // faction alone, so there is nothing here to seat on.
    const auto d = DecideDynamicJoin(SessionKind::PersistentWar, "", kCrossing,
                                     0, WAR_SIDE_CAPACITY_DEFAULT);
    CHECK(d.outcome == DynamicJoinOutcome::NoFaction);
    CHECK(d.team == -1);
}

TEST_CASE("dynamic join: a faction this war does not field is declined") {
    const auto d = DecideDynamicJoin(SessionKind::PersistentWar, "severed",
                                     kCrossing, 0, WAR_SIDE_CAPACITY_DEFAULT);
    CHECK(d.outcome == DynamicJoinOutcome::NoSideForFaction);
    CHECK(d.team == -1);

    // Same outcome for a legacy war with no `war_sides` at all — and it must
    // be this outcome rather than an admit onto some default team.
    CHECK(DecideDynamicJoin(SessionKind::PersistentWar, "union", WarSides{}, 0,
                            WAR_SIDE_CAPACITY_DEFAULT).outcome ==
          DynamicJoinOutcome::NoSideForFaction);
}

TEST_CASE("dynamic join: capacity is measured before the joiner is bound") {
    // `humansOnSide` counts who is ALREADY seated, so a side holding exactly
    // `capacity` is full — comparing with `>` would seat one player too many,
    // and it would do so only on the boundary, which no test with a comfortable
    // margin can see.
    CHECK(DecideDynamicJoin(SessionKind::PersistentWar, "union", kCrossing,
                            /*humansOnSide=*/2, /*capacity=*/3).outcome ==
          DynamicJoinOutcome::Admit);
    const auto full = DecideDynamicJoin(SessionKind::PersistentWar, "union",
                                        kCrossing, 3, 3);
    CHECK(full.outcome == DynamicJoinOutcome::SideFull);
    CHECK(full.team == -1);
    CHECK(DecideDynamicJoin(SessionKind::PersistentWar, "union", kCrossing, 4,
                            3).outcome == DynamicJoinOutcome::SideFull);
}

TEST_CASE("dynamic join: capacity 0 means unlimited, not zero seats") {
    // An unset capacity must be permissive. A war that never sized its sides
    // should let players in and be rebalanced by seeding (§6), not lock
    // everyone out of a running world — and `0` is the value an absent
    // `--war-side-capacity` would most easily decay to.
    CHECK(WAR_SIDE_CAPACITY_UNLIMITED == 0);
    CHECK(DecideDynamicJoin(SessionKind::PersistentWar, "union", kCrossing,
                            /*humansOnSide=*/999,
                            WAR_SIDE_CAPACITY_UNLIMITED).outcome ==
          DynamicJoinOutcome::Admit);
}

TEST_CASE("dynamic join: every outcome names itself for the operator log") {
    // A join that silently does not happen is indistinguishable from a
    // spectator who meant to spectate. Each decline reaches the log with its
    // own reason, so none of the five collapses into "unknown".
    for (auto o : {DynamicJoinOutcome::NotAWar, DynamicJoinOutcome::NoFaction,
                   DynamicJoinOutcome::NoSideForFaction,
                   DynamicJoinOutcome::SideFull, DynamicJoinOutcome::Admit}) {
        const std::string s = DynamicJoinOutcomeToString(o);
        CHECK(s != "unknown");
        CHECK_FALSE(s.empty());
    }
}
