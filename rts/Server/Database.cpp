/**
 * Database — SQLite storage for accounts and sessions.
 */

#include "Database.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "db"

#include <sqlite3.h>
#include <cstdio>


Database::Database() {}

Database::~Database() {
    Close();
}

bool Database::Open(const std::string& path) {
    if (db)
        Close();

    int rc = sqlite3_open(path.c_str(), &db);
    if (rc != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "failed to open %s: %s",
            path.c_str(), sqlite3_errmsg(db));
        sqlite3_close(db);
        db = nullptr;
        return false;
    }

    // Enable WAL mode for concurrent reads
    sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nullptr, nullptr, nullptr);

    // WAL allows concurrent readers but only ONE writer at a time, and the
    // lobby now opens a second connection to this file for periodic
    // maintenance (PLAN-long-uptime S9). Without a busy timeout the loser of
    // a write race gets SQLITE_BUSY back immediately, which every call site
    // here reports as an ordinary failure — a silently dropped write. Wait
    // instead.
    sqlite3_busy_timeout(db, 5000);

    CreateTables();
    SLOG(SPRING_LOG_INFO, "opened %s", path.c_str());
    return true;
}

void Database::Close() {
    if (db) {
        sqlite3_close(db);
        db = nullptr;
    }
}

void Database::CreateTables() {
    const char* sql = R"(
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'player',
            is_banned INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS admin_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            username TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            args_digest TEXT NOT NULL DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- PLAN-client-resilience.md task 3: client-side crash/fatal reports.
        -- Retention (30-day purge) and the grouped-by-stack-hash dashboard
        -- view are task 4 — this table is the ingestion side only.
        CREATE TABLE IF NOT EXISTS client_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            reason TEXT NOT NULL DEFAULT '',
            error_class TEXT NOT NULL DEFAULT '',
            message TEXT NOT NULL DEFAULT '',
            stack TEXT NOT NULL DEFAULT '',
            stack_hash TEXT NOT NULL DEFAULT '',
            recovery_rung TEXT NOT NULL DEFAULT '',
            phase TEXT NOT NULL DEFAULT '',
            frame INTEGER NOT NULL DEFAULT 0,
            entity_count INTEGER NOT NULL DEFAULT 0,
            game_id TEXT NOT NULL DEFAULT '',
            map_id TEXT NOT NULL DEFAULT '',
            build_stamp TEXT NOT NULL DEFAULT '',
            gpu_renderer TEXT NOT NULL DEFAULT '',
            log_ring TEXT NOT NULL DEFAULT '',
            count INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_client_errors_stack_hash ON client_errors(stack_hash);
        CREATE INDEX IF NOT EXISTS idx_client_errors_created_at ON client_errors(created_at);

        -- PLAN-metalstorm-scripting.md task 6: saved command-composer
        -- presets. `intent_json` is opaque to the server — a filled
        -- CommandIntent, not logic.
        CREATE TABLE IF NOT EXISTS command_presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            intent_json TEXT NOT NULL DEFAULT '',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, name)
        );
        CREATE INDEX IF NOT EXISTS idx_command_presets_user ON command_presets(user_id);
    )";

    char* errMsg = nullptr;
    int rc = sqlite3_exec(db, sql, nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "error creating tables: %s", errMsg);
        sqlite3_free(errMsg);
    }

    // Non-destructive migration: `users` holds durable accounts (unlike
    // `rooms`, which the lobby is free to drop+recreate on a schema bump),
    // so a stale schema gets an ALTER TABLE instead of DROP+CREATE. Probe
    // for the newest-added column first — ALTER TABLE ADD COLUMN fails if
    // it's already there.
    {
        sqlite3_stmt* stmt = nullptr;
        int probeRc = sqlite3_prepare_v2(db, "SELECT is_dev FROM users LIMIT 1", -1, &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (probeRc != SQLITE_OK) {
            sqlite3_exec(db, "ALTER TABLE users ADD COLUMN is_dev INTEGER NOT NULL DEFAULT 0",
                nullptr, nullptr, nullptr);
        }
    }
}

int64_t Database::CreateUser(const std::string& username, const std::string& passwordHash,
                             const std::string& role, bool isDev)
{
    const char* sql = "INSERT INTO users (username, password_hash, role, is_dev) VALUES (?, ?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, passwordHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, role.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 4, isDev ? 1 : 0);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE)
        return 0;

    return sqlite3_last_insert_rowid(db);
}

