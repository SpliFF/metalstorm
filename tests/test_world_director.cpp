// PLAN-worldsim.md W1: "Tests: schema round-trip, clock arithmetic incl. pause
// intervals, route JSON."
//
// The World Director is defined by never touching sim state, which is what
// makes this file possible: every assertion below runs against an in-memory
// SQLite database (or, for the clock, against nothing at all), with no lobby,
// no game server and no sim.

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"

namespace {

// One in-memory db per test case, torn down with the fixture.
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

// An arbitrary but fixed founding instant, so nothing here depends on wall
// time (a clock test that reads the clock is not a test).
constexpr int64_t kEpoch = 1'700'000'000'000LL;

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

}  // namespace

// ── The clock: pure arithmetic, no database ────────────────────────────────

TEST_CASE("W1: the world clock runs at the configured ratio from the epoch") {
    WorldClockConfig cfg;
    cfg.epochRealMs = kEpoch;

    // The directive's working ratio: one battle hour is one world day.
    CHECK(ReadWorldClock(cfg, {}, kEpoch + kHourMs).worldMs == kDayMs);
    CHECK(ReadWorldClock(cfg, {}, kEpoch).worldMs == 0);

    // Before the epoch the clock does not run backwards.
    CHECK(ReadWorldClock(cfg, {}, kEpoch - kDayMs).worldMs == 0);

    // The ratio is DATA: a world tuned to 1× is not a special case in code.
    cfg.ratioNum = 1;
    CHECK(ReadWorldClock(cfg, {}, kEpoch + kHourMs).worldMs == kHourMs);

    // A fractional ratio multiplies before it divides, so a short span does
    // not truncate to nothing.
    cfg.ratioNum = 3;
    cfg.ratioDen = 2;
    CHECK(ReadWorldClock(cfg, {}, kEpoch + 1000).worldMs == 1500);

    // A corrupt denominator makes the world slow, not a division by zero.
    cfg.ratioDen = 0;
    CHECK(ReadWorldClock(cfg, {}, kEpoch + 1000).worldMs == 3000);
}

TEST_CASE("W1: a non-zero world epoch offsets the clock without back-dating it") {
    WorldClockConfig cfg;
    cfg.epochRealMs  = kEpoch;
    cfg.epochWorldMs = 40 * kDayMs;
    const auto r = ReadWorldClock(cfg, {}, kEpoch + kHourMs);
    CHECK(r.worldMs == 41 * kDayMs);
    CHECK(WorldCalendarFromMs(r.worldMs).dayNumber == 42);
}

TEST_CASE("W1: a closed pause interval is removed from world time") {
    WorldClockConfig cfg;
    cfg.epochRealMs = kEpoch;

    // Paused for the second half of the first real hour: half an hour of real
    // time ran, so the world advanced half a world day.
    const std::vector<WorldPauseInterval> ledger = {
        {kEpoch + kHourMs / 2, kEpoch + kHourMs}};
    const auto r = ReadWorldClock(cfg, ledger, kEpoch + kHourMs);
    CHECK(r.pausedRealMs == kHourMs / 2);
    CHECK(r.runningRealMs == kHourMs / 2);
    CHECK(r.worldMs == kDayMs / 2);
    CHECK_FALSE(r.paused);

    // And the pause is not re-charged after it ends: the second hour runs in
    // full, so the total is 0.5 + 1 world days.
    CHECK(ReadWorldClock(cfg, ledger, kEpoch + 2 * kHourMs).worldMs == kDayMs * 3 / 2);
}

TEST_CASE("W1: an OPEN pause freezes the clock") {
    WorldClockConfig cfg;
    cfg.epochRealMs = kEpoch;
    const std::vector<WorldPauseInterval> ledger = {{kEpoch + kHourMs, 0}};

    const auto a = ReadWorldClock(cfg, ledger, kEpoch + 2 * kHourMs);
    const auto b = ReadWorldClock(cfg, ledger, kEpoch + 9 * kHourMs);
    CHECK(a.paused);
    CHECK(b.paused);
    // Frozen, not merely slowed: seven more real hours moved the world zero.
    CHECK(a.worldMs == kDayMs);
    CHECK(b.worldMs == kDayMs);
    CHECK(b.pausedRealMs == 8 * kHourMs);
}

