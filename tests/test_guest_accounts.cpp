#include <doctest/doctest.h>

#include <sqlite3.h>

#include <string>

#include "Server/AuthTokens.h"
#include "Server/GuestAccounts.h"

// PLAN-metalstorm-lobby.md §7.1, task 8c — provisional accounts and the
// upgrade decision, below the HTTP layer. test_guest_routes.cpp proves the
// wiring; these prove the rules, and each is a thing that can silently be
// wrong rather than a restatement of the code:
//
//  1. **A device token is the account.** It does not rotate (a lost race
//     between two tabs would delete a guest with no password to recover with)
//     and it is not stored in the clear (the db file would otherwise be three
//     months of impersonation for every guest in it).
//  2. **Abandonment is measured from last USE, not from creation.** A guest
//     who comes back every weekend has a token that is months old and has
//     never once been abandoned; a prune keyed on `created_at` deletes them.
//  3. **A guest who played is not abandoned.** The prune skips any account
//     holding a war binding — deleting one strands durable per-player state
//     inside a running world.
//  4. **A faction change at upgrade clears the seats, and keeping it does
//     not.** This is §1b inherited, and it is the one place "upgrade without
//     losing progress" is deliberately false. Both directions are pinned,
//     because the failure that matters is the flag getting stuck on either.
//  5. **A rename is refused while the account sits in a room.** Not a
//     database constraint — the roster identifies players by username, and the
//     rename produces no error anywhere, just a silently demoted player.

namespace {

struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        GuestAccounts::EnsureTables(db);
        // The prune reaches `users` and `sessions`; build the two columns of
        // each it actually touches rather than pulling in Database.
        sqlite3_exec(db,
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " username TEXT, is_provisional INTEGER NOT NULL DEFAULT 0)",
            nullptr, nullptr, nullptr);
        sqlite3_exec(db,
            "CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER)",
            nullptr, nullptr, nullptr);
    }
    ~TestDb() { sqlite3_close(db); }

    int64_t addUser(const char* name, bool provisional) {
        sqlite3_stmt* s = nullptr;
        sqlite3_prepare_v2(db,
            "INSERT INTO users (username, is_provisional) VALUES (?, ?)",
            -1, &s, nullptr);
        sqlite3_bind_text(s, 1, name, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(s, 2, provisional ? 1 : 0);
        sqlite3_step(s);
        sqlite3_finalize(s);
        return sqlite3_last_insert_rowid(db);
    }

    int userCount() {
        sqlite3_stmt* s = nullptr;
        sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM users", -1, &s, nullptr);
        int n = sqlite3_step(s) == SQLITE_ROW ? sqlite3_column_int(s, 0) : -1;
        sqlite3_finalize(s);
        return n;
    }

    bool userExists(int64_t id) {
        sqlite3_stmt* s = nullptr;
        sqlite3_prepare_v2(db, "SELECT 1 FROM users WHERE id=?", -1, &s, nullptr);
        sqlite3_bind_int64(s, 1, id);
        const bool found = sqlite3_step(s) == SQLITE_ROW;
        sqlite3_finalize(s);
        return found;
    }

    /// The war-binding table as WarPlayerBindings::EnsureTable would leave it,
    /// reduced to the one column the prune's NOT EXISTS reads.
    void createBindings() {
        sqlite3_exec(db,
            "CREATE TABLE war_player_bindings (room_id INTEGER, account_id INTEGER)",
            nullptr, nullptr, nullptr);
    }
    void addBinding(int64_t accountId) {
        sqlite3_stmt* s = nullptr;
        sqlite3_prepare_v2(db,
            "INSERT INTO war_player_bindings (room_id, account_id) VALUES (7, ?)",
            -1, &s, nullptr);
        sqlite3_bind_int64(s, 1, accountId);
        sqlite3_step(s);
        sqlite3_finalize(s);
    }
};

constexpr int64_t kT0  = 1'700'000'000;
constexpr int     kTtl = 3600;

