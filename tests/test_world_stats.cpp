// PLAN-worldsim.md W8: Authority (per commander), Capacity (per player) and
// Rank (per player per faction, derived).
//
// Same shape as test_world_factions.cpp: the stat layer never touches sim
// state, so everything here runs against an in-memory SQLite database with no
// lobby, no game server and no sim — and the RULES (decay, attribution,
// recharge, the rank formula) are pure functions driven with no database at
// all, which is the point of them being pure.
//
// The design under test is LOCKED (PLAN-metalstorm-worldbuilding.md Captures
// 23/24/27 + decisions rows 8/10). These cases assert the design's OWN
// statements — authority is slow in both directions, capacity is a per-real-24h
// player budget whose ceiling authority raises, rank is derived and excludes
// loans — not an implementation's convenience.

#include <algorithm>
#include <cmath>

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldFactions.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr int64_t kDayMs    = 24LL * 3600LL * 1000LL;
constexpr const char* kW    = "earth";

struct StatDb {
    sqlite3* db = nullptr;
    StatDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~StatDb() { sqlite3_close(db); }

    WorldStatRules Rules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldStatRules::FromWorldConfig(w->config);
    }

    /// Retune the world's blob: pillar 7 means a rate is a row, so the tests
    /// move the row rather than the code.
    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

    void AddPoi(const std::string& id, const std::string& owner = {}) {
        WorldPoiRecord p;
        p.worldId = kW;
        p.poiId   = id;
        p.name    = id;
        p.ownerFactionId = owner;
        p.createdAt = kNow;
        REQUIRE(WorldDirector::UpsertPoi(db, p));
    }

    /// A faction with one member, straight through the real founding path so
    /// the membership row is the one the store would really see.
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

    WorldCommanderRecord Commander(const std::string& id, int64_t account,
                                   const std::string& faction,
                                   const std::string& poi, double authority,
                                   int64_t createdAt = kNow) {
        WorldCommanderRecord c;
        c.worldId            = kW;
        c.commanderId        = id;
        c.name               = id;
        c.accountId          = account;
        c.factionId          = faction;
        c.poiId              = poi;
        c.authority          = authority;
        c.authorityAtWorldMs = kWorldNow;
        c.createdAt          = createdAt;
        REQUIRE(WorldStats::UpsertCommander(db, c));
        return c;
    }

    void Settle(const std::string& poi, const std::string& winners,
                int64_t recordedAt = kNow) {
        WorldSettlementRecord e;
        e.worldId    = kW;
        e.poiId      = poi;
        e.roomId     = 4242;
        e.outcome    = "victory_objective";
        e.factions   = winners;
        e.recordedAt = recordedAt;
        REQUIRE(WorldDirector::RecordSettlement(db, e));
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

TEST_CASE("W8: the stat tables are world-scoped and never room-scoped") {
    StatDb h;
    CHECK(TableExists(h.db, "world_commanders"));
    CHECK(TableExists(h.db, "world_authority_events"));
    // The lane's hard boundary 1: every `war*` table is keyed by room_id, and
    // no world table may be. Asserted by walking the schema rather than by
    // reading the CREATE statements, so a later ALTER cannot smuggle one in.
    for (const char* table : {"world_commanders", "world_authority_events"}) {
        const auto cols = ColumnsOf(h.db, table);
        REQUIRE(!cols.empty());
        CHECK(cols.front() == "world_id");
        for (const auto& c : cols) CHECK(c != "room_id");
    }
}

TEST_CASE("W8: W7's per-account row gains the capacity bookkeeping columns") {
    StatDb h;
    const auto cols = ColumnsOf(h.db, "world_authority");
    auto has = [&](const char* name) {
        return std::find(cols.begin(), cols.end(), name) != cols.end();
    };
    CHECK(has("capacity_spent"));
    CHECK(has("capacity_recharged_at"));
    // Additive: W7's columns survive.
    CHECK(has("authority"));
    CHECK(has("capacity"));

    // And EnsureTables is idempotent — the ALTERs must not turn a second boot
    // into a failure.
    WorldStats::EnsureTables(h.db);
    CHECK(ColumnsOf(h.db, "world_authority").size() == cols.size());
}

// ─────────────────────────── the rates are data ────────────────────────────

TEST_CASE("W8: every rate comes off the world row, per key") {
    StatDb h;
    const auto shipped = h.Rules();
    CHECK(shipped.authorityPerVictory == doctest::Approx(12.0));
    CHECK(shipped.capacityRechargeHours == doctest::Approx(24.0));

    h.SetConfig("authorityPerVictory", 40.0);
    const auto tuned = h.Rules();
    CHECK(tuned.authorityPerVictory == doctest::Approx(40.0));
    // Per key, not per blob: tuning one rate must not reset its neighbours to
    // the shipped defaults or to zero.
    CHECK(tuned.rankPerCommander == doctest::Approx(shipped.rankPerCommander));

    // A world seeded before W8 has none of these keys. Every rule must still
    // be in force — a missing key is a default, never an off switch.
    const auto old = WorldStatRules::FromWorldConfig(nlohmann::json::object());
    CHECK(old.authorityPerVictory == doctest::Approx(shipped.authorityPerVictory));
    CHECK(old.capacityBase == doctest::Approx(shipped.capacityBase));
}

// ─────────────────────────── Authority: pure ───────────────────────────────

TEST_CASE("W8: authority decays slowly, and only forwards") {
    WorldStatRules r;
    r.authorityDecayPerWorldDay = 0.10;
    r.authorityFloor = 0.0;

    // Capture 23: "decreases slowly". One world day at 10% is 10%.
    CHECK(DecayAuthority(100.0, kDayMs, r) == doctest::Approx(90.0));
    // Continuous, so the answer cannot depend on how often it is evaluated —
    // the property that makes decay-on-read legitimate.
    const double twoSteps = DecayAuthority(DecayAuthority(100.0, kDayMs, r), kDayMs, r);
    CHECK(DecayAuthority(100.0, 2 * kDayMs, r) == doctest::Approx(twoSteps));
    // A stamp slightly ahead of the clock (a resync, a pause closing) is
    // neither a windfall nor a penalty.
    CHECK(DecayAuthority(100.0, -kDayMs, r) == doctest::Approx(100.0));
    CHECK(DecayAuthority(100.0, 0, r) == doctest::Approx(100.0));
}

TEST_CASE("W8: the floor stops decay without inflating a small value") {
    WorldStatRules r;
    r.authorityDecayPerWorldDay = 0.5;
    r.authorityFloor = 10.0;
    CHECK(DecayAuthority(100.0, 100 * kDayMs, r) == doctest::Approx(10.0));
    // A commander already below the floor keeps what it has: the floor is
    // where decay stops, not a value decay grants.
    CHECK(DecayAuthority(4.0, 100 * kDayMs, r) == doctest::Approx(4.0));
}

TEST_CASE("W8: an unstamped commander row does not decay by the world's age") {
    WorldStatRules r;
    WorldCommanderRecord c;
    c.authority = 50.0;
    c.authorityAtWorldMs = 0;
    CHECK(CommanderAuthorityAt(c, kWorldNow, r) == doctest::Approx(50.0));
}

TEST_CASE("W8: settlement attribution reads the winner list, not the outcome") {
    WorldStatRules r;
    WorldSettlementRecord s;
    s.worldId  = kW;
    s.poiId    = "paris";
    s.factions = "iron-order, free-cities";
    s.recordedAt = kNow;

    CHECK(SettlementNamesFaction(s.factions, "free-cities"));
    // Whitespace after the comma is how the war layer joins some of these.
    CHECK(SettlementNamesFaction("a, b", "b"));
    CHECK(!SettlementNamesFaction(s.factions, "iron"));      // not a prefix match
    CHECK(!SettlementNamesFaction("", "iron-order"));

    std::vector<WorldCommanderRecord> at;
    WorldCommanderRecord win;
    win.commanderId = "w"; win.factionId = "iron-order"; win.poiId = "paris";
    win.createdAt = kNow - kDayMs;
    WorldCommanderRecord lose = win;
    lose.commanderId = "l"; lose.factionId = "grey-hand";
    WorldCommanderRecord elsewhere = win;
    elsewhere.commanderId = "e"; elsewhere.poiId = "berlin";
    WorldCommanderRecord dead = win;
    dead.commanderId = "d"; dead.state = "dead";
    WorldCommanderRecord fresh = win;
    fresh.commanderId = "f"; fresh.createdAt = kNow + kDayMs;
    at = {win, lose, elsewhere, dead, fresh};

    const auto awards = AttributeSettlement(s, at, r);
    REQUIRE(awards.size() == 2);
    CHECK(awards[0].commanderId == "w");
    CHECK(awards[0].reason == "victory");
    CHECK(awards[0].delta == doctest::Approx(r.authorityPerVictory));
    CHECK(awards[1].commanderId == "l");
    CHECK(awards[1].reason == "defeat");
    CHECK(awards[1].delta == doctest::Approx(r.authorityPerDefeat));
    // `e` was not there, `d` is dead, and `f` did not exist when the war
    // settled — a fresh commander posted to a contested POI must not harvest
    // its history.
}

// ─────────────────────────── Authority: the store ──────────────────────────

TEST_CASE("W8: accrual is idempotent across repeated reads") {
    StatDb h;
    h.AddPoi("paris");
    const auto rules = h.Rules();
    h.Commander("cmdr-a", 1, "iron-order", "paris", 10.0);
    h.Settle("paris", "iron-order");

    CHECK(WorldStats::AccrueFromSettlements(h.db, kW, rules, kNow, kWorldNow) == 1);
    const auto after = WorldStats::LoadCommander(h.db, kW, "cmdr-a");
    REQUIRE(after.has_value());
    CHECK(after->authority == doctest::Approx(10.0 + rules.authorityPerVictory));

    // The whole point of the ledger's UNIQUE key: a read may run accrual, so
    // running it again must award nothing.
    CHECK(WorldStats::AccrueFromSettlements(h.db, kW, rules, kNow, kWorldNow) == 0);
    CHECK(WorldStats::AccrueFromSettlements(h.db, kW, rules, kNow, kWorldNow) == 0);
    const auto stable = WorldStats::LoadCommander(h.db, kW, "cmdr-a");
    CHECK(stable->authority == doctest::Approx(after->authority));
    CHECK(WorldStats::EventsFor(h.db, kW, "cmdr-a").size() == 1);
}

TEST_CASE("W8: two wars at one POI are two awards") {
    StatDb h;
    h.AddPoi("paris");
    const auto rules = h.Rules();
    h.Commander("cmdr-a", 1, "iron-order", "paris", 0.0);
    h.Settle("paris", "iron-order", kNow);
    h.Settle("paris", "iron-order", kNow + 1000);
    CHECK(WorldStats::AccrueFromSettlements(h.db, kW, rules, kNow, kWorldNow) == 2);
    CHECK(WorldStats::EventsFor(h.db, kW, "cmdr-a").size() == 2);
    const auto c = WorldStats::LoadCommander(h.db, kW, "cmdr-a");
    CHECK(c->authority == doctest::Approx(2 * rules.authorityPerVictory));
}

TEST_CASE("W8: an award decays what was there before adding to it") {
    StatDb h;
    h.AddPoi("paris");
    auto rules = h.Rules();
    rules.authorityDecayPerWorldDay = 0.10;
    rules.authorityFloor = 0.0;
    h.Commander("cmdr-a", 1, "iron-order", "paris", 100.0);
    h.Settle("paris", "iron-order");

    // Ten world days after the stored stamp: 100 → ~34.87, then +12.
    const int64_t later = kWorldNow + 10 * kDayMs;
    CHECK(WorldStats::AccrueFromSettlements(h.db, kW, rules, kNow, later) == 1);
    const auto c = WorldStats::LoadCommander(h.db, kW, "cmdr-a");
    REQUIRE(c.has_value());
    CHECK(c->authority == doctest::Approx(100.0 * std::pow(0.9, 10) +
                                         rules.authorityPerVictory));
    CHECK(c->authorityAtWorldMs == later);
    // And the stamp moved, so a read at the same instant does not decay again.
    CHECK(CommanderAuthorityAt(*c, later, rules) == doctest::Approx(c->authority));
}

TEST_CASE("W8: the commander roster is queryable by POI and by owner") {
    StatDb h;
    h.AddPoi("paris");
    h.AddPoi("berlin");
    h.Commander("a", 1, "iron-order", "paris", 5.0);
    h.Commander("b", 2, "grey-hand", "paris", 5.0);
    h.Commander("c", 1, "iron-order", "berlin", 5.0);
    CHECK(WorldStats::CommandersAtPoi(h.db, kW, "paris").size() == 2);
    CHECK(WorldStats::CommandersOwnedBy(h.db, kW, 1).size() == 2);
    CHECK(WorldStats::CommandersFor(h.db, kW).size() == 3);
    // Another world's rows are invisible, which is what world-scoping means.
    CHECK(WorldStats::CommandersFor(h.db, "mars").empty());
}

TEST_CASE("W8: the starter commander is a threshold grant, given once") {
    StatDb h;
    const auto rules = h.Rules();
    // Below the threshold: nothing, and that is not a failure.
    CHECK(!WorldStats::EnsureStarterCommander(h.db, kW, 7, "vex", 0.0, rules,
                                              kNow, kWorldNow));
    CHECK(WorldStats::CommandersOwnedBy(h.db, kW, 7).empty());

    const auto granted = WorldStats::EnsureStarterCommander(
        h.db, kW, 7, "vex", rules.commanderGrantAuthority, rules, kNow, kWorldNow);
    REQUIRE(granted.has_value());
    CHECK(granted->accountId == 7);
    CHECK(granted->authority == doctest::Approx(rules.authorityFloor));
    CHECK(granted->authorityAtWorldMs == kWorldNow);

    // Never a second one this way — including after the first one dies.
    CHECK(!WorldStats::EnsureStarterCommander(h.db, kW, 7, "vex", 999.0, rules,
                                              kNow, kWorldNow));
    auto dead = *granted;
    dead.state = "dead";
    REQUIRE(WorldStats::UpsertCommander(h.db, dead));
    CHECK(!WorldStats::EnsureStarterCommander(h.db, kW, 7, "vex", 999.0, rules,
                                              kNow, kWorldNow));
    CHECK(WorldStats::CommandersOwnedBy(h.db, kW, 7).size() == 1);
}

TEST_CASE("W8: a starter commander is stationed where their faction stands") {
    StatDb h;
    h.AddPoi("paris");
    const std::string fid = h.Found("Iron Order", 7, "paris");
    const auto rules = h.Rules();
    // Founding SPENDS authority, so read what the account actually holds
    // rather than assuming the starting grant.
    const auto a = WorldFactions::AuthorityFor(
        h.db, kW, 7, WorldFactionRules::FromWorldConfig(
                         WorldDirector::Load(h.db, kW)->config), kNow);
    const auto granted = WorldStats::EnsureStarterCommander(
        h.db, kW, 7, "player7", a.authority, rules, kNow, kWorldNow);
    REQUIRE(granted.has_value());
    CHECK(granted->factionId == fid);
    CHECK(granted->poiId == "paris");
}

// ─────────────────────────── Capacity ──────────────────────────────────────

TEST_CASE("W8: authority raises capacity's ceiling and nothing else") {
    WorldStatRules r;
    r.capacityBase = 20.0;
    r.capacityPerCommanderAuthority = 0.5;
    // Capture 23: "authority could affect the upper limit of capacity, but
    // they're separate stats".
    CHECK(CapacityCeiling(0.0, r) == doctest::Approx(20.0));
    CHECK(CapacityCeiling(100.0, r) == doctest::Approx(70.0));
    // A player with no commanders still has a budget (C17: no-commander orders
    // stay legal, at a steep cost).
    CHECK(CapacityCeiling(-5.0, r) == doctest::Approx(20.0));
}

TEST_CASE("W8: capacity recharges per whole real period, never partially") {
    WorldStatRules r;
    r.capacityRechargeHours = 24.0;
    r.capacityRechargeFraction = 1.0;
    const double max = 100.0;

    // Anchoring: a row that never recharged starts its period now, and says so.
    const auto fresh = NormalizeCapacity(0.0, 0, max, r, kNow);
    CHECK(fresh.rechargedAt == kNow);
    CHECK(fresh.changed);

    // 23 hours in: nothing back yet. C12's ceiling is a real-day ceiling.
    const auto held = NormalizeCapacity(80.0, kNow, max, r, kNow + 23 * 3600 * 1000LL);
    CHECK(held.spent == doctest::Approx(80.0));
    CHECK(held.rechargedAt == kNow);

    // A day later: the whole budget back.
    const auto day = NormalizeCapacity(80.0, kNow, max, r, kNow + kDayMs);
    CHECK(day.spent == doctest::Approx(0.0));
    CHECK(day.rechargedAt == kNow + kDayMs);

    // 25 hours later the period advances by exactly one day, not to "now" —
    // otherwise a player who checks their panel late drifts their own recharge
    // clock forward every day.
    const auto late = NormalizeCapacity(80.0, kNow, max, r, kNow + kDayMs + 3600 * 1000LL);
    CHECK(late.rechargedAt == kNow + kDayMs);

    // A partial refill leaves a debt behind: below 1.0 makes a heavy day cost
    // the next one too.
    r.capacityRechargeFraction = 0.25;
    const auto partial = NormalizeCapacity(80.0, kNow, max, r, kNow + kDayMs);
    CHECK(partial.spent == doctest::Approx(55.0));
}

TEST_CASE("W8: the capacity budget spends, refuses and recharges on the row") {
    StatDb h;
    auto rules = h.Rules();
    rules.capacityBase = 100.0;
    rules.capacityPerCommanderAuthority = 0.0;

    auto state = WorldStats::CapacityFor(h.db, kW, 5, rules, kNow, kWorldNow);
    CHECK(state.max == doctest::Approx(100.0));
    CHECK(state.available == doctest::Approx(100.0));
    CHECK(state.nextRechargeInMs == kDayMs);

    CHECK(WorldStats::SpendCapacity(h.db, kW, 5, 60.0, rules, kNow, kWorldNow));
    state = WorldStats::CapacityFor(h.db, kW, 5, rules, kNow, kWorldNow);
    CHECK(state.spent == doctest::Approx(60.0));
    CHECK(state.available == doctest::Approx(40.0));

    // C12: "at some point will need to wait for their limit to recharge".
    CHECK(!WorldStats::SpendCapacity(h.db, kW, 5, 60.0, rules, kNow, kWorldNow));
    CHECK(WorldStats::CapacityFor(h.db, kW, 5, rules, kNow, kWorldNow).spent ==
          doctest::Approx(60.0));

    // A real day later it is back, and the row was normalised in place.
    const auto next = WorldStats::CapacityFor(h.db, kW, 5, rules, kNow + kDayMs, kWorldNow);
    CHECK(next.available == doctest::Approx(100.0));
    CHECK(WorldStats::CapacityFor(h.db, kW, 5, rules, kNow + kDayMs, kWorldNow).spent ==
          doctest::Approx(0.0));
}

TEST_CASE("W8: a capacity read must not eat W7's starting authority grant") {
    StatDb h;
    const auto rules = h.Rules();
    const auto factionRules =
        WorldFactionRules::FromWorldConfig(WorldDirector::Load(h.db, kW)->config);
    // The capacity surface is reached FIRST, before anything W7 owns has run
    // for this account. W7 credits `startingAuthority` by inserting the row, so
    // a capacity write that created it (with the only authority a budget knows:
    // zero) would skip the grant permanently and leave the founding gate
    // reading zero for a player who never spent a thing.
    WorldStats::CapacityFor(h.db, kW, 11, rules, kNow, kWorldNow);
    const auto a = WorldFactions::AuthorityFor(h.db, kW, 11, factionRules, kNow);
    CHECK(a.authority == doctest::Approx(factionRules.startingAuthority));
    // And the capacity bookkeeping survived the shared row.
    REQUIRE(WorldStats::SpendCapacity(h.db, kW, 11, 5.0, rules, kNow, kWorldNow));
    CHECK(WorldStats::CapacityFor(h.db, kW, 11, rules, kNow, kWorldNow).spent ==
          doctest::Approx(5.0));
    CHECK(WorldFactions::AuthorityFor(h.db, kW, 11, factionRules, kNow).authority ==
          doctest::Approx(factionRules.startingAuthority));
}

TEST_CASE("W8: a paused world does not widen the order budget") {
    StatDb h;
    auto rules = h.Rules();
    rules.capacityBase = 50.0;
    rules.capacityPerCommanderAuthority = 0.0;
    REQUIRE(WorldStats::SpendCapacity(h.db, kW, 5, 50.0, rules, kNow, kWorldNow));
    // The recharge is measured in REAL hours (C12 protects the player's day),
    // so advancing the WORLD clock — which is what a pause stops — must not
    // hand anybody a refill.
    const auto s = WorldStats::CapacityFor(h.db, kW, 5, rules, kNow, kWorldNow + 30 * kDayMs);
    CHECK(s.available == doctest::Approx(0.0));
}

TEST_CASE("W8: capacity's ceiling follows the commanders a player HOLDS") {
    StatDb h;
    auto rules = h.Rules();
    rules.capacityBase = 10.0;
    rules.capacityPerCommanderAuthority = 1.0;
    rules.authorityDecayPerWorldDay = 0.0;
    h.AddPoi("paris");
    auto c = h.Commander("a", 1, "iron-order", "paris", 40.0);
    CHECK(WorldStats::CapacityFor(h.db, kW, 1, rules, kNow, kWorldNow).max ==
          doctest::Approx(50.0));
    // Lend it out and the ceiling drops with it: a commander somebody else is
    // commanding does not widen the lender's budget (C27's exclusion).
    c.loanedToAccountId = 2;
    REQUIRE(WorldStats::UpsertCommander(h.db, c));
    CHECK(WorldStats::CapacityFor(h.db, kW, 1, rules, kNow, kWorldNow).max ==
          doctest::Approx(10.0));
}

// ─────────────────────────── Rank (derived) ────────────────────────────────

TEST_CASE("W8: rank is the sum of holdings, term by term") {
    WorldStatRules r;
    r.rankPerCommander = 10.0;
    r.rankPerCommanderAuthority = 1.0;
    r.rankPerPoiHeld = 25.0;
    r.rankPerMoney = 1.0;
    r.rankPerUnit = 2.0;
    r.rankPerArtifact = 50.0;
    r.authorityDecayPerWorldDay = 0.0;

    WorldCommanderRecord a;
    a.commanderId = "a"; a.authority = 30.0; a.authorityAtWorldMs = kWorldNow;
    WorldHoldings holdings;
    holdings.money = 100.0;
    holdings.units = 3;
    holdings.artifacts = 1;

    const auto rank = ComputeRank({a}, /*poisHeld=*/2, holdings, r, kWorldNow);
    CHECK(rank.commanders == doctest::Approx(10.0));
    CHECK(rank.commanderAuthority == doctest::Approx(30.0));
    CHECK(rank.regions == doctest::Approx(50.0));
    CHECK(rank.money == doctest::Approx(100.0));
    CHECK(rank.units == doctest::Approx(6.0));
    CHECK(rank.artifacts == doctest::Approx(50.0));
    CHECK(rank.total == doctest::Approx(246.0));
    CHECK(rank.commanderCount == 1);
    CHECK(rank.poiCount == 2);
}

TEST_CASE("W8: a loaned commander counts for NEITHER party") {
    WorldStatRules r;
    r.rankPerCommander = 10.0;
    r.rankPerCommanderAuthority = 0.0;
    WorldCommanderRecord held;
    held.commanderId = "h";
    WorldCommanderRecord lent = held;
    lent.commanderId = "l";
    lent.loanedToAccountId = 99;
    WorldCommanderRecord dead = held;
    dead.commanderId = "d";
    dead.state = "dead";

    // C27's counterbalance, and the residual it left open decided in the
    // direction it pointed: standing cannot be borrowed for a vote, and
    // lending is not rank-free income.
    const auto lender = ComputeRank({held, lent, dead}, 0, {}, r, kWorldNow);
    CHECK(lender.total == doctest::Approx(10.0));
    CHECK(lender.commanderCount == 1);
    CHECK(lender.loanedCount == 1);
    // The borrower does not own the row at all, so no query of theirs returns
    // it — the exclusion needs no second rule on their side.
}

TEST_CASE("W8: a trade MOVES rank rather than creating it") {
    WorldStatRules r;
    r.rankPerCommander = 10.0;
    r.rankPerCommanderAuthority = 1.0;
    r.rankPerMoney = 1.0;
    r.authorityDecayPerWorldDay = 0.0;
    WorldCommanderRecord c;
    c.commanderId = "c"; c.authority = 40.0; c.authorityAtWorldMs = kWorldNow;

    // Seller: one commander (10 + 40) and no money. Buyer: 50 money.
    WorldHoldings buyerBefore;
    buyerBefore.money = 50.0;
    const double sellerBefore = ComputeRank({c}, 0, {}, r, kWorldNow).total;
    const double buyerBeforeTotal = ComputeRank({}, 0, buyerBefore, r, kWorldNow).total;
    // After: the commander and the money swap owners.
    WorldHoldings sellerAfter;
    sellerAfter.money = 50.0;
    const double sellerAfterTotal = ComputeRank({}, 0, sellerAfter, r, kWorldNow).total;
    const double buyerAfterTotal = ComputeRank({c}, 0, {}, r, kWorldNow).total;
    // The pair's combined standing is conserved — which is exactly why
    // flipping a faction needs out-accumulating it, not shuffling assets.
    CHECK(sellerBefore + buyerBeforeTotal ==
          doctest::Approx(sellerAfterTotal + buyerAfterTotal));
}

TEST_CASE("W8: rank counts a region the player's faction holds AND garrisons") {
    StatDb h;
    h.AddPoi("paris");
    h.AddPoi("berlin");
    const std::string fid = h.Found("Iron Order", 1, "paris");
    auto rules = h.Rules();
    rules.authorityDecayPerWorldDay = 0.0;

    // No commander yet: the faction holds Paris but this player garrisons
    // nothing, so they exert no control there.
    CHECK(WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).poiCount == 0);

    h.Commander("a", 1, fid, "paris", 20.0);
    CHECK(WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).poiCount == 1);

    // A commander standing on ground the faction does NOT own is not control.
    h.Commander("b", 1, fid, "berlin", 20.0);
    CHECK(WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).poiCount == 1);

    const auto rank = WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow);
    CHECK(rank.commanderCount == 2);
    CHECK(rank.total == doctest::Approx(2 * rules.rankPerCommander +
                                        40.0 * rules.rankPerCommanderAuthority +
                                        rules.rankPerPoiHeld));
}

