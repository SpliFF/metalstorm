// PLAN-metalstorm-wars.md §9 task 1 + §10's first test row: "seed a war →
// correct `wars`/`war_sides` rows + one boot call; side sizing from map
// start-boxes + population ratio".
//
// The Director is defined by never touching sim state, which is exactly what
// makes this file possible: every assertion below runs against an in-memory
// SQLite database and a struct, with no lobby, no game server and no sim.

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WarDirector.h"

namespace {

// One in-memory db per test case, torn down with the fixture.
struct DirectorDb {
    sqlite3* db = nullptr;
    DirectorDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WarDirector::EnsureTables(db);
    }
    ~DirectorDb() { sqlite3_close(db); }
};

WarSeedRequest TwoSidedRequest() {
    WarSeedRequest r;
    r.name          = "Raven Basin";
    r.theatre       = "scorched_crossing_v2.4";
    r.gameId        = "metalstorm";
    r.factions      = {"compact", "union"};
    r.startBoxCount = 6;
    return r;
}

}  // namespace

TEST_CASE("task 1: a seed plan sizes its sides from the population") {
    WarSeedPopulation pop;
    // 12 registered compact across 1 existing war + this one → 6 a side;
    // 5 union across 0 existing + this one → 5. Asymmetric on purpose: the
    // surplus faction gets the bigger side, per WarSeeding.h's own rule.
    pop.registered["compact"]   = 12;
    pop.warsFielding["compact"] = 1;
    pop.registered["union"]     = 5;
    pop.warsFielding["union"]   = 0;

    const WarSeedPlan plan = PlanWarSeed(TwoSidedRequest(), pop);
    REQUIRE(plan.ok);
    REQUIRE(plan.sides.size() == 2);

    CHECK(plan.sides[0].factionId == "compact");
    CHECK(plan.sides[0].team == 0);
    CHECK(plan.sides[0].startBox == 0);
    CHECK(plan.sides[0].slotCap == 6);
    CHECK_FALSE(plan.sides[0].incentivised);

    CHECK(plan.sides[1].factionId == "union");
    CHECK(plan.sides[1].team == 1);
    CHECK(plan.sides[1].startBox == 1);
    CHECK(plan.sides[1].slotCap == 5);

    // §8.1: seed time is the only moment every cap is known at once, and this
    // is the number the game server has to size its player arrays for.
    CHECK(plan.TotalSlotCap() == 11);
}

TEST_CASE("task 1: a plan refuses what would produce an unplayable war") {
    WarSeedPopulation pop;

    SUBCASE("one side is not a war") {
        WarSeedRequest r = TwoSidedRequest();
        r.factions = {"compact"};
        const WarSeedPlan plan = PlanWarSeed(r, pop);
        CHECK_FALSE(plan.ok);
        CHECK(plan.error.find("two distinct factions") != std::string::npos);
    }

    SUBCASE("a repeated faction is one side, not two") {
        WarSeedRequest r = TwoSidedRequest();
        r.factions = {"compact", "compact"};
        CHECK_FALSE(PlanWarSeed(r, pop).ok);
    }

    SUBCASE("more sides than the map has start boxes (§3)") {
        WarSeedRequest r = TwoSidedRequest();
        r.factions      = {"compact", "union", "syndicate", "reach"};
        r.startBoxCount = 2;
        const WarSeedPlan plan = PlanWarSeed(r, pop);
        CHECK_FALSE(plan.ok);
        CHECK(plan.error.find("start box") != std::string::npos);
    }

    SUBCASE("an unknown start-box count is permissive, not fatal") {
        WarSeedRequest r = TwoSidedRequest();
        r.startBoxCount = 0;  // metadata not ingested yet
        CHECK(PlanWarSeed(r, pop).ok);
    }

    SUBCASE("a theatre is required") {
        WarSeedRequest r = TwoSidedRequest();
        r.theatre.clear();
        CHECK_FALSE(PlanWarSeed(r, pop).ok);
    }

    SUBCASE("a faction key that cannot survive the modoption grammar") {
        WarSeedRequest r = TwoSidedRequest();
        r.factions = {"com,pact", "un:ion", "reach"};
        // Two of the three are dropped, leaving one side — which is refused
        // for being one side, not silently encoded as a broken modoption.
        CHECK_FALSE(PlanWarSeed(r, pop).ok);
    }
}