std::optional<UserRecord> Database::FindUser(const std::string& username) {
    const char* sql = "SELECT id, username, password_hash, role, is_banned, is_dev FROM users WHERE username = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;

    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);

    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }

    UserRecord user;
    user.id = sqlite3_column_int64(stmt, 0);
    user.username = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    user.passwordHash = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    user.role = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
    user.isBanned = sqlite3_column_int(stmt, 4) != 0;
    user.isDev = sqlite3_column_int(stmt, 5) != 0;

    sqlite3_finalize(stmt);
    return user;
}

std::optional<UserRecord> Database::FindUserById(int64_t userId) {
    const char* sql = "SELECT id, username, password_hash, role, is_banned, is_dev FROM users WHERE id = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return std::nullopt;

    sqlite3_bind_int64(stmt, 1, userId);

    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }

    UserRecord user;
    user.id = sqlite3_column_int64(stmt, 0);
    user.username = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    user.passwordHash = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    user.role = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
    user.isBanned = sqlite3_column_int(stmt, 4) != 0;
    user.isDev = sqlite3_column_int(stmt, 5) != 0;

    sqlite3_finalize(stmt);
    return user;
}

bool Database::UpdatePasswordHash(int64_t userId, const std::string& passwordHash) {
    const char* sql = "UPDATE users SET password_hash = ? WHERE id = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;

    sqlite3_bind_text(stmt, 1, passwordHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, userId);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return rc == SQLITE_DONE;
}

bool Database::CreateSession(int64_t userId, const std::string& token) {
    const char* sql = "INSERT INTO sessions (token, user_id) VALUES (?, ?)";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;

    sqlite3_bind_text(stmt, 1, token.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, userId);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return rc == SQLITE_DONE;
}

int64_t Database::ValidateSession(const std::string& token, int maxAgeSeconds) {
    // Check token exists and hasn't expired
    const char* sql =
        "SELECT user_id FROM sessions WHERE token = ? "
        "AND created_at > datetime('now', '-' || ? || ' seconds')";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        // Distinct from "no matching row": this is a DB-level fault. Log it
        // (callers still treat the 0 return as unauthenticated).
        SLOG(SPRING_LOG_ERROR, "ValidateSession: prepare failed: %s",
             sqlite3_errmsg(db));
        return 0;
    }

    sqlite3_bind_text(stmt, 1, token.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, maxAgeSeconds);

    int64_t userId = 0;
    const int rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
        userId = sqlite3_column_int64(stmt, 0);
    } else if (rc != SQLITE_DONE) {
        // SQLITE_DONE == valid "no such session" (returns 0). Anything else is
        // a real error worth surfacing, not silent unauthentication.
        SLOG(SPRING_LOG_ERROR, "ValidateSession: step failed (%d): %s",
             rc, sqlite3_errmsg(db));
    }

    sqlite3_finalize(stmt);
    return userId;
}

bool Database::EnsureAdminRole(const std::string& username) {
    const char* sql = "UPDATE users SET role = 'admin' WHERE username = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;

    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return rc == SQLITE_DONE && sqlite3_changes(db) > 0;
}

bool Database::SetBanned(int64_t userId, bool banned) {
    const char* sql = "UPDATE users SET is_banned = ? WHERE id = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;

    sqlite3_bind_int(stmt, 1, banned ? 1 : 0);
    sqlite3_bind_int64(stmt, 2, userId);
    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return rc == SQLITE_DONE && sqlite3_changes(db) > 0;
}

bool Database::SetBannedByUsername(const std::string& username, bool banned, int64_t& userId) {
    userId = 0;
    // Resolve the id first so the caller can revoke sessions + audit even
    // though the UPDATE is keyed on username.
    auto user = FindUser(username);
    if (!user)
        return false;
    userId = user->id;
    return SetBanned(user->id, banned);
}

int Database::RevokeUserSessions(int64_t userId) {
    const char* sql = "DELETE FROM sessions WHERE user_id = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return sqlite3_changes(db);
}

std::vector<UserRecord> Database::GetBannedUsers(int limit) {
    std::vector<UserRecord> out;
    const char* sql =
        "SELECT id, username, password_hash, role, is_banned, is_dev "
        "FROM users WHERE is_banned = 1 ORDER BY id DESC LIMIT ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return out;

    sqlite3_bind_int(stmt, 1, limit);

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        UserRecord u;
        u.id = sqlite3_column_int64(stmt, 0);
        u.username = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        u.passwordHash = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        u.role = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
        u.isBanned = sqlite3_column_int(stmt, 4) != 0;
        u.isDev = sqlite3_column_int(stmt, 5) != 0;
        out.push_back(std::move(u));
    }

    sqlite3_finalize(stmt);
    return out;
}

