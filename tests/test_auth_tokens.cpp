#include <doctest/doctest.h>

#include <sqlite3.h>

#include <set>
#include <string>

#include "Server/AuthTokens.h"

// PLAN-metalstorm-lobby.md §7.2/§7.3, task 8a — the two long-lived credentials
// an account holds beyond its 24 h access session.
//
// What these tests pin down, and why each one is a thing that can silently be
// wrong rather than a restatement of the code:
//
//  1. **Rotation actually rotates.** A refresh token is single-use. The bug
//     this catches is the one where the successor is minted but the
//     predecessor is never marked — the endpoint looks correct from the
//     client's side (it always gets a new token) while every token ever issued
//     stays live forever, which is the exact opposite of what rotation is for.
//  2. **Reuse kills the FAMILY, not the row.** Revoking only the replayed
//     token leaves the thief's successor — which they minted from it — fully
//     live, so the mitigation protects nobody. The lineage is the credential.
//  3. **Reuse is checked before expiry.** A replayed token that has also aged
//     out is still a replay. If the ladder tests expiry first, an attacker who
//     waits out the TTL gets `Expired` and the family is never revoked.
//  4. **A war token is bound to its war.** The whole safety argument for a
//     seven-day TTL is that the token opens exactly one room. If the room is
//     checked anywhere other than inside the lookup, some caller eventually
//     forgets it.
//  5. **Nothing is stored in the clear.** The point of hashing at rest is that
//     a read of the db file is not a month of impersonation, so the raw value
//     must appear in no column of either table.

namespace {

struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        AuthTokens::EnsureTables(db);
    }
    ~TestDb() { sqlite3_close(db); }
};

constexpr int64_t kT0  = 1'700'000'000;
constexpr int     kTtl = 3600;
constexpr int64_t kUser = 42;

/// Does `needle` appear as a literal value anywhere in `table`? Used to prove
/// the raw token is not stored — a column-by-column assertion would miss the
/// day somebody adds a "last presented value" column for debugging.
bool AppearsInTable(sqlite3* db, const char* table, const std::string& needle) {
    std::string sql = "SELECT * FROM ";
    sql += table;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return false;
    bool found = false;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        for (int i = 0; i < sqlite3_column_count(stmt); ++i) {
            if (const unsigned char* t = sqlite3_column_text(stmt, i)) {
                if (std::string(reinterpret_cast<const char*>(t)) == needle)
                    found = true;
            }
        }
    }
    sqlite3_finalize(stmt);
    return found;
}

}  // namespace

TEST_CASE("refresh: issue mints a usable token in its own family") {
    TestDb t;
    auto a = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    auto b = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    REQUIRE(a.has_value());
    REQUIRE(b.has_value());
    CHECK(a->token != b->token);
    // Two password logins are two lineages: revoking one must not touch the
    // session the player just opened.
    CHECK(a->familyId != b->familyId);
}

TEST_CASE("refresh: rotation is single-use and stays in the family") {
    TestDb t;
    auto issued = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    REQUIRE(issued.has_value());

    auto first = AuthTokens::Rotate(t.db, issued->token, kTtl, kT0 + 10);
    CHECK(first.status == AuthTokens::RefreshStatus::OK);
    CHECK(first.userId == kUser);
    CHECK(first.next.token != issued->token);
    CHECK(first.next.familyId == issued->familyId);

    // The successor works...
    auto second = AuthTokens::Rotate(t.db, first.next.token, kTtl, kT0 + 20);
    CHECK(second.status == AuthTokens::RefreshStatus::OK);
    CHECK(second.next.familyId == issued->familyId);
}

TEST_CASE("refresh: replaying a spent token revokes the whole family") {
    TestDb t;
    auto issued = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    REQUIRE(issued.has_value());
    auto first = AuthTokens::Rotate(t.db, issued->token, kTtl, kT0 + 10);
    REQUIRE(first.status == AuthTokens::RefreshStatus::OK);

    // The thief replays the token the legitimate client already spent.
    auto replay = AuthTokens::Rotate(t.db, issued->token, kTtl, kT0 + 20);
    CHECK(replay.status == AuthTokens::RefreshStatus::Reused);

    // …and the successor the LEGITIMATE client is holding is dead too. This is
    // the assertion that separates "revoke the row" from "revoke the family":
    // with a row-only revocation this call still returns OK.
    auto after = AuthTokens::Rotate(t.db, first.next.token, kTtl, kT0 + 30);
    CHECK(after.status == AuthTokens::RefreshStatus::Revoked);
}