TEST_CASE("task 1: the boot call is one --direct manifest") {
    WarSeedPopulation pop;
    pop.registered["compact"] = 8;
    pop.registered["union"]   = 8;

    WarSeedRequest r = TwoSidedRequest();
    r.scenario = "raven_basin";
    r.origin   = WarOrigin::Demand;

    const WarSeedPlan plan = PlanWarSeed(r, pop);
    REQUIRE(plan.ok);

    const auto m = nlohmann::json::parse(BuildWarBootManifest(plan));

    CHECK(m["map"] == "scorched_crossing_v2.4");
    CHECK(m["game"] == "metalstorm");
    // A seeded war is a war, not a skirmish — a skirmish ends when its room
    // empties, which is the one thing a war must not do.
    CHECK(m["sessionKind"] == "persistent");
    CHECK(m["scenario"] == "raven_basin");
    CHECK(m["autoStart"] == true);

    // The host exists because runDirectStart requires players[0], and is a
    // spectator because a Director-seeded war has no human on any side —
    // seating the operator would enlist them AND occupy a capped seat.
    REQUIRE(m["players"].size() == 1);
    CHECK(m["players"][0]["spectator"] == true);

    // One caretaker per declared side: a side with neither player nor AI is a
    // gap team, and a spectator-only room would otherwise trip
    // runDirectStart's solo-team Null-AI net into inventing a participant.
    REQUIRE(m["aiSlots"].size() == 2);
    CHECK(m["aiSlots"][0]["team"] == 0);
    CHECK(m["aiSlots"][1]["team"] == 1);
    CHECK(m["aiSlots"][1]["startPos"] == 1);

    // Derived from the plan through the EXISTING encoders — the Director
    // assembles no modoption string by hand.
    CHECK(m["modoptions"]["war_sides"] == "compact:0,union:1");
    CHECK(m["modoptions"]["war_side_capacities"] == "compact:8,union:8");

    // Round-trips through the decoders three other processes use.
    const auto sides = ParseWarSides(m["modoptions"]["war_sides"]);
    REQUIRE(sides.size() == 2);
    CHECK(TeamForFactionIn(sides, "union").value_or(99) == 1);
    const auto caps = ParseWarSideCapacities(
        m["modoptions"]["war_side_capacities"].get<std::string>());
    CHECK(CapacityForSideIn(caps, "compact", 0) == 8);
}

TEST_CASE("task 1: a plan that failed emits no boot call") {
    WarSeedRequest r = TwoSidedRequest();
    r.factions = {"compact"};
    CHECK(BuildWarBootManifest(PlanWarSeed(r, WarSeedPopulation{})).empty());
}

TEST_CASE("task 1: registering a war writes both tables") {
    DirectorDb fx;
    WarSeedPopulation pop;
    pop.registered["compact"] = 10;
    pop.registered["union"]   = 4;

    WarSeedRequest r = TwoSidedRequest();
    r.origin   = WarOrigin::Demand;
    r.seasonId = "s1";
    const WarSeedPlan plan = PlanWarSeed(r, pop);
    REQUIRE(plan.ok);

    REQUIRE(WarDirector::Register(fx.db, 7, plan, /*now=*/1000));

    const auto war = WarDirector::Load(fx.db, 7);
    REQUIRE(war.has_value());
    CHECK(war->roomId == 7);
    CHECK(war->name == "Raven Basin");
    CHECK(war->theatre == "scorched_crossing_v2.4");
    CHECK(war->origin == WarOrigin::Demand);
    CHECK(war->seasonId == "s1");
    CHECK(war->createdAt == 1000);
    // A war is `seeding` until its boot call returns — nobody may be handed a
    // join token for a war with nothing behind it yet.
    CHECK(war->state == WarState::Seeding);
    CHECK(war->IsLive());

    const auto sides = WarDirector::SidesFor(fx.db, 7);
    REQUIRE(sides.size() == 2);
    CHECK(sides[0].factionId == "compact");
    CHECK(sides[0].slotCap == 10);
    CHECK(sides[1].factionId == "union");
    CHECK(sides[1].slotCap == 4);
    CHECK_FALSE(sides[1].incentivised);

    CHECK(WarDirector::Load(fx.db, 8).has_value() == false);
    CHECK(WarDirector::SidesFor(fx.db, 8).empty());
}

TEST_CASE("task 1: room ids are reused, so registration replaces") {
    DirectorDb fx;
    WarSeedPopulation pop;

    WarSeedRequest first = TwoSidedRequest();
    REQUIRE(WarDirector::Register(fx.db, 3, PlanWarSeed(first, pop), 100));
    REQUIRE(WarDirector::Retire(fx.db, 3, 200));

    // The lobby hands out the lowest free room id, so a brand-new war lands
    // on a dead one's id. Its sides must be ITS sides.
    WarSeedRequest second = TwoSidedRequest();
    second.name     = "Iron Bend";
    second.factions = {"syndicate", "reach"};
    REQUIRE(WarDirector::Register(fx.db, 3, PlanWarSeed(second, pop), 300));

    const auto sides = WarDirector::SidesFor(fx.db, 3);
    REQUIRE(sides.size() == 2);
    CHECK(sides[0].factionId == "syndicate");
    CHECK(sides[1].factionId == "reach");

    const auto war = WarDirector::Load(fx.db, 3);
    REQUIRE(war.has_value());
    CHECK(war->name == "Iron Bend");
    // Re-registration is a NEW war, not a resurrection: state and retirement
    // reset, or the new war would boot already archived.
    CHECK(war->state == WarState::Seeding);
    CHECK(war->retiredAt == 0);
    CHECK(war->createdAt == 300);
}

