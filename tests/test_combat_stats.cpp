#include <doctest/doctest.h>

#include "Server/CombatEventCollector.h"

// PLAN-headless task 2 — CombatStatsAccumulator, the per-weapon-def running
// totals fed from the existing combatEvents.Drain() call in
// StateStreamer::BroadcastCombatEvents (so a headless run keeps aggregate
// combat stats even with zero connected clients to broadcast to).

TEST_CASE("CombatStatsAccumulator: totals volleys/kills/damage per weapon def") {
    CombatStatsAccumulator acc;
    std::vector<CombatEventData> batch1 = {
        {1, 10, /*weaponDefId=*/5, /*result=*/0 /*hit*/, 25.0f, {}},
        {1, 10, /*weaponDefId=*/5, /*result=*/3 /*kill*/, 75.0f, {}},
        {2, 11, /*weaponDefId=*/7, /*result=*/1 /*miss*/, 0.0f, {}},
    };
    acc.Accumulate(batch1);

    auto snap = acc.Snapshot();
    REQUIRE(snap.count(5) == 1);
    CHECK(snap[5].volleys == 2);
    CHECK(snap[5].kills == 1);
    CHECK(snap[5].damage == doctest::Approx(100.0f));

    REQUIRE(snap.count(7) == 1);
    CHECK(snap[7].volleys == 1);
    CHECK(snap[7].kills == 0);
    CHECK(snap[7].damage == doctest::Approx(0.0f));
}

TEST_CASE("CombatStatsAccumulator: accumulates across multiple batches (never resets)") {
    CombatStatsAccumulator acc;
    acc.Accumulate({{1, 10, 5, 0, 10.0f, {}}});
    acc.Accumulate({{1, 10, 5, 3, 90.0f, {}}});

    auto snap = acc.Snapshot();
    REQUIRE(snap.count(5) == 1);
    CHECK(snap[5].volleys == 2);
    CHECK(snap[5].kills == 1);
    CHECK(snap[5].damage == doctest::Approx(100.0f));
}

TEST_CASE("CombatStatsAccumulator: empty batch is a no-op") {
    CombatStatsAccumulator acc;
    acc.Accumulate({});
    CHECK(acc.Snapshot().empty());
}
