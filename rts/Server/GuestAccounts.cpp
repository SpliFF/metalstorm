#include "Server/GuestAccounts.h"

#include "Server/AuthTokens.h"
#include "Server/Crypto.h"

#include <sqlite3.h>

#include <cctype>
#include <functional>

namespace {

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

bool Exec(sqlite3* db, const char* sql,
          const std::function<void(sqlite3_stmt*)>& bind) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    bind(stmt);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

}  // namespace

namespace GuestAccounts {

void EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS guest_devices ("
        "  token_hash TEXT PRIMARY KEY,"
        "  user_id INTEGER NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  expires_at INTEGER NOT NULL DEFAULT 0,"
        "  last_used_at INTEGER NOT NULL DEFAULT 0,"
        "  revoked_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    // Every non-primary access is by account: the upgrade revokes an account's
    // tokens, and the prune deletes them alongside the account.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_guest_devices_user "
        "ON guest_devices(user_id)", nullptr, nullptr, nullptr);
}

std::string GenerateUsername() {
    // 4 bytes of the same CSPRNG the tokens use, hex-encoded by
    // GenerateToken's own encoder — not rand(), which on a lobby that mints
    // guests from several connections would happily repeat itself.
    return "guest-" + Crypto::GenerateToken(4);
}

std::optional<std::string> IssueDevice(sqlite3* db, int64_t userId,
                                       int ttlSeconds, int64_t now) {
    if (!db || userId <= 0) return std::nullopt;
    const std::string raw = Crypto::GenerateToken(32);
    if (raw.empty()) return std::nullopt;
    const std::string hash = AuthTokens::HashToken(raw);
    if (hash.empty()) return std::nullopt;
    const bool ok = Exec(db,
        "INSERT INTO guest_devices "
        "(token_hash, user_id, created_at, expires_at, last_used_at, revoked_at) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        [&](sqlite3_stmt* s) {
            BindText(s, 1, hash);
            sqlite3_bind_int64(s, 2, userId);
            sqlite3_bind_int64(s, 3, now);
            sqlite3_bind_int64(s, 4, now + ttlSeconds);
            sqlite3_bind_int64(s, 5, now);
        });
    if (!ok) return std::nullopt;
    return raw;
}

int64_t ValidateDevice(sqlite3* db, const std::string& presented, int64_t now) {
    if (!db || presented.empty()) return 0;
    const std::string hash = AuthTokens::HashToken(presented);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT user_id, expires_at, revoked_at FROM guest_devices "
            "WHERE token_hash=?", -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    BindText(stmt, 1, hash);
    int64_t userId = 0, expiresAt = 0, revokedAt = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        userId    = sqlite3_column_int64(stmt, 0);
        expiresAt = sqlite3_column_int64(stmt, 1);
        revokedAt = sqlite3_column_int64(stmt, 2);
    }
    sqlite3_finalize(stmt);
    if (userId <= 0 || revokedAt != 0 || expiresAt <= now) return 0;

    // Touch. This is what makes PruneAbandoned measure abandonment rather than
    // age: a guest who plays every weekend for a year has a device token that
    // is eleven months old and has never once been unused.
    Exec(db, "UPDATE guest_devices SET last_used_at=? WHERE token_hash=?",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, now);
             BindText(s, 2, hash);
         });
    return userId;
}

int RevokeDevicesForUser(sqlite3* db, int64_t userId, int64_t now) {
    if (!db || userId <= 0) return 0;
    Exec(db,
         "UPDATE guest_devices SET revoked_at=? WHERE user_id=? AND revoked_at=0",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, now);
             sqlite3_bind_int64(s, 2, userId);
         });
    return sqlite3_changes(db);
}

