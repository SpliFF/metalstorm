#include <doctest/doctest.h>

#include "Server/JoinPreview.h"
#include "Server/WarRejoinPolicy.h"

// PLAN-metalstorm-lobby.md §2.4, task 5, second half — pre-join legibility.
//
// §2.4 puts the grants in the sim and the *legibility* in the lobby: "you'll
// join Side B near the River Line with 100 authority". The property worth
// testing is not the wording — it is that the promise is made by the same two
// pure functions that do the seating (`DecideDynamicJoin`, `DecideRejoin`), so
// a preview cannot offer a seat the game server then refuses, or quote an
// authority number the gadget does not mint.
//
// The lobby can answer all of this without the sim, which is the point: a war
// whose process is not even running (task 3) still has to be legible.

namespace {

WarSides TwoSides() {
    WarSides s;
    s.push_back({"compact", 0});
    s.push_back({"union", 1});
    return s;
}

constexpr double kGrant = 100.0;

}  // namespace

TEST_CASE("a first-time joiner is told their side and the grant they arrive with") {
    const JoinPreview p =
        PreviewJoin(SessionKind::PersistentWar, "union", TwoSides(),
                    /*humansOnSide=*/2, /*capacity=*/8, /*hasBinding=*/false,
                    /*boundTeam=*/-1, /*absenceSec=*/0, /*savedPool=*/0.0,
                    /*hasSavedState=*/false, kGrant);
    CHECK(p.willFight);
    CHECK(p.team == 1);
    CHECK(p.side == "union");
    CHECK(p.humansOnSide == 2);
    CHECK(p.capacityPerSide == 8);
    CHECK(p.authority == doctest::Approx(100.0));
    CHECK(p.authoritySource == JoinAuthoritySource::JoinGrant);
    CHECK_FALSE(p.returning);
}

TEST_CASE("a skirmish previews as spectating, and says why") {
    const JoinPreview p =
        PreviewJoin(SessionKind::Skirmish, "compact", TwoSides(), 0, 8, false,
                    -1, 0, 0.0, false, kGrant);
    CHECK_FALSE(p.willFight);
    CHECK(p.outcome == DynamicJoinOutcome::NotAWar);
    CHECK(p.team == -1);
    CHECK(p.authoritySource == JoinAuthoritySource::None);
    CHECK(p.authority == doctest::Approx(0.0));
}

TEST_CASE("no faction and no side for the faction are different answers") {
    // Both spectate, and a player is owed the difference: one is fixed by
    // registering a faction, the other by finding a different war.
    const JoinPreview none =
        PreviewJoin(SessionKind::PersistentWar, "", TwoSides(), 0, 8, false, -1,
                    0, 0.0, false, kGrant);
    CHECK_FALSE(none.willFight);
    CHECK(none.outcome == DynamicJoinOutcome::NoFaction);

    const JoinPreview foreign =
        PreviewJoin(SessionKind::PersistentWar, "robots", TwoSides(), 0, 8,
                    false, -1, 0, 0.0, false, kGrant);
    CHECK_FALSE(foreign.willFight);
    CHECK(foreign.outcome == DynamicJoinOutcome::NoSideForFaction);
}

TEST_CASE("a full side previews as spectating rather than promising a seat") {
    const JoinPreview p =
        PreviewJoin(SessionKind::PersistentWar, "compact", TwoSides(),
                    /*humansOnSide=*/8, /*capacity=*/8, false, -1, 0, 0.0,
                    false, kGrant);
    CHECK_FALSE(p.willFight);
    CHECK(p.outcome == DynamicJoinOutcome::SideFull);
    // The population is still reported: "8/8" is the useful part of a refusal.
    CHECK(p.humansOnSide == 8);
    CHECK(p.capacityPerSide == 8);
}