TEST_CASE("task 1: the meta-state machine refuses illegal moves") {
    CHECK(IsLegalWarTransition(WarState::Seeding, WarState::Open));
    CHECK(IsLegalWarTransition(WarState::Open, WarState::Active));
    CHECK(IsLegalWarTransition(WarState::Active, WarState::WindingDown));
    CHECK(IsLegalWarTransition(WarState::WindingDown, WarState::Resolving));
    CHECK(IsLegalWarTransition(WarState::Resolving, WarState::Archived));

    // Idempotent re-assertion (an adoption pass) is not an error.
    CHECK(IsLegalWarTransition(WarState::Active, WarState::Active));

    // Anything may be retired outright — an operator-retire, a room that
    // vanished, a war that died while seeding.
    CHECK(IsLegalWarTransition(WarState::Seeding, WarState::Archived));
    CHECK(IsLegalWarTransition(WarState::Open, WarState::Archived));

    // Nothing comes back. Re-opening an archived war re-opens its escrow.
    CHECK_FALSE(IsLegalWarTransition(WarState::Archived, WarState::Open));
    CHECK_FALSE(IsLegalWarTransition(WarState::Archived, WarState::Active));
    // No skipping the ending.
    CHECK_FALSE(IsLegalWarTransition(WarState::Active, WarState::Resolving));
    CHECK_FALSE(IsLegalWarTransition(WarState::Resolving, WarState::Open));
    CHECK_FALSE(IsLegalWarTransition(WarState::WindingDown, WarState::Active));

    // A state spelling this build does not know is refused, not defaulted —
    // a typo must never quietly reopen a finished war.
    CHECK_FALSE(WarStateFromString("winding-down").has_value());
    CHECK(WarStateFromString("winding_down").value() == WarState::WindingDown);
    for (const auto s : {WarState::Seeding, WarState::Open, WarState::Active,
                         WarState::WindingDown, WarState::Resolving,
                         WarState::Archived})
        CHECK(WarStateFromString(WarStateToString(s)).value() == s);
    for (const auto o : {WarOrigin::Operator, WarOrigin::Demand,
                         WarOrigin::Scenario, WarOrigin::Scheduled})
        CHECK(WarOriginFromString(WarOriginToString(o)).value() == o);
}

TEST_CASE("task 1: the state machine is enforced against the row, not just in "
          "the predicate") {
    DirectorDb fx;
    REQUIRE(WarDirector::Register(fx.db, 1,
                                  PlanWarSeed(TwoSidedRequest(),
                                              WarSeedPopulation{}),
                                  1000));

    CHECK_FALSE(WarDirector::SetState(fx.db, 1, WarState::Resolving, 1001));
    CHECK(WarDirector::Load(fx.db, 1)->state == WarState::Seeding);

    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::Open, 1002));
    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::Active, 1003));
    CHECK(WarDirector::Load(fx.db, 1)->state == WarState::Active);

    // An unknown war is a false, not a silent success.
    CHECK_FALSE(WarDirector::SetState(fx.db, 99, WarState::Open, 1004));

    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::WindingDown, 1005));
    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::Resolving, 1006));
    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::Archived, 1007));

    const auto war = WarDirector::Load(fx.db, 1);
    REQUIRE(war.has_value());
    CHECK(war->state == WarState::Archived);
    CHECK(war->retiredAt == 1007);
    CHECK_FALSE(war->IsLive());

    // Re-retiring keeps the original moment — the digest and the escrow
    // settlement are dated from it.
    REQUIRE(WarDirector::Retire(fx.db, 1, 9999));
    CHECK(WarDirector::Load(fx.db, 1)->retiredAt == 1007);
    CHECK_FALSE(WarDirector::SetState(fx.db, 1, WarState::Open, 10000));
}

