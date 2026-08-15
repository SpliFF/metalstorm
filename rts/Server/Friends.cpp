#include "Friends.h"

#include <sqlite3.h>

namespace {

int RunDelete(sqlite3* db, const char* sql, int64_t a, int64_t b) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, a);
    sqlite3_bind_int64(stmt, 2, b);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(db);
}

}  // namespace

void Friends::EnsureTable(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS friend_edges ("
        "  from_id INTEGER NOT NULL,"
        "  to_id INTEGER NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (from_id, to_id)"
        ")", nullptr, nullptr, nullptr);
    // The reverse lookup ("who has added me?") is every bit as hot as the
    // forward one — it is half of what ListFor asks — and the primary key
    // leads with from_id, so it cannot serve it.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_friend_edges_to "
        "ON friend_edges(to_id)", nullptr, nullptr, nullptr);
}

bool Friends::Add(sqlite3* db, int64_t fromId, int64_t toId, int64_t now) {
    if (!db || fromId <= 0 || toId <= 0) return false;
    // Self-friendship is refused here rather than at the route, because every
    // caller would otherwise have to remember: a self-edge would read as
    // Mutual (the row is its own reverse) and put the viewer in their own
    // friends list as permanently online.
    if (fromId == toId) return false;
    // DO NOTHING, not DO UPDATE: `created_at` means "friends since", and a
    // second click on Add must not reset it. The row already says everything
    // this call wanted to say.
    static const char* kSql =
        "INSERT INTO friend_edges (from_id, to_id, created_at) VALUES (?, ?, ?) "
        "ON CONFLICT(from_id, to_id) DO NOTHING";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, fromId);
    sqlite3_bind_int64(stmt, 2, toId);
    sqlite3_bind_int64(stmt, 3, now);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

int Friends::Remove(sqlite3* db, int64_t aId, int64_t bId) {
    if (!db || aId <= 0 || bId <= 0) return 0;
    // Both directions in one statement. Deleting only the caller's own edge
    // would leave the other player looking at an incoming request from
    // somebody who has just removed them — a "will you be my friend?" prompt
    // manufactured by the act of saying no.
    static const char* kSql =
        "DELETE FROM friend_edges WHERE (from_id=? AND to_id=?) "
        "OR (from_id=? AND to_id=?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, aId);
    sqlite3_bind_int64(stmt, 2, bId);
    sqlite3_bind_int64(stmt, 3, bId);
    sqlite3_bind_int64(stmt, 4, aId);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(db);
}

FriendEdge Friends::EdgeBetween(sqlite3* db, int64_t viewerId, int64_t otherId) {
    if (!db || viewerId <= 0 || otherId <= 0 || viewerId == otherId)
        return FriendEdge::None;
    static const char* kSql =
        "SELECT from_id FROM friend_edges "
        "WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return FriendEdge::None;
    }
    sqlite3_bind_int64(stmt, 1, viewerId);
    sqlite3_bind_int64(stmt, 2, otherId);
    sqlite3_bind_int64(stmt, 3, otherId);
    sqlite3_bind_int64(stmt, 4, viewerId);
    bool out = false, in = false;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        if (sqlite3_column_int64(stmt, 0) == viewerId) out = true;
        else                                           in  = true;
    }
    sqlite3_finalize(stmt);
    if (out && in) return FriendEdge::Mutual;
    if (out)       return FriendEdge::Outgoing;
    if (in)        return FriendEdge::Incoming;
    return FriendEdge::None;
}

std::vector<FriendListEntry> Friends::ListFor(sqlite3* db, int64_t viewerId) {
    std::vector<FriendListEntry> out;
    if (!db || viewerId <= 0) return out;
    // One pass over both directions: `mine` is the caller's edge, `theirs` is
    // the reverse, and the pair of booleans is exactly the FriendEdge lattice.
    // Doing it as two queries and merging in C++ would compute the same thing
    // with a chance of the two halves disagreeing about ordering.
    static const char* kSql =
        "SELECT u.id, u.username, u.faction_id,"
        "       MAX(CASE WHEN e.from_id=?1 THEN 1 ELSE 0 END) AS mine,"
        "       MAX(CASE WHEN e.to_id=?1   THEN 1 ELSE 0 END) AS theirs,"
        "       MAX(CASE WHEN e.from_id=?1 THEN e.created_at ELSE 0 END) AS since "
        "FROM friend_edges e "
        "JOIN users u ON u.id = CASE WHEN e.from_id=?1 THEN e.to_id ELSE e.from_id END "
        "WHERE e.from_id=?1 OR e.to_id=?1 "
        "GROUP BY u.id "
        "ORDER BY (mine AND theirs) DESC, u.username COLLATE NOCASE";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    sqlite3_bind_int64(stmt, 1, viewerId);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        FriendListEntry e;
        e.accountId = sqlite3_column_int64(stmt, 0);
        if (const unsigned char* u = sqlite3_column_text(stmt, 1))
            e.username = reinterpret_cast<const char*>(u);
        if (const unsigned char* f = sqlite3_column_text(stmt, 2))
            e.factionId = reinterpret_cast<const char*>(f);
        const bool mine   = sqlite3_column_int(stmt, 3) != 0;
        const bool theirs = sqlite3_column_int(stmt, 4) != 0;
        e.since = sqlite3_column_int64(stmt, 5);
        e.edge = (mine && theirs) ? FriendEdge::Mutual
               : mine             ? FriendEdge::Outgoing
               : theirs           ? FriendEdge::Incoming
                                  : FriendEdge::None;
        out.push_back(std::move(e));
    }
    sqlite3_finalize(stmt);
    return out;
}

std::vector<int64_t> Friends::MutualIds(sqlite3* db, int64_t viewerId) {
    std::vector<int64_t> out;
    if (!db || viewerId <= 0) return out;
    static const char* kSql =
        "SELECT a.to_id FROM friend_edges a "
        "JOIN friend_edges b ON b.from_id = a.to_id AND b.to_id = a.from_id "
        "WHERE a.from_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return out;
    }
    sqlite3_bind_int64(stmt, 1, viewerId);
    while (sqlite3_step(stmt) == SQLITE_ROW)
        out.push_back(sqlite3_column_int64(stmt, 0));
    sqlite3_finalize(stmt);
    return out;
}

int Friends::DeleteForAccount(sqlite3* db, int64_t accountId) {
    if (!db || accountId <= 0) return 0;
    return RunDelete(db,
        "DELETE FROM friend_edges WHERE from_id=? OR to_id=?",
        accountId, accountId);
}

int Friends::PruneOrphans(sqlite3* db) {
    if (!db) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM friend_edges WHERE "
            "from_id NOT IN (SELECT id FROM users) OR "
            "to_id NOT IN (SELECT id FROM users)",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(db);
}