TEST_CASE("W1: overlapping pause rows are counted once, not twice") {
    WorldClockConfig cfg;
    cfg.epochRealMs = kEpoch;
    // Two admins paused within the same window — an ordinary state of the
    // table. Summed raw this would charge 2 h of pause against 1.5 h of real
    // time and the clock would run BACKWARDS relative to an earlier reading.
    const std::vector<WorldPauseInterval> ledger = {
        {kEpoch + 2 * kHourMs, kEpoch + 4 * kHourMs},
        {kEpoch + 3 * kHourMs, kEpoch + 3 * kHourMs + kHourMs / 2},
    };
    const auto r = ReadWorldClock(cfg, ledger, kEpoch + 5 * kHourMs);
    CHECK(r.pausedRealMs == 2 * kHourMs);
    CHECK(r.runningRealMs == 3 * kHourMs);
    CHECK(r.worldMs == 3 * kDayMs);

    // Abutting intervals merge; a backwards row contributes nothing.
    const std::vector<WorldPauseInterval> messy = {
        {kEpoch + 4 * kHourMs, kEpoch + 5 * kHourMs},
        {kEpoch + 2 * kHourMs, kEpoch + 4 * kHourMs},
        {kEpoch + 9 * kHourMs, kEpoch + 8 * kHourMs},  // corrupt: ends first
    };
    CHECK(WorldPausedRealMsBetween(messy, kEpoch, kEpoch + 10 * kHourMs) == 3 * kHourMs);
    CHECK_FALSE(IsWorldPausedAt(messy, kEpoch + 10 * kHourMs));
}

TEST_CASE("W1: the calendar splits world ms the way the UI reads it") {
    const auto c = WorldCalendarFromMs(3 * kDayMs + 7 * kHourMs + 31 * 60 * 1000 + 9000);
    CHECK(c.day == 3);
    CHECK(c.dayNumber == 4);
    CHECK(c.hour == 7);
    CHECK(c.minute == 31);
    CHECK(c.second == 9);
    CHECK(FormatWorldCalendar(c) == "Day 4, 07:31");
    // A world's first day is "Day 1", not "Day 0".
    CHECK(WorldCalendarFromMs(0).dayNumber == 1);
}

// ── The rows: schema round-trip ────────────────────────────────────────────

TEST_CASE("W1: EnsureTables creates the five world tables and no war table") {
    WorldDb f;
    CHECK(TableExists(f.db, "worlds"));
    CHECK(TableExists(f.db, "world_pois"));
    CHECK(TableExists(f.db, "world_poi_edges"));
    CHECK(TableExists(f.db, "world_pause_ledger"));
    CHECK(TableExists(f.db, "world_settlement_ledger"));
    // The hard boundary, asserted rather than assumed: the world layer must
    // not create, extend or depend on the per-battle (room_id-keyed) tables.
    CHECK_FALSE(TableExists(f.db, "wars"));
    CHECK_FALSE(TableExists(f.db, "war_sides"));
    // Idempotent — EnsureTables runs on every boot.
    WorldDirector::EnsureTables(f.db);
    CHECK(TableExists(f.db, "worlds"));
}

TEST_CASE("W1: a world round-trips, tunables included") {
    WorldDb f;
    WorldRecord w;
    w.worldId            = "earth";
    w.name               = "Earth";
    w.clock.epochRealMs  = kEpoch;
    w.clock.epochWorldMs = 5 * kDayMs;
    w.clock.ratioNum     = 48;
    w.clock.ratioDen     = 2;
    w.createdAt          = kEpoch;
    w.config             = WorldDefaults{}.ToJson();
    REQUIRE(WorldDirector::Upsert(f.db, w));

    const auto got = WorldDirector::Load(f.db, "earth");
    REQUIRE(got.has_value());
    CHECK(got->name == "Earth");
    CHECK(got->state == "active");
    CHECK(got->clock.epochRealMs == kEpoch);
    CHECK(got->clock.epochWorldMs == 5 * kDayMs);
    CHECK(got->clock.ratioNum == 48);
    CHECK(got->clock.ratioDen == 2);
    CHECK(got->config["poiBudgetInitial"] == WorldDefaults{}.poiBudgetInitial);
    CHECK(got->config["transitWorldMsPerKm"] == WorldDefaults{}.transitWorldMsPerKm);

    CHECK_FALSE(WorldDirector::Load(f.db, "mars").has_value());
    CHECK(WorldDirector::PrimaryWorldId(f.db) == "earth");
}

