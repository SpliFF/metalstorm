#include <doctest/doctest.h>

#include <sqlite3.h>
#include <string>
#include <vector>

#include "Server/AuthTokens.h"
#include "Server/GameEventsDb.h"
#include "Server/GameServersDb.h"
#include "Server/GameStateStore.h"
#include "Server/RoomManager.h"
#include "Server/WarLog.h"
#include "Server/WarPlayerBindings.h"
#include "Server/WarResume.h"

// PLAN-persistence task 4e — the DURABLE half of "a reused room id inherits
// nothing". Task 4d built the in-memory half (`WarStateEvents::Forget` /
// `Retain`); this is the same rule against SQLite.
//
// The fact underneath all of it: `rooms.id` is assigned from a counter, and
// `RoomManager::LoadFromDatabase` re-seeds that counter as `MAX(id) + 1` over
// the rooms that SURVIVED. Delete the highest room, restart the lobby, and the
// next room created is handed its number back. Every table below is keyed on
// that number, and each one is inherited in a differently wrong way:
//
//   war_player_bindings  a roster of accounts that never fought here, with
//                        their authority pools
//   game_events          somebody else's war story, read back as the rejoin
//                        digest
//   game_snapshots       a WORLD — `warresume::LatestSnapshot` is what decides
//                        a war comes back on a stored world, so this one is a
//                        world swap rather than a stale row
//   war_reconnect_tokens a SEAT — `ValidateWarReconnect` scopes a token by
//                        room and nothing else
//   game_servers /       "ready", plus the population and frame of a war that
//   game_status /        is over
//   war_summary
//
// The chokepoint is `RoomManager::DeleteRoomFromDb`, and it is a chokepoint on
// purpose: rooms die two ways and only one of them passes through the lobby's
// game-server bookkeeping. `ReapStaleRooms` at STARTUP runs before that
// bookkeeping exists, so a cleanup hung off `removeGameServer` would cover the
// abandon path and miss the reap — which is exactly the shape the game-server
// triple had before this task.

namespace {

constexpr int64_t kT0 = 1'700'000'000;

/// Every room-keyed table, created by its own owner. Hand-rolled DDL here
/// would let this test keep passing after a schema moved underneath it — and
/// it would hide the trap that a `RoomManager` probe drops sibling tables.
struct WarDb {
    sqlite3* db = nullptr;
    WarDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        RoomManager::EnsureTables(db);
        WarPlayerBindings::EnsureTable(db);
        GameEventsDb::EnsureTable(db);
        GameServersDb::EnsureTables(db);
        AuthTokens::EnsureTables(db);
        gamestate::GameStateStore::EnsureTables(db);
    }
    ~WarDb() { sqlite3_close(db); }

    int Count(const std::string& table, uint32_t roomId) {
        sqlite3_stmt* st = nullptr;
        const std::string sql =
            "SELECT COUNT(*) FROM " + table + " WHERE room_id = ?";
        REQUIRE(sqlite3_prepare_v2(db, sql.c_str(), -1, &st, nullptr) == SQLITE_OK);
        sqlite3_bind_int(st, 1, static_cast<int>(roomId));
        REQUIRE(sqlite3_step(st) == SQLITE_ROW);
        const int n = sqlite3_column_int(st, 0);
        sqlite3_finalize(st);
        return n;
    }

