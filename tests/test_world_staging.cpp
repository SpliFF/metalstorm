// PLAN-worldsim.md W10: battle triggers from the map (staging).
//
// Same shape as test_world_economy.cpp: an in-memory SQLite database with no
// lobby, no game server and no sim, and the POLICY (the instigation rule, the
// window sizing, the edge pricing) driven as pure functions with no database
// at all.
//
// The properties under test are the ones WorldStaging.h promises:
//   - §7.1's instigation rule, in exactly one place: a transport, carrying a
//     squad, at a POI the faction does not hold
//   - the window is the transit weight, scaled and CLAMPED (Q16), and a
//     commitment nothing can price still gets a bounded window
//   - §7.2's late commitment JOINS the open window and never moves it
//   - `DueStagings` is a read: draining it twice sees the same rows, and
//     `MarkMaterialised` is guarded so a second sweep cannot double-create
//   - the retry budget is re-read from config, so lowering it retires a row
//     that is already spinning
//   - W5's marker upgrade is an UPGRADE: quiet→staging, never active→staging
//   - every rate is per-world config (pillar 7)

#include <doctest/doctest.h>
#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include "Server/WorldDirector.h"
#include "Server/WorldFactions.h"
#include "Server/WorldStaging.h"
#include "Server/WorldStats.h"

namespace {

constexpr int64_t kNow      = 1'700'000'000'000LL;
constexpr int64_t kWorldNow = 5'000'000'000LL;
constexpr int64_t kHourMs   = 3600LL * 1000LL;
constexpr const char* kW    = "earth";

struct StagingDb {
    sqlite3* db = nullptr;
    StagingDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        WorldDirector::EnsureTables(db);
        WorldFactions::EnsureTables(db);
        WorldStats::EnsureTables(db);
        WorldStaging::EnsureTables(db);
        REQUIRE(WorldDirector::SeedDefaultWorld(db, kNow) == kW);
    }
    ~StagingDb() { sqlite3_close(db); }

    WorldStagingRules Rules() const {
        const auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        return WorldStagingRules::FromWorldConfig(w->config);
    }

    void SetConfig(const char* key, double value) {
        auto w = WorldDirector::Load(db, kW);
        REQUIRE(w.has_value());
        w->config[key] = value;
        REQUIRE(WorldDirector::Upsert(db, *w));
    }

    void AddPoi(const std::string& id, const std::string& owner,
                const std::string& mapId = "meridian_basin") {
        WorldPoiRecord p;
        p.worldId   = kW;
        p.poiId     = id;
        p.name      = id;
        p.mapId     = mapId;
        p.createdAt = kNow;
        REQUIRE(WorldDirector::UpsertPoi(db, p));
        if (!owner.empty())
            REQUIRE(WorldDirector::SetPoiOwner(db, kW, id, owner));
    }