TEST_CASE("a returning player inside the seat hold is not turned away by a full side") {
    // The whole reason `DecideRejoin` carries `bypassCapacity`: the seat is
    // already theirs. A preview that read capacity first would tell the one
    // player guaranteed a place that the war is full — the single most
    // misleading thing this endpoint could say.
    const JoinPreview p = PreviewJoin(
        SessionKind::PersistentWar, "compact", TwoSides(),
        /*humansOnSide=*/8, /*capacity=*/8, /*hasBinding=*/true,
        /*boundTeam=*/0, /*absenceSec=*/WAR_SEAT_HOLD_SEC - 1,
        /*savedPool=*/250.0, /*hasSavedState=*/true, kGrant);
    CHECK(p.willFight);
    CHECK(p.returning);
    CHECK(p.team == 0);
}

TEST_CASE("the quoted authority follows the rejoin rule, not a flat grant") {
    SUBCASE("brief absence — the pool they left with, restored") {
        const JoinPreview p = PreviewJoin(
            SessionKind::PersistentWar, "compact", TwoSides(), 1, 8, true, 0,
            /*absenceSec=*/60, /*savedPool=*/250.0, true, kGrant);
        CHECK(p.willFight);
        CHECK(p.authoritySource == JoinAuthoritySource::RestoredPool);
        // 250, NOT 250 + 100: the sim's RestorePool is a top-up to a
        // remembered level, so the level IS what they arrive holding.
        CHECK(p.authority == doctest::Approx(250.0));
    }
    SUBCASE("long absence — the pool is stale, the stipend is quoted") {
        const JoinPreview p = PreviewJoin(
            SessionKind::PersistentWar, "compact", TwoSides(), 1, 8, true, 0,
            /*absenceSec=*/WAR_BRIEF_ABSENCE_SEC + 1, /*savedPool=*/250.0, true,
            kGrant);
        CHECK(p.authoritySource == JoinAuthoritySource::OnboardingStipend);
        CHECK(p.authority == doctest::Approx(kGrant));
    }
    SUBCASE("a binding that never saved state is a join, not a rejoin restore") {
        const JoinPreview p =
            PreviewJoin(SessionKind::PersistentWar, "compact", TwoSides(), 1, 8,
                        true, 0, 60, /*savedPool=*/0.0,
                        /*hasSavedState=*/false, kGrant);
        CHECK(p.authoritySource == JoinAuthoritySource::JoinGrant);
        CHECK(p.authority == doctest::Approx(kGrant));
    }
}

TEST_CASE("the war's own join grant is quoted, not the default") {
    // The endpoint reads `authority_join_grant` off the room's modoptions
    // because that is what game_authority.lua reads. A preview that hardcoded
    // 100 would be wrong on every war that tuned it.
    const JoinPreview p =
        PreviewJoin(SessionKind::PersistentWar, "union", TwoSides(), 0, 8,
                    false, -1, 0, 0.0, false, /*joinGrant=*/40.0);
    CHECK(p.authority == doctest::Approx(40.0));
}

TEST_CASE("a superseded binding previews off the faction, not the stale team") {
    // The war's sides were re-authored and compact now fights on team 1. The
    // binding still says team 0. Faction is the immutable identity, so the
    // preview must promise team 1 — the same precedence the seating rule uses,
    // and the reason a stale row can never put a player on a side their
    // faction does not fight for.
    WarSides reauthored;
    reauthored.push_back({"compact", 1});
    reauthored.push_back({"union", 0});
    const JoinPreview p =
        PreviewJoin(SessionKind::PersistentWar, "compact", reauthored,
                    /*humansOnSide=*/0, /*capacity=*/8, /*hasBinding=*/true,
                    /*boundTeam=*/0, 60, 250.0, true, kGrant);
    CHECK(p.willFight);
    CHECK(p.team == 1);
    CHECK_FALSE(p.returning);            // the seat was superseded, not restored
    // And the stale pool does NOT come back with them: the restore path keys
    // on a restored seat, so a superseded binding gets the join grant.
    CHECK(p.authoritySource == JoinAuthoritySource::JoinGrant);
}

TEST_CASE("capacity 0 means unlimited, not closed") {
    const JoinPreview p =
        PreviewJoin(SessionKind::PersistentWar, "compact", TwoSides(),
                    /*humansOnSide=*/99, WAR_SIDE_CAPACITY_UNLIMITED, false, -1,
                    0, 0.0, false, kGrant);
    CHECK(p.willFight);
}
