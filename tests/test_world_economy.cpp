// PLAN-worldsim.md W9: the economic tick — per-POI/per-faction income and
// treasury decay, priced against the world clock.
//
// Same shape as test_world_stats.cpp: everything here runs against an
// in-memory SQLite database with no lobby, no game server and no sim, and the
// PRICING (income, decay) is pure functions driven with no database at all.
//
// The properties under test are the ones the header promises, not an
// implementation's convenience:
//   - a ledger, never a mutated balance column (`TreasuryFor` sums rows)
//   - idempotent catch-up: one Tick call over a long gap prices the same
//     total as the closed-form functions predict, never a per-day replay
//   - the pause ledger stops accrual for free, because a paused world's
//     `worldMs` does not move between two Tick calls
//   - every rate is per-world config

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldEconomy.h"
#include "Server/WorldFactions.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr int64_t kDayMs    = 24LL * 3600LL * 1000LL;
constexpr const char* kW    = "earth";

struct EconDb {
    sqlite3* db = nullptr;
    EconDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);  // also ensures WorldEconomy's tables
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~EconDb() { sqlite3_close(db); }

    WorldEconomyRules Rules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldEconomyRules::FromWorldConfig(w->config);
    }

    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

    // UpsertPoi deliberately never writes ownership (WorldDirector.h: it
    // changes on a different cadence than geography, so it is its own
    // statement) — SetPoiOwner is the real writer.
    void AddPoi(const std::string& id, const std::string& owner) {
        WorldPoiRecord p;
        p.worldId = kW;
        p.poiId   = id;
        p.name    = id;
        p.createdAt = kNow;
        REQUIRE(WorldDirector::UpsertPoi(db, p));
        if (!owner.empty())
            REQUIRE(WorldDirector::SetPoiOwner(db, kW, id, owner));
    }

    std::string Found(const std::string& name, int64_t account,
                      const std::string& seatPoi = {}) {
        WorldFactionFoundRequest r;
        r.worldId   = kW;
        r.name      = name;
        r.archetype = kArchetypeOrder;
        r.accountId = account;
        r.username  = "player" + std::to_string(account);
        r.seatPoiId = seatPoi;
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        const auto res = WorldFactions::Found(
            db, WorldFactionRules::FromWorldConfig(w->config), r, kNow);
        REQUIRE_MESSAGE(res.ok, res.error);
        return res.faction->factionId;
    }
};

bool TableExists(sqlite3* db, const char* name) {
    sqlite3_stmt* s = nullptr;
    REQUIRE(sqlite3_prepare_v2(
                db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                -1, &s, nullptr) == SQLITE_OK);
    sqlite3_bind_text(s, 1, name, -1, SQLITE_TRANSIENT);
    const bool found = sqlite3_step(s) == SQLITE_ROW;
    sqlite3_finalize(s);
    return found;
}

std::vector<std::string> ColumnsOf(sqlite3* db, const std::string& table) {
    std::vector<std::string> out;
    sqlite3_stmt* s = nullptr;
    const std::string sql = "PRAGMA table_info(" + table + ")";
    REQUIRE(sqlite3_prepare_v2(db, sql.c_str(), -1, &s, nullptr) == SQLITE_OK);
    while (sqlite3_step(s) == SQLITE_ROW)
        out.push_back(reinterpret_cast<const char*>(sqlite3_column_text(s, 1)));
    sqlite3_finalize(s);
    return out;
}

}  // namespace

// ─────────────────────────── the boundary ──────────────────────────────────

TEST_CASE("W9: the economy tables are world-scoped and never room-scoped") {
    EconDb h;
    CHECK(TableExists(h.db, "world_economy_events"));
    CHECK(TableExists(h.db, "world_economy_cursor"));
    for (const char* table : {"world_economy_events", "world_economy_cursor"}) {
        const auto cols = ColumnsOf(h.db, table);
        REQUIRE(!cols.empty());
        CHECK(cols.front() == "world_id");
        for (const auto& c : cols) CHECK(c != "room_id");
    }
}

// ─────────────────────────── pure pricing ──────────────────────────────────

TEST_CASE("W9: POI income is linear and zero at zero elapsed") {
    WorldEconomyRules r;
    r.poiIncomePerWorldDay = 4.0;
    CHECK(PoiIncomeOverPeriod(0, r) == 0.0);
    CHECK(PoiIncomeOverPeriod(-1000, r) == 0.0);
    CHECK(PoiIncomeOverPeriod(kDayMs, r) == doctest::Approx(4.0));
    CHECK(PoiIncomeOverPeriod(3 * kDayMs, r) == doctest::Approx(12.0));
    // Linear: pricing one long gap must equal pricing it in two pieces summed
    // — the property idempotent catch-up (one Tick call over any gap) leans
    // on.
    CHECK(PoiIncomeOverPeriod(5 * kDayMs, r) ==
          doctest::Approx(PoiIncomeOverPeriod(2 * kDayMs, r) + PoiIncomeOverPeriod(3 * kDayMs, r)));
}

TEST_CASE("W9: treasury decay is continuous, gentle and floored") {
    WorldEconomyRules r;
    r.treasuryDecayPerWorldDay = 0.10;
    r.treasuryFloor = 5.0;

    CHECK(TreasuryDecayOverPeriod(100.0, 0, r) == 0.0);
    const double d1 = TreasuryDecayOverPeriod(100.0, kDayMs, r);
    CHECK(d1 < 0.0);
    CHECK(100.0 + d1 == doctest::Approx(90.0));

    // Never raises a balance already at/below the floor.
    CHECK(TreasuryDecayOverPeriod(5.0, kDayMs, r) == 0.0);
    CHECK(TreasuryDecayOverPeriod(2.0, kDayMs, r) == 0.0);

    // Never decays PAST the floor even over a huge span.
    const double dBig = TreasuryDecayOverPeriod(100.0, 10000 * kDayMs, r);
    CHECK(100.0 + dBig == doctest::Approx(5.0));

    // A non-positive or zero rate never touches the balance.
    WorldEconomyRules zero = r;
    zero.treasuryDecayPerWorldDay = 0.0;
    CHECK(TreasuryDecayOverPeriod(100.0, kDayMs, zero) == 0.0);
}