    void Exec(const std::string& sql) {
        REQUIRE(sqlite3_exec(db, sql.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK);
    }

    /// Fill every room-keyed table with one war's worth of rows.
    void StageWar(uint32_t roomId, int64_t accountId) {
        WarPlayerBindings::BindSeat(db, roomId, accountId, "veteran",
                                    "compact", /*team=*/0, kT0);
        warlog::Event e;
        e.seq = 1;
        e.kind = "objective";
        e.subject = "Kessel Ridge";
        e.detail = "held";
        e.team = 0;
        e.frame = 900;
        CHECK(GameEventsDb::Append(db, roomId, {e}, kT0) == 1);

        sqlite3_stmt* st = nullptr;
        REQUIRE(sqlite3_prepare_v2(db,
            "INSERT INTO game_snapshots (game_id, room_id, frame, taken_at,"
            " engine_hash, map_hash, label, raw_size, blob_size, sha256, blob)"
            " VALUES ('metalstorm', ?, 4242, 1700000000, 'e', 'm',"
            " 'hibernate:signal', 1, 1, 's', x'00')", -1, &st, nullptr) == SQLITE_OK);
        sqlite3_bind_int(st, 1, static_cast<int>(roomId));
        REQUIRE(sqlite3_step(st) == SQLITE_DONE);
        sqlite3_finalize(st);

        CHECK(AuthTokens::IssueWarReconnect(db, accountId, roomId,
                                            AuthTokens::kWarReconnectTtlSeconds,
                                            kT0).has_value());

        const std::string id = std::to_string(roomId);
        Exec("INSERT INTO game_servers (room_id, port, pid, map_id, game_id,"
             " state) VALUES (" + id + ", 9100, 1234, 'meridian_basin',"
             " 'metalstorm', 'running')");
        Exec("INSERT INTO game_status (room_id, ready) VALUES (" + id + ", 1)");
        Exec("INSERT INTO war_summary (room_id, summary_json)"
             " VALUES (" + id + ", '{\"live\":true,\"frame\":4242}')");
    }

    /// The whole census, as one number per room.
    int TotalRows(uint32_t roomId) {
        return Count("war_player_bindings", roomId) +
               Count("game_events", roomId) +
               Count("game_snapshots", roomId) +
               Count("war_reconnect_tokens", roomId) +
               Count("game_servers", roomId) +
               Count("game_status", roomId) +
               Count("war_summary", roomId);
    }
};

uint32_t MakeRoom(RoomManager& rooms, uint32_t hostId) {
    return rooms.CreateRoom("war room", "meridian_basin", "metalstorm",
                            /*maxPlayers=*/4, /*password=*/"", hostId,
                            /*hostClientId=*/hostId, "host");
}

}  // namespace

TEST_CASE("room forget: deleting a room deletes the whole war it is keyed to") {
    WarDb t;
    RoomManager rooms;
    rooms.SetDatabase(t.db);

    const uint32_t doomed = MakeRoom(rooms, 1);
    const uint32_t kept   = MakeRoom(rooms, 2);
    REQUIRE(doomed != kept);

    t.StageWar(doomed, /*accountId=*/11);
    t.StageWar(kept, /*accountId=*/22);
    REQUIRE(t.TotalRows(doomed) == 7);
    REQUIRE(t.TotalRows(kept) == 7);

    rooms.DeleteRoom(doomed);

    // Named one by one rather than only through the total: a sum that went to
    // zero because one delete over-reached would read identically here.
    CHECK(t.Count("war_player_bindings", doomed) == 0);
    CHECK(t.Count("game_events", doomed) == 0);
    CHECK(t.Count("game_snapshots", doomed) == 0);
    CHECK(t.Count("war_reconnect_tokens", doomed) == 0);
    CHECK(t.Count("game_servers", doomed) == 0);
    CHECK(t.Count("game_status", doomed) == 0);
    CHECK(t.Count("war_summary", doomed) == 0);

    // The neighbouring war is untouched. Every statement here is a DELETE with
    // one bound room id, and a dropped WHERE is the failure mode that a
    // single-room fixture cannot see.
    CHECK(t.TotalRows(kept) == 7);
}

TEST_CASE("room forget: a recycled room id inherits nothing") {
    // The end-to-end shape of the rule, and the reason it is not merely tidy.
    // A war is played on room N and deleted; the lobby restarts; the counter
    // re-seeds from MAX(id)+1 over the survivors and hands N straight back out.
    WarDb t;
    const uint32_t recycled = [&] {
        RoomManager rooms;
        rooms.SetDatabase(t.db);
        // A survivor first, so the reload below re-seeds the counter from a
        // real MAX(id) rather than from the empty-table default — the id being
        // handed back has to be one the counter arrived at, not id 1.
        MakeRoom(rooms, 1);
        const uint32_t id = MakeRoom(rooms, 2);
        t.StageWar(id, /*accountId=*/11);
        rooms.DeleteRoom(id);
        return id;
    }();

    RoomManager restarted;
    restarted.SetDatabase(t.db);
    restarted.LoadFromDatabase();
    const uint32_t fresh = MakeRoom(restarted, 2);
    // The premise: the id really is handed back. If this ever stops being true
    // the rule above is still correct, but this test would be testing nothing.
    REQUIRE(fresh == recycled);

    CHECK(t.TotalRows(fresh) == 0);
    // Specifically: nothing offers this brand-new room a world to resume.
    CHECK(warresume::LatestSnapshot(t.db, "metalstorm", fresh).has == false);
}