int PruneAbandoned(sqlite3* db, int64_t now, int maxAgeSeconds) {
    if (!db) return 0;
    const int64_t cutoff = now - maxAgeSeconds;

    // One subquery names the victims and three statements act on it, in
    // dependency order (tokens, then sessions, then the account). Written
    // against `users` rather than against a collected id list because the set
    // must be identical in all three — a list gathered once and re-used after
    // a concurrent upgrade would delete an account that stopped qualifying
    // between the read and the write.
    //
    // The `war_player_bindings` exclusion is a NOT EXISTS rather than a join:
    // the table is created by WarPlayerBindings::EnsureTable, which the game
    // server calls and a lobby that has never launched a war has not — so the
    // guard has to tolerate the table being absent, which it does by being
    // skipped entirely when it is.
    bool haveBindings = false;
    {
        sqlite3_stmt* probe = nullptr;
        haveBindings = sqlite3_prepare_v2(
            db, "SELECT 1 FROM war_player_bindings LIMIT 1", -1, &probe,
            nullptr) == SQLITE_OK;
        sqlite3_finalize(probe);
    }

    std::string victims =
        "SELECT u.id FROM users u "
        "WHERE u.is_provisional=1 "
        "  AND u.id NOT IN (SELECT user_id FROM guest_devices "
        "                   WHERE last_used_at > ?)";
    if (haveBindings) {
        victims += " AND NOT EXISTS (SELECT 1 FROM war_player_bindings b "
                   "                 WHERE b.account_id = u.id)";
    }

    const std::string delDevices =
        "DELETE FROM guest_devices WHERE user_id IN (" + victims + ")";
    const std::string delSessions =
        "DELETE FROM sessions WHERE user_id IN (" + victims + ")";
    const std::string delUsers =
        "DELETE FROM users WHERE id IN (" + victims + ")";

    auto bindCutoff = [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, cutoff); };
    Exec(db, delDevices.c_str(), bindCutoff);
    Exec(db, delSessions.c_str(), bindCutoff);
    Exec(db, delUsers.c_str(), bindCutoff);
    return sqlite3_changes(db);
}

// ── The upgrade decision ───────────────────────────────────────────────────

UpgradePlan DecideUpgrade(const UpgradeRequest& req, const AccountState& before,
                          bool factionIsKnown,
                          bool nameIsTaken, bool nameIsInUse) {
    UpgradePlan plan;
    plan.username  = before.username;
    plan.factionId = before.factionId.value_or("");

    auto fail = [&](UpgradeStatus s) {
        UpgradePlan f;
        f.status = s;
        return f;
    };

    // Upgrading a full account is not a no-op, it is a password reset with no
    // proof of the old password — so it is refused rather than tolerated.
    if (!before.isProvisional) return fail(UpgradeStatus::NotProvisional);

    if (req.password.empty()) return fail(UpgradeStatus::MissingPassword);
    if (req.password.size() < kMinPasswordLength)
        return fail(UpgradeStatus::WeakPassword);

    // The rename, checked before anything else that could succeed. Both
    // failures abort the whole upgrade (see the header): a caller that wanted
    // the name badly enough to send it should not have the password silently
    // installed under the guest name instead.
    if (!req.username.empty() && req.username != before.username) {
        if (req.username.size() < 2 || req.username.size() > 32)
            return fail(UpgradeStatus::BadUsername);
        // A generated guest name is a reserved shape, not a name anyone can
        // claim: allowing it would let an account impersonate a guest that
        // does not exist yet, and — worse — collide with one this lobby is
        // about to mint.
        if (req.username.rfind("guest-", 0) == 0)
            return fail(UpgradeStatus::BadUsername);
        for (unsigned char c : req.username) {
            if (!std::isalnum(c) && c != '_' && c != '-')
                return fail(UpgradeStatus::BadUsername);
        }
        if (nameIsTaken) return fail(UpgradeStatus::NameTaken);
        if (nameIsInUse) return fail(UpgradeStatus::NameInUse);
        plan.username = req.username;
        plan.renaming = true;
    }

    // Faction. Supplied wins over the provisional one; if neither exists the
    // upgrade cannot complete, because a full account with no faction can
    // never take a side (§2.3) and would be a worse account than the guest it
    // replaced.
    if (!req.factionId.empty()) {
        if (!factionIsKnown) return fail(UpgradeStatus::UnknownFaction);
        plan.factionId = req.factionId;
    }
    if (plan.factionId.empty()) return fail(UpgradeStatus::NoFaction);

    // §1b: moving off a side gives up the seats held on it. Note this is
    // computed against `before`, so keeping the provisional faction — the
    // overwhelmingly common case, and the one the UI defaults to — costs
    // nothing at all.
    plan.clearsBindings =
        before.factionId.has_value() && !before.factionId->empty() &&
        *before.factionId != plan.factionId;

    plan.status = UpgradeStatus::OK;
    return plan;
}

}  // namespace GuestAccounts
