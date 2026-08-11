#include "Server/AuthTokens.h"

#include "Server/Crypto.h"

#include <openssl/evp.h>
#include <sqlite3.h>

#include <array>
#include <cstdint>
#include <functional>

namespace {

constexpr char kHexDigits[] = "0123456789abcdef";

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

/// Run one statement that takes no results. Returns true on SQLITE_DONE.
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

namespace AuthTokens {

std::string HashToken(const std::string& raw) {
    std::array<uint8_t, EVP_MAX_MD_SIZE> md{};
    unsigned int len = 0;
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    if (!ctx) return "";
    // EVP_DigestUpdate over an empty string is fine here (unlike a null
    // pointer), so an empty token hashes to the real sha256 of "" rather than
    // to an accident — and then simply matches no row.
    const bool ok = EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) == 1 &&
                    EVP_DigestUpdate(ctx, raw.data(), raw.size()) == 1 &&
                    EVP_DigestFinal_ex(ctx, md.data(), &len) == 1;
    EVP_MD_CTX_free(ctx);
    if (!ok) return "";
    std::string out;
    out.reserve(len * 2);
    for (unsigned int i = 0; i < len; ++i) {
        out += kHexDigits[md[i] >> 4];
        out += kHexDigits[md[i] & 0x0F];
    }
    return out;
}

void EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS refresh_tokens ("
        "  token_hash TEXT PRIMARY KEY,"
        "  user_id INTEGER NOT NULL,"
        "  family_id TEXT NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  expires_at INTEGER NOT NULL DEFAULT 0,"
        "  used_at INTEGER NOT NULL DEFAULT 0,"
        "  revoked_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    // Both non-primary reads are by family (revocation) and by user
    // (log-out-everywhere); neither is served by a hash-leading primary key.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_refresh_family "
        "ON refresh_tokens(family_id)", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_refresh_user "
        "ON refresh_tokens(user_id)", nullptr, nullptr, nullptr);

    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS war_reconnect_tokens ("
        "  token_hash TEXT PRIMARY KEY,"
        "  account_id INTEGER NOT NULL,"
        "  room_id INTEGER NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  expires_at INTEGER NOT NULL DEFAULT 0,"
        "  revoked_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_war_reconnect_account "
        "ON war_reconnect_tokens(account_id)", nullptr, nullptr, nullptr);
}

// ── Refresh tokens ─────────────────────────────────────────────────────────

namespace {

/// Insert one refresh row. `familyId` empty means "start a new lineage".
std::optional<RefreshIssue> InsertRefresh(sqlite3* db, int64_t userId,
                                          const std::string& familyId,
                                          int ttlSeconds, int64_t now) {
    if (!db || userId <= 0) return std::nullopt;
    RefreshIssue issue;
    issue.token    = Crypto::GenerateToken(32);
    issue.familyId = familyId.empty() ? Crypto::GenerateToken(16) : familyId;
    if (issue.token.empty() || issue.familyId.empty()) return std::nullopt;

    static const char* kSql =
        "INSERT INTO refresh_tokens "
        "  (token_hash, user_id, family_id, created_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?)";
    const std::string hash = HashToken(issue.token);
    const bool ok = Exec(db, kSql, [&](sqlite3_stmt* s) {
        BindText(s, 1, hash);
        sqlite3_bind_int64(s, 2, userId);
        BindText(s, 3, issue.familyId);
        sqlite3_bind_int64(s, 4, now);
        sqlite3_bind_int64(s, 5, now + ttlSeconds);
    });
    if (!ok) return std::nullopt;
    return issue;
}

}  // namespace

std::optional<RefreshIssue> IssueRefresh(sqlite3* db, int64_t userId,
                                         int ttlSeconds, int64_t now) {
    return InsertRefresh(db, userId, /*familyId=*/"", ttlSeconds, now);
}

int RevokeFamily(sqlite3* db, const std::string& familyId, int64_t now) {
    if (!db || familyId.empty()) return 0;
    Exec(db,
         "UPDATE refresh_tokens SET revoked_at=? "
         "WHERE family_id=? AND revoked_at=0",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, now);
             BindText(s, 2, familyId);
         });
    return sqlite3_changes(db);
}

