// Tests for the PLAN-long-uptime task-2b growth bounds.
//
// Two of the four surfaces in that wave are testable without a live sim:
//
//   S6 — standing orders were "throttled, not bounded". Expiry only fired if
//        the *client* passed expires_in_frames > 0, and every UI path passes
//        0, so a weeks-long campaign accumulated orders for the life of the
//        game. There is now a default TTL and a per-team cap.
//   S8 — `admin_audit` and `client_errors` are append-only and had no DELETE
//        anywhere (T2a-4). They now ride the lobby's maintenance sweep.
//
//   S1 — the rulesParams key dictionary is append-only. Its *decision* and its
//        *rebuild* are pure and tested here; sending the rebuilt dictionary to
//        every behind-rev session is existing wire code driven by the same rev
//        bump a newly-interned key already caused.
//
// S4 is synced Lua and is covered by the busted spec
// (LuaRules/Gadgets/tests/game_parley_spec.lua, "resolved-proposal archive").

#include <doctest/doctest.h>

#include "Server/StandingOrders.h"
#include "Server/RulesParamKeyDict.h"
#include "Server/Database.h"

#include <sqlite3.h>

#include <filesystem>
#include <string>

namespace {

/// The manager is a global; every case starts from a known configuration
/// rather than inheriting whatever the previous one set.
void resetOrders() {
    standingOrders.Clear();
    standingOrders.SetChangeNotifier(nullptr);
    standingOrders.SetDefaultTtlFrames(108000);
    standingOrders.SetPerTeamCap(64);
}

uint32_t makeOrder(int team, uint32_t expiresInFrames, uint32_t frame) {
    return standingOrders.Create(team, StandingOrderType::DefendArea, 0,
                                 {0.0f, 0.0f, 0.0f, 100.0f},
                                 StandingOrderConditions{}, expiresInFrames,
                                 frame);
}

const StandingOrder* findOrder(uint32_t id) {
    for (const auto& o : standingOrders.GetAllOrders()) {
        if (o.id == id) return &o;
    }
    return nullptr;
}

} // namespace

TEST_SUITE("StandingOrderManager growth bounds (PLAN-long-uptime S6)") {

    TEST_CASE("an order created with no deadline gets the default TTL") {
        resetOrders();
        standingOrders.SetDefaultTtlFrames(1000);

        const uint32_t id = makeOrder(1, 0, 500);
        REQUIRE(id != 0);
        const StandingOrder* o = findOrder(id);
        REQUIRE(o != nullptr);
        // This is the whole point of the row: 0 used to mean "forever".
        CHECK(o->expiresAtFrame == 1500);
    }

    TEST_CASE("an explicit deadline always wins, including a longer one") {
        resetOrders();
        standingOrders.SetDefaultTtlFrames(1000);

        const uint32_t shortId = makeOrder(1, 60, 500);
        const uint32_t longId = makeOrder(1, 100000, 500);
        REQUIRE(findOrder(shortId) != nullptr);
        REQUIRE(findOrder(longId) != nullptr);
        CHECK(findOrder(shortId)->expiresAtFrame == 560);
        CHECK(findOrder(longId)->expiresAtFrame == 100500);
    }

    TEST_CASE("a zero default TTL restores the never-expires behaviour") {
        resetOrders();
        standingOrders.SetDefaultTtlFrames(0);

        const uint32_t id = makeOrder(1, 0, 500);
        REQUIRE(findOrder(id) != nullptr);
        CHECK(findOrder(id)->expiresAtFrame == 0);
    }

    TEST_CASE("the default TTL actually expires the order in Evaluate") {
        resetOrders();
        standingOrders.SetDefaultTtlFrames(1000);

        const uint32_t id = makeOrder(1, 0, 0);
        REQUIRE(findOrder(id) != nullptr);

        standingOrders.Evaluate(999);
        CHECK(findOrder(id) != nullptr);   // one frame short

        standingOrders.Evaluate(1000);
        CHECK(findOrder(id) == nullptr);   // and gone
        CHECK(standingOrders.CountTeamOrders(1) == 0);
    }

    TEST_CASE("Create refuses past the per-team cap and reports it as 0") {
        resetOrders();
        standingOrders.SetPerTeamCap(3);

        CHECK(makeOrder(1, 0, 0) != 0);
        CHECK(makeOrder(1, 0, 0) != 0);
        CHECK(makeOrder(1, 0, 0) != 0);
        // Fourth is refused rather than growing the vector or evicting
        // somebody else's directive.
        CHECK(makeOrder(1, 0, 0) == 0);
        CHECK(standingOrders.CountTeamOrders(1) == 3);
    }

    TEST_CASE("the cap is per team, not global") {
        resetOrders();
        standingOrders.SetPerTeamCap(2);

        CHECK(makeOrder(1, 0, 0) != 0);
        CHECK(makeOrder(1, 0, 0) != 0);
        CHECK(makeOrder(1, 0, 0) == 0);     // team 1 full
        CHECK(makeOrder(2, 0, 0) != 0);     // team 2 unaffected
        CHECK(makeOrder(2, 0, 0) != 0);
        CHECK(makeOrder(2, 0, 0) == 0);
        CHECK(standingOrders.CountTeamOrders(1) == 2);
        CHECK(standingOrders.CountTeamOrders(2) == 2);
    }

    TEST_CASE("removing an order frees a cap slot") {
        resetOrders();
        standingOrders.SetPerTeamCap(1);

        const uint32_t id = makeOrder(1, 0, 0);
        REQUIRE(id != 0);
        CHECK(makeOrder(1, 0, 0) == 0);

        CHECK(standingOrders.Remove(id, 1));
        CHECK(makeOrder(1, 0, 0) != 0);
    }

    TEST_CASE("a refused create does not burn an order id") {
        resetOrders();
        standingOrders.SetPerTeamCap(1);

        const uint32_t first = makeOrder(1, 0, 0);
        CHECK(makeOrder(1, 0, 0) == 0);          // refused
        CHECK(standingOrders.Remove(first, 1));
        const uint32_t second = makeOrder(1, 0, 0);
        // Ids stay dense: the refusal happened before nextId was touched.
        CHECK(second == first + 1);
    }

    TEST_CASE("a zero cap disables the bound entirely") {
        resetOrders();
        standingOrders.SetPerTeamCap(0);
        for (int i = 0; i < 200; ++i) CHECK(makeOrder(1, 0, 0) != 0);
        CHECK(standingOrders.CountTeamOrders(1) == 200);
        resetOrders();
    }
}

