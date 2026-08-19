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
#include "Server/WarTheatrePool.h"

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

// ── §3's pool rotation (task 7) ───────────────────────────────────────────
//
// The key that was MISSING, and whose absence was invisible because the
// ordering looked like a choice: with variety unrepresented, a box with two
// idle theatres seeded the alphabetically-first one every time, forever.

TEST_CASE("wars task 7: the pool rotates — least-recently-used wins a tie") {
    std::vector<TheatreOption> options = {
        Theatre("alpha_ridge", "alpha_war", {"compact", "union"}),
        Theatre("zeta_basin", "zeta_war", {"compact", "union"}),
    };
    // Equal on every prior key, so map id used to decide and `alpha_ridge`
    // won forever. Now the one used longest ago does.
    options[0].use.lastSeededAt = 9000;
    options[1].use.lastSeededAt = 1000;
    const auto* pick = ChooseDemandSeedTheatre(options, "compact", {"union"});
    REQUIRE(pick != nullptr);
    CHECK(pick->mapId == "zeta_basin");
}

TEST_CASE("wars task 7: a NEVER-seeded theatre goes first") {
    // What makes newly shipped content get its turn instead of waiting for
    // every incumbent to age past it. `0` is a distinct case, not a very old
    // timestamp.
    std::vector<TheatreOption> options = {
        Theatre("alpha_ridge", "alpha_war", {"compact", "union"}),
        Theatre("zeta_basin", "zeta_war", {"compact", "union"}),
    };
    options[0].use.lastSeededAt = 1;      // used once, long ago
    options[1].use.lastSeededAt = 0;      // never
    const auto* pick = ChooseDemandSeedTheatre(options, "compact", {"union"});
    REQUIRE(pick != nullptr);
    CHECK(pick->mapId == "zeta_basin");
}

TEST_CASE("wars task 7: rotation ranks BELOW spreading across empty maps") {
    // Spreading wars onto a map nobody is fighting on is a stronger claim on
    // variety than rotating onto one that is already busy.
    std::vector<TheatreOption> options = {
        Theatre("busy", "busy_war", {"compact", "union"}, 4, /*liveWars=*/2),
        Theatre("quiet", "quiet_war", {"compact", "union"}, 4, /*liveWars=*/0),
    };
    options[0].use.lastSeededAt = 0;       // never used, but busy
    options[1].use.lastSeededAt = 9000;    // used a moment ago, but empty
    const auto* pick = ChooseDemandSeedTheatre(options, "compact", {"union"});
    REQUIRE(pick != nullptr);
    CHECK(pick->mapId == "quiet");
}

TEST_CASE("wars task 7: rotation never outranks fielding the right opponent") {
    // A war seeded against a faction with nobody waiting is a war with one
    // side in it. Variety is a tie-break, not a reason to build that.
    std::vector<TheatreOption> options = {
        Theatre("stale", "stale_war", {"compact", "raiders"}),
        Theatre("fresh", "fresh_war", {"compact", "union"}),
    };
    options[0].use.lastSeededAt = 0;       // never used
    options[1].use.lastSeededAt = 9999;    // used seconds ago
    const auto* pick =
        ChooseDemandSeedTheatre(options, "compact", {"union", "raiders"});
    REQUIRE(pick != nullptr);
    CHECK(pick->mapId == "fresh");
}

TEST_CASE("wars task 7: identical recency still deploys deterministically") {
    std::vector<TheatreOption> options = {
        Theatre("zeta", "zeta_war", {"compact", "union"}),
        Theatre("alpha", "alpha_war", {"compact", "union"}),
    };
    options[0].use.lastSeededAt = 500;
    options[1].use.lastSeededAt = 500;
    CHECK(ChooseDemandSeedTheatre(options, "compact", {"union"})->mapId ==
          "alpha");
}

TEST_CASE("wars task 7: LessRecentlyUsed is a rule about variety, not an order") {
    CHECK(LessRecentlyUsed({0}, {5}));
    CHECK_FALSE(LessRecentlyUsed({5}, {0}));
    CHECK(LessRecentlyUsed({3}, {5}));
    CHECK_FALSE(LessRecentlyUsed({5}, {5}));
    // Two never-used theatres are equally fresh; the caller's next key
    // decides, which is what keeps this from pretending to be a total order.
    CHECK(SameRecency({0}, {0}));
    CHECK(SameRecency({7}, {7}));
    CHECK_FALSE(SameRecency({0}, {7}));
}

// ── §3's operator pick: adopting a war that already exists ────────────────

TEST_CASE("wars task 7: a room's own sides become the Director's row") {
    const WarSides sides = {{"compact", 0}, {"union", 4}};
    const WarSideCapacities caps = {{"compact", 6}, {"union", 3}};
    const WarSeedPlan plan =
        PlanWarFromRoom("Raven Basin", "scorched_crossing_v2.4", "metalstorm",
                        "crossing_standoff", sides, caps, WarOrigin::Operator);
    REQUIRE(plan.ok);
    CHECK(plan.theatre == "scorched_crossing_v2.4");
    CHECK(plan.scenario == "crossing_standoff");
    CHECK(plan.origin == WarOrigin::Operator);
    REQUIRE(plan.sides.size() == 2);
    // The SCENARIO's team numbers survive — not re-derived as 0/1. Handing
    // this war {0,1} would put the union's whole army on a team nobody is
    // seated on, which is §7.4's defect from the other end.
    CHECK(plan.sides[0].team == 0);
    CHECK(plan.sides[1].team == 4);
    // …and the scenario's authored side widths, which a second sizing pass
    // would silently discard.
    CHECK(plan.sides[0].slotCap == 6);
    CHECK(plan.sides[1].slotCap == 3);
    CHECK(plan.TotalSlotCap() == 9);
}

TEST_CASE("wars task 7: a one-sided room is a skirmish, not a war to adopt") {
    const WarSeedPlan plan =
        PlanWarFromRoom("Solo", "map", "metalstorm", "", {{"compact", 0}}, {},
                        WarOrigin::Operator);
    CHECK_FALSE(plan.ok);
    CHECK_FALSE(plan.error.empty());
}

TEST_CASE("wars task 7: an adopted side has no capacity opinion of its own") {
    // A room that declared no capacities gets the default, not zero — zero is
    // UNLIMITED everywhere else in this system, and adopting a war into
    // unlimited sides would make its ` slotCap` sum unknowable (task 5).
    const WarSeedPlan plan =
        PlanWarFromRoom("W", "map", "metalstorm", "", {{"a", 0}, {"b", 1}}, {},
                        WarOrigin::Operator);
    REQUIRE(plan.ok);
    CHECK(plan.sides[0].slotCap == WAR_SIDE_CAPACITY_DEFAULT);
}