TEST_CASE("refresh: reuse is detected even after the token has expired") {
    TestDb t;
    auto issued = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    REQUIRE(issued.has_value());
    auto first = AuthTokens::Rotate(t.db, issued->token, kTtl, kT0 + 10);
    REQUIRE(first.status == AuthTokens::RefreshStatus::OK);

    // Replayed long after its TTL. An expiry-first ladder reports Expired here
    // and never revokes, handing an attacker who simply waits a free probe.
    auto replay = AuthTokens::Rotate(t.db, issued->token, kTtl,
                                     kT0 + 10 * kTtl);
    CHECK(replay.status == AuthTokens::RefreshStatus::Reused);
    auto after = AuthTokens::Rotate(t.db, first.next.token, kTtl, kT0 + 20);
    CHECK(after.status == AuthTokens::RefreshStatus::Revoked);
}

TEST_CASE("refresh: expiry and unknown tokens are distinct non-answers") {
    TestDb t;
    auto issued = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    REQUIRE(issued.has_value());

    auto expired = AuthTokens::Rotate(t.db, issued->token, kTtl, kT0 + kTtl + 1);
    CHECK(expired.status == AuthTokens::RefreshStatus::Expired);

    auto unknown = AuthTokens::Rotate(t.db, "not-a-token", kTtl, kT0);
    CHECK(unknown.status == AuthTokens::RefreshStatus::Unknown);
    CHECK(unknown.userId == 0);
}

TEST_CASE("refresh: logout revokes the presented token's family") {
    TestDb t;
    auto issued = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    REQUIRE(issued.has_value());
    auto first = AuthTokens::Rotate(t.db, issued->token, kTtl, kT0 + 10);
    REQUIRE(first.status == AuthTokens::RefreshStatus::OK);

    // Logout presents the token the client currently holds — the successor,
    // not the one it was issued at login.
    CHECK(AuthTokens::RevokeFamilyOfToken(t.db, first.next.token, kT0 + 20) > 0);
    auto after = AuthTokens::Rotate(t.db, first.next.token, kTtl, kT0 + 30);
    CHECK(after.status == AuthTokens::RefreshStatus::Revoked);

    // An unknown token is a no-op, not a failure: /api/auth/logout must still
    // return 200 for a client whose token has already been pruned.
    CHECK(AuthTokens::RevokeFamilyOfToken(t.db, "gone", kT0 + 40) == 0);
}

TEST_CASE("refresh: log-out-everywhere kills every family the account holds") {
    TestDb t;
    auto a = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    auto b = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    auto other = AuthTokens::IssueRefresh(t.db, kUser + 1, kTtl, kT0);
    REQUIRE(a.has_value());
    REQUIRE(b.has_value());
    REQUIRE(other.has_value());

    CHECK(AuthTokens::RevokeAllRefreshForUser(t.db, kUser, kT0 + 5) == 2);
    CHECK(AuthTokens::Rotate(t.db, a->token, kTtl, kT0 + 10).status ==
          AuthTokens::RefreshStatus::Revoked);
    CHECK(AuthTokens::Rotate(t.db, b->token, kTtl, kT0 + 10).status ==
          AuthTokens::RefreshStatus::Revoked);
    // Another account's lineage is untouched — "everywhere" is scoped to one
    // account, and a WHERE clause that lost its user_id would pass every other
    // assertion in this file.
    CHECK(AuthTokens::Rotate(t.db, other->token, kTtl, kT0 + 10).status ==
          AuthTokens::RefreshStatus::OK);
}