TEST_CASE("W8: rank is derived, and W7's rank column is not the source") {
    StatDb h;
    h.AddPoi("paris");
    const std::string fid = h.Found("Iron Order", 1, "paris");
    const auto rules = h.Rules();
    h.Commander("a", 1, fid, "paris", 20.0);
    const double derived = WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).total;
    CHECK(derived > 0.0);

    // Poison the legacy column. Nothing may change: rank has no table (W8's
    // "no rank table writes, compute on read").
    auto m = WorldFactions::MembershipFor(h.db, kW, 1);
    REQUIRE(m.has_value());
    sqlite3_exec(h.db, "UPDATE world_faction_members SET rank=99999", nullptr, nullptr, nullptr);
    CHECK(WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).total == doctest::Approx(derived));
}

// ─────────────────────────── the JSON surface ──────────────────────────────

TEST_CASE("W8: GET /api/world/stats carries rules, commanders and standings") {
    StatDb h;
    h.AddPoi("paris");
    const std::string fid = h.Found("Iron Order", 1, "paris");
    REQUIRE(WorldFactions::Join(h.db, kW, fid, 2, "player2", kNow).ok);
    const auto rules = h.Rules();
    h.Commander("a", 1, fid, "paris", 40.0);
    h.Commander("b", 2, fid, "paris", 5.0);

    const auto body = WorldStats::StatsJson(h.db, kW, rules, kNow, kWorldNow);
    CHECK(body["worldId"] == kW);
    CHECK(body["rules"]["authorityPerVictory"] == doctest::Approx(rules.authorityPerVictory));
    REQUIRE(body["commanders"].size() == 2);
    CHECK(body["commanders"][0]["commanderId"] == "a");
    CHECK(body["commanders"][0].contains("authority"));
    CHECK(body["commanders"][0].contains("authorityStored"));

    REQUIRE(body["factions"].size() == 1);
    const auto& f = body["factions"][0];
    CHECK(f["factionId"] == fid);
    REQUIRE(f["members"].size() == 2);
    // Ordered by rank, highest first: this table IS the vote-weight table.
    CHECK(f["members"][0]["accountId"] == 1);
    CHECK(f["members"][0]["rank"]["total"].get<double>() >=
          f["members"][1]["rank"]["total"].get<double>());
    CHECK(f["rankTotal"].get<double>() > 0.0);
}

