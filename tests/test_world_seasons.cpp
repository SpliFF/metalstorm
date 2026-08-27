// PLAN-worldsim.md W12: seasons — per-world season rows advancing on the
// world clock, rollover archiving the settlement/economy ledgers into a
// season-scoped digest and reporting whether an event should be emitted.
//
// Same shape as test_world_economy.cpp: everything here runs against an
// in-memory SQLite database with no lobby, no game server and no sim.
//
// The properties under test are the ones the header promises, not an
// implementation's convenience:
//   - the first Tick for a world opens season 1 anchored at `nowWorldMs`,
//     never backdated, and rolls over nothing
//   - a season rolls over only once its configured length has elapsed
//   - a rollover's digest is exactly the settlements/economy events that
//     happened DURING that season — no bleed from a prior or later one
//   - a rollover never mutates the settlement or economy ledgers it reads
//     ("no balance changes")
//   - a paused world (nowWorldMs not advancing) never rolls over
//   - every rate is per-world config

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldEconomy.h"
#include "Server/WorldFactions.h"
#include "Server/WorldSeasons.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr int64_t kDayMs    = 24LL * 3600LL * 1000LL;
constexpr const char* kW    = "earth";

struct SeasonDb {
    sqlite3* db = nullptr;
    SeasonDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);  // also ensures WorldEconomy's tables
        WorldSeasons::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~SeasonDb() { sqlite3_close(db); }

    WorldSeasonRules Rules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldSeasonRules::FromWorldConfig(w->config);
    }

    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

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

    std::string Found(const std::string& name, int64_t account) {
        WorldFactionFoundRequest r;
        r.worldId   = kW;
        r.name      = name;
        r.archetype = kArchetypeOrder;
        r.accountId = account;
        r.username  = "player" + std::to_string(account);
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        const auto res = WorldFactions::Found(
            db, WorldFactionRules::FromWorldConfig(w->config), r, kNow);
        REQUIRE_MESSAGE(res.ok, res.error);
        return res.faction->factionId;
    }

    void Settle(const std::string& poiId, const std::string& factionsCsv,
               int64_t recordedAtReal) {
        WorldSettlementRecord s;
        s.worldId    = kW;
        s.poiId      = poiId;
        s.roomId     = 1;
        s.outcome    = "victory_objective";
        s.factions   = factionsCsv;
        s.recordedAt = recordedAtReal;
        REQUIRE(WorldDirector::RecordSettlement(db, s));
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

std::optional<WorldSeasonDigestRecord> DigestOf(
    const std::vector<WorldSeasonDigestRecord>& digests, const std::string& factionId) {
    for (const auto& d : digests)
        if (d.factionId == factionId) return d;
    return std::nullopt;
}

}  // namespace

// ─────────────────────────── the boundary ──────────────────────────────────

TEST_CASE("W12: the season tables are world-scoped and never room-scoped") {
    SeasonDb h;
    CHECK(TableExists(h.db, "world_seasons"));
    CHECK(TableExists(h.db, "world_season_digests"));
    for (const char* table : {"world_seasons", "world_season_digests"}) {
        const auto cols = ColumnsOf(h.db, table);
        REQUIRE(!cols.empty());
        CHECK(cols.front() == "world_id");
        for (const auto& c : cols) CHECK(c != "room_id");
    }
}

// ─────────────────────────── opening a season ──────────────────────────────

TEST_CASE("W12: the first tick for a world opens season 1 anchored at nowWorldMs and rolls over nothing") {
    SeasonDb h;
    const auto result = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    CHECK_FALSE(result.rolledOver);

    const auto season = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(season.has_value());
    CHECK(season->seasonNumber == 1);
    CHECK(season->state == "active");
    CHECK(season->startedWorldMs == kWorldNow);
    CHECK(season->settlementCursorStart == 0);
}

TEST_CASE("W12: a world ticked long after founding is not backdated a season") {
    SeasonDb h;
    // The world's clock has run for a long time before the first tick — a
    // lobby upgraded to a build with W12 mid-life.
    const int64_t longAfter = kWorldNow + 1000 * kDayMs;
    WorldSeasons::Tick(h.db, kW, h.Rules(), longAfter, kNow);
    const auto season = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(season.has_value());
    // Anchored at the tick's own now, not at world genesis.
    CHECK(season->startedWorldMs == longAfter);
}

// ─────────────────────────── rollover timing ───────────────────────────────