    void AddEdge(const std::string& from, const std::string& to,
                 int64_t weight, bool bidirectional = true) {
        WorldPoiEdgeRecord e;
        e.worldId        = kW;
        e.fromPoi        = from;
        e.toPoi          = to;
        e.transitWorldMs = weight;
        e.bidirectional  = bidirectional;
        REQUIRE(WorldDirector::UpsertEdge(db, e));
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

    WorldStagingCommitResult Commit(const std::string& poi,
                                    const std::string& faction,
                                    int transports = 1, int squads = 1,
                                    const std::string& origin = {},
                                    int64_t worldNow = kWorldNow) {
        WorldStagingCommitRequest req;
        req.worldId           = kW;
        req.poiId             = poi;
        req.attackerFactionId = faction;
        req.originPoiId       = origin;
        req.transports        = transports;
        req.squads            = squads;
        req.accountId         = 7;
        return WorldStaging::Commit(db, Rules(), req, worldNow, kNow);
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

TEST_CASE("W10: world_staging is world-scoped and never room-keyed") {
    StagingDb h;
    REQUIRE(TableExists(h.db, "world_staging"));
    const auto cols = ColumnsOf(h.db, "world_staging");
    REQUIRE(!cols.empty());
    CHECK(cols.front() == "world_id");
    // `room_id` IS a column here — but as a LABEL, exactly like W6's ledger.
    // The boundary that matters is that the table is keyed by world_id: it is
    // never looked up by room, and hard boundary 1 is about the KEY.
    CHECK(std::find(cols.begin(), cols.end(), "poi_id") != cols.end());
    CHECK(std::find(cols.begin(), cols.end(), "attacker_faction_id") != cols.end());
}

TEST_CASE("W10: EnsureTables is additive and idempotent") {
    StagingDb h;
    const auto before = ColumnsOf(h.db, "world_staging");
    WorldStaging::EnsureTables(h.db);
    WorldStaging::EnsureTables(h.db);
    CHECK(ColumnsOf(h.db, "world_staging") == before);
}

// ─────────────────── §7.1: the instigation rule, pure ──────────────────────

TEST_CASE("W10: a commitment instigates only with a transport carrying a squad") {
    CHECK(StagingInstigationError(1, 1, "atk", "def").empty());
    CHECK(StagingInstigationError(3, 9, "atk", "").empty());  // unowned POI
    CHECK(StagingInstigationError(0, 1, "atk", "def") == "no_transport");
    CHECK(StagingInstigationError(1, 0, "atk", "def") == "no_squads");
    // The empty transport is the more common mistake, so it is the complaint
    // reported when BOTH are missing.
    CHECK(StagingInstigationError(0, 0, "atk", "def") == "no_transport");
    CHECK(StagingInstigationError(1, 1, "", "def") == "no_faction");
}

TEST_CASE("W10: a faction cannot instigate at a POI it already holds") {
    CHECK(StagingInstigationError(1, 1, "atk", "atk") == "already_held");
    // …and holding it is the ONLY thing that stops it: somebody else's POI is
    // a target however much force is committed.
    CHECK(StagingInstigationError(1, 1, "atk", "other").empty());
}

// ─────────────────── the window: transit-priced and clamped ────────────────

TEST_CASE("W10: the window is the transit weight, scaled") {
    WorldStagingRules r;
    r.stagingWindowMinWorldMs   = 0;
    r.stagingWindowMaxWorldMs   = 1'000 * kHourMs;
    r.stagingWindowPerTransitMs = 1.0;
    CHECK(StagingWindowFor(6 * kHourMs, r) == 6 * kHourMs);
    r.stagingWindowPerTransitMs = 0.5;
    CHECK(StagingWindowFor(6 * kHourMs, r) == 3 * kHourMs);
}

TEST_CASE("W10: Q16's clamps bound every window, priced or defaulted") {
    WorldStagingRules r;
    r.stagingWindowMinWorldMs   = 2 * kHourMs;
    r.stagingWindowMaxWorldMs   = 10 * kHourMs;
    r.stagingWindowPerTransitMs = 1.0;
    CHECK(StagingWindowFor(1, r) == 2 * kHourMs);              // floor
    CHECK(StagingWindowFor(500 * kHourMs, r) == 10 * kHourMs); // ceiling
    CHECK(StagingWindowFor(5 * kHourMs, r) == 5 * kHourMs);    // between
    // "no edge priced it" takes the default — and the default is clamped too,
    // so a misconfigured default cannot escape the bounds.
    r.stagingWindowDefaultWorldMs = 900 * kHourMs;
    CHECK(StagingWindowFor(0, r) == 10 * kHourMs);
    CHECK(StagingWindowFor(-5, r) == 10 * kHourMs);
}

TEST_CASE("W10: a max below the min does not invert the clamp — the floor wins") {
    WorldStagingRules r;
    r.stagingWindowMinWorldMs = 5 * kHourMs;
    r.stagingWindowMaxWorldMs = 1 * kHourMs;
    CHECK(StagingWindowFor(3 * kHourMs, r) == 5 * kHourMs);
    CHECK(StagingWindowFor(0, r) == 5 * kHourMs);
}

TEST_CASE("W10: pricing takes the cheapest edge, and respects one-way routes") {
    std::vector<WorldPoiEdgeRecord> edges;
    auto edge = [&](const char* a, const char* b, int64_t w, bool bi) {
        WorldPoiEdgeRecord e;
        e.fromPoi = a; e.toPoi = b; e.transitWorldMs = w; e.bidirectional = bi;
        edges.push_back(e);
    };
    edge("near", "target", 3 * kHourMs, true);
    edge("far",  "target", 9 * kHourMs, true);
    edge("target", "oneway", 1 * kHourMs, false);   // target → oneway ONLY

    CHECK(CheapestTransitTo(edges, {"near", "far"}, "target") == 3 * kHourMs);
    CHECK(CheapestTransitTo(edges, {"far"}, "target") == 9 * kHourMs);
    // A bidirectional edge counts from either end…
    CHECK(CheapestTransitTo(edges, {"target"}, "near") == 3 * kHourMs);
    // …a one-way one does not: you cannot march up a one-way route.
    CHECK(CheapestTransitTo(edges, {"oneway"}, "target") == 0);
    CHECK(CheapestTransitTo(edges, {"nowhere"}, "target") == 0);
    CHECK(CheapestTransitTo(edges, {}, "target") == 0);
}

// ─────────────────────────── the store ─────────────────────────────────────

TEST_CASE("W10: committing force opens a staging row priced by the edge") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    const std::string def = h.Found("Defenders", 2);
    h.AddPoi("home", atk);
    h.AddPoi("target", def);
    h.AddEdge("home", "target", 6 * kHourMs);

    const auto res = h.Commit("target", atk);
    REQUIRE_MESSAGE(res.ok, res.error);
    CHECK_FALSE(res.joined);
    CHECK(res.staging.state == WorldStagingState::Staging);
    CHECK(res.staging.openedAtWorldMs == kWorldNow);
    // The window IS the transit weight at the default per-transit rate of 1.0.
    CHECK(res.staging.endsAtWorldMs == kWorldNow + 6 * kHourMs);
    CHECK(res.staging.transports == 1);

    const auto open = WorldStaging::OpenFor(h.db, kW);
    REQUIRE(open.size() == 1);
    CHECK(open[0].stagingId == res.staging.stagingId);
}

TEST_CASE("W10: an origin the committer did not name is inferred from what it holds") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    const std::string def = h.Found("Defenders", 2);
    h.AddPoi("far_home", atk);
    h.AddPoi("near_home", atk);
    h.AddPoi("target", def);
    h.AddEdge("far_home", "target", 20 * kHourMs);
    h.AddEdge("near_home", "target", 4 * kHourMs);

    // Unnamed origin: the cheapest POI the faction holds prices it.
    const auto inferred = h.Commit("target", atk);
    REQUIRE_MESSAGE(inferred.ok, inferred.error);
    CHECK(inferred.staging.endsAtWorldMs == kWorldNow + 4 * kHourMs);

    // A named origin wins over the inference, even a slower one.
    const std::string atk2 = h.Found("Third", 3);
    WorldDirector::SetPoiOwner(h.db, kW, "far_home", atk2);
    const auto named = h.Commit("target", atk2, 1, 1, "far_home");
    REQUIRE_MESSAGE(named.ok, named.error);
    CHECK(named.staging.endsAtWorldMs == kWorldNow + 20 * kHourMs);
}

TEST_CASE("W10: an unconnected POI still gets a bounded default window") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("island", "");   // unowned, no edges at all
    const auto res = h.Commit("island", atk);
    REQUIRE_MESSAGE(res.ok, res.error);
    const auto rules = h.Rules();
    CHECK(res.staging.endsAtWorldMs - res.staging.openedAtWorldMs ==
          StagingWindowFor(0, rules));
    CHECK(res.staging.endsAtWorldMs > res.staging.openedAtWorldMs);
}