void Database::RevokeSession(const std::string& token) {
    const char* sql = "DELETE FROM sessions WHERE token = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return;

    sqlite3_bind_text(stmt, 1, token.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
}

void Database::LogAudit(int64_t userId, const std::string& username, const std::string& action,
                        const std::string& target, const std::string& argsDigest)
{
    const char* sql =
        "INSERT INTO admin_audit (user_id, username, action, target, args_digest) "
        "VALUES (?, ?, ?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "LogAudit: prepare failed: %s", sqlite3_errmsg(db));
        return;
    }

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_bind_text(stmt, 2, username.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, action.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, target.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, argsDigest.c_str(), -1, SQLITE_TRANSIENT);

    if (sqlite3_step(stmt) != SQLITE_DONE)
        SLOG(SPRING_LOG_ERROR, "LogAudit: insert failed: %s", sqlite3_errmsg(db));

    sqlite3_finalize(stmt);
}

std::vector<Database::AuditEntry> Database::GetRecentAuditEntries(int limit) {
    std::vector<AuditEntry> out;
    const char* sql =
        "SELECT id, user_id, username, action, target, args_digest, created_at "
        "FROM admin_audit ORDER BY id DESC LIMIT ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return out;

    sqlite3_bind_int(stmt, 1, limit);

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        AuditEntry e;
        e.id = sqlite3_column_int64(stmt, 0);
        e.userId = sqlite3_column_int64(stmt, 1);
        e.username = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
        e.action = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3));
        e.target = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 4));
        e.argsDigest = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 5));
        const unsigned char* ts = sqlite3_column_text(stmt, 6);
        e.createdAt = ts ? reinterpret_cast<const char*>(ts) : "";
        out.push_back(std::move(e));
    }

    sqlite3_finalize(stmt);
    return out;
}

int64_t Database::InsertClientError(const ClientErrorRecord& rec) {
    const char* sql =
        "INSERT INTO client_errors (user_id, reason, error_class, message, stack, stack_hash, "
        "recovery_rung, phase, frame, entity_count, game_id, map_id, build_stamp, gpu_renderer, "
        "log_ring, count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "InsertClientError: prepare failed: %s", sqlite3_errmsg(db));
        return 0;
    }

    sqlite3_bind_int64(stmt, 1, rec.userId);
    sqlite3_bind_text(stmt, 2, rec.reason.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, rec.errorClass.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, rec.message.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, rec.stack.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, rec.stackHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, rec.recoveryRung.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, rec.phase.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 9, rec.frame);
    sqlite3_bind_int(stmt, 10, rec.entityCount);
    sqlite3_bind_text(stmt, 11, rec.gameId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 12, rec.mapId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 13, rec.buildStamp.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 14, rec.gpuRenderer.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 15, rec.logRing.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 16, rec.count);

    int64_t id = 0;
    if (sqlite3_step(stmt) != SQLITE_DONE)
        SLOG(SPRING_LOG_ERROR, "InsertClientError: insert failed: %s", sqlite3_errmsg(db));
    else
        id = sqlite3_last_insert_rowid(db);

    sqlite3_finalize(stmt);
    return id;
}

int Database::CountRecentClientErrors(int64_t userId, int windowSeconds) {
    const char* sql =
        "SELECT COUNT(*) FROM client_errors WHERE user_id = ? "
        "AND created_at > datetime('now', '-' || ? || ' seconds')";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_bind_int(stmt, 2, windowSeconds);

    int count = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        count = sqlite3_column_int(stmt, 0);

    sqlite3_finalize(stmt);
    return count;
}

bool Database::SaveCommandPreset(int64_t userId, const std::string& name, const std::string& intentJson) {
    // Upsert on (user_id, name) — re-saving a preset under the same name
    // overwrites the filled template rather than accumulating duplicates.
    const char* sql =
        "INSERT INTO command_presets (user_id, name, intent_json, updated_at) "
        "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(user_id, name) DO UPDATE SET "
        "intent_json = excluded.intent_json, updated_at = CURRENT_TIMESTAMP";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "SaveCommandPreset: prepare failed: %s", sqlite3_errmsg(db));
        return false;
    }

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_bind_text(stmt, 2, name.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, intentJson.c_str(), -1, SQLITE_TRANSIENT);

    bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    if (!ok)
        SLOG(SPRING_LOG_ERROR, "SaveCommandPreset: upsert failed: %s", sqlite3_errmsg(db));

    sqlite3_finalize(stmt);
    return ok;
}