TEST_CASE("room forget: the retroactive purge collects what earlier lobbies left") {
    // The rule above only holds for rooms deleted after it existed. A live
    // database therefore still carries rows for rooms that are long gone, and
    // they are not a leak: the counter climbs back through their numbers.
    WarDb t;
    RoomManager rooms;
    rooms.SetDatabase(t.db);
    const uint32_t living = MakeRoom(rooms, 1);
    t.StageWar(living, /*accountId=*/11);
    // Two rooms deleted the old way — rows with no `rooms` row above them.
    t.StageWar(95, /*accountId=*/95);
    t.StageWar(330, /*accountId=*/330);
    // And the shape the live database was actually found in: an orphaned
    // readiness flag alone, with nothing else of that war left.
    t.Exec("INSERT INTO game_status (room_id, ready) VALUES (124, 1)");

    CHECK(rooms.PurgeOrphanedWarRows() == 3);

    CHECK(t.TotalRows(95) == 0);
    CHECK(t.TotalRows(330) == 0);
    CHECK(t.Count("game_status", 124) == 0);
    // The living room is not an orphan and keeps everything, including the
    // world it would resume on — the purge runs at startup, when a persistent
    // war is exactly the thing sitting there waiting to be resumed.
    CHECK(t.TotalRows(living) == 7);
    CHECK(warresume::LatestSnapshot(t.db, "metalstorm", living).has == true);
    // Idempotent: a second pass has nothing left to find.
    CHECK(rooms.PurgeOrphanedWarRows() == 0);
}

TEST_CASE("room forget: the deletes are safe on a database that has none of it") {
    // A lobby whose database no game server has ever opened has no
    // `game_snapshots` table at all — the same tolerance `LatestSnapshot`
    // carries. A room delete there must be a no-op, not a prepare failure
    // logged once per reaped room.
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    RoomManager::EnsureTables(db);
    WarPlayerBindings::EnsureTable(db);
    GameEventsDb::EnsureTable(db);

    RoomManager rooms;
    rooms.SetDatabase(db);
    const uint32_t id = MakeRoom(rooms, 1);
    rooms.DeleteRoom(id);
    CHECK(rooms.GetRoom(id) == nullptr);

    CHECK(warresume::DeleteSnapshotsForRoom(db, id) == 0);
    CHECK(GameServersDb::DeleteForRoom(db, id) == 0);
    CHECK(AuthTokens::DeleteWarReconnectForRoom(db, id) == 0);
    // And on a null handle, which is what every one of these gets on a lobby
    // running without persistence.
    CHECK(warresume::DeleteSnapshotsForRoom(nullptr, id) == 0);
    CHECK(GameServersDb::DeleteForRoom(nullptr, id) == 0);
    CHECK(AuthTokens::DeleteWarReconnectForRoom(nullptr, id) == 0);
    sqlite3_close(db);
}

TEST_CASE("room forget: DeleteSnapshotsForRoom is not filtered by game") {
    // `LatestSnapshot` partitions on (game_id, room_id) because two games can
    // share a room id. The DELETE deliberately does NOT: the room is gone, so
    // every partition under its number is orphaned, and a blob left behind
    // under a game the caller did not name is a world nothing would refuse.
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    gamestate::GameStateStore::EnsureTables(db);

    auto insert = [&](const char* game, int room) {
        sqlite3_stmt* st = nullptr;
        REQUIRE(sqlite3_prepare_v2(db,
            "INSERT INTO game_snapshots (game_id, room_id, frame, taken_at,"
            " engine_hash, map_hash, label, raw_size, blob_size, sha256, blob)"
            " VALUES (?, ?, 100, 1700000000, 'e', 'm', 'hibernate:idle',"
            " 1, 1, 's', x'00')", -1, &st, nullptr) == SQLITE_OK);
        sqlite3_bind_text(st, 1, game, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 2, room);
        REQUIRE(sqlite3_step(st) == SQLITE_DONE);
        sqlite3_finalize(st);
    };
    insert("metalstorm", 7);
    insert("otherGame", 7);
    insert("metalstorm", 8);

    CHECK(warresume::DeleteSnapshotsForRoom(db, 7) == 2);
    CHECK(warresume::LatestSnapshot(db, "metalstorm", 7).has == false);
    CHECK(warresume::LatestSnapshot(db, "otherGame", 7).has == false);
    CHECK(warresume::LatestSnapshot(db, "metalstorm", 8).has == true);
    sqlite3_close(db);
}