TEST_CASE("war reconnect: a token opens exactly one war") {
    TestDb t;
    auto tok = AuthTokens::IssueWarReconnect(t.db, kUser, /*roomId=*/7, kTtl, kT0);
    REQUIRE(tok.has_value());

    CHECK(AuthTokens::ValidateWarReconnect(t.db, *tok, 7, kT0 + 10) == kUser);
    // The safety argument for a week-long TTL is entirely this line.
    CHECK(AuthTokens::ValidateWarReconnect(t.db, *tok, 8, kT0 + 10) == 0);
}

TEST_CASE("war reconnect: expiry, revocation and unknown all return 0") {
    TestDb t;
    auto tok = AuthTokens::IssueWarReconnect(t.db, kUser, 7, kTtl, kT0);
    REQUIRE(tok.has_value());

    CHECK(AuthTokens::ValidateWarReconnect(t.db, *tok, 7, kT0 + kTtl + 1) == 0);
    CHECK(AuthTokens::ValidateWarReconnect(t.db, "nope", 7, kT0) == 0);

    CHECK(AuthTokens::RevokeWarReconnectForAccount(t.db, kUser, kT0 + 5) == 1);
    CHECK(AuthTokens::ValidateWarReconnect(t.db, *tok, 7, kT0 + 10) == 0);
}

TEST_CASE("war reconnect: re-issuing does not evict the other device") {
    TestDb t;
    auto phone   = AuthTokens::IssueWarReconnect(t.db, kUser, 7, kTtl, kT0);
    auto desktop = AuthTokens::IssueWarReconnect(t.db, kUser, 7, kTtl, kT0 + 1);
    REQUIRE(phone.has_value());
    REQUIRE(desktop.has_value());
    // §7.4 allows an account to hold seats from more than one device, so
    // minting on the desktop must not silently log the phone out of the war.
    CHECK(AuthTokens::ValidateWarReconnect(t.db, *phone, 7, kT0 + 10) == kUser);
    CHECK(AuthTokens::ValidateWarReconnect(t.db, *desktop, 7, kT0 + 10) == kUser);
}

TEST_CASE("neither table stores a raw token") {
    TestDb t;
    auto refresh = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    auto war     = AuthTokens::IssueWarReconnect(t.db, kUser, 7, kTtl, kT0);
    REQUIRE(refresh.has_value());
    REQUIRE(war.has_value());

    CHECK_FALSE(AppearsInTable(t.db, "refresh_tokens", refresh->token));
    CHECK_FALSE(AppearsInTable(t.db, "war_reconnect_tokens", *war));
    // The digest IS there — otherwise the check above passes trivially against
    // a table that stored nothing at all.
    CHECK(AppearsInTable(t.db, "refresh_tokens",
                         AuthTokens::HashToken(refresh->token)));
    CHECK(AppearsInTable(t.db, "war_reconnect_tokens",
                         AuthTokens::HashToken(*war)));
}

TEST_CASE("prune removes only what is past its TTL plus the grace window") {
    TestDb t;
    auto live    = AuthTokens::IssueRefresh(t.db, kUser, kTtl, kT0);
    auto warLive = AuthTokens::IssueWarReconnect(t.db, kUser, 7, kTtl, kT0);
    REQUIRE(live.has_value());
    REQUIRE(warLive.has_value());

    // Just expired, inside the grace window — still there.
    CHECK(AuthTokens::PruneExpired(t.db, kT0 + kTtl + 1, /*grace=*/86400) == 0);
    CHECK(AuthTokens::ValidateWarReconnect(t.db, *warLive, 7, kT0 + 10) == kUser);

    // Well past it — both rows go.
    CHECK(AuthTokens::PruneExpired(t.db, kT0 + kTtl + 86401, 86400) == 2);
    CHECK(AuthTokens::Rotate(t.db, live->token, kTtl, kT0).status ==
          AuthTokens::RefreshStatus::Unknown);
}

TEST_CASE("HashToken is stable, one-way-shaped and collision-free per input") {
    std::set<std::string> seen;
    for (const char* s : {"", "a", "b", "aa", "token-1", "token-2"}) {
        const std::string h = AuthTokens::HashToken(s);
        CHECK(h.size() == 64);
        CHECK(h == AuthTokens::HashToken(s));
        CHECK(seen.insert(h).second);
    }
}