TEST_CASE("W8: the player panel body carries commanders, capacity and rank") {
    StatDb h;
    h.AddPoi("paris");
    const std::string fid = h.Found("Iron Order", 1, "paris");
    const auto factionRules =
        WorldFactionRules::FromWorldConfig(WorldDirector::Load(h.db, kW)->config);
    const auto rules = h.Rules();

    nlohmann::json me = WorldFactions::MeJson(h.db, kW, 1, factionRules, kNow);
    me = WorldStats::AttachMeStats(std::move(me), h.db, kW, 1, "player1", rules,
                                  kNow, kWorldNow);
    // The starter grant fires from the read (W8 has no tick).
    CHECK(me["commanderGranted"] == true);
    REQUIRE(me["commanders"].size() == 1);
    CHECK(me["commanders"][0]["poiId"] == "paris");
    CHECK(me["capacity"]["max"].get<double>() > 0.0);
    CHECK(me["capacity"]["available"].get<double>() > 0.0);
    CHECK(me["capacity"]["rechargeHours"] == doctest::Approx(rules.capacityRechargeHours));
    CHECK(me["rank"]["factionId"] == fid);
    CHECK(me["rank"]["total"].get<double>() > 0.0);
    CHECK(me["rank"]["terms"].contains("commanderAuthority"));
    // W7's fields survive the merge — the panel needs both halves.
    CHECK(me["authority"].get<double>() >= 0.0);
    CHECK(me["membership"]["factionId"] == fid);

    // A second read grants nothing more and awards nothing more.
    nlohmann::json again = WorldFactions::MeJson(h.db, kW, 1, factionRules, kNow);
    again = WorldStats::AttachMeStats(std::move(again), h.db, kW, 1, "player1", rules,
                                     kNow, kWorldNow);
    CHECK(again["commanderGranted"] == false);
    CHECK(again["commanders"].size() == 1);
}

TEST_CASE("W8: a war a player's commander wins raises their authority and rank") {
    StatDb h;
    h.AddPoi("paris");
    const std::string fid = h.Found("Iron Order", 1, "paris");
    const auto rules = h.Rules();
    h.Commander("a", 1, fid, "paris", 10.0);
    const double before = WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).total;

    // The whole W6 → W8 seam, end to end: a settlement row is the only input.
    h.Settle("paris", fid);
    CHECK(WorldStats::AccrueFromSettlements(h.db, kW, rules, kNow, kWorldNow) == 1);
    const double after = WorldStats::RankFor(h.db, kW, 1, rules, kWorldNow).total;
    CHECK(after > before);
    CHECK(after - before ==
          doctest::Approx(rules.authorityPerVictory * rules.rankPerCommanderAuthority));
}