TEST_CASE("W12: a season does not roll over before its configured length elapses") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    const auto r1 = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 5 * kDayMs, kNow + 1);
    CHECK_FALSE(r1.rolledOver);
    CHECK(WorldSeasons::CurrentSeason(h.db, kW)->seasonNumber == 1);
}

TEST_CASE("W12: a season rolls over once its configured length elapses") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    const int64_t rolloverAt = kWorldNow + 10 * kDayMs;
    const auto r = WorldSeasons::Tick(h.db, kW, h.Rules(), rolloverAt, kNow + 1000);
    CHECK(r.rolledOver);
    CHECK(r.endedSeasonNumber == 1);
    CHECK(r.newSeasonNumber == 2);

    const auto season = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(season.has_value());
    CHECK(season->seasonNumber == 2);
    CHECK(season->startedWorldMs == rolloverAt);
}

TEST_CASE("W12: a tick that has already rolled over does not roll over a second time for the same instant") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    const int64_t rolloverAt = kWorldNow + 10 * kDayMs;
    WorldSeasons::Tick(h.db, kW, h.Rules(), rolloverAt, kNow + 1000);

    // Same instant fired again (the lobby loop's next pass before the world
    // clock has moved) — season 2 has just started, so elapsed is 0.
    const auto again = WorldSeasons::Tick(h.db, kW, h.Rules(), rolloverAt, kNow + 1100);
    CHECK_FALSE(again.rolledOver);
    CHECK(WorldSeasons::CurrentSeason(h.db, kW)->seasonNumber == 2);
}

TEST_CASE("W12: a paused world (nowWorldMs not advancing) never rolls over") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(1 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    // The lobby loop fires several more times while the world is paused —
    // ClockFor would answer the same worldMs each time, exactly this.
    for (int i = 0; i < 5; ++i) {
        const auto r = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow + 100 * i);
        CHECK_FALSE(r.rolledOver);
    }
    CHECK(WorldSeasons::CurrentSeason(h.db, kW)->seasonNumber == 1);
}

// ─────────────────────────── the digest ────────────────────────────────────

TEST_CASE("W12: the digest credits settlements to their winning faction(s), and unclaimed ones separately") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(1 * kDayMs));
    const auto vanguard = h.Found("Vanguard", 1);
    const auto remnant  = h.Found("Remnant", 2);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    h.Settle("poi-a", vanguard, kNow + 10);
    h.Settle("poi-b", vanguard + "," + remnant, kNow + 20);  // a joint win
    h.Settle("poi-c", "", kNow + 30);                        // operator retire — no winner

    const auto r = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 2 * kDayMs, kNow + 40);
    REQUIRE(r.rolledOver);

    const auto digests = WorldSeasons::DigestsFor(h.db, kW, 1);
    const auto vg = DigestOf(digests, vanguard);
    REQUIRE(vg.has_value());
    CHECK(vg->settlementsWon == 2);  // poi-a alone, poi-b jointly

    const auto rm = DigestOf(digests, remnant);
    REQUIRE(rm.has_value());
    CHECK(rm->settlementsWon == 1);  // poi-b jointly

    const auto unclaimed = DigestOf(digests, "");
    REQUIRE(unclaimed.has_value());
    CHECK(unclaimed->settlementsWon == 1);  // poi-c
}

TEST_CASE("W12: a settlement recorded in a LATER season is not credited to the one that already closed") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(1 * kDayMs));
    const auto vanguard = h.Found("Vanguard", 1);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    h.Settle("poi-a", vanguard, kNow + 10);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 2 * kDayMs, kNow + 20);  // closes season 1

    // A second settlement, recorded after season 1 closed.
    h.Settle("poi-b", vanguard, kNow + 30);
    const auto r2 =
        WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 4 * kDayMs, kNow + 40);
    REQUIRE(r2.rolledOver);
    REQUIRE(r2.endedSeasonNumber == 2);

    const auto season1Digests = WorldSeasons::DigestsFor(h.db, kW, 1);
    CHECK(DigestOf(season1Digests, vanguard)->settlementsWon == 1);

    const auto season2Digests = WorldSeasons::DigestsFor(h.db, kW, 2);
    CHECK(DigestOf(season2Digests, vanguard)->settlementsWon == 1);
}

