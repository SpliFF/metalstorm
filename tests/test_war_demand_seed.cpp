// PLAN-metalstorm-wars.md §4's demand-driven seeding and §10's "demand-seed
// fires only when no open faction slot exists", task 2's second half.
//
// The firing CONDITION is `WarDeploy.h`'s `seed` outcome and is tested with
// it; what is tested here is the decision that outcome could not make on its
// own — which factions the new war is fought between, and where.

#include <doctest/doctest.h>
#include <sqlite3.h>

#include "Server/WarDemandSeed.h"
#include "Server/WarDeploy.h"
#include "Server/WarDirector.h"

namespace {

FactionDemand Demand(const char* faction, unsigned registered,
                     unsigned openSlots) {
    FactionDemand d;
    d.factionId  = faction;
    d.registered = registered;
    d.openSlots  = openSlots;
    return d;
}

TheatreOption Theatre(const char* mapId, const char* scenarioId,
                      std::vector<std::string> factions,
                      unsigned startBoxCount = 4, unsigned liveWars = 0) {
    TheatreOption t;
    t.mapId         = mapId;
    t.scenarioId    = scenarioId;
    t.factions      = std::move(factions);
    t.startBoxCount = startBoxCount;
    t.liveWars      = liveWars;
    return t;
}

}  // namespace

TEST_CASE("task 2: the seed fires exactly when no side has an open slot") {
    // Restating the gate this file's decisions hang off, because the two
    // halves live in different files and the seam is where a demand seed could
    // start firing on a war that had room all along.
    DeployCandidate full;
    full.roomId = 3;
    full.fieldsMyFaction = true;
    full.myBound = 4;
    full.myCapacity = 4;
    CHECK(DecideDeploy("compact", {full}).outcome == DeployOutcome::SeedNewWar);

    DeployCandidate room = full;
    room.myBound = 3;
    CHECK(DecideDeploy("compact", {room}).outcome == DeployOutcome::JoinWar);
}

TEST_CASE("task 2: a demand seed is fought against the longest queue") {
    const std::vector<FactionDemand> supply = {
        Demand("compact", 40, 0),   // waiting 40 — the requester
        Demand("union", 30, 2),     // waiting 28
        Demand("raiders", 12, 12),  // waiting 0 — everybody has a seat
    };
    const auto ranked = ChooseDemandSeedOpponents("compact", supply, 2);
    REQUIRE(ranked.size() == 2);
    CHECK(ranked[0] == "union");
    CHECK(ranked[1] == "raiders");

    // The requesting faction is never its own opponent — a player always
    // fights their own faction, so a war of compact vs compact is not a thing
    // this can produce.
    for (const auto& f : ranked)
        CHECK(f != "compact");
}

TEST_CASE("task 2: a faction nobody plays is not seeded against") {
    const auto ranked = ChooseDemandSeedOpponents(
        "compact", {Demand("union", 0, 0), Demand("raiders", 3, 0)}, 2);
    REQUIRE(ranked.size() == 1);
    CHECK(ranked[0] == "raiders");

    // Nobody at all to fight → no opponents, and the caller must not seed.
    CHECK(ChooseDemandSeedOpponents("compact", {Demand("union", 0, 0)}, 2)
              .empty());
}

TEST_CASE("task 2: the theatre must field both factions") {
    const std::vector<TheatreOption> options = {
        Theatre("solo_ridge", "solo", {"compact"}),
        Theatre("raider_gulch", "gulch", {"compact", "raiders"}),
        Theatre("meridian", "meridian_basin", {"compact", "union"}),
    };
    const std::vector<std::string> ranked = {"union", "raiders"};
    const auto* pick = ChooseDemandSeedTheatre(options, "compact", ranked);
    REQUIRE(pick != nullptr);
    // Ranked opponent first: the war seeds against the faction with the
    // longest queue, not against whichever map sorts first.
    CHECK(pick->scenarioId == "meridian_basin");

    // Nothing fields my faction → nullptr, and `seed` stays a recommendation
    // rather than becoming a war booted onto a map with no side for me.
    CHECK(ChooseDemandSeedTheatre(options, "nomads", ranked) == nullptr);
    // Fields my faction but nobody worth fighting.
    CHECK(ChooseDemandSeedTheatre({options[0]}, "compact", ranked) == nullptr);
}

TEST_CASE("task 2: a tie between theatres prefers the emptier world") {
    const std::vector<TheatreOption> options = {
        Theatre("busy", "busy_war", {"compact", "union"}, 4, /*liveWars=*/3),
        Theatre("quiet", "quiet_war", {"compact", "union"}, 4, /*liveWars=*/0),
    };
    const auto* pick = ChooseDemandSeedTheatre(options, "compact", {"union"});
    REQUIRE(pick != nullptr);
    CHECK(pick->mapId == "quiet");
}

