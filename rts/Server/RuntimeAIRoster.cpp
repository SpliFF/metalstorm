#include "RuntimeAIRoster.h"

#include <sqlite3.h>

const char* RuntimeAIRestoreVerdictName(RuntimeAIRestoreVerdict v) {
    switch (v) {
        case RuntimeAIRestoreVerdict::Restore:          return "restoring";
        case RuntimeAIRestoreVerdict::RefuseNoTeam:     return "refused: team is not active in the resumed world";
        case RuntimeAIRestoreVerdict::RefuseNoId:       return "refused: stored row names no plugin";
        case RuntimeAIRestoreVerdict::RefuseSlotTaken:  return "refused: player number already taken";
        case RuntimeAIRestoreVerdict::RefuseTeamHasAI:  return "refused: team already has an AI";
    }
    return "unknown";
}

RuntimeAIRestoreVerdict DecideRuntimeAIRestore(const RuntimeAISeat& seat,
                                              bool teamActive,
                                              bool playerNumTaken,
                                              bool teamHasActiveAI) {
    if (seat.aiId.empty())
        return RuntimeAIRestoreVerdict::RefuseNoId;
    if (seat.playerNum < 0)
        return RuntimeAIRestoreVerdict::RefuseSlotTaken;
    if (!teamActive)
        return RuntimeAIRestoreVerdict::RefuseNoTeam;
    // Order matters: a taken NUMBER is reported ahead of a taken TEAM because
    // it is the more specific fact and the two can be true together (the seat's
    // number handed to a human who joined the war's launch roster since the
    // freeze, on a team a new `--ai` slot also covers). Naming the team first
    // would send an operator looking at the AI roster for a human's row.
    if (playerNumTaken)
        return RuntimeAIRestoreVerdict::RefuseSlotTaken;
    if (teamHasActiveAI)
        return RuntimeAIRestoreVerdict::RefuseTeamHasAI;
    return RuntimeAIRestoreVerdict::Restore;
}

void RuntimeAIRoster::EnsureTable(sqlite3* db) {
    if (!db) return;
    // Additive only — see the header. A `player_num` that is part of the
    // primary key is also the reason there is no AUTOINCREMENT id: the seat IS
    // its number within a room.
    static const char* kDdl =
        "CREATE TABLE IF NOT EXISTS room_runtime_ai ("
        "  room_id     INTEGER NOT NULL,"
        "  player_num  INTEGER NOT NULL,"
        "  ai_id       TEXT    NOT NULL,"
        "  team        INTEGER NOT NULL,"
        "  seated_frame INTEGER NOT NULL DEFAULT 0,"
        "  created_at  INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (room_id, player_num)"
        ")";
    sqlite3_exec(db, kDdl, nullptr, nullptr, nullptr);
}

bool RuntimeAIRoster::Record(sqlite3* db, const RuntimeAISeat& seat) {
    if (!db) return false;
    sqlite3_stmt* st = nullptr;
    const char* kSql =
        "INSERT OR REPLACE INTO room_runtime_ai "
        "(room_id, player_num, ai_id, team, seated_frame, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)";
    if (sqlite3_prepare_v2(db, kSql, -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return false;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(seat.roomId));
    sqlite3_bind_int(st, 2, seat.playerNum);
    sqlite3_bind_text(st, 3, seat.aiId.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(st, 4, seat.team);
    sqlite3_bind_int(st, 5, static_cast<int>(seat.seatedFrame));
    sqlite3_bind_int64(st, 6, seat.createdAt);
    const bool ok = sqlite3_step(st) == SQLITE_DONE;
    sqlite3_finalize(st);
    return ok;
}

std::vector<RuntimeAISeat> RuntimeAIRoster::ForRoom(sqlite3* db, uint32_t roomId) {
    std::vector<RuntimeAISeat> out;
    if (!db) return out;
    sqlite3_stmt* st = nullptr;
    const char* kSql =
        "SELECT player_num, ai_id, team, seated_frame, created_at "
        "FROM room_runtime_ai WHERE room_id=? ORDER BY player_num";
    if (sqlite3_prepare_v2(db, kSql, -1, &st, nullptr) != SQLITE_OK) {
        // Table absent on a db that predates it: no seats, not an error.
        sqlite3_finalize(st);
        return out;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    while (sqlite3_step(st) == SQLITE_ROW) {
        RuntimeAISeat s;
        s.roomId      = roomId;
        s.playerNum   = sqlite3_column_int(st, 0);
        const unsigned char* id = sqlite3_column_text(st, 1);
        s.aiId        = id ? reinterpret_cast<const char*>(id) : "";
        s.team        = sqlite3_column_int(st, 2);
        s.seatedFrame = sqlite3_column_int(st, 3);
        s.createdAt   = sqlite3_column_int64(st, 4);
        out.push_back(std::move(s));
    }
    sqlite3_finalize(st);
    return out;
}

int RuntimeAIRoster::DeleteForRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM room_runtime_ai WHERE room_id=?",
                           -1, &st, nullptr) != SQLITE_OK) {
        sqlite3_finalize(st);
        return 0;
    }
    sqlite3_bind_int(st, 1, static_cast<int>(roomId));
    sqlite3_step(st);
    sqlite3_finalize(st);
    return sqlite3_changes(db);
}
