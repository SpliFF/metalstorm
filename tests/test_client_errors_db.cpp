#include <doctest/doctest.h>

#include <sqlite3.h>

#include <filesystem>
#include <string>

#include "Server/Database.h"

// PLAN-client-resilience.md task 3: client-side crash/fatal report ingestion.
// PLAN-client-resilience.md task 4: the grouped-by-stack-hash read side and
// the retention prune that bounds the table.
// ":memory:" gives each test case a fresh, isolated SQLite database.

namespace {

/// A file-backed DB, for the cases that need a *second* connection to
/// backdate `created_at` (it defaults to CURRENT_TIMESTAMP and the production
/// API deliberately offers no way to write it — the prune's age boundary is
/// otherwise untestable without sleeping for days).
struct TempDbPath {
    std::filesystem::path path;
    explicit TempDbPath(const char* name)
        : path(std::filesystem::temp_directory_path() /
               ("springrts-test-" + std::string(name) + ".sqlite")) {
        std::filesystem::remove(path);
    }
    ~TempDbPath() { std::filesystem::remove(path); }
    const char* c_str() const { return path.c_str(); }
};

/// Shift a row's created_at back by `days`, through a separate connection.
void BackdateReport(const TempDbPath& dbPath, const std::string& stackHash, int days) {
    sqlite3* raw = nullptr;
    REQUIRE(sqlite3_open(dbPath.c_str(), &raw) == SQLITE_OK);
    const std::string sql =
        "UPDATE client_errors SET created_at = datetime('now', '-" +
        std::to_string(days) + " days') WHERE stack_hash = '" + stackHash + "'";
    REQUIRE(sqlite3_exec(raw, sql.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK);
    sqlite3_close(raw);
}

Database::ClientErrorRecord MakeReport(const std::string& stackHash,
                                       const std::string& message = "boom") {
    Database::ClientErrorRecord rec;
    rec.reason = "fatal";
    rec.errorClass = "TypeError";
    rec.message = message;
    rec.stack = "TypeError: " + message + "\n  at a.b (chunk-x.js:1:2345)";
    rec.stackHash = stackHash;
    rec.recoveryRung = "R2";
    rec.phase = "render";
    rec.frame = 900;
    rec.entityCount = 60;
    rec.gameId = "metalstorm";
    rec.mapId = "meridian_basin";
    rec.buildStamp = "b100";
    rec.gpuRenderer = "ANGLE (Test)";
    rec.logRing = "[INFO] a\n[WARN] b";
    rec.count = 1;
    return rec;
}

} // namespace

TEST_CASE("Database.InsertClientError stores a report and returns a positive id") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    int64_t userId = db.CreateUser("player1", "hash");
    REQUIRE(userId > 0);

    Database::ClientErrorRecord rec;
    rec.userId = userId;
    rec.reason = "fatal";
    rec.errorClass = "TypeError";
    rec.message = "boom";
    rec.stack = "TypeError: boom\n  at foo (x.js:1:1)";
    rec.stackHash = "deadbeef";
    rec.recoveryRung = "none";
    rec.phase = "fx";
    rec.frame = 12345;
    rec.entityCount = 200;
    rec.gameId = "zk";
    rec.mapId = "green_flat";
    rec.buildStamp = "abc123";
    rec.gpuRenderer = "ANGLE (Test)";
    rec.logRing = "[INFO] a\n[WARN] b";
    rec.count = 1;

    int64_t id = db.InsertClientError(rec);
    CHECK(id > 0);
}