TEST_CASE("W1: POIs and edges round-trip; a POI needs no battle map") {
    WorldDb f;
    WorldRecord w;
    w.worldId = "earth";
    w.name    = "Earth";
    REQUIRE(WorldDirector::Upsert(f.db, w));

    WorldPoiRecord a;
    a.worldId = "earth";
    a.poiId   = "randtown";
    a.name    = "Randtown";
    a.lat     = 51.5;
    a.lon     = -0.12;
    a.mapId   = "meridian_basin";
    a.tags    = {"coastal", "ruin"};
    REQUIRE(WorldDirector::UpsertPoi(f.db, a));

    // "Not all regions will be visitable" — a POI with no map is a legal row,
    // not an incomplete one.
    WorldPoiRecord b;
    b.worldId = "earth";
    b.poiId   = "osprey_fen";
    b.name    = "Osprey Fen";
    b.lat     = 52.4;
    b.lon     = 0.5;
    REQUIRE(WorldDirector::UpsertPoi(f.db, b));

    const auto pois = WorldDirector::PoisFor(f.db, "earth");
    REQUIRE(pois.size() == 2);
    CHECK(pois[0].poiId == "osprey_fen");   // ordered by id
    CHECK_FALSE(pois[0].HasBattleMap());
    CHECK(pois[1].poiId == "randtown");
    CHECK(pois[1].HasBattleMap());
    CHECK(pois[1].lat == doctest::Approx(51.5));
    CHECK(pois[1].lon == doctest::Approx(-0.12));
    REQUIRE(pois[1].tags.size() == 2);
    CHECK(pois[1].tags[0] == "coastal");
    CHECK(pois[1].tags[1] == "ruin");

    // Upsert replaces rather than duplicating — a re-seed must not fork a POI.
    a.name = "Randtown (rebuilt)";
    REQUIRE(WorldDirector::UpsertPoi(f.db, a));
    CHECK(WorldDirector::PoisFor(f.db, "earth").size() == 2);
    CHECK(WorldDirector::LoadPoi(f.db, "earth", "randtown")->name == "Randtown (rebuilt)");

    WorldPoiEdgeRecord e;
    e.worldId        = "earth";
    e.fromPoi        = "randtown";
    e.toPoi          = "osprey_fen";
    e.transitWorldMs = 6 * kHourMs;
    REQUIRE(WorldDirector::UpsertEdge(f.db, e));
    // A self-edge is not a route.
    e.toPoi = "randtown";
    CHECK_FALSE(WorldDirector::UpsertEdge(f.db, e));

    const auto edges = WorldDirector::EdgesFor(f.db, "earth");
    REQUIRE(edges.size() == 1);
    CHECK(edges[0].fromPoi == "randtown");
    CHECK(edges[0].toPoi == "osprey_fen");
    CHECK(edges[0].transitWorldMs == 6 * kHourMs);
    CHECK(edges[0].bidirectional);

    // Another world's rows are not this world's.
    CHECK(WorldDirector::PoisFor(f.db, "mars").empty());
    CHECK(WorldDirector::EdgesFor(f.db, "mars").empty());
}

