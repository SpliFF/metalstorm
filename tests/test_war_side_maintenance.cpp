// PLAN-metalstorm-wars.md §4, task 2's third and fourth halves: side sizing
// maintenance (the post-boot raise, within the map limit) and underdog-
// incentive flagging (a FLAG, never a reassignment).

#include <doctest/doctest.h>
#include <sqlite3.h>

#include "Server/WarDirector.h"
#include "Server/WarPlayerBindings.h"
#include "Server/WarSideMaintenance.h"
#include "Server/WarSlotReservation.h"

namespace {

constexpr int64_t kNow = 1'700'000'000;

WarSideFacts Side(const char* faction, unsigned cap, unsigned bound,
                  unsigned reserved = 0, bool incentivised = false) {
    WarSideFacts f;
    f.factionId    = faction;
    f.slotCap      = cap;
    f.bound        = bound;
    f.reserved     = reserved;
    f.incentivised = incentivised;
    return f;
}

struct MaintDb {
    sqlite3* db = nullptr;
    MaintDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WarDirector::EnsureTables(db);
        WarPlayerBindings::EnsureTable(db);
        WarSlotReservations::EnsureTable(db);
    }
    ~MaintDb() { sqlite3_close(db); }

    void SeedWar(unsigned cap, unsigned spawnedSlotCap) {
        WarSeedRequest r;
        r.name          = "Raven Basin";
        r.theatre       = "scorched_crossing_v2.4";
        r.gameId        = "metalstorm";
        r.factions      = {"compact", "union"};
        r.startBoxCount = 4;
        WarSeedPlan plan = PlanWarSeed(r, WarSeedPopulation{});
        REQUIRE(plan.ok);
        for (auto& s : plan.sides)
            s.slotCap = cap;
        REQUIRE(WarDirector::Register(db, 7, plan, kNow));
        REQUIRE(WarDirector::SetState(db, 7, WarState::Open, kNow));
        REQUIRE(WarDirector::RecordSpawnedSlotCap(db, 7, spawnedSlotCap));
    }

    unsigned CapOf(const char* faction) {
        for (const auto& s : WarDirector::SidesFor(db, 7))
            if (s.factionId == faction)
                return s.slotCap;
        return 0;
    }
    bool IncentivisedOf(const char* faction) {
        for (const auto& s : WarDirector::SidesFor(db, 7))
            if (s.factionId == faction)
                return s.incentivised;
        return false;
    }
};

}  // namespace

TEST_CASE("task 2: only a side with no free seat is raised") {
    // compact is full (4 bound against a cap of 4); union has room.
    const std::vector<WarSideFacts> sides = {Side("compact", 4, 4),
                                             Side("union", 4, 1)};
    const auto plan = PlanWarSideMaintenance(sides, {/*spawned=*/12, 0});
    REQUIRE(plan.capRaises.size() == 1);
    CHECK(plan.capRaises[0].factionId == "compact");
    CHECK(plan.capRaises[0].from == 4);
    // One seat per pass: the war grows with the queue rather than jumping to
    // the ceiling the first time somebody is turned away.
    CHECK(plan.capRaises[0].to == 5);
}

TEST_CASE("task 2: a reservation presses a side as hard as a binding") {
    // 3 bound + 1 in-flight join against a cap of 4 — no free seat.
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 4, 3, 1), Side("union", 4, 0)}, {12, 0});
    REQUIRE(plan.capRaises.size() == 1);
    CHECK(plan.capRaises[0].factionId == "compact");
}

TEST_CASE("task 2: a raise never crosses the limit the caller supplies") {
    // Σ cap is 8 and the running server was spawned for 8 player slots. Both
    // sides are full and NEITHER may grow: a ninth advertised seat is a seat
    // the dynamic join has no player slot for.
    const auto atCeiling = PlanWarSideMaintenance(
        {Side("compact", 4, 4), Side("union", 4, 4)}, {/*spawned=*/8, 0});
    CHECK(atCeiling.capRaises.empty());

    // One seat of headroom, two pressed sides → the more oversubscribed one
    // gets it.
    const auto oneSeat = PlanWarSideMaintenance(
        {Side("compact", 4, 6), Side("union", 4, 4)}, {/*spawned=*/9, 0});
    REQUIRE(oneSeat.capRaises.size() == 1);
    CHECK(oneSeat.capRaises[0].factionId == "compact");

    // The map's own limit binds when it is the smaller of the two.
    const auto mapBound = PlanWarSideMaintenance(
        {Side("compact", 4, 6), Side("union", 4, 4)},
        {/*spawned=*/16, /*map=*/8});
    CHECK(mapBound.capRaises.empty());

    // An unknown spawn size raises nothing: it is read as "no raise is
    // possible", not as "no limit".
    const auto unknown = PlanWarSideMaintenance(
        {Side("compact", 4, 6), Side("union", 4, 4)}, {/*spawned=*/0, 0});
    CHECK(unknown.capRaises.empty());
}