TEST_CASE("W10: Commit refuses what the design refuses") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("mine", atk);
    h.AddPoi("theirs", "");
    h.AddPoi("worldonly", "", /*mapId=*/"");

    CHECK(h.Commit("nosuchpoi", atk).error == "no_poi");
    CHECK(h.Commit("theirs", "nosuchfaction").error == "no_faction");
    CHECK(h.Commit("theirs", atk, 0, 1).error == "no_transport");
    CHECK(h.Commit("theirs", atk, 1, 0).error == "no_squads");
    CHECK(h.Commit("mine", atk).error == "already_held");
    // A POI with no battle map is refused AT COMMITMENT, not discovered at the
    // window's end — the player is owed the answer while the force is still
    // theirs to spend.
    CHECK(h.Commit("worldonly", atk).error == "no_battle_map");
    // …and none of the refusals wrote a row.
    CHECK(WorldStaging::OpenFor(h.db, kW).empty());
}

TEST_CASE("W10: §7.2 late force joins the open window and never moves it") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    const std::string def = h.Found("Defenders", 2);
    h.AddPoi("home", atk);
    h.AddPoi("target", def);
    h.AddEdge("home", "target", 6 * kHourMs);

    const auto first = h.Commit("target", atk, 2, 5);
    REQUIRE_MESSAGE(first.ok, first.error);

    // A commitment an hour later, from an origin that would have priced a much
    // longer window on its own: it joins, and the window does not move. This
    // is the anti-grief property — otherwise one transport at a time holds a
    // defender in permanent staging.
    const auto late = h.Commit("target", atk, 1, 3, {}, kWorldNow + kHourMs);
    REQUIRE_MESSAGE(late.ok, late.error);
    CHECK(late.joined);
    CHECK(late.staging.stagingId == first.staging.stagingId);
    CHECK(late.staging.transports == 3);
    CHECK(late.staging.squads == 8);
    CHECK(late.staging.endsAtWorldMs == first.staging.endsAtWorldMs);
    CHECK(WorldStaging::OpenFor(h.db, kW).size() == 1);
}