TEST_CASE("Database.CountRecentClientErrors counts only the given user's recent reports") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    int64_t userA = db.CreateUser("a", "hash");
    int64_t userB = db.CreateUser("b", "hash");
    REQUIRE(userA > 0);
    REQUIRE(userB > 0);

    Database::ClientErrorRecord rec;
    rec.errorClass = "Error";
    rec.message = "x";

    rec.userId = userA;
    for (int i = 0; i < 3; i++) {
        rec.stackHash = "hash" + std::to_string(i);
        REQUIRE(db.InsertClientError(rec) > 0);
    }
    rec.userId = userB;
    rec.stackHash = "other";
    REQUIRE(db.InsertClientError(rec) > 0);

    CHECK(db.CountRecentClientErrors(userA, 3600) == 3);
    CHECK(db.CountRecentClientErrors(userB, 3600) == 1);
    CHECK(db.CountRecentClientErrors(999, 3600) == 0);
}

TEST_CASE("Database.InsertClientError does not crash on an unknown/zero user id or empty fields") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    Database::ClientErrorRecord rec;
    rec.userId = 0;
    CHECK(db.InsertClientError(rec) > 0);
    CHECK(db.CountRecentClientErrors(0, 3600) == 1);
}

// --- task 4: the read side ---

TEST_CASE("Database.GetClientErrorGroups collapses reports by stack hash and tallies occurrences") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    const int64_t userA = db.CreateUser("a", "hash");
    const int64_t userB = db.CreateUser("b", "hash");
    REQUIRE(userA > 0);
    REQUIRE(userB > 0);

    // Same crash site, two accounts, two builds, two games — and one report
    // that carries a client-side dedup tally of 8.
    auto r1 = MakeReport("aaa", "first");
    r1.userId = userA;
    REQUIRE(db.InsertClientError(r1) > 0);

    auto r2 = MakeReport("aaa", "latest");
    r2.userId = userB;
    r2.buildStamp = "b200";
    r2.gameId = "papertanks";
    r2.count = 8;
    r2.recoveryRung = "R3";
    REQUIRE(db.InsertClientError(r2) > 0);

    // A different crash site, so grouping has something to keep apart.
    auto r3 = MakeReport("bbb", "unrelated");
    r3.userId = userA;
    REQUIRE(db.InsertClientError(r3) > 0);

    auto groups = db.GetClientErrorGroups(50, 0);
    REQUIRE(groups.size() == 2);

    const Database::ClientErrorGroup* aaa = nullptr;
    for (const auto& g : groups)
        if (g.stackHash == "aaa")
            aaa = &g;
    REQUIRE(aaa != nullptr);

    CHECK(aaa->reports == 2);
    CHECK(aaa->occurrences == 9); // 1 + 8 — the tally, not the row count
    CHECK(aaa->users == 2);
    // Class/message/rung come from the newest row in the group, not an
    // arbitrary one: SQLite's bare-column rule is undefined with four
    // min/max aggregates in the query, so this is the assertion that the
    // explicit ORDER BY subqueries are doing their job.
    CHECK(aaa->message == "latest");
    CHECK(aaa->recoveryRung == "R3");
    CHECK(aaa->firstBuild == "b100");
    CHECK(aaa->lastBuild == "b200");
    CHECK(aaa->games.find("metalstorm") != std::string::npos);
    CHECK(aaa->games.find("papertanks") != std::string::npos);
    CHECK_FALSE(aaa->firstSeen.empty());
    CHECK_FALSE(aaa->lastSeen.empty());
}

TEST_CASE("Database.GetClientErrorGroups leaves empty build stamps and game ids out of the summary") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    auto rec = MakeReport("ccc");
    rec.buildStamp = "";
    rec.gameId = "";
    REQUIRE(db.InsertClientError(rec) > 0);

    auto groups = db.GetClientErrorGroups(50, 0);
    REQUIRE(groups.size() == 1);
    // NULLIF keeps '' out of the range/list rather than reporting a build
    // range of "" → "b100" or a game list with a leading comma.
    CHECK(groups[0].firstBuild.empty());
    CHECK(groups[0].lastBuild.empty());
    CHECK(groups[0].games.empty());
}

