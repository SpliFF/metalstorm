#include <doctest/doctest.h>

#include "Server/Database.h"

// PLAN-security-hardening task 6: admin_audit is an append-only log of
// privileged actions (exec, restart, direct-start, GM verbs). ":memory:"
// gives each test case a fresh, isolated SQLite database.

TEST_CASE("Database.LogAudit appends entries, readable newest-first via GetRecentAuditEntries") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    int64_t userId = db.CreateUser("auditor", "hash");
    REQUIRE(userId > 0);
    db.EnsureAdminRole("auditor");

    db.LogAudit(userId, "auditor", "exec", "sql", "SELECT 1");
    db.LogAudit(userId, "auditor", "restart", "", "");
    db.LogAudit(0, "(loopback)", "direct_start", "papertanks", "room=7");

    auto entries = db.GetRecentAuditEntries(10);
    REQUIRE(entries.size() == 3);

    // Newest first.
    CHECK(entries[0].action == "direct_start");
    CHECK(entries[0].userId == 0);
    CHECK(entries[0].username == "(loopback)");
    CHECK(entries[0].target == "papertanks");
    CHECK(entries[0].argsDigest == "room=7");

    CHECK(entries[1].action == "restart");
    CHECK(entries[2].action == "exec");
    CHECK(entries[2].userId == userId);
    CHECK(entries[2].username == "auditor");
    CHECK(entries[2].target == "sql");
    CHECK(entries[2].argsDigest == "SELECT 1");
}

TEST_CASE("Database.GetRecentAuditEntries respects the limit") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    for (int i = 0; i < 5; i++)
        db.LogAudit(1, "u", "action", "t", std::to_string(i));

    CHECK(db.GetRecentAuditEntries(2).size() == 2);
    CHECK(db.GetRecentAuditEntries(100).size() == 5);
}

TEST_CASE("Database.LogAudit does not crash on an unknown/zero user id") {
    Database db;
    REQUIRE(db.Open(":memory:"));

    // Routes reached off-loopback-without-a-token (e.g. /api/rooms/direct
    // from localhost with no Authorization header) audit as user_id=0 — must
    // not crash or silently corrupt the table.
    db.LogAudit(0, "(loopback)", "direct_start", "papertanks", "room=1");
    db.LogAudit(-1, "bogus", "exec", "sql", "");

    CHECK(db.GetRecentAuditEntries(10).size() == 2);
}