TEST_CASE("W10: two attackers gather against one POI as two rows") {
    StagingDb h;
    const std::string a = h.Found("Alpha", 1);
    const std::string b = h.Found("Bravo", 2);
    const std::string def = h.Found("Defenders", 3);
    h.AddPoi("target", def);

    REQUIRE(h.Commit("target", a).ok);
    REQUIRE(h.Commit("target", b).ok);
    // `(world_id, poi_id)` is emphatically not a key: a contested POI has one
    // row per gathering faction.
    CHECK(WorldStaging::OpenFor(h.db, kW).size() == 2);
}

TEST_CASE("W10: withdrawal cancels an open row and only an open row") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    CHECK(WorldStaging::Cancel(h.db, res.staging.stagingId, kNow));
    // Idempotence by guard: a second cancel changes nothing and says so.
    CHECK_FALSE(WorldStaging::Cancel(h.db, res.staging.stagingId, kNow));
    const auto row = WorldStaging::Load(h.db, res.staging.stagingId);
    REQUIRE(row.has_value());
    CHECK(row->state == WorldStagingState::Cancelled);
    CHECK(WorldStaging::OpenFor(h.db, kW).empty());
    // …but it is still history the POI panel can show.
    CHECK(WorldStaging::AllFor(h.db, kW).size() == 1);
}

// ─────────────────── the materialisation queue (the sweep) ─────────────────

TEST_CASE("W10: DueStagings is a read — an open window is not due, a closed one is") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("home", atk);
    h.AddPoi("target", "");
    h.AddEdge("home", "target", 6 * kHourMs);
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    const auto rules = h.Rules();

    CHECK(WorldStaging::DueStagings(h.db, kW, rules, kWorldNow).empty());
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, res.staging.endsAtWorldMs - 1).empty());
    // Draining is a READ: a sweep that crashes mid-drain sees the same row.
    const int64_t after = res.staging.endsAtWorldMs;
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, after).size() == 1);
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, after + kHourMs).size() == 1);
}

