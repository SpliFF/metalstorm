// PLAN-worldsim.md W3: "seeder writes POIs + transit edges (weight =
// world-hours, from great-circle distance × per-world rate). Dynamic POI
// count = config knob honoured by the seeder (worlds start sparse). POIs
// with no battle map are legal."
//
// Same pattern as test_world_director.cpp: an in-memory sqlite database, no
// lobby, no sim.

#include <algorithm>
#include <string>
#include <vector>

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldMapSeeder.h"

namespace {

struct WorldDb {
    sqlite3* db = nullptr;
    WorldDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
    }
    ~WorldDb() { sqlite3_close(db); }
};

constexpr int64_t kHourMs = 3600LL * 1000;
constexpr int64_t kDayMs  = 24 * kHourMs;
constexpr int64_t kEpoch  = 1'700'000'000'000LL;

}  // namespace

// ── The budget arithmetic: pure, no database ───────────────────────────────

TEST_CASE("W3: POI budget starts at the initial floor and never goes below it") {
    WorldDefaults cfg;
    CHECK(WorldMapSeeder::ComputePoiBudget(cfg, 0, 0) == cfg.poiBudgetInitial);
    // A negative age (clock skew) must not dip the budget below the floor.
    CHECK(WorldMapSeeder::ComputePoiBudget(cfg, -kDayMs, 0) == cfg.poiBudgetInitial);
}

TEST_CASE("W3: POI budget grows with world age and registered players, and caps at the max") {
    WorldDefaults cfg;
    cfg.poiBudgetInitial      = 4;
    cfg.poiBudgetMax          = 20;
    cfg.poiPerWorldAgeDay     = 1.0;
    cfg.poiPerRegisteredPlayer = 2.0;

    // 4 initial + 10 age-days*1.0 = 14.
    CHECK(WorldMapSeeder::ComputePoiBudget(cfg, 10 * kDayMs, 0) == 14);
    // 4 initial + 3 players*2.0 = 10.
    CHECK(WorldMapSeeder::ComputePoiBudget(cfg, 0, 3) == 10);
    // Both combine, then clamp at the max.
    CHECK(WorldMapSeeder::ComputePoiBudget(cfg, 100 * kDayMs, 50) == 20);
}

// ── Great-circle distance: pure, no database ───────────────────────────────

TEST_CASE("W3: great-circle distance is zero for coincident points and symmetric") {
    CHECK(WorldMapSeeder::GreatCircleKm(51.5, -0.12, 51.5, -0.12) == doctest::Approx(0.0));
    const double ab = WorldMapSeeder::GreatCircleKm(51.5, -0.12, 68.2, 14.6);
    const double ba = WorldMapSeeder::GreatCircleKm(68.2, 14.6, 51.5, -0.12);
    CHECK(ab == doctest::Approx(ba));
    CHECK(ab > 0.0);
    // London to Lofoten is a bit under 2000km as the crow flies — sanity
    // bound, not an exact fixture, so the tolerance is generous.
    CHECK(ab == doctest::Approx(1930.0).epsilon(0.05));
}

// ── The seeder, through the store ──────────────────────────────────────────

TEST_CASE("W3: a fresh world is seeded up to its initial budget, battle maps first") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);
    REQUIRE(!id.empty());

    // Shrink the budget below the register's size so seeding order is
    // observable: with a budget of 2, only the two battle-map POIs earliest
    // in the register should land, never a world-only one ahead of them.
    auto world = WorldDirector::Load(f.db, id);
    REQUIRE(world.has_value());
    world->config["poiBudgetInitial"] = 2;
    world->config["poiBudgetMax"] = 2;
    REQUIRE(WorldDirector::Upsert(f.db, *world));

    const int added = WorldMapSeeder::SeedFromRegistry(f.db, id, kEpoch);
    CHECK(added == 2);

    const auto pois = WorldDirector::PoisFor(f.db, id);
    REQUIRE(pois.size() == 2);
    for (const auto& p : pois) {
        CHECK_FALSE(p.mapId.empty());
    }

    // Idempotent: seeding again with the same budget adds nothing new.
    CHECK(WorldMapSeeder::SeedFromRegistry(f.db, id, kEpoch) == 0);
    CHECK(WorldDirector::PoisFor(f.db, id).size() == 2);
}