namespace {

/// Backdate a row. Both tables default `created_at` to CURRENT_TIMESTAMP and
/// neither write verb overrides it, so ageing a row means going around the
/// Database API to the same file with a second connection. That is also the
/// shape the real sweep runs in (a maintenance connection alongside the
/// lobby's — PLAN-long-uptime §8.2), so it is not an artificial arrangement.
bool BackdateRow(const std::string& dbPath, const char* table, int64_t id,
                 int days) {
    sqlite3* raw = nullptr;
    if (sqlite3_open(dbPath.c_str(), &raw) != SQLITE_OK) return false;
    const std::string sql = std::string("UPDATE ") + table +
        " SET created_at = datetime('now', '-" + std::to_string(days) +
        " days') WHERE id = " + std::to_string(id);
    const int rc = sqlite3_exec(raw, sql.c_str(), nullptr, nullptr, nullptr);
    sqlite3_close(raw);
    return rc == SQLITE_OK;
}

Database::ClientErrorRecord sampleError(const std::string& hash) {
    Database::ClientErrorRecord rec;
    rec.reason = "fatal";
    rec.errorClass = "TypeError";
    rec.message = "boom";
    rec.stack = "at x";
    rec.stackHash = hash;
    return rec;
}

} // namespace

TEST_SUITE("rulesParams key-dictionary compaction (PLAN-long-uptime S1)") {

    // The thresholds the streamer actually uses.
    static constexpr size_t kMinDead = 512;
    static constexpr size_t kMinPct = 25;

    TEST_CASE("compaction holds off until enough ids are dead") {
        using RulesParamKeyDict::ShouldCompact;

        // Nothing dead.
        CHECK_FALSE(ShouldCompact(1000, 1000, kMinDead, kMinPct));
        // Dead but under the absolute floor — a small dictionary is not worth
        // re-issuing every id and re-broadcasting for.
        CHECK_FALSE(ShouldCompact(1000, 600, kMinDead, kMinPct));
        // Over the floor but only 5% dead: mostly-live dictionary, leave it.
        CHECK_FALSE(ShouldCompact(20000, 19000, kMinDead, kMinPct));
        // Over both.
        CHECK(ShouldCompact(4000, 1000, kMinDead, kMinPct));
        // Exactly on both boundaries counts as over.
        CHECK(ShouldCompact(2048, 1536, kMinDead, kMinPct));
    }

    TEST_CASE("a live count above the interned count is not treated as dead") {
        // Underflow guard: size_t subtraction the wrong way round would read
        // as ~1.8e19 dead ids and compact every single tick.
        CHECK_FALSE(RulesParamKeyDict::ShouldCompact(10, 5000, kMinDead, kMinPct));
    }

    TEST_CASE("rebuild keeps every live key, drops the rest, reserves index 0") {
        std::unordered_map<std::string, uint16_t> keyToId;
        std::vector<std::string> idToKey;

        // A dictionary as it would look mid-campaign: live keys plus the
        // residue of resolved objectives.
        std::unordered_set<std::string> live;
        idToKey.push_back("");
        for (int i = 0; i < 1000; ++i) {
            const std::string k = "objective_" + std::to_string(i) + "_state";
            keyToId[k] = static_cast<uint16_t>(idToKey.size());
            idToKey.push_back(k);
        }
        for (const char* k : {"war_state", "score_1_kills", "authority_player_1"}) {
            live.insert(k);
            keyToId[k] = static_cast<uint16_t>(idToKey.size());
            idToKey.push_back(k);
        }
        live.insert("objective_999_state");  // one objective still active

        RulesParamKeyDict::Rebuild(keyToId, idToKey, live);

        REQUIRE(idToKey.size() == live.size() + 1);
        CHECK(idToKey[0].empty());                 // 0 stays "not interned"
        CHECK(keyToId.size() == live.size());
        for (const auto& k : live) {
            REQUIRE(keyToId.count(k) == 1);
            const uint16_t id = keyToId[k];
            CHECK(id > 0);
            CHECK(idToKey[id] == k);               // the two maps agree
        }
        // A key that was interned and is no longer live is gone for good.
        CHECK(keyToId.count("objective_0_state") == 0);
    }

    TEST_CASE("rebuild is a function of the live set, not of insertion order") {
        // Two dictionaries that saw the same keys in opposite orders must
        // compact to identical ids, or a replay's clients and a live game's
        // clients would decode the same recording differently.
        const std::unordered_set<std::string> live{"a_key", "b_key", "c_key",
                                                   "d_key"};

        std::unordered_map<std::string, uint16_t> mapA, mapB;
        std::vector<std::string> vecA{""}, vecB{""};
        for (const char* k : {"d_key", "c_key", "b_key", "a_key"}) {
            mapA[k] = static_cast<uint16_t>(vecA.size());
            vecA.push_back(k);
        }
        for (const char* k : {"a_key", "b_key", "c_key", "d_key"}) {
            mapB[k] = static_cast<uint16_t>(vecB.size());
            vecB.push_back(k);
        }
        REQUIRE(vecA != vecB);

        RulesParamKeyDict::Rebuild(mapA, vecA, live);
        RulesParamKeyDict::Rebuild(mapB, vecB, live);
        CHECK(vecA == vecB);
        CHECK(vecA[1] == "a_key");   // sorted, not hash order
        CHECK(vecA[4] == "d_key");
    }

    TEST_CASE("an empty live set leaves a valid, empty dictionary") {
        std::unordered_map<std::string, uint16_t> keyToId{{"stale", 1}};
        std::vector<std::string> idToKey{"", "stale"};

        RulesParamKeyDict::Rebuild(keyToId, idToKey, {});

        CHECK(keyToId.empty());
        REQUIRE(idToKey.size() == 1);
        CHECK(idToKey[0].empty());   // InternKey's reserved slot must survive
    }
}