TEST_CASE("task 2: a theatre with too few start boxes is not chosen") {
    // Choosing it would only move the refusal downstream: PlanWarSeed refuses
    // a war that declares more sides than the map has corners.
    const std::vector<TheatreOption> options = {
        Theatre("cramped", "cramped_war", {"compact", "union", "raiders"},
                /*startBoxCount=*/2),
    };
    CHECK(ChooseDemandSeedTheatre(options, "compact", {"union"}) == nullptr);
}

TEST_CASE("task 2: seeding is self-limiting through warsFielding") {
    // The brake §4 relies on: each war a faction already fields divides the
    // next one's side, so a surplus faction gets MORE wars rather than one
    // enormous one — and the seed loop cannot run away.
    WarSeedRequest r;
    r.name     = "Demand Seed";
    r.theatre  = "meridian";
    r.gameId   = "metalstorm";
    r.factions = {"compact", "union"};
    r.origin   = WarOrigin::Demand;

    WarSeedPopulation pop;
    pop.registered["compact"] = 24;
    pop.registered["union"]   = 24;

    pop.warsFielding["compact"] = 0;
    pop.warsFielding["union"]   = 0;
    CHECK(PlanWarSeed(r, pop).sides[0].slotCap == 24);

    pop.warsFielding["compact"] = 3;
    pop.warsFielding["union"]   = 3;
    const auto fourth = PlanWarSeed(r, pop);
    CHECK(fourth.sides[0].slotCap == 6);
    CHECK(fourth.origin == WarOrigin::Demand);

    pop.warsFielding["compact"] = 20;
    pop.warsFielding["union"]   = 20;
    CHECK(PlanWarSeed(r, pop).sides[0].slotCap == WAR_SEED_MIN_CAPACITY);
}

TEST_CASE("task 2: a seeded war records the sides its boot actually produced") {
    WarSeedRequest r;
    r.name     = "Demand Seed";
    r.theatre  = "meridian";
    r.gameId   = "metalstorm";
    r.factions = {"compact", "union"};
    WarSeedPlan plan = PlanWarSeed(r, WarSeedPopulation{});
    REQUIRE(plan.ok);
    // The Director's own numbering is side index → team index.
    CHECK(plan.sides[1].team == 1);

    // The scenario stages the union's army on team 4 (§7.4). Reconciling to
    // the room's `war_sides` is what stops the Director's {0,1} from booting a
    // war whose second army is on a team nobody is seated on.
    const WarSides roomSides = {{"compact", 0}, {"union", 4}};
    const WarSideCapacities roomCaps = {{"compact", 5}, {"union", 3}};
    const WarSeedPlan booted = ReconcileSeededSides(plan, roomSides, roomCaps);
    REQUIRE(booted.ok);
    REQUIRE(booted.sides.size() == 2);
    CHECK(booted.sides[1].factionId == "union");
    CHECK(booted.sides[1].team == 4);
    CHECK(booted.sides[1].startBox == 1);
    // The author's deliberate side size survives, and Σ is what the server was
    // spawned for.
    CHECK(booted.sides[0].slotCap == 5);
    CHECK(booted.sides[1].slotCap == 3);
    CHECK(booted.TotalSlotCap() == 8);
    // Nothing is outnumbered in a war with nobody in it.
    CHECK_FALSE(booted.sides[0].incentivised);

    // A war booted with no scenario has nothing to reconcile to, and keeps the
    // plan it was seeded from.
    const WarSeedPlan unchanged = ReconcileSeededSides(plan, {}, {});
    CHECK(unchanged.sides.size() == plan.sides.size());
    CHECK(unchanged.sides[1].team == 1);
}

TEST_CASE("task 2: a demand-seeded war is registered as demand-origin") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    WarDirector::EnsureTables(db);

    WarSeedRequest r;
    r.name     = "Demand Seed";
    r.theatre  = "meridian";
    r.gameId   = "metalstorm";
    r.factions = {"compact", "union"};
    r.origin   = WarOrigin::Demand;
    const WarSeedPlan plan = PlanWarSeed(r, WarSeedPopulation{});
    REQUIRE(WarDirector::Register(db, 11, plan, 1'700'000'000));
    REQUIRE(WarDirector::RecordSpawnedSlotCap(db, 11, plan.TotalSlotCap()));

    const auto war = WarDirector::Load(db, 11);
    REQUIRE(war.has_value());
    // The origin is what keeps seeding self-limiting in the other direction:
    // an operator's flagship must be distinguishable from the pool of wars the
    // Director created for itself.
    CHECK(war->origin == WarOrigin::Demand);
    CHECK(war->spawnedSlotCap == plan.TotalSlotCap());
    // And it now counts against the next seed's sizing — a JOIN, not a counter.
    CHECK(WarDirector::WarsFielding(db, "compact") == 1);
    CHECK(WarDirector::WarsFielding(db, "union") == 1);

    sqlite3_close(db);
}
