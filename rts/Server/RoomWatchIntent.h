// RoomWatchIntent — "this account asked to WATCH this war, not fight in it".
//
// PLAN-metalstorm-lobby.md §3, task 6. §3 makes spectating a first-class way
// to be in a war ("watching the war *is* content"), which means a player whose
// faction fields a side has to be able to choose the stands. Task 2 gave every
// such account an automatic promotion to a seat on auth, so without this the
// only way to watch a war your faction is in is to not have a faction.
//
// ── Why this crosses the db and not the wire ──────────────────────────────
// The intent is expressed in the LOBBY (a button on a war card) and honoured
// in the GAME SERVER (the auth handler that seats people), two processes whose
// only shared channel is the SQLite file — the same rendezvous game_status and
// war_player_bindings use. It rides `room_members` because it is a property of
// a membership: it dies with the membership, and a player who leaves the war
// and comes back is asking again.
//
// The column is written by RoomManager::JoinRoom (which owns every other
// column on that table) and read here. This file exists so the *name* of the
// column appears exactly twice in the tree, next to a statement of what it
// means — the shape task 1 and task 2 both settled on for a spelling that
// crosses a process boundary.
#pragma once

#include <cstdint>

#include <sqlite3.h>

/// Did `accountId` ask to watch room `roomId` rather than fight in it?
///
/// False for every case that is not an explicit, recorded "watch": no row, no
/// table, no db, a skirmish (RoomManager never sets the flag on one — its
/// spectators are seated by the room itself), and any read failure. Defaulting
/// to false is the safe direction: the cost of missing the intent is a player
/// seated in a war they wanted to watch, who can leave; the cost of inventing
/// one is a fighter silently benched with no error anywhere.
inline bool AccountWantsToWatch(sqlite3* db, uint32_t roomId, int64_t accountId) {
    if (db == nullptr || accountId <= 0) return false;
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT spectate_only FROM room_members "
            "WHERE room_id=? AND player_id=?",
            -1, &s, nullptr) != SQLITE_OK) {
        sqlite3_finalize(s);
        return false;
    }
    sqlite3_bind_int(s, 1, static_cast<int>(roomId));
    sqlite3_bind_int64(s, 2, accountId);
    bool watch = false;
    if (sqlite3_step(s) == SQLITE_ROW)
        watch = sqlite3_column_int(s, 0) != 0;
    sqlite3_finalize(s);
    return watch;
}
