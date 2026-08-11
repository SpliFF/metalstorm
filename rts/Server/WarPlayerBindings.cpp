#include "WarPlayerBindings.h"

#include <sqlite3.h>

namespace {

// Bind a std::string as transient — sqlite copies, so the source can go out of
// scope. Same helper (and reason) as RoomManager.cpp's.
void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

const char* kColumns =
    "room_id, account_id, username, faction_id, team, "
    "first_seen_at, last_seen_at, authority_pool, score_earned, "
    "score_spent, objectives, state_saved_at";

WarPlayerBinding ReadRow(sqlite3_stmt* s) {
    WarPlayerBinding b;
    b.roomId    = static_cast<uint32_t>(sqlite3_column_int64(s, 0));
    b.accountId = sqlite3_column_int64(s, 1);
    if (const unsigned char* u = sqlite3_column_text(s, 2))
        b.username = reinterpret_cast<const char*>(u);
    if (const unsigned char* f = sqlite3_column_text(s, 3))
        b.factionId = reinterpret_cast<const char*>(f);
    b.team               = sqlite3_column_int(s, 4);
    b.firstSeenAt        = sqlite3_column_int64(s, 5);
    b.lastSeenAt         = sqlite3_column_int64(s, 6);
    b.state.authorityPool = sqlite3_column_double(s, 7);
    b.state.scoreEarned   = sqlite3_column_double(s, 8);
    b.state.scoreSpent    = sqlite3_column_double(s, 9);
    b.state.objectives    = sqlite3_column_int(s, 10);
    b.stateSavedAt        = sqlite3_column_int64(s, 11);
    return b;
}

}  // namespace

void WarPlayerBindings::EnsureTable(sqlite3* db) {
    if (!db) return;
    // NO probe-and-drop here, unlike its neighbours. `rooms`/`game_servers`/
    // `game_status` are mirrors of live in-memory state and can be rebuilt
    // from it; this table is the ONLY copy of a player's war state, so a
    // schema change must migrate additively (ALTER TABLE ADD COLUMN, the way
    // `users.faction_id` did) rather than drop the war's whole player history
    // because a column was added.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS war_player_bindings ("
        "  room_id INTEGER NOT NULL,"
        "  account_id INTEGER NOT NULL,"
        "  username TEXT NOT NULL DEFAULT '',"
        "  faction_id TEXT NOT NULL DEFAULT '',"
        "  team INTEGER NOT NULL DEFAULT -1,"
        "  first_seen_at INTEGER NOT NULL DEFAULT 0,"
        "  last_seen_at INTEGER NOT NULL DEFAULT 0,"
        "  authority_pool REAL NOT NULL DEFAULT 0,"
        "  score_earned REAL NOT NULL DEFAULT 0,"
        "  score_spent REAL NOT NULL DEFAULT 0,"
        "  objectives INTEGER NOT NULL DEFAULT 0,"
        "  state_saved_at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (room_id, account_id)"
        ")", nullptr, nullptr, nullptr);
    // The account-wide read (`DeleteForAccount`, and task 6's "my wars"
    // filter) is not served by the primary key, which leads with room_id.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_war_bindings_account "
        "ON war_player_bindings(account_id)", nullptr, nullptr, nullptr);
}

bool WarPlayerBindings::BindSeat(sqlite3* db, uint32_t roomId, int64_t accountId,
                                 const std::string& username,
                                 const std::string& factionId, int team,
                                 int64_t now) {
    if (!db) return false;
    // ON CONFLICT DO UPDATE rather than INSERT OR REPLACE: REPLACE deletes the
    // row and re-inserts it, which would silently zero the four state columns
    // this statement does not name — i.e. every reconnect would confiscate the
    // pool it is about to restore. `first_seen_at` is likewise left alone, so
    // it keeps meaning "when this account first fought in this war".
    static const char* kSql =
        "INSERT INTO war_player_bindings "
        "  (room_id, account_id, username, faction_id, team, "
        "   first_seen_at, last_seen_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(room_id, account_id) DO UPDATE SET "
        "  username=excluded.username, faction_id=excluded.faction_id, "
        "  team=excluded.team, last_seen_at=excluded.last_seen_at";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, accountId);
    BindText(stmt, 3, username);
    BindText(stmt, 4, factionId);
    sqlite3_bind_int(stmt, 5, team);
    sqlite3_bind_int64(stmt, 6, now);
    sqlite3_bind_int64(stmt, 7, now);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

bool WarPlayerBindings::SaveState(sqlite3* db, uint32_t roomId, int64_t accountId,
                                  const WarPlayerState& state, int64_t now) {
    if (!db) return false;
    static const char* kSql =
        "UPDATE war_player_bindings SET "
        "  authority_pool=?, score_earned=?, score_spent=?, objectives=?, "
        "  state_saved_at=?, last_seen_at=? "
        "WHERE room_id=? AND account_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_double(stmt, 1, state.authorityPool);
    sqlite3_bind_double(stmt, 2, state.scoreEarned);
    sqlite3_bind_double(stmt, 3, state.scoreSpent);
    sqlite3_bind_int(stmt, 4, state.objectives);
    sqlite3_bind_int64(stmt, 5, now);
    sqlite3_bind_int64(stmt, 6, now);
    sqlite3_bind_int64(stmt, 7, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 8, accountId);
    const bool stepped = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    // An UPDATE that matched nothing is not an error at the sqlite level, and
    // it is the case that matters: no binding means this account never took a
    // seat in this war (a spectator), and there is nothing to save.
    return stepped && sqlite3_changes(db) > 0;
}

std::optional<WarPlayerBinding> WarPlayerBindings::Find(sqlite3* db, uint32_t roomId,
                                                        int64_t accountId) {
    if (!db) return std::nullopt;
    const std::string sql = std::string("SELECT ") + kColumns +
        " FROM war_player_bindings WHERE room_id=? AND account_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_bind_int64(stmt, 2, accountId);
    std::optional<WarPlayerBinding> out;
    if (sqlite3_step(stmt) == SQLITE_ROW)
        out = ReadRow(stmt);
    sqlite3_finalize(stmt);
    return out;
}

std::vector<WarPlayerBinding> WarPlayerBindings::ForRoom(sqlite3* db, uint32_t roomId) {
    std::vector<WarPlayerBinding> out;
    if (!db) return out;
    const std::string sql = std::string("SELECT ") + kColumns +
        " FROM war_player_bindings WHERE room_id=? ORDER BY first_seen_at, account_id";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(ReadRow(stmt));
    sqlite3_finalize(stmt);
    return out;
}

int WarPlayerBindings::RenameAccount(sqlite3* db, int64_t accountId,
                                     const std::string& username) {
    if (!db || accountId <= 0 || username.empty()) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "UPDATE war_player_bindings SET username=? WHERE account_id=?",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_text(stmt, 1, username.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 2, accountId);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(db);
}

int WarPlayerBindings::DeleteForAccount(sqlite3* db, int64_t accountId) {
    if (!db) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM war_player_bindings WHERE account_id=?", -1, &stmt,
            nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, accountId);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(db);
}

int WarPlayerBindings::DeleteForRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM war_player_bindings WHERE room_id=?", -1, &stmt,
            nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(db);
}
