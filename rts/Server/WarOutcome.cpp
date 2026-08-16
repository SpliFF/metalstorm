#include "WarOutcome.h"

#include <sqlite3.h>

#include <nlohmann/json.hpp>

namespace {

// Transient bind — sqlite copies, so the source may go out of scope. Same
// helper (and reason) as WarPlayerBindings.cpp's.
void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

const char* kColumns =
    "room_id, final_frame, winner_team, winner_factions, "
    "settled_complete, settled_expired, scoreboard_json, recorded_at";

}  // namespace

bool IsPublishableWarOutcome(const std::string& simWarState, int32_t finalFrame) {
    // No gadget, or a war still being fought: there is no ending to publish.
    // A scenario-less war has no terminal condition at all (§7.1) and the
    // Director must not be handed one.
    if (simWarState.empty() || simWarState == "active")
        return false;
    // Left `active`, but `resolve()` has not stamped its frame — this is a
    // heartbeat inside the 300-frame wind-down grace, where every field that
    // matters still reads 0. Not an ending yet.
    return finalFrame > 0;
}

std::string EncodeWarScoreboard(const std::vector<WarScoreRow>& rows) {
    nlohmann::json arr = nlohmann::json::array();
    for (const auto& r : rows) {
        nlohmann::json j;
        j["player"] = r.playerNum;
        j["name"] = r.name;
        j["team"] = r.team;
        j["earned"] = r.earned;
        j["spent"] = r.spent;
        j["objectives"] = r.objectives;
        arr.push_back(std::move(j));
    }
    return arr.dump();
}

std::vector<WarScoreRow> DecodeWarScoreboard(const std::string& text) {
    std::vector<WarScoreRow> out;
    // A malformed scoreboard yields an EMPTY archive line, never a throw and
    // never a partial row with invented numbers. An archived war that can no
    // longer show its scoreboard is a disappointment; one that shows made-up
    // figures is a lie, and the browser already renders "no scoreboard" for
    // the wars that ended before this table existed.
    const auto j = nlohmann::json::parse(text, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_array())
        return out;
    for (const auto& e : j) {
        if (!e.is_object()) continue;
        WarScoreRow r;
        r.playerNum  = e.value("player", -1);
        r.name       = e.value("name", std::string{});
        r.team       = e.value("team", -1);
        r.earned     = e.value("earned", 0.0);
        r.spent      = e.value("spent", 0.0);
        r.objectives = e.value("objectives", 0u);
        out.push_back(std::move(r));
    }
    return out;
}

void WarOutcomeDb::EnsureTable(sqlite3* db) {
    if (!db) return;
    // Additive only — see the header. This is the only copy of a finished
    // war's scoreboard, and dropping it to add a column would erase the
    // history of every war that ever ended on this box.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS war_outcome ("
        "  room_id INTEGER PRIMARY KEY,"
        "  final_frame INTEGER NOT NULL DEFAULT 0,"
        "  winner_team INTEGER NOT NULL DEFAULT -1,"
        "  winner_factions TEXT NOT NULL DEFAULT '',"
        "  settled_complete INTEGER NOT NULL DEFAULT 0,"
        "  settled_expired INTEGER NOT NULL DEFAULT 0,"
        "  scoreboard_json TEXT NOT NULL DEFAULT '[]',"
        "  recorded_at INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
}

bool WarOutcomeDb::Record(sqlite3* db, const WarOutcomeRecord& o) {
    if (!db) return false;
    // REPLACE, not INSERT: the game server republishes on every heartbeat for
    // the whole post-game observation window, and a war that resumes from a
    // snapshot taken before the win can legitimately end a second time with
    // different numbers. The latest publication is the war's ending.
    static const char* kSql =
        "INSERT OR REPLACE INTO war_outcome "
        "  (room_id, final_frame, winner_team, winner_factions, "
        "   settled_complete, settled_expired, scoreboard_json, recorded_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, o.roomId);
    sqlite3_bind_int(stmt, 2, o.finalFrame);
    sqlite3_bind_int(stmt, 3, o.winnerTeam);
    BindText(stmt, 4, o.winnerFactions);
    sqlite3_bind_int(stmt, 5, static_cast<int>(o.settledComplete));
    sqlite3_bind_int(stmt, 6, static_cast<int>(o.settledExpired));
    const std::string board = EncodeWarScoreboard(o.scoreboard);
    BindText(stmt, 7, board);
    sqlite3_bind_int64(stmt, 8, o.recordedAt);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

std::optional<WarOutcomeRecord> WarOutcomeDb::Load(sqlite3* db, uint32_t roomId) {
    if (!db) return std::nullopt;
    const std::string sql =
        std::string("SELECT ") + kColumns + " FROM war_outcome WHERE room_id=?";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }
    sqlite3_bind_int64(stmt, 1, roomId);
    std::optional<WarOutcomeRecord> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        WarOutcomeRecord o;
        o.roomId          = static_cast<uint32_t>(sqlite3_column_int64(stmt, 0));
        o.finalFrame      = sqlite3_column_int(stmt, 1);
        o.winnerTeam      = sqlite3_column_int(stmt, 2);
        if (const unsigned char* w = sqlite3_column_text(stmt, 3))
            o.winnerFactions = reinterpret_cast<const char*>(w);
        o.settledComplete = static_cast<unsigned>(sqlite3_column_int(stmt, 4));
        o.settledExpired  = static_cast<unsigned>(sqlite3_column_int(stmt, 5));
        if (const unsigned char* b = sqlite3_column_text(stmt, 6))
            o.scoreboard = DecodeWarScoreboard(reinterpret_cast<const char*>(b));
        o.recordedAt      = sqlite3_column_int64(stmt, 7);
        out = std::move(o);
    }
    sqlite3_finalize(stmt);
    return out;
}

bool WarOutcomeDb::HasOutcome(sqlite3* db, uint32_t roomId) {
    if (!db) return false;
    sqlite3_stmt* stmt = nullptr;
    // `final_frame > 0` is the completeness half — see the header. A row whose
    // frame is unstamped is a war still winding down, not a war that ended.
    if (sqlite3_prepare_v2(db,
                           "SELECT 1 FROM war_outcome"
                           " WHERE room_id=? AND final_frame>0",
                           -1, &stmt, nullptr) != SQLITE_OK) {
        // The table can legitimately be absent on a lobby that has never seen
        // a war end. Not an error, and emphatically not "the war is over".
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, roomId);
    const bool found = sqlite3_step(stmt) == SQLITE_ROW;
    sqlite3_finalize(stmt);
    return found;
}

bool WarOutcomeDb::Forget(sqlite3* db, uint32_t roomId) {
    if (!db) return false;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, "DELETE FROM war_outcome WHERE room_id=?", -1,
                           &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    sqlite3_bind_int64(stmt, 1, roomId);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}