/// Does `needle` appear anywhere in `guest_devices`? Proves the raw token is
/// not stored, in a way that survives somebody adding a debugging column.
bool AppearsInDevices(sqlite3* db, const std::string& needle) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, "SELECT * FROM guest_devices", -1, &stmt,
                           nullptr) != SQLITE_OK)
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

GuestAccounts::AccountState Guest(const char* faction = "union") {
    GuestAccounts::AccountState s;
    s.id            = 11;
    s.username      = "guest-deadbeef";
    s.isProvisional = true;
    if (faction != nullptr) s.factionId = faction;
    return s;
}

GuestAccounts::UpgradeRequest Req(const char* user, const char* pass,
                                  const char* faction) {
    GuestAccounts::UpgradeRequest r;
    r.username  = user ? user : "";
    r.password  = pass ? pass : "";
    r.factionId = faction ? faction : "";
    return r;
}

}  // namespace

TEST_CASE("guest device token round-trips and is not stored in the clear") {
    TestDb t;
    auto raw = GuestAccounts::IssueDevice(t.db, 42, kTtl, kT0);
    REQUIRE(raw.has_value());
    CHECK(raw->size() == 64);  // 32 bytes of CSPRNG, hex

    CHECK(GuestAccounts::ValidateDevice(t.db, *raw, kT0 + 1) == 42);
    // The digest is there, the raw value is not.
    CHECK(AppearsInDevices(t.db, AuthTokens::HashToken(*raw)));
    CHECK_FALSE(AppearsInDevices(t.db, *raw));
}

TEST_CASE("a device token does NOT rotate — the same value keeps working") {
    TestDb t;
    auto raw = GuestAccounts::IssueDevice(t.db, 42, kTtl, kT0);
    REQUIRE(raw.has_value());
    // Three presentations, no rotation, no reuse detection. A guest with two
    // tabs open must not lose the account to a race.
    CHECK(GuestAccounts::ValidateDevice(t.db, *raw, kT0 + 1) == 42);
    CHECK(GuestAccounts::ValidateDevice(t.db, *raw, kT0 + 2) == 42);
    CHECK(GuestAccounts::ValidateDevice(t.db, *raw, kT0 + 3) == 42);
}

TEST_CASE("a device token expires, and revocation is immediate") {
    TestDb t;
    auto raw = GuestAccounts::IssueDevice(t.db, 42, kTtl, kT0);
    REQUIRE(raw.has_value());
    CHECK(GuestAccounts::ValidateDevice(t.db, *raw, kT0 + kTtl + 1) == 0);
    // Still refused before expiry once revoked (the upgrade's spend).
    CHECK(GuestAccounts::RevokeDevicesForUser(t.db, 42, kT0) == 1);
    CHECK(GuestAccounts::ValidateDevice(t.db, *raw, kT0 + 1) == 0);
}

TEST_CASE("generated guest usernames are distinct and carry the reserved prefix") {
    const std::string a = GuestAccounts::GenerateUsername();
    const std::string b = GuestAccounts::GenerateUsername();
    CHECK(a.rfind("guest-", 0) == 0);
    CHECK(a.size() == 6 + 8);
    CHECK(a != b);
}

TEST_CASE("prune measures abandonment from last USE, not creation") {
    TestDb t;
    const int64_t returning = t.addUser("guest-a", /*provisional=*/true);
    const int64_t abandoned = t.addUser("guest-b", /*provisional=*/true);
    const int64_t full      = t.addUser("realplayer", /*provisional=*/false);

    // Both tokens were minted at the same ancient moment. The difference is
    // that one of them has been used since — which is the whole distinction
    // the prune exists to make, and the one a `created_at` cutoff loses.
    auto ra = GuestAccounts::IssueDevice(t.db, returning, kTtl * 10000, kT0);
    auto rb = GuestAccounts::IssueDevice(t.db, abandoned, kTtl * 10000, kT0);
    REQUIRE(ra.has_value());
    REQUIRE(rb.has_value());

    const int64_t now = kT0 + 60 * 86400;
    // The returning guest was here yesterday.
    REQUIRE(GuestAccounts::ValidateDevice(t.db, *ra, now - 86400) == returning);

    const int deleted = GuestAccounts::PruneAbandoned(t.db, now, 30 * 86400);
    CHECK(deleted == 1);
    CHECK(t.userExists(returning));
    CHECK_FALSE(t.userExists(abandoned));
    CHECK(t.userExists(full));  // never a candidate — not provisional
    CHECK(t.userCount() == 2);
}