// ─────────────────────────── the tick ──────────────────────────────────────

TEST_CASE("W9: the first tick for a world plants the cursor and prices nothing") {
    EconDb h;
    const auto f = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", f);
    const int written = WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    CHECK(written == 0);
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, f) == 0.0);
    CHECK(WorldEconomy::LastTickWorldMs(h.db, kW) == kWorldNow);
}

TEST_CASE("W9: a POI's owning faction earns per-POI income over elapsed world time") {
    EconDb h;
    const auto f = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", f);
    h.AddPoi("poi-b", f);
    // Baseline.
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    const int64_t later = kWorldNow + 2 * kDayMs;
    const int written = WorldEconomy::Tick(h.db, kW, h.Rules(), later, kNow + 1000);
    // One income event per owned POI.
    CHECK(written == 2);

    const auto rules = h.Rules();
    const double expectedPerPoi = PoiIncomeOverPeriod(2 * kDayMs, rules);
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, f) ==
          doctest::Approx(2 * expectedPerPoi));

    const auto events = WorldEconomy::EventsFor(h.db, kW, f);
    REQUIRE(events.size() == 2);
    for (const auto& e : events) {
        CHECK(e.source == "poi_income");
        CHECK(!e.poiId.empty());
        CHECK(e.delta == doctest::Approx(expectedPerPoi));
    }
}

TEST_CASE("W9: a faction with no POIs earns nothing") {
    EconDb h;
    const auto f = h.Found("Vanguard", 1);  // no AddPoi call
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow + 5 * kDayMs, kNow);
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, f) == 0.0);
}

TEST_CASE("W9: an idle faction's treasury decays even after it loses its POI") {
    EconDb h;
    const auto f = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", f);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow + kDayMs, kNow);
    const double afterIncome = WorldEconomy::TreasuryFor(h.db, kW, f);
    REQUIRE(afterIncome > 0.0);

    // The faction loses the POI: SetPoiOwner clears it.
    REQUIRE(WorldDirector::SetPoiOwner(h.db, kW, "poi-a", ""));
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow + 2 * kDayMs, kNow);
    const double afterDecay = WorldEconomy::TreasuryFor(h.db, kW, f);
    CHECK(afterDecay < afterIncome);
    CHECK(afterDecay > 0.0);
}

TEST_CASE("W9: idempotent catch-up — one long gap prices the same total as the closed form, "
          "and calling Tick again at the same clock reading writes nothing") {
    EconDb h;
    const auto f = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", f);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    // Simulate a lobby that was down for a long stretch: one Tick call prices
    // a 40-world-day gap in a single shot.
    const int64_t bigLater = kWorldNow + 40 * kDayMs;
    const int written = WorldEconomy::Tick(h.db, kW, h.Rules(), bigLater, kNow + 999);
    CHECK(written >= 1);
    const auto rules = h.Rules();
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, f) ==
          doctest::Approx(PoiIncomeOverPeriod(40 * kDayMs, rules)));

    // Calling again at the SAME world-clock reading (what happens while the
    // world is paused — see WorldClock.h) must not write or move the ledger.
    const double before = WorldEconomy::TreasuryFor(h.db, kW, f);
    const int repeat = WorldEconomy::Tick(h.db, kW, h.Rules(), bigLater, kNow + 5000);
    CHECK(repeat == 0);
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, f) == doctest::Approx(before));
}

TEST_CASE("W9: rates are per-world config, per key, never a hardcoded literal") {
    EconDb h;
    h.SetConfig("poiIncomePerWorldDay", 100.0);
    h.SetConfig("treasuryDecayPerWorldDay", 0.0);
    const auto f = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", f);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow + kDayMs, kNow);
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, f) == doctest::Approx(100.0));

    // A world whose blob predates these keys (an empty config) must still get
    // the struct's own defaults, not zero/disabled.
    const auto fallback = WorldEconomyRules::FromWorldConfig(nlohmann::json::object());
    CHECK(fallback.poiIncomePerWorldDay == WorldEconomyRules{}.poiIncomePerWorldDay);
}

// ─────────────────────────── the Rank seam (W8 closes on this) ────────────

TEST_CASE("W9: a faction's treasury feeds Rank's money term, split across active members") {
    EconDb h;
    const auto f = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", f);
    REQUIRE(WorldFactions::Join(h.db, kW, f, 2, "player2", kNow).ok);

    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    WorldEconomy::Tick(h.db, kW, h.Rules(), kWorldNow + kDayMs, kNow);
    const double treasury = WorldEconomy::TreasuryFor(h.db, kW, f);
    REQUIRE(treasury > 0.0);

    const auto statRules = [&] {
        const auto w = WorldDirector::Load(h.db, kW);
        REQUIRE(w.has_value());
        return WorldStatRules::FromWorldConfig(w->config);
    }();
    const auto rank1 = WorldStats::RankFor(h.db, kW, 1, statRules, kWorldNow + kDayMs);
    const auto rank2 = WorldStats::RankFor(h.db, kW, 2, statRules, kWorldNow + kDayMs);
    // Two members, equal split.
    CHECK(rank1.money == doctest::Approx(rank2.money));
    CHECK(rank1.money == doctest::Approx((treasury / 2.0) * statRules.rankPerMoney));
}