TEST_SUITE("Append-only table retention (PLAN-long-uptime S8 / T2a-4)") {

    TEST_CASE("audit and client-error rows past the window are swept") {
        const auto path = std::filesystem::temp_directory_path() /
                          "springrts-growth-bounds-test.db";
        std::filesystem::remove(path);

        Database db;
        REQUIRE(db.Open(path.string()));

        db.LogAudit(0, "gm", "exec", "room:1", "abc");
        db.LogAudit(0, "gm", "restart", "room:1", "def");
        REQUIRE(BackdateRow(path.string(), "admin_audit", 1, 200));

        REQUIRE(db.InsertClientError(sampleError("h1")) == 1);
        REQUIRE(db.InsertClientError(sampleError("h2")) == 2);
        REQUIRE(BackdateRow(path.string(), "client_errors", 1, 60));

        CHECK(db.CleanOldAuditEntries(90 * 86400) == 1);
        CHECK(db.CleanOldClientErrors(30 * 86400) == 1);

        // The recent rows survive — a sweep that emptied the table would pass
        // a "rows go away" assertion just as happily.
        CHECK(db.CleanOldAuditEntries(90 * 86400) == 0);
        CHECK(db.CleanOldClientErrors(30 * 86400) == 0);
        REQUIRE(db.GetRecentAuditEntries(10).size() == 1);
        CHECK(db.GetRecentAuditEntries(10)[0].action == "restart");

        std::filesystem::remove(path);
    }

    TEST_CASE("a non-positive window is a no-op, not a table wipe") {
        Database db;
        REQUIRE(db.Open(":memory:"));
        db.LogAudit(0, "gm", "exec", "room:1", "abc");

        CHECK(db.CleanOldAuditEntries(0) == 0);
        CHECK(db.CleanOldAuditEntries(-1) == 0);
        CHECK(db.GetRecentAuditEntries(10).size() == 1);
    }
}