TEST_CASE("prune spares a guest who holds a war binding") {
    TestDb t;
    t.createBindings();
    const int64_t played      = t.addUser("guest-played", true);
    const int64_t neverPlayed = t.addUser("guest-idle", true);
    REQUIRE(GuestAccounts::IssueDevice(t.db, played, kTtl, kT0).has_value());
    REQUIRE(GuestAccounts::IssueDevice(t.db, neverPlayed, kTtl, kT0).has_value());
    t.addBinding(played);

    const int deleted = GuestAccounts::PruneAbandoned(t.db, kT0 + 60 * 86400,
                                                      30 * 86400);
    CHECK(deleted == 1);
    CHECK(t.userExists(played));
    CHECK_FALSE(t.userExists(neverPlayed));
}

TEST_CASE("prune tolerates a lobby that has never launched a war") {
    // No `war_player_bindings` table at all — the shape of a fresh lobby,
    // where the guard has to be skipped rather than throwing the query away.
    TestDb t;
    const int64_t idle = t.addUser("guest-idle", true);
    REQUIRE(GuestAccounts::IssueDevice(t.db, idle, kTtl, kT0).has_value());
    CHECK(GuestAccounts::PruneAbandoned(t.db, kT0 + 60 * 86400, 30 * 86400) == 1);
    CHECK_FALSE(t.userExists(idle));
}

TEST_CASE("upgrade keeps the provisional faction and costs nothing") {
    const auto plan = GuestAccounts::DecideUpgrade(
        Req(nullptr, "hunter22hunter", nullptr), Guest("union"),
        /*factionIsKnown=*/false, /*nameIsTaken=*/false, /*nameIsInUse=*/false);
    CHECK(plan.status == GuestAccounts::UpgradeStatus::OK);
    CHECK(plan.factionId == "union");
    CHECK(plan.username == "guest-deadbeef");  // no rename asked for
    CHECK_FALSE(plan.renaming);
    CHECK_FALSE(plan.clearsBindings);
}

TEST_CASE("upgrade that CHANGES the faction clears the seats — §1b inherited") {
    const auto plan = GuestAccounts::DecideUpgrade(
        Req("Ravager", "hunter22hunter", "compact"), Guest("union"),
        /*factionIsKnown=*/true, false, false);
    CHECK(plan.status == GuestAccounts::UpgradeStatus::OK);
    CHECK(plan.factionId == "compact");
    CHECK(plan.username == "Ravager");
    CHECK(plan.renaming);
    CHECK(plan.clearsBindings);
}

TEST_CASE("re-stating the SAME faction is not a change") {
    // The near-miss: a UI that always sends the faction field would otherwise
    // clear every upgrading player's seats.
    const auto plan = GuestAccounts::DecideUpgrade(
        Req(nullptr, "hunter22hunter", "union"), Guest("union"),
        /*factionIsKnown=*/true, false, false);
    CHECK(plan.status == GuestAccounts::UpgradeStatus::OK);
    CHECK_FALSE(plan.clearsBindings);
}

TEST_CASE("a guest with no faction picks one at upgrade without paying for it") {
    // Nothing was held, so nothing is given up — `clearsBindings` must not
    // fire on nullopt → set.
    auto before = Guest(nullptr);
    REQUIRE_FALSE(before.factionId.has_value());
    const auto plan = GuestAccounts::DecideUpgrade(
        Req(nullptr, "hunter22hunter", "compact"), before,
        /*factionIsKnown=*/true, false, false);
    CHECK(plan.status == GuestAccounts::UpgradeStatus::OK);
    CHECK(plan.factionId == "compact");
    CHECK_FALSE(plan.clearsBindings);
}