std::vector<Database::CommandPresetRecord> Database::GetCommandPresets(int64_t userId, int limit) {
    std::vector<CommandPresetRecord> out;
    const char* sql =
        "SELECT name, intent_json, updated_at FROM command_presets "
        "WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return out;

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_bind_int(stmt, 2, limit);

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        CommandPresetRecord rec;
        const unsigned char* name = sqlite3_column_text(stmt, 0);
        const unsigned char* intentJson = sqlite3_column_text(stmt, 1);
        const unsigned char* updatedAt = sqlite3_column_text(stmt, 2);
        rec.name = name ? reinterpret_cast<const char*>(name) : "";
        rec.intentJson = intentJson ? reinterpret_cast<const char*>(intentJson) : "";
        rec.updatedAt = updatedAt ? reinterpret_cast<const char*>(updatedAt) : "";
        out.push_back(std::move(rec));
    }

    sqlite3_finalize(stmt);
    return out;
}

bool Database::DeleteCommandPreset(int64_t userId, const std::string& name) {
    const char* sql = "DELETE FROM command_presets WHERE user_id = ? AND name = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_bind_text(stmt, 2, name.c_str(), -1, SQLITE_TRANSIENT);

    sqlite3_step(stmt);
    bool deleted = sqlite3_changes(db) > 0;
    sqlite3_finalize(stmt);
    return deleted;
}

int Database::CountCommandPresets(int64_t userId) {
    const char* sql = "SELECT COUNT(*) FROM command_presets WHERE user_id = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_int64(stmt, 1, userId);

    int count = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        count = sqlite3_column_int(stmt, 0);

    sqlite3_finalize(stmt);
    return count;
}

bool Database::CommandPresetExists(int64_t userId, const std::string& name) {
    const char* sql = "SELECT 1 FROM command_presets WHERE user_id = ? AND name = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return false;

    sqlite3_bind_int64(stmt, 1, userId);
    sqlite3_bind_text(stmt, 2, name.c_str(), -1, SQLITE_TRANSIENT);

    bool exists = sqlite3_step(stmt) == SQLITE_ROW;
    sqlite3_finalize(stmt);
    return exists;
}

std::vector<std::pair<int, std::string>> Database::LatestGameExtraJson() {
    std::vector<std::pair<int, std::string>> out;
    // Joined to game_servers, not just to the newest metric row: game_metrics
    // rows outlive the game that wrote them, so scanning them alone would keep
    // re-reading every finished game's last row forever — the caller's
    // per-room state would then never shrink, which is a poor outcome for the
    // plan whose subject is containers that only grow.
    const char* sql =
        "SELECT m.room_id, m.extra_json FROM game_metrics m "
        "JOIN (SELECT room_id, MAX(id) AS mid FROM game_metrics GROUP BY room_id) lm "
        "  ON m.id = lm.mid "
        "JOIN game_servers gs ON gs.room_id = m.room_id "
        "WHERE m.extra_json <> ''";
    sqlite3_stmt* stmt = nullptr;
    // A lobby that has never hosted a game has no game_metrics table at all;
    // prepare fails and that is the empty answer, not a failure to report.
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return out;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const auto* t = sqlite3_column_text(stmt, 1);
        out.emplace_back(sqlite3_column_int(stmt, 0),
                         t ? reinterpret_cast<const char*>(t) : "");
    }
    sqlite3_finalize(stmt);
    return out;
}

int Database::CleanExpiredSessions(int maxAgeSeconds) {
    const char* sql =
        "DELETE FROM sessions WHERE created_at <= datetime('now', '-' || ? || ' seconds')";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_int(stmt, 1, maxAgeSeconds);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return sqlite3_changes(db);
}

/// Shared body for the two append-only-table sweeps below. `table` is a
/// compile-time literal from this file only — never a caller-supplied string —
/// because a table name cannot be a bound parameter.
static int DeleteOlderThan(sqlite3* db, const char* table, int maxAgeSeconds) {
    if (db == nullptr || maxAgeSeconds <= 0) return 0;

    const std::string sql = std::string("DELETE FROM ") + table +
        " WHERE created_at <= datetime('now', '-' || ? || ' seconds')";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_int(stmt, 1, maxAgeSeconds);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    return sqlite3_changes(db);
}

int Database::CleanOldAuditEntries(int maxAgeSeconds) {
    return DeleteOlderThan(db, "admin_audit", maxAgeSeconds);
}

int Database::CleanOldClientErrors(int maxAgeSeconds) {
    return DeleteOlderThan(db, "client_errors", maxAgeSeconds);
}