TEST_CASE("W1: the default world is seeded once and its epoch never moves") {
    WorldDb f;
    CHECK(WorldDirector::PrimaryWorldId(f.db).empty());

    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);
    CHECK(id == kDefaultWorldId);
    const auto first = WorldDirector::Load(f.db, id);
    REQUIRE(first.has_value());
    CHECK(first->clock.epochRealMs == kEpoch);
    CHECK(first->clock.ratioNum == kDefaultWorldTimeRatioNum);
    CHECK(first->config["poiBudgetInitial"] == WorldDefaults{}.poiBudgetInitial);

    // Every later boot calls this again. Moving the epoch would rewind the
    // world clock for everyone — the one number nothing may retroactively
    // change.
    CHECK(WorldDirector::SeedDefaultWorld(f.db, kEpoch + 90 * kDayMs) == id);
    CHECK(WorldDirector::Load(f.db, id)->clock.epochRealMs == kEpoch);
    CHECK(WorldDirector::ListWorlds(f.db).size() == 1);
}

// ── The ledger, through the store ──────────────────────────────────────────

TEST_CASE("W1: pause/resume through the store drives the clock") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);

    CHECK(WorldDirector::OpenPause(f.db, id, kEpoch + kHourMs, "maintenance", "admin"));
    // A pause is a state, not a counter: a second pause is refused.
    CHECK_FALSE(WorldDirector::OpenPause(f.db, id, kEpoch + 2 * kHourMs, "again", "admin2"));
    REQUIRE(WorldDirector::PausesFor(f.db, id).size() == 1);

    auto frozen = WorldDirector::ClockFor(f.db, id, kEpoch + 5 * kHourMs);
    REQUIRE(frozen.has_value());
    CHECK(frozen->paused);
    CHECK(frozen->worldMs == kDayMs);

    CHECK(WorldDirector::ClosePause(f.db, id, kEpoch + 5 * kHourMs));
    // Nothing open → nothing to resume.
    CHECK_FALSE(WorldDirector::ClosePause(f.db, id, kEpoch + 6 * kHourMs));

    auto running = WorldDirector::ClockFor(f.db, id, kEpoch + 6 * kHourMs);
    REQUIRE(running.has_value());
    CHECK_FALSE(running->paused);
    CHECK(running->pausedRealMs == 4 * kHourMs);
    CHECK(running->worldMs == 2 * kDayMs);

    CHECK_FALSE(WorldDirector::ClockFor(f.db, "mars", kEpoch).has_value());
}

// ── W4: POST /api/world/pause's effect on the served clock ─────────────────
//
// The route itself is a thin transport (parse {action,reason} → call
// OpenPause/ClosePause → re-serve WorldStatusJson); there is no socket
// fixture in this file, so what is tested here is exactly that contract:
// after an admin pauses, the very next `GET /api/world` body (i.e.
// WorldStatusJson) must show the frozen clock, and after a resume it must
// show the clock running again with the pause counted into pausedRealMs.

TEST_CASE("W4: pausing then resuming is visible in the next WorldStatusJson") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);

    REQUIRE(WorldDirector::OpenPause(f.db, id, kEpoch + kHourMs, "maintenance", "admin1"));
    const nlohmann::json paused = WorldDirector::WorldStatusJson(f.db, id, kEpoch + 3 * kHourMs);
    CHECK(paused["clock"]["paused"] == true);
    // Frozen at the instant of the pause, not still advancing.
    CHECK(paused["clock"]["worldMs"] == kDayMs);

    // A second pause is refused (already open) — the route reports this as
    // `changed:false`, not an error; OpenPause's own return is that signal.
    CHECK_FALSE(WorldDirector::OpenPause(f.db, id, kEpoch + 2 * kHourMs, "again", "admin2"));

    REQUIRE(WorldDirector::ClosePause(f.db, id, kEpoch + 5 * kHourMs));
    const nlohmann::json running = WorldDirector::WorldStatusJson(f.db, id, kEpoch + 6 * kHourMs);
    CHECK(running["clock"]["paused"] == false);
    // 4 hours paused (kEpoch+1h .. kEpoch+5h), then 1 more hour running.
    CHECK(running["clock"]["pausedRealMs"] == 4 * kHourMs);
    CHECK(running["clock"]["worldMs"] == 2 * kDayMs);

    // Resuming an already-running world is a no-op, same as ClosePause alone.
    CHECK_FALSE(WorldDirector::ClosePause(f.db, id, kEpoch + 7 * kHourMs));
}

