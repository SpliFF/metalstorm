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
    )";

    char* errMsg = nullptr;
    int rc = sqlite3_exec(db, sql, nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "error creating tables: %s", errMsg);
        sqlite3_free(errMsg);
    }
}

int64_t Database::CreateUser(const std::string& username, const std::string& passwordHash,
                             const std::string& role)
{
    const char* sql = "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, passwordHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, role.c_str(), -1, SQLITE_TRANSIENT);

    int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE)
        return 0;

    return sqlite3_last_insert_rowid(db);
}

std::optional<UserRecord> Database::FindUser(const std::string& username) {
    const char* sql = "SELECT id, username, password_hash, role, is_banned FROM users WHERE username = ?";
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

    sqlite3_finalize(stmt);
    return user;
}

std::optional<UserRecord> Database::FindUserById(int64_t userId) {
    const char* sql = "SELECT id, username, password_hash, role, is_banned FROM users WHERE id = ?";
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

    sqlite3_finalize(stmt);
    return user;
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

int64_t Database::ValidateSession(const std::string& token) {
    const char* sql = "SELECT user_id FROM sessions WHERE token = ?";
    sqlite3_stmt* stmt = nullptr;

    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK)
        return 0;

    sqlite3_bind_text(stmt, 1, token.c_str(), -1, SQLITE_TRANSIENT);

    int64_t userId = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        userId = sqlite3_column_int64(stmt, 0);
    }

    sqlite3_finalize(stmt);
    return userId;
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