RefreshOutcome Rotate(sqlite3* db, const std::string& presented,
                      int ttlSeconds, int64_t now) {
    RefreshOutcome out;
    if (!db || presented.empty()) return out;

    const std::string hash = HashToken(presented);
    sqlite3_stmt* stmt = nullptr;
    static const char* kSel =
        "SELECT user_id, family_id, expires_at, used_at, revoked_at "
        "FROM refresh_tokens WHERE token_hash=?";
    if (sqlite3_prepare_v2(db, kSel, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    BindText(stmt, 1, hash);
    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        out.status = RefreshStatus::Unknown;
        return out;
    }
    const int64_t userId = sqlite3_column_int64(stmt, 0);
    std::string   familyId;
    if (const unsigned char* f = sqlite3_column_text(stmt, 1))
        familyId = reinterpret_cast<const char*>(f);
    const int64_t     expiresAt = sqlite3_column_int64(stmt, 2);
    const int64_t     usedAt    = sqlite3_column_int64(stmt, 3);
    const int64_t     revokedAt = sqlite3_column_int64(stmt, 4);
    sqlite3_finalize(stmt);

    out.userId = userId;

    // Reuse is checked BEFORE revocation and expiry on purpose: a replayed
    // token that has also aged out is still a replay, and the family still has
    // to die. Reporting it as merely Expired would let a thief probe the
    // lineage for free.
    if (usedAt != 0) {
        RevokeFamily(db, familyId, now);
        out.status = RefreshStatus::Reused;
        return out;
    }
    if (revokedAt != 0) { out.status = RefreshStatus::Revoked; return out; }
    if (expiresAt <= now) { out.status = RefreshStatus::Expired; return out; }

    // Mark used, then mint the successor in the same family. The order matters
    // under a crash: a used row with no successor costs the player one
    // re-login, whereas a successor with an unused predecessor leaves two live
    // tokens and defeats rotation entirely.
    Exec(db, "UPDATE refresh_tokens SET used_at=? WHERE token_hash=?",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, now);
             BindText(s, 2, hash);
         });

    auto next = InsertRefresh(db, userId, familyId, ttlSeconds, now);
    if (!next) return out;  // Unknown — the caller re-authenticates
    out.next   = *next;
    out.status = RefreshStatus::OK;
    return out;
}

int RevokeFamilyOfToken(sqlite3* db, const std::string& presented, int64_t now) {
    if (!db || presented.empty()) return 0;
    const std::string hash = HashToken(presented);
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT family_id FROM refresh_tokens WHERE token_hash=?",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    BindText(stmt, 1, hash);
    std::string familyId;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        if (const unsigned char* f = sqlite3_column_text(stmt, 0))
            familyId = reinterpret_cast<const char*>(f);
    }
    sqlite3_finalize(stmt);
    if (familyId.empty()) return 0;
    return RevokeFamily(db, familyId, now);
}

int RevokeAllRefreshForUser(sqlite3* db, int64_t userId, int64_t now) {
    if (!db || userId <= 0) return 0;
    Exec(db,
         "UPDATE refresh_tokens SET revoked_at=? "
         "WHERE user_id=? AND revoked_at=0",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, now);
             sqlite3_bind_int64(s, 2, userId);
         });
    return sqlite3_changes(db);
}

// ── Per-war reconnect tokens ───────────────────────────────────────────────

std::optional<std::string> IssueWarReconnect(sqlite3* db, int64_t accountId,
                                             uint32_t roomId, int ttlSeconds,
                                             int64_t now) {
    if (!db || accountId <= 0) return std::nullopt;
    const std::string token = Crypto::GenerateToken(32);
    if (token.empty()) return std::nullopt;
    const std::string hash = HashToken(token);
    const bool ok = Exec(db,
        "INSERT INTO war_reconnect_tokens "
        "  (token_hash, account_id, room_id, created_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?)",
        [&](sqlite3_stmt* s) {
            BindText(s, 1, hash);
            sqlite3_bind_int64(s, 2, accountId);
            sqlite3_bind_int64(s, 3, static_cast<int64_t>(roomId));
            sqlite3_bind_int64(s, 4, now);
            sqlite3_bind_int64(s, 5, now + ttlSeconds);
        });
    if (!ok) return std::nullopt;
    return token;
}

int64_t ValidateWarReconnect(sqlite3* db, const std::string& presented,
                             uint32_t roomId, int64_t now) {
    if (!db || presented.empty()) return 0;
    const std::string hash = HashToken(presented);
    sqlite3_stmt* stmt = nullptr;
    // The room match is in the WHERE clause rather than a post-check so that
    // "wrong war" and "no such token" are the same non-answer — there is
    // nothing to learn by presenting a stolen token against every open war.
    static const char* kSel =
        "SELECT account_id FROM war_reconnect_tokens "
        "WHERE token_hash=? AND room_id=? AND revoked_at=0 AND expires_at>?";
    if (sqlite3_prepare_v2(db, kSel, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    BindText(stmt, 1, hash);
    sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 3, now);
    int64_t accountId = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        accountId = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return accountId;
}

int RevokeWarReconnectForAccount(sqlite3* db, int64_t accountId, int64_t now) {
    if (!db || accountId <= 0) return 0;
    Exec(db,
         "UPDATE war_reconnect_tokens SET revoked_at=? "
         "WHERE account_id=? AND revoked_at=0",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, now);
             sqlite3_bind_int64(s, 2, accountId);
         });
    return sqlite3_changes(db);
}

int DeleteWarReconnectForRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    Exec(db, "DELETE FROM war_reconnect_tokens WHERE room_id=?",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, static_cast<int64_t>(roomId));
         });
    return sqlite3_changes(db);
}

int PruneExpired(sqlite3* db, int64_t now, int graceSeconds) {
    if (!db) return 0;
    const int64_t cutoff = now - graceSeconds;
    int deleted = 0;
    Exec(db, "DELETE FROM refresh_tokens WHERE expires_at<=?",
         [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, cutoff); });
    deleted += sqlite3_changes(db);
    Exec(db, "DELETE FROM war_reconnect_tokens WHERE expires_at<=?",
         [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, cutoff); });
    deleted += sqlite3_changes(db);
    return deleted;
}

}  // namespace AuthTokens