TEST_CASE("W3: a wide-open budget seeds the whole register, including world-only POIs") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);

    const int added = WorldMapSeeder::SeedFromRegistry(f.db, id, kEpoch);
    CHECK(added == static_cast<int>(WorldMapSeeder::Registry().size()));

    const auto pois = WorldDirector::PoisFor(f.db, id);
    CHECK(pois.size() == WorldMapSeeder::Registry().size());

    // At least one seeded POI carries no battle map — legal per Capture 10,
    // and the seeder must actually exercise the capability, not merely leave
    // it possible.
    const bool anyWorldOnly = std::any_of(pois.begin(), pois.end(),
        [](const WorldPoiRecord& p) { return p.mapId.empty(); });
    CHECK(anyWorldOnly);
    const bool anyWithMap = std::any_of(pois.begin(), pois.end(),
        [](const WorldPoiRecord& p) { return !p.mapId.empty(); });
    CHECK(anyWithMap);

    // Every registry POI the seeder wrote is real Earth geography, not the
    // 0,0 zero-value default a forgotten field would leave behind.
    for (const auto& p : pois) {
        CHECK_FALSE((p.lat == 0.0 && p.lon == 0.0));
    }
}

TEST_CASE("W3: transit edges connect the whole graph and their weight is distance x rate") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);
    WorldMapSeeder::SeedFromRegistry(f.db, id, kEpoch);

    const auto pois = WorldDirector::PoisFor(f.db, id);
    const auto edges = WorldDirector::EdgesFor(f.db, id);
    // A minimum spanning tree over N nodes has exactly N-1 edges.
    REQUIRE(edges.size() == pois.size() - 1);

    const auto world = WorldDirector::Load(f.db, id);
    REQUIRE(world.has_value());
    const double rate = world->config.value("transitWorldMsPerKm", WorldDefaults{}.transitWorldMsPerKm);

    for (const auto& e : edges) {
        CHECK(e.bidirectional);
        CHECK(e.transitWorldMs > 0);
        const auto from = WorldDirector::LoadPoi(f.db, id, e.fromPoi);
        const auto to   = WorldDirector::LoadPoi(f.db, id, e.toPoi);
        REQUIRE(from.has_value());
        REQUIRE(to.has_value());
        const double km = WorldMapSeeder::GreatCircleKm(from->lat, from->lon, to->lat, to->lon);
        CHECK(e.transitWorldMs == doctest::Approx(km * rate).epsilon(0.001));
    }

    // Connectivity: a BFS/DFS over the edges reaches every POI.
    std::vector<std::string> frontier = {pois.front().poiId};
    std::vector<std::string> reached = frontier;
    while (!frontier.empty()) {
        const std::string cur = frontier.back();
        frontier.pop_back();
        for (const auto& e : edges) {
            std::string other;
            if (e.fromPoi == cur) other = e.toPoi;
            else if (e.toPoi == cur) other = e.fromPoi;
            else continue;
            if (std::find(reached.begin(), reached.end(), other) == reached.end()) {
                reached.push_back(other);
                frontier.push_back(other);
            }
        }
    }
    CHECK(reached.size() == pois.size());
}

TEST_CASE("W3: an incrementally seeded world still ends up fully connected") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);
    auto world = WorldDirector::Load(f.db, id);
    REQUIRE(world.has_value());
    world->config["poiBudgetInitial"] = 1;
    world->config["poiBudgetMax"] = 1;
    REQUIRE(WorldDirector::Upsert(f.db, *world));

    // First boot: budget 1, one POI, no edges possible yet.
    WorldMapSeeder::SeedFromRegistry(f.db, id, kEpoch);
    CHECK(WorldDirector::PoisFor(f.db, id).size() == 1);
    CHECK(WorldDirector::EdgesFor(f.db, id).empty());

    // The world ages / grows and the operator raises the cap; the next boot
    // must connect the newly-added POIs to the ones already there, not just
    // among themselves.
    world = WorldDirector::Load(f.db, id);
    world->config["poiBudgetMax"] = 10;
    WorldDirector::Upsert(f.db, *world);
    WorldMapSeeder::SeedFromRegistry(f.db, id, kEpoch + 400 * kDayMs);

    const auto pois = WorldDirector::PoisFor(f.db, id);
    const auto edges = WorldDirector::EdgesFor(f.db, id);
    CHECK(edges.size() == pois.size() - 1);
}

TEST_CASE("W3: an unknown world seeds nothing") {
    WorldDb f;
    CHECK(WorldMapSeeder::SeedFromRegistry(f.db, "mars", kEpoch) == 0);
}
