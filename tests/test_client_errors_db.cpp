#include <doctest/doctest.h>

#include "Server/Database.h"

// PLAN-client-resilience.md task 3: client-side crash/fatal report ingestion.
// ":memory:" gives each test case a fresh, isolated SQLite database.

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