// ── The route bodies ───────────────────────────────────────────────────────

TEST_CASE("W1: GET /api/world's body carries the clock and the tunables") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);

    const nlohmann::json j =
        WorldDirector::WorldStatusJson(f.db, id, kEpoch + 7 * kHourMs + 31 * 60 * 1000);
    CHECK(j["worldId"] == "earth");
    CHECK(j["name"] == "Earth");
    CHECK(j["state"] == "active");
    CHECK(j["poiCount"] == 0);
    CHECK(j["config"]["poiBudgetMax"] == WorldDefaults{}.poiBudgetMax);
    CHECK(j["clock"]["paused"] == false);
    CHECK(j["clock"]["ratioNum"] == kDefaultWorldTimeRatioNum);
    CHECK(j["clock"]["ratioDen"] == kDefaultWorldTimeRatioDen);
    CHECK(j["clock"]["epochRealMs"] == kEpoch);
    CHECK(j["clock"]["worldMs"] == 7 * kDayMs + 24 * 31 * 60 * 1000);
    CHECK(j["clock"]["day"] == 8);

    // An unknown world is an error body, never a plausible empty world.
    const nlohmann::json miss = WorldDirector::WorldStatusJson(f.db, "mars", kEpoch);
    CHECK(miss["error"] == "world_not_found");
    CHECK_FALSE(miss.contains("clock"));
}

TEST_CASE("W1: GET /api/world/pois's body carries nodes and edges") {
    WorldDb f;
    const std::string id = WorldDirector::SeedDefaultWorld(f.db, kEpoch);

    // An empty world answers with empty ARRAYS, not with nulls or a 404: a
    // freshly seeded world genuinely has no POIs until W3 seeds them, and the
    // map UI must render that rather than error.
    nlohmann::json j = WorldDirector::WorldPoisJson(f.db, id);
    CHECK(j["pois"].is_array());
    CHECK(j["pois"].empty());
    CHECK(j["edges"].is_array());

    WorldPoiRecord a;
    a.worldId = id;
    a.poiId   = "randtown";
    a.name    = "Randtown";
    a.lat     = 51.5;
    a.lon     = -0.12;
    a.mapId   = "meridian_basin";
    a.tags    = {"coastal"};
    REQUIRE(WorldDirector::UpsertPoi(f.db, a));
    WorldPoiRecord b;
    b.worldId = id;
    b.poiId   = "osprey_fen";
    b.name    = "Osprey Fen";
    REQUIRE(WorldDirector::UpsertPoi(f.db, b));
    WorldPoiEdgeRecord e;
    e.worldId        = id;
    e.fromPoi        = "osprey_fen";
    e.toPoi          = "randtown";
    e.transitWorldMs = 6 * kHourMs;
    REQUIRE(WorldDirector::UpsertEdge(f.db, e));

    j = WorldDirector::WorldPoisJson(f.db, id);
    REQUIRE(j["pois"].size() == 2);
    CHECK(j["pois"][1]["id"] == "randtown");
    CHECK(j["pois"][1]["mapId"] == "meridian_basin");
    CHECK(j["pois"][1]["tags"][0] == "coastal");
    // A world-only POI reports mapId null — the UI branches on enterable.
    CHECK(j["pois"][0]["id"] == "osprey_fen");
    CHECK(j["pois"][0]["mapId"].is_null());
    REQUIRE(j["edges"].size() == 1);
    CHECK(j["edges"][0]["from"] == "osprey_fen");
    CHECK(j["edges"][0]["transitWorldMs"] == 6 * kHourMs);
}

// ── W6: the settlement write-back stub ─────────────────────────────────────