TEST_CASE("task 1: the live set, and what feeds the capacity rule back") {
    DirectorDb fx;
    WarSeedPopulation pop;

    WarSeedRequest a = TwoSidedRequest();                    // compact/union
    WarSeedRequest b = TwoSidedRequest();
    b.name = "Amber Row";
    b.factions = {"compact", "syndicate"};                   // compact again
    WarSeedRequest c = TwoSidedRequest();
    c.name = "Skerry";
    c.factions = {"union", "syndicate"};

    REQUIRE(WarDirector::Register(fx.db, 1, PlanWarSeed(a, pop), 100));
    REQUIRE(WarDirector::Register(fx.db, 2, PlanWarSeed(b, pop), 200));
    REQUIRE(WarDirector::Register(fx.db, 3, PlanWarSeed(c, pop), 300));

    CHECK(WarDirector::ListLive(fx.db).size() == 3);
    CHECK(WarDirector::ListByState(fx.db, WarState::Seeding).size() == 3);
    CHECK(WarDirector::ListByState(fx.db, WarState::Active).empty());

    CHECK(WarDirector::WarsFielding(fx.db, "compact") == 2);
    CHECK(WarDirector::WarsFielding(fx.db, "union") == 2);
    CHECK(WarDirector::WarsFielding(fx.db, "reach") == 0);

    // A retired war stops counting — which is what lets the next war for that
    // faction be sized bigger again.
    REQUIRE(WarDirector::Retire(fx.db, 2, 400));
    CHECK(WarDirector::ListLive(fx.db).size() == 2);
    CHECK(WarDirector::WarsFielding(fx.db, "compact") == 1);

    // A winding-down war still holds its players, so it still counts.
    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::Open, 500));
    REQUIRE(WarDirector::SetState(fx.db, 1, WarState::WindingDown, 501));
    CHECK(WarDirector::WarsFielding(fx.db, "compact") == 1);

    // Forget is for the id-reuse path, and it takes the history with it.
    REQUIRE(WarDirector::Forget(fx.db, 2));
    CHECK_FALSE(WarDirector::Load(fx.db, 2).has_value());
    CHECK(WarDirector::SidesFor(fx.db, 2).empty());
}

TEST_CASE("task 1: the columns task 2 and task 5 will write") {
    DirectorDb fx;
    WarSeedPopulation pop;
    pop.registered["compact"] = 6;
    pop.registered["union"]   = 6;
    const WarSeedPlan plan = PlanWarSeed(TwoSidedRequest(), pop);
    REQUIRE(WarDirector::Register(fx.db, 5, plan, 100));

    // §8.1 / task 5: the Σ slotCap the server was actually spawned with. Kept
    // separate from the live caps because task 2 may raise one after boot,
    // and a dynamic join has to know what the RUNNING process was sized for.
    CHECK(WarDirector::Load(fx.db, 5)->spawnedSlotCap == 0);
    REQUIRE(WarDirector::RecordSpawnedSlotCap(fx.db, 5, plan.TotalSlotCap()));
    CHECK(WarDirector::Load(fx.db, 5)->spawnedSlotCap == 12);
    CHECK_FALSE(WarDirector::RecordSpawnedSlotCap(fx.db, 99, 4));

    // §4's underdog incentive is a FLAG on a side. Nobody is moved.
    REQUIRE(WarDirector::SetSideIncentivised(fx.db, 5, "union", true));
    auto sides = WarDirector::SidesFor(fx.db, 5);
    CHECK(sides[0].incentivised == false);
    CHECK(sides[1].incentivised == true);
    CHECK_FALSE(WarDirector::SetSideIncentivised(fx.db, 5, "reach", true));

    // §4: "cap is a soft target; the Director may raise it within the map
    // limit if one faction floods". The map limit is the caller's to know.
    REQUIRE(WarDirector::SetSideSlotCap(fx.db, 5, "compact", 9));
    sides = WarDirector::SidesFor(fx.db, 5);
    CHECK(sides[0].slotCap == 9);
    CHECK_FALSE(WarDirector::SetSideSlotCap(fx.db, 5, "reach", 9));

    // The activity stamp never goes backwards — a resumed war whose sim
    // restarts at frame 0 must not make the war look younger than it is.
    REQUIRE(WarDirector::TouchActivity(fx.db, 5, 4000, 200));
    REQUIRE(WarDirector::TouchActivity(fx.db, 5, 0, 300));
    CHECK(WarDirector::Load(fx.db, 5)->lastActiveFrame == 4000);
}

TEST_CASE("task 1: a null database is refused, never crashed through") {
    WarDirector::EnsureTables(nullptr);
    CHECK_FALSE(WarDirector::Register(nullptr, 1,
                                      PlanWarSeed(TwoSidedRequest(),
                                                  WarSeedPopulation{}), 0));
    CHECK_FALSE(WarDirector::Load(nullptr, 1).has_value());
    CHECK(WarDirector::SidesFor(nullptr, 1).empty());
    CHECK(WarDirector::ListLive(nullptr).empty());
    CHECK(WarDirector::WarsFielding(nullptr, "compact") == 0);
    CHECK_FALSE(WarDirector::Retire(nullptr, 1, 0));
    CHECK_FALSE(WarDirector::Forget(nullptr, 1));
}