TEST_CASE("W12: the digest sums this season's economy events per faction and snapshots the treasury, without mutating either ledger") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    const auto vanguard = h.Found("Vanguard", 1);
    h.AddPoi("poi-a", vanguard);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    // The economic tick (W9) is what actually writes world_economy_events —
    // seasons only ever READ it. W9's own first call for a world only plants
    // its cursor and writes nothing, so a baseline call is needed before the
    // one that actually prices a period.
    const auto econRules =
        WorldEconomyRules::FromWorldConfig(WorldDirector::Load(h.db, kW)->config);
    WorldEconomy::Tick(h.db, kW, econRules, kWorldNow, kNow);
    WorldEconomy::Tick(h.db, kW, econRules, kWorldNow + 5 * kDayMs, kNow + 500);
    const auto eventsBefore = WorldEconomy::EventsFor(h.db, kW, vanguard);
    const double treasuryBefore = WorldEconomy::TreasuryFor(h.db, kW, vanguard);
    REQUIRE(!eventsBefore.empty());

    const auto r =
        WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 1000);
    REQUIRE(r.rolledOver);

    // No balance changes: the ledger this season read from is untouched by
    // the rollover.
    CHECK(WorldEconomy::EventsFor(h.db, kW, vanguard).size() == eventsBefore.size());
    CHECK(WorldEconomy::TreasuryFor(h.db, kW, vanguard) == doctest::Approx(treasuryBefore));

    const auto digests = WorldSeasons::DigestsFor(h.db, kW, 1);
    const auto vg = DigestOf(digests, vanguard);
    REQUIRE(vg.has_value());
    CHECK(vg->poiIncomeTotal > 0.0);
    CHECK(vg->treasuryAtRollover == doctest::Approx(treasuryBefore));
}

// ─────────────────────────── the read surface ──────────────────────────────

TEST_CASE("W12: AttachSeasonStatus reports null before any tick has ever run, and the season shape after") {
    SeasonDb h;
    nlohmann::json body;

    const auto beforeTick =
        WorldSeasons::AttachSeasonStatus(body, h.db, kW, h.Rules(), kWorldNow);
    CHECK(beforeTick["season"].is_null());

    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    const auto afterTick =
        WorldSeasons::AttachSeasonStatus(body, h.db, kW, h.Rules(), kWorldNow + kDayMs);
    REQUIRE(afterTick["season"].is_object());
    CHECK(afterTick["season"]["number"].get<int>() == 1);
    CHECK(afterTick["season"]["startedWorldMs"].get<int64_t>() == kWorldNow);
    CHECK(afterTick["season"]["remainingWorldMs"].get<int64_t>() ==
          afterTick["season"]["endsWorldMs"].get<int64_t>() - (kWorldNow + kDayMs));
}

TEST_CASE("W12: the season headline names both the ended and the new season number") {
    const auto headline = WorldSeasonHeadline(3, 4);
    CHECK(headline.find("3") != std::string::npos);
    CHECK(headline.find("4") != std::string::npos);
}

// ─────────────────────────── phase 3: the season id seam ───────────────────
//
// Worldsim phase 3 item 1: `WarTerminationFacts::currentSeasonId` is wired.
// `WorldSeasonIdFor` is the ONE builder both ends use — the stamp a war is
// seeded with at staging materialisation (`WarSeedRequest::seasonId`) and the
// comparison value the lifecycle sweep hands `EvaluateWarTermination` — so
// the rule in WarTermination.h can never see a format mismatch. These tests
// drive the real store across a real rollover, exactly the read path the
// sweep performs.

#include "Server/WarTermination.h"

TEST_CASE("phase 3: the season id is stable within a season and changes only at rollover") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    const auto s1 = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(s1.has_value());
    const std::string idAtSeed = WorldSeasonIdFor(kW, s1->seasonNumber);
    CHECK(!idAtSeed.empty());
    // The id is world-scoped: two worlds both in "season 1" must not compare
    // equal, or a war on one world could be ended by another world's clock.
    CHECK(idAtSeed != WorldSeasonIdFor("mars", s1->seasonNumber));

    // Mid-season, the id has not moved.
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 5 * kDayMs, kNow + 1);
    const auto still = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(still.has_value());
    CHECK(WorldSeasonIdFor(kW, still->seasonNumber) == idAtSeed);

    // Rollover: the id changes.
    const auto r = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 2);
    REQUIRE(r.rolledOver);
    const auto s2 = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(s2.has_value());
    CHECK(WorldSeasonIdFor(kW, s2->seasonNumber) != idAtSeed);
}