TEST_CASE("task 2: an unlimited side is never raised") {
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 0, 40), Side("union", 4, 0)}, {64, 0});
    CHECK(plan.capRaises.empty());
}

TEST_CASE("task 2: the outnumbered side is flagged, and nobody is moved") {
    // union trails by 3 — flagged. compact leads — never flagged.
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 6, 4), Side("union", 6, 1)}, {12, 0});
    REQUIRE(plan.incentiveChanges.size() == 1);
    CHECK(plan.incentiveChanges[0].factionId == "union");
    CHECK(plan.incentiveChanges[0].on);
}

TEST_CASE("task 2: a one-player difference is not an underdog") {
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 6, 3), Side("union", 6, 2)}, {12, 0});
    CHECK(plan.incentiveChanges.empty());
}

TEST_CASE("task 2: a closed deficit clears the flag") {
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 6, 3, 0, /*incentivised=*/false),
         Side("union", 6, 3, 0, /*incentivised=*/true)},
        {12, 0});
    REQUIRE(plan.incentiveChanges.size() == 1);
    CHECK(plan.incentiveChanges[0].factionId == "union");
    CHECK_FALSE(plan.incentiveChanges[0].on);
}

TEST_CASE("task 2: an unchanged flag produces no write") {
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 6, 4, 0, false), Side("union", 6, 1, 0, true)},
        {12, 0});
    CHECK(plan.incentiveChanges.empty());
}

TEST_CASE("task 2: an in-flight join does not close the deficit on paper") {
    // union trails by 3 bound, with 3 joins in flight. The flag stays on: a
    // reservation is somebody who has not arrived, and paying the bonus for a
    // deficit that is about to close would pay it to the wrong people.
    const auto plan = PlanWarSideMaintenance(
        {Side("compact", 6, 4), Side("union", 6, 1, 3)}, {12, 0});
    REQUIRE(plan.incentiveChanges.size() == 1);
    CHECK(plan.incentiveChanges[0].factionId == "union");
    CHECK(plan.incentiveChanges[0].on);
}

TEST_CASE("task 2: a maintenance pass applies both rules to a live war") {
    MaintDb t;
    t.SeedWar(/*cap=*/2, /*spawnedSlotCap=*/8);

    // Four compact veterans hold seats — the war has outgrown its seed size —
    // and one union player is alone on the other side.
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 101, "a", "compact", 0, kNow));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 102, "b", "compact", 0, kNow));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 103, "c", "compact", 0, kNow));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 201, "d", "union", 1, kNow));

    const auto r = MaintainWarSides(t.db, 7, {/*spawned=*/0, /*map=*/0}, kNow);
    CHECK(r.ok);
    CHECK(r.capsRaised == 1);
    CHECK(r.flagsChanged == 1);
    // The spawn record was read off the `wars` row — the caller left it 0.
    CHECK(t.CapOf("compact") == 3);
    CHECK(t.CapOf("union") == 2);
    CHECK(t.IncentivisedOf("union"));
    CHECK_FALSE(t.IncentivisedOf("compact"));

    // Repeated passes raise only while the pressure lasts: once compact has a
    // free seat again the war stops growing, well short of the spawned
    // ceiling. A raise is a response to demand, not a policy.
    for (int i = 0; i < 10; ++i)
        MaintainWarSides(t.db, 7, {}, kNow);
    CHECK(t.CapOf("compact") == 4);
    CHECK(t.CapOf("union") == 2);
    CHECK(t.CapOf("compact") + t.CapOf("union") <= 8);
}

TEST_CASE("task 2: a war that stopped taking joiners is not resized") {
    MaintDb t;
    t.SeedWar(/*cap=*/2, /*spawnedSlotCap=*/8);
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 101, "a", "compact", 0, kNow));
    REQUIRE(WarPlayerBindings::BindSeat(t.db, 7, 102, "b", "compact", 0, kNow));
    REQUIRE(WarDirector::SetState(t.db, 7, WarState::WindingDown, kNow));

    const auto r = MaintainWarSides(t.db, 7, {}, kNow);
    CHECK(r.ok);
    CHECK(r.capsRaised == 0);
    CHECK(r.flagsChanged == 0);
    CHECK(t.CapOf("compact") == 2);
}

TEST_CASE("task 2: maintenance on an unknown war reports failure") {
    MaintDb t;
    const auto r = MaintainWarSides(t.db, 404, {}, kNow);
    CHECK_FALSE(r.ok);
}
