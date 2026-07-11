#include <doctest/doctest.h>

#include "Server/Database.h"

// PLAN-gm-tools task 4 — ban list + enforcement primitives on Database.
// ":memory:" gives each case a fresh, isolated database.

TEST_CASE("Database.SetBanned flips is_banned and FindUser reflects it") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    int64_t id = db.CreateUser("griefer", "hash");
    REQUIRE(id > 0);

    CHECK_FALSE(db.FindUser("griefer")->isBanned);

    CHECK(db.SetBanned(id, true));
    CHECK(db.FindUser("griefer")->isBanned);
    CHECK(db.FindUserById(id)->isBanned);

    CHECK(db.SetBanned(id, false));
    CHECK_FALSE(db.FindUser("griefer")->isBanned);
}

TEST_CASE("Database.SetBanned returns false for an unknown user id") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    CHECK_FALSE(db.SetBanned(4242, true));
}

TEST_CASE("Database.SetBannedByUsername resolves the id and bans by name") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    int64_t id = db.CreateUser("mallory", "hash");
    REQUIRE(id > 0);

    int64_t outId = -1;
    CHECK(db.SetBannedByUsername("mallory", true, outId));
    CHECK(outId == id);
    CHECK(db.FindUser("mallory")->isBanned);

    // Unknown username → false, out id cleared to 0.
    int64_t missId = 999;
    CHECK_FALSE(db.SetBannedByUsername("nobody", true, missId));
    CHECK(missId == 0);
}

TEST_CASE("Database.RevokeUserSessions deletes all of a user's sessions") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    int64_t id = db.CreateUser("player1", "hash");
    REQUIRE(id > 0);
    db.CreateSession(id, "tok-a");
    db.CreateSession(id, "tok-b");

    // Both tokens valid before the revoke.
    CHECK(db.ValidateSession("tok-a") == id);
    CHECK(db.ValidateSession("tok-b") == id);

    CHECK(db.RevokeUserSessions(id) == 2);

    // Ban ejection: the live tokens are dead immediately.
    CHECK(db.ValidateSession("tok-a") == 0);
    CHECK(db.ValidateSession("tok-b") == 0);
    // Idempotent — no sessions left to revoke.
    CHECK(db.RevokeUserSessions(id) == 0);
}

TEST_CASE("Database.GetBannedUsers lists only banned accounts, newest first") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    int64_t a = db.CreateUser("alice", "h");
    int64_t b = db.CreateUser("bob", "h");
    int64_t c = db.CreateUser("carol", "h");
    REQUIRE(a > 0); REQUIRE(b > 0); REQUIRE(c > 0);

    CHECK(db.GetBannedUsers().empty());

    db.SetBanned(a, true);
    db.SetBanned(c, true);

    auto banned = db.GetBannedUsers();
    REQUIRE(banned.size() == 2);
    // Newest id first (carol before alice); bob (unbanned) absent.
    CHECK(banned[0].username == "carol");
    CHECK(banned[1].username == "alice");
    for (const auto& u : banned) CHECK(u.isBanned);
}