TEST_CASE("phase 3: a war spanning a season rollover meets SeasonEnd, and only after the rollover") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    // The war is seeded mid-season-1 and stamped with season 1's id — the
    // same stamp materialiseStaging writes into `wars.season_id`.
    const auto seedSeason = WorldSeasons::CurrentSeason(h.db, kW);
    REQUIRE(seedSeason.has_value());
    WarTerminationFacts facts;
    facts.warSeasonId = WorldSeasonIdFor(kW, seedSeason->seasonNumber);

    // While season 1 is still running, the war does not end.
    facts.currentSeasonId =
        WorldSeasonIdFor(kW, WorldSeasons::CurrentSeason(h.db, kW)->seasonNumber);
    CHECK(EvaluateWarTermination(facts) == WarTerminalReason::None);

    // The season rolls over under the war.
    const auto r = WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 1);
    REQUIRE(r.rolledOver);
    facts.currentSeasonId =
        WorldSeasonIdFor(kW, WorldSeasons::CurrentSeason(h.db, kW)->seasonNumber);
    CHECK(EvaluateWarTermination(facts) == WarTerminalReason::SeasonEnd);

    // A war that predates the season system (empty stamp) is untouched by the
    // same rollover — it does not belong to a finished season.
    WarTerminationFacts unseasoned;
    unseasoned.currentSeasonId = facts.currentSeasonId;
    CHECK(EvaluateWarTermination(unseasoned) == WarTerminalReason::None);
}

// ─────────────────────────── phase 3: the archive route bodies ─────────────

TEST_CASE("phase 3: SeasonByNumber answers ended seasons too, unlike CurrentSeason") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    REQUIRE(WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 1).rolledOver);

    const auto ended = WorldSeasons::SeasonByNumber(h.db, kW, 1);
    REQUIRE(ended.has_value());
    CHECK(ended->state == "ended");
    CHECK(ended->endedWorldMs == kWorldNow + 10 * kDayMs);
    CHECK_FALSE(WorldSeasons::SeasonByNumber(h.db, kW, 99).has_value());
}

TEST_CASE("phase 3: the archive index lists every season newest first") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 1);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 20 * kDayMs, kNow + 2);

    const auto body = WorldSeasons::SeasonsIndexJson(h.db, kW);
    CHECK(body["worldId"].get<std::string>() == kW);
    REQUIRE(body["seasons"].size() == 3);
    CHECK(body["seasons"][0]["number"].get<int>() == 3);
    CHECK(body["seasons"][0]["state"].get<std::string>() == "active");
    CHECK(body["seasons"][2]["number"].get<int>() == 1);
    CHECK(body["seasons"][2]["state"].get<std::string>() == "ended");
    // Every row carries the canonical id, so a client can hand it back to
    // anything that speaks `wars.season_id`.
    CHECK(body["seasons"][0]["seasonId"].get<std::string>() == WorldSeasonIdFor(kW, 3));
}

TEST_CASE("phase 3: the season archive body serves an ended season's digests, an active one's empty set, and refuses an unknown number") {
    SeasonDb h;
    h.SetConfig("seasonLengthWorldMs", static_cast<double>(10 * kDayMs));
    const auto red = h.Found("Red Banner", 101);
    h.AddPoi("poi-a", red);
    WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow, kNow);

    // One settlement won by red, one unclaimed, both during season 1.
    h.Settle("poi-a", red, kNow + 10);
    h.Settle("poi-a", "", kNow + 11);
    REQUIRE(WorldSeasons::Tick(h.db, kW, h.Rules(), kWorldNow + 10 * kDayMs, kNow + 20).rolledOver);

    const auto archived = WorldSeasons::SeasonArchiveJson(h.db, kW, 1);
    REQUIRE_FALSE(archived.contains("error"));
    CHECK(archived["season"]["number"].get<int>() == 1);
    CHECK(archived["season"]["state"].get<std::string>() == "ended");
    REQUIRE(archived["digests"].size() == 2);
    bool sawRed = false, sawUnclaimed = false;
    for (const auto& d : archived["digests"]) {
        if (d["factionId"].is_null()) {
            sawUnclaimed = true;
            CHECK(d["settlementsWon"].get<int>() == 1);
        } else if (d["factionId"].get<std::string>() == red) {
            sawRed = true;
            CHECK(d["settlementsWon"].get<int>() == 1);
        }
    }
    CHECK(sawRed);
    CHECK(sawUnclaimed);

    // The ACTIVE season answers truthfully: its row, no digests yet.
    const auto active = WorldSeasons::SeasonArchiveJson(h.db, kW, 2);
    REQUIRE_FALSE(active.contains("error"));
    CHECK(active["season"]["state"].get<std::string>() == "active");
    CHECK(active["digests"].empty());

    // A number naming no row is an error the route maps to 404.
    CHECK(WorldSeasons::SeasonArchiveJson(h.db, kW, 7)["error"].get<std::string>() ==
          "no_such_season");
}