TEST_CASE("Database.GetClientErrorGroups honours limit and a zero/negative limit returns nothing") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    for (int i = 0; i < 5; i++)
        REQUIRE(db.InsertClientError(MakeReport("h" + std::to_string(i))) > 0);

    CHECK(db.GetClientErrorGroups(3, 0).size() == 3);
    CHECK(db.GetClientErrorGroups(0, 0).empty());
    CHECK(db.GetClientErrorGroups(-1, 0).empty());
}

TEST_CASE("Database.GetClientErrorsByHash returns the full stored report for one crash site") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    const int64_t userId = db.CreateUser("player1", "hash");
    auto rec = MakeReport("ddd", "detail me");
    rec.userId = userId;
    REQUIRE(db.InsertClientError(rec) > 0);
    REQUIRE(db.InsertClientError(MakeReport("eee")) > 0);

    auto reports = db.GetClientErrorsByHash("ddd", 200);
    REQUIRE(reports.size() == 1);
    const auto& r = reports[0];
    CHECK(r.id > 0);
    CHECK_FALSE(r.createdAt.empty());
    CHECK(r.userId == userId);
    CHECK(r.message == "detail me");
    CHECK(r.stackHash == "ddd");
    CHECK(r.stack.find("chunk-x.js") != std::string::npos); // full stack, for export
    CHECK(r.logRing == "[INFO] a\n[WARN] b");
    CHECK(r.gpuRenderer == "ANGLE (Test)");
    CHECK(r.frame == 900);

    CHECK(db.GetClientErrorsByHash("no-such-hash", 200).empty());
    CHECK(db.GetClientErrorsByHash("ddd", 0).empty());
}

// --- task 4: retention ---

TEST_CASE("Database.PruneClientErrors deletes only reports older than the retention window") {
    TempDbPath dbPath("client-errors-prune");
    Database db;
    REQUIRE(db.Open(dbPath.c_str()));

    REQUIRE(db.InsertClientError(MakeReport("fresh")) > 0);
    REQUIRE(db.InsertClientError(MakeReport("old")) > 0);
    REQUIRE(db.InsertClientError(MakeReport("edge")) > 0);

    BackdateReport(dbPath, "old", 45);
    BackdateReport(dbPath, "edge", 29); // inside a 30-day window

    CHECK(db.PruneClientErrors(30) == 1);
    CHECK(db.GetClientErrorsByHash("old", 10).empty());
    CHECK(db.GetClientErrorsByHash("fresh", 10).size() == 1);
    CHECK(db.GetClientErrorsByHash("edge", 10).size() == 1);

    // Idempotent: a second sweep has nothing left to take.
    CHECK(db.PruneClientErrors(30) == 0);
}

TEST_CASE("Database.PruneClientErrors treats a non-positive retention as 'keep everything'") {
    TempDbPath dbPath("client-errors-prune-guard");
    Database db;
    REQUIRE(db.Open(dbPath.c_str()));

    REQUIRE(db.InsertClientError(MakeReport("ancient")) > 0);
    BackdateReport(dbPath, "ancient", 4000);

    // A config read that produced 0 must not wipe the table.
    CHECK(db.PruneClientErrors(0) == 0);
    CHECK(db.PruneClientErrors(-1) == 0);
    CHECK(db.GetClientErrorsByHash("ancient", 10).size() == 1);
}

TEST_CASE("Database.GetClientErrorGroups sinceDays bounds the window, 0 means all retained") {
    TempDbPath dbPath("client-errors-since");
    Database db;
    REQUIRE(db.Open(dbPath.c_str()));

    REQUIRE(db.InsertClientError(MakeReport("recent")) > 0);
    REQUIRE(db.InsertClientError(MakeReport("lastweek")) > 0);
    BackdateReport(dbPath, "lastweek", 5);

    CHECK(db.GetClientErrorGroups(50, 1).size() == 1);  // last 24h
    CHECK(db.GetClientErrorGroups(50, 7).size() == 2);  // last week
    CHECK(db.GetClientErrorGroups(50, 0).size() == 2);  // unbounded
}