TEST_CASE("W10: materialisation is guarded — a second sweep cannot double-create") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    const int64_t id = res.staging.stagingId;
    const auto rules = h.Rules();
    const int64_t due = res.staging.endsAtWorldMs;

    CHECK(WorldStaging::MarkMaterialised(h.db, id, 4242, kNow));
    // The guard IS the idempotence — the same shape W6's ledger guard uses.
    CHECK_FALSE(WorldStaging::MarkMaterialised(h.db, id, 9999, kNow));
    const auto row = WorldStaging::Load(h.db, id);
    REQUIRE(row.has_value());
    CHECK(row->state == WorldStagingState::Materialised);
    CHECK(row->roomId == 4242u);
    // …and it has left the queue for good.
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, due).empty());
}

TEST_CASE("W10: a failing materialisation retries, then gives up") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    h.SetConfig("stagingMaterialiseMaxAttempts", 3);
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    const int64_t id  = res.staging.stagingId;
    const int64_t due = res.staging.endsAtWorldMs;
    const auto rules = h.Rules();
    REQUIRE(rules.materialiseMaxAttempts == 3);

    CHECK(WorldStaging::MarkAttemptFailed(h.db, id, "no game server", rules, kNow));
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, due).size() == 1);
    CHECK(WorldStaging::MarkAttemptFailed(h.db, id, "no game server", rules, kNow));
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, due).size() == 1);
    CHECK(WorldStaging::MarkAttemptFailed(h.db, id, "no game server", rules, kNow));

    const auto row = WorldStaging::Load(h.db, id);
    REQUIRE(row.has_value());
    CHECK(row->attempts == 3);
    CHECK(row->state == WorldStagingState::Failed);
    CHECK(row->lastError == "no game server");
    // "This became a battle" and "this never could" are different facts, and
    // a failed row is out of the queue rather than silently materialised.
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, due).empty());
    CHECK_FALSE(WorldStaging::MarkAttemptFailed(h.db, id, "again", rules, kNow));
}

TEST_CASE("W10: lowering the retry budget retires a row that is already spinning") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    const int64_t id  = res.staging.stagingId;
    const int64_t due = res.staging.endsAtWorldMs;

    auto rules = h.Rules();
    for (int i = 0; i < 2; ++i)
        REQUIRE(WorldStaging::MarkAttemptFailed(h.db, id, "boom", rules, kNow));
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, due).size() == 1);

    // The budget is re-read on every sweep rather than frozen into the row.
    h.SetConfig("stagingMaterialiseMaxAttempts", 2);
    rules = h.Rules();
    CHECK(WorldStaging::DueStagings(h.db, kW, rules, due).empty());
}

// ─────────────────────────── pillar 7 ──────────────────────────────────────

TEST_CASE("W10: every staging rate is per-world config") {
    StagingDb h;
    // The defaults are the world's, not a hard-coded constant read past it.
    const auto stock = h.Rules();
    CHECK(stock.stagingWindowPerTransitMs == doctest::Approx(1.0));

    h.SetConfig("stagingWindowPerTransitMs", 2.0);
    h.SetConfig("stagingWindowMinWorldMs", static_cast<double>(kHourMs));
    h.SetConfig("stagingWindowMaxWorldMs", static_cast<double>(100 * kHourMs));
    const auto tuned = h.Rules();
    CHECK(tuned.stagingWindowPerTransitMs == doctest::Approx(2.0));

    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("home", atk);
    h.AddPoi("target", "");
    h.AddEdge("home", "target", 6 * kHourMs);
    const auto res = h.Commit("target", atk);
    REQUIRE_MESSAGE(res.ok, res.error);
    // Doubled by config, with no re-weighting of the POI graph — the whole
    // reason the knob exists.
    CHECK(res.staging.endsAtWorldMs - res.staging.openedAtWorldMs == 12 * kHourMs);
}

TEST_CASE("W10: an unrelated config blob leaves every rate at its default") {
    // Per-KEY fallback, never whole-blob: a world configured for economy alone
    // must not lose its staging clamps.
    const nlohmann::json cfg = {{"poiIncomePerWorldDay", 3.0}};
    const auto r = WorldStagingRules::FromWorldConfig(cfg);
    const WorldStagingRules stock;
    CHECK(r.stagingWindowPerTransitMs == doctest::Approx(stock.stagingWindowPerTransitMs));
    CHECK(r.stagingWindowMinWorldMs == doctest::Approx(stock.stagingWindowMinWorldMs));
    CHECK(r.materialiseMaxAttempts == stock.materialiseMaxAttempts);
}

