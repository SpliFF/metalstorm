#include "GameEventsDb.h"

#include <sqlite3.h>

namespace {

std::string TextCol(sqlite3_stmt* st, int col) {
    const unsigned char* p = sqlite3_column_text(st, col);
    return p ? reinterpret_cast<const char*>(p) : "";
}

}  // namespace

void GameEventsDb::EnsureTable(sqlite3* db) {
    if (!db) return;
    // Durable: additive migration only (see the header). `seq` is the sim's
    // own monotonic counter and `(room_id, seq)` is the natural key — the
    // rowid is not, because the same event can be offered twice by a drain
    // that lost its watermark, and the UNIQUE is what makes that a no-op.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS game_events ("
        "  room_id INTEGER NOT NULL,"
        "  seq INTEGER NOT NULL,"
        "  kind TEXT NOT NULL DEFAULT '',"
        "  subject TEXT NOT NULL DEFAULT '',"
        "  detail TEXT NOT NULL DEFAULT '',"
        "  team INTEGER NOT NULL DEFAULT -1,"
        "  frame INTEGER NOT NULL DEFAULT 0,"
        "  at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (room_id, seq)"
        ")", nullptr, nullptr, nullptr);
    // The digest's own query is "this room, after this instant" — the primary
    // key leads with room_id but orders by seq, and seq and time agree only
    // within one run of the game server (a resumed war restarts its wall clock
    // while its seq continues). So the time ordering gets its own index.
    sqlite3_exec(db,
        "CREATE INDEX IF NOT EXISTS idx_game_events_room_at "
        "ON game_events(room_id, at)", nullptr, nullptr, nullptr);
}

int GameEventsDb::Append(sqlite3* db, uint32_t roomId,
                         const std::vector<warlog::Event>& events, int64_t now) {
    if (!db || events.empty()) return 0;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "INSERT OR IGNORE INTO game_events"
            " (room_id, seq, kind, subject, detail, team, frame, at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return 0;
    }
    sqlite3_exec(db, "BEGIN", nullptr, nullptr, nullptr);
    int written = 0;
    for (const auto& e : events) {
        sqlite3_reset(st);
        sqlite3_bind_int(st, 1, static_cast<int>(roomId));
        sqlite3_bind_int64(st, 2, e.seq);
        sqlite3_bind_text(st, 3, e.kind.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 4, e.subject.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_text(st, 5, e.detail.c_str(), -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 6, e.team);
        sqlite3_bind_int(st, 7, e.frame);
        sqlite3_bind_int64(st, 8, now);
        if (sqlite3_step(st) == SQLITE_DONE) written += sqlite3_changes(db);
    }
    sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
    sqlite3_finalize(st);
    return written;
}

int64_t GameEventsDb::HighestSeq(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT MAX(seq) FROM game_events WHERE room_id = ?",
            -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return 0;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    int64_t out = 0;
    if (sqlite3_step(st) == SQLITE_ROW &&
        sqlite3_column_type(st, 0) != SQLITE_NULL)
        out = sqlite3_column_int64(st, 0);
    sqlite3_finalize(st);
    return out;
}

std::vector<warlog::Event> GameEventsDb::Since(sqlite3* db, uint32_t roomId,
                                               int64_t sinceUnix, int limit,
                                               int* totalOut) {
    std::vector<warlog::Event> out;
    if (totalOut) *totalOut = 0;
    if (!db || limit <= 0) return out;

    if (totalOut) {
        sqlite3_stmt* ct = nullptr;
        if (sqlite3_prepare_v2(db,
                "SELECT COUNT(*) FROM game_events"
                " WHERE room_id = ? AND at > ?",
                -1, &ct, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(ct, 1, static_cast<int>(roomId));
            sqlite3_bind_int64(ct, 2, sinceUnix);
            if (sqlite3_step(ct) == SQLITE_ROW)
                *totalOut = sqlite3_column_int(ct, 0);
        }
        sqlite3_finalize(ct);
    }

    // Newest `limit` by the inner ORDER BY, handed back oldest-first by the
    // outer one: a digest is read as a story and the story runs forwards, but
    // what gets cut when it is too long is the beginning.
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT seq, kind, subject, detail, team, frame FROM ("
            "  SELECT seq, kind, subject, detail, team, frame FROM game_events"
            "  WHERE room_id = ? AND at > ? ORDER BY seq DESC LIMIT ?"
            ") ORDER BY seq ASC",
            -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return out;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    sqlite3_bind_int64(st, 2, sinceUnix);
    sqlite3_bind_int(st, 3, limit);
    while (sqlite3_step(st) == SQLITE_ROW) {
        warlog::Event e;
        e.seq = sqlite3_column_int64(st, 0);
        e.kind = TextCol(st, 1);
        e.subject = TextCol(st, 2);
        e.detail = TextCol(st, 3);
        e.team = sqlite3_column_int(st, 4);
        e.frame = sqlite3_column_int(st, 5);
        out.push_back(std::move(e));
    }
    sqlite3_finalize(st);
    return out;
}

void GameEventsDb::Prune(sqlite3* db, uint32_t roomId) {
    if (!db) return;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db,
            "DELETE FROM game_events WHERE room_id = ? AND seq <= ("
            "  SELECT seq FROM game_events WHERE room_id = ?"
            "  ORDER BY seq DESC LIMIT 1 OFFSET ?"
            ")", -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    sqlite3_bind_int(st, 2, static_cast<int>(roomId));
    // Ordered newest-first, the row AT offset `kRetainPerRoom` is the newest
    // one that must go — the 500 above it are the keepers — and the DELETE
    // takes it and everything older. With fewer rows than the retention the
    // subquery returns no row, `seq <= NULL` is never true, and the statement
    // deletes nothing.
    sqlite3_bind_int(st, 3, kRetainPerRoom);
    sqlite3_step(st);
    sqlite3_finalize(st);
}

void GameEventsDb::DeleteForRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM game_events WHERE room_id = ?",
                           -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    sqlite3_step(st);
    sqlite3_finalize(st);
}