TEST_CASE("W6: PoiForMap resolves a room's map to its POI, across worlds") {
    WorldDb f;
    WorldRecord w;
    w.worldId = "earth";
    REQUIRE(WorldDirector::Upsert(f.db, w));

    WorldPoiRecord a;
    a.worldId = "earth";
    a.poiId   = "randtown";
    a.mapId   = "meridian_basin";
    REQUIRE(WorldDirector::UpsertPoi(f.db, a));

    const auto found = WorldDirector::PoiForMap(f.db, "meridian_basin");
    REQUIRE(found.has_value());
    CHECK(found->worldId == "earth");
    CHECK(found->poiId == "randtown");

    // A world-only POI's absent map is never returned for an empty query —
    // nothing here should match a room with no map id set.
    CHECK_FALSE(WorldDirector::PoiForMap(f.db, "").has_value());
    // A map nobody seeded as a POI settles nowhere. Legal, not a defect.
    CHECK_FALSE(WorldDirector::PoiForMap(f.db, "no_such_map").has_value());
}

TEST_CASE("W6: two sequential wars at one POI accumulate, they do not overwrite") {
    WorldDb f;
    WorldRecord w;
    w.worldId = "earth";
    REQUIRE(WorldDirector::Upsert(f.db, w));
    WorldPoiRecord a;
    a.worldId = "earth";
    a.poiId   = "randtown";
    a.mapId   = "meridian_basin";
    REQUIRE(WorldDirector::UpsertPoi(f.db, a));

    // War 1: room 7 settles at Randtown, the union wins.
    WorldSettlementRecord s1;
    s1.worldId    = "earth";
    s1.poiId      = "randtown";
    s1.roomId     = 7;
    s1.outcome    = "victory_objective";
    s1.factions   = "union";
    s1.recordedAt = 1000;
    REQUIRE(WorldDirector::RecordSettlement(f.db, s1));

    // War 2: a LATER war, different room, same POI — the compact wins this
    // time. The room id could even be reused (§ header note); it is not the
    // key.
    WorldSettlementRecord s2;
    s2.worldId    = "earth";
    s2.poiId      = "randtown";
    s2.roomId     = 11;
    s2.outcome    = "faction_elimination";
    s2.factions   = "compact";
    s2.recordedAt = 2000;
    REQUIRE(WorldDirector::RecordSettlement(f.db, s2));

    const auto rows = WorldDirector::SettlementsFor(f.db, "earth");
    REQUIRE(rows.size() == 2);
    CHECK(rows[0].roomId == 7);
    CHECK(rows[0].outcome == "victory_objective");
    CHECK(rows[0].factions == "union");
    CHECK(rows[0].recordedAt == 1000);
    CHECK(rows[1].roomId == 11);
    CHECK(rows[1].outcome == "faction_elimination");
    CHECK(rows[1].factions == "compact");
    CHECK(rows[1].recordedAt == 2000);

    // A world nobody has settled anything in yet reports an empty ledger, not
    // an error.
    CHECK(WorldDirector::SettlementsFor(f.db, "mars").empty());
}

TEST_CASE("W6: an ending the sim never saw settles with no faction named") {
    // An operator retire or a season end has no war_outcome row (see
    // WarOutcome.h); the caller then passes an empty factions string rather
    // than inventing a winner, and the ledger must accept and preserve that.
    WorldDb f;
    WorldSettlementRecord s;
    s.worldId    = "earth";
    s.poiId      = "randtown";
    s.roomId     = 3;
    s.outcome    = "operator_retire";
    s.recordedAt = 500;
    REQUIRE(WorldDirector::RecordSettlement(f.db, s));

    const auto rows = WorldDirector::SettlementsFor(f.db, "earth");
    REQUIRE(rows.size() == 1);
    CHECK(rows[0].factions.empty());
    CHECK(rows[0].outcome == "operator_retire");
}

TEST_CASE("W6: RecordSettlement is guarded against an empty world or POI id") {
    WorldDb f;
    WorldSettlementRecord s;
    s.roomId     = 1;
    s.outcome    = "victory_objective";
    s.recordedAt = 100;

    s.worldId = "";
    s.poiId   = "randtown";
    CHECK_FALSE(WorldDirector::RecordSettlement(f.db, s));

    s.worldId = "earth";
    s.poiId   = "";
    CHECK_FALSE(WorldDirector::RecordSettlement(f.db, s));

    CHECK(WorldDirector::SettlementsFor(f.db, "earth").empty());
}