TEST_CASE("W10: a count typed as a whole double is still that count") {
    // `config_json` is hand-editable operator data. A budget written `3.0` is
    // a 3 — the strict `is_number_integer()` form its sibling modules use has
    // no way to complain, so a mistyped knob would present as the rule simply
    // not applying (see WorldStaging.cpp's CfgInt).
    CHECK(WorldStagingRules::FromWorldConfig(
              {{"stagingMaterialiseMaxAttempts", 3.0}}).materialiseMaxAttempts == 3);
    CHECK(WorldStagingRules::FromWorldConfig(
              {{"stagingMaterialiseMaxAttempts", 3}}).materialiseMaxAttempts == 3);
    // A non-number is still ignored: garbage does not become a zero budget.
    CHECK(WorldStagingRules::FromWorldConfig(
              {{"stagingMaterialiseMaxAttempts", "three"}}).materialiseMaxAttempts ==
          WorldStagingRules().materialiseMaxAttempts);
}

// ─────────────────── W5's marker states, now real ──────────────────────────

TEST_CASE("W10: a gathering force upgrades a quiet POI to staging") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("quiet_one", "");
    h.AddPoi("target", "");
    REQUIRE(h.Commit("target", atk).ok);

    nlohmann::json pois = WorldDirector::WorldPoisJson(h.db, kW);
    // W5's body: everything starts quiet when no war exists.
    for (auto& p : pois["pois"]) p["battleStatus"] = "quiet";

    const auto out = WorldStaging::AttachStaging(pois, h.db, kW, kWorldNow);
    for (const auto& p : out["pois"]) {
        const std::string id = p["id"];
        REQUIRE(p.contains("staging"));
        if (id == "target") {
            CHECK(p["battleStatus"] == "staging");
            REQUIRE(p["staging"].size() == 1);
            CHECK(p["staging"][0]["attackerFaction"] == atk);
            CHECK(p["staging"][0]["transports"] == 1);
            CHECK(p["staging"][0]["remainingWorldMs"] > 0);
        } else {
            CHECK(p["battleStatus"] == "quiet");
            CHECK(p["staging"].empty());
        }
    }
}

TEST_CASE("W10: AttachStaging upgrades and never downgrades") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    REQUIRE(h.Commit("target", atk).ok);

    nlohmann::json pois = WorldDirector::WorldPoisJson(h.db, kW);
    // A battle is already being fought here while the NEXT force gathers.
    for (auto& p : pois["pois"]) p["battleStatus"] = "active";
    const auto out = WorldStaging::AttachStaging(pois, h.db, kW, kWorldNow);
    // The marker shows the more urgent of two independent facts.
    CHECK(out["pois"][0]["battleStatus"] == "active");
    CHECK(out["pois"][0]["staging"].size() == 1);
}

TEST_CASE("W10: a resolved row is off the map even though it is still history") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    REQUIRE(WorldStaging::MarkMaterialised(h.db, res.staging.stagingId, 12, kNow));

    nlohmann::json pois = WorldDirector::WorldPoisJson(h.db, kW);
    for (auto& p : pois["pois"]) p["battleStatus"] = "quiet";
    const auto out = WorldStaging::AttachStaging(pois, h.db, kW, kWorldNow);
    CHECK(out["pois"][0]["staging"].empty());
    CHECK(out["pois"][0]["battleStatus"] == "quiet");
    CHECK(WorldStaging::AllFor(h.db, kW).size() == 1);
}

TEST_CASE("W10: an overdue window reports zero remaining, never a negative") {
    StagingDb h;
    const std::string atk = h.Found("Attackers", 1);
    h.AddPoi("target", "");
    const auto res = h.Commit("target", atk);
    REQUIRE(res.ok);
    const auto j = WorldStaging::StagingJson(res.staging,
                                             res.staging.endsAtWorldMs + 99 * kHourMs);
    CHECK(j["remainingWorldMs"] == 0);
    CHECK(j["roomId"].is_null());
}