TEST_CASE("an upgrade with no faction anywhere is refused") {
    const auto plan = GuestAccounts::DecideUpgrade(
        Req(nullptr, "hunter22hunter", nullptr), Guest(nullptr),
        false, false, false);
    CHECK(plan.status == GuestAccounts::UpgradeStatus::NoFaction);
}

TEST_CASE("upgrade refusals: not provisional, password, faction, username") {
    auto full = Guest("union");
    full.isProvisional = false;
    CHECK(GuestAccounts::DecideUpgrade(Req(nullptr, "hunter22hunter", nullptr),
                                       full, false, false, false).status
          == GuestAccounts::UpgradeStatus::NotProvisional);

    CHECK(GuestAccounts::DecideUpgrade(Req(nullptr, nullptr, nullptr), Guest(),
                                       false, false, false).status
          == GuestAccounts::UpgradeStatus::MissingPassword);

    CHECK(GuestAccounts::DecideUpgrade(Req(nullptr, "short7!", nullptr), Guest(),
                                       false, false, false).status
          == GuestAccounts::UpgradeStatus::WeakPassword);

    CHECK(GuestAccounts::DecideUpgrade(Req(nullptr, "hunter22hunter", "aliens"),
                                       Guest(), /*factionIsKnown=*/false,
                                       false, false).status
          == GuestAccounts::UpgradeStatus::UnknownFaction);

    CHECK(GuestAccounts::DecideUpgrade(Req("R", "hunter22hunter", nullptr),
                                       Guest(), false, false, false).status
          == GuestAccounts::UpgradeStatus::BadUsername);
    CHECK(GuestAccounts::DecideUpgrade(Req("has space", "hunter22hunter", nullptr),
                                       Guest(), false, false, false).status
          == GuestAccounts::UpgradeStatus::BadUsername);
    // The reserved shape: claiming a `guest-` name would let a full account
    // impersonate a guest, including one this lobby has not minted yet.
    CHECK(GuestAccounts::DecideUpgrade(Req("guest-c0ffee01", "hunter22hunter", nullptr),
                                       Guest(), false, false, false).status
          == GuestAccounts::UpgradeStatus::BadUsername);

    CHECK(GuestAccounts::DecideUpgrade(Req("Ravager", "hunter22hunter", nullptr),
                                       Guest(), false, /*nameIsTaken=*/true,
                                       false).status
          == GuestAccounts::UpgradeStatus::NameTaken);
}

TEST_CASE("a rename is refused while the account sits in a room, and nothing else is") {
    // In a room + renaming → refused outright, with no partial plan the caller
    // could act on.
    const auto blocked = GuestAccounts::DecideUpgrade(
        Req("Ravager", "hunter22hunter", nullptr), Guest(),
        false, /*nameIsTaken=*/false, /*nameIsInUse=*/true);
    CHECK(blocked.status == GuestAccounts::UpgradeStatus::NameInUse);
    CHECK(blocked.username.empty());  // a failed plan carries no instructions

    // In a room and NOT renaming → the upgrade goes through. This is the case
    // that matters for play: a guest halfway through a war can still claim
    // their account, they just keep the generated name for now.
    const auto allowed = GuestAccounts::DecideUpgrade(
        Req(nullptr, "hunter22hunter", nullptr), Guest(),
        false, false, /*nameIsInUse=*/true);
    CHECK(allowed.status == GuestAccounts::UpgradeStatus::OK);
    CHECK_FALSE(allowed.renaming);

    // Renaming to the name already held is not a rename, so the room does not
    // block it — the near-miss where a UI echoes the current name back.
    auto self = GuestAccounts::DecideUpgrade(
        Req("guest-deadbeef", "hunter22hunter", nullptr), Guest(),
        false, false, /*nameIsInUse=*/true);
    CHECK(self.status == GuestAccounts::UpgradeStatus::OK);
    CHECK_FALSE(self.renaming);
}
