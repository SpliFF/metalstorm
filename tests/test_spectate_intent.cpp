#include <doctest/doctest.h>

#include "Server/RoomManager.h"

#include <sqlite3.h>

// PLAN-metalstorm-lobby.md §3, task 6 — "I came to watch."
//
// §3 makes spectating a first-class way to be in a war. Task 2 made the
// opposite true by default: an account whose faction fields a side is
// PROMOTED to that side on auth, every time it connects. So without a
// recorded intent, the only way to watch a war your faction is fighting is to
// have no faction — and "watch this war" is a button the browser has to be
// able to offer.
//
// The intent is deliberately NOT `is_spectator`. On a room that is already
// running, the lobby sets `is_spectator` on every arrival because the lobby
// does not seat them — the game server does. So on a war `is_spectator` means
// "not seated by the lobby", which is true of every fighter in it, and
// reading it as an intent would put the whole war in the stands.
//
// It also has to survive a lobby restart: the process that honours it is the
// game server, reading the row (RoomWatchIntent.h) on the next auth, and a
// player who clicked Watch before a lobby restart did not change their mind.

namespace {

/// A war and a skirmish in one lobby, with the war Active — the state a
/// dynamic joiner actually arrives into.
struct TwoRooms {
    sqlite3* db = nullptr;
    RoomManager rooms;
    uint32_t warId = 0;
    uint32_t skirmishId = 0;

    TwoRooms() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        RoomManager::EnsureTables(db);
        rooms.SetDatabase(db);
        warId = rooms.CreateRoom("the war", "meridian_basin", "metalstorm", 8,
                                 "", 1, 1, "host", /*persistent=*/false,
                                 /*hostFactionId=*/"", SessionKind::PersistentWar);
        skirmishId = rooms.CreateRoom("a match", "meridian_basin", "metalstorm",
                                      8, "", 2, 2, "host2");
        rooms.SetRoomState(warId, ERoomState::Active);
        rooms.SetRoomState(skirmishId, ERoomState::Active);
    }
    ~TwoRooms() { sqlite3_close(db); }
};

}  // namespace

TEST_CASE("a war join records whether the player came to fight or to watch") {
    TwoRooms t;
    REQUIRE(t.rooms.JoinRoom(t.warId, 10, 0, "watcher", "",
                             /*asSpectator=*/true, "union"));
    REQUIRE(t.rooms.JoinRoom(t.warId, 11, 0, "fighter", "",
                             /*asSpectator=*/false, "union"));

    const auto* war = t.rooms.GetRoom(t.warId);
    REQUIRE(war != nullptr);
    REQUIRE(war->FindPlayer(10) != nullptr);
    REQUIRE(war->FindPlayer(11) != nullptr);
    CHECK(war->FindPlayer(10)->spectateOnly);
    CHECK_FALSE(war->FindPlayer(11)->spectateOnly);

    // Both are `is_spectator` in the room, and that is exactly why the intent
    // needs its own field: the room did not seat either of them.
    CHECK(war->FindPlayer(10)->isSpectator);
    CHECK(war->FindPlayer(11)->isSpectator);
}

TEST_CASE("a skirmish never records a watch intent") {
    // On a skirmish `asSpectator` already means what it says — the lobby
    // seats that room itself — so recording a second copy would give the game
    // server a flag to honour that the room row has already honoured.
    TwoRooms t;
    REQUIRE(t.rooms.JoinRoom(t.skirmishId, 10, 0, "watcher", "",
                             /*asSpectator=*/true, "union"));
    const auto* sk = t.rooms.GetRoom(t.skirmishId);
    REQUIRE(sk->FindPlayer(10) != nullptr);
    CHECK_FALSE(sk->FindPlayer(10)->spectateOnly);
    CHECK(sk->FindPlayer(10)->isSpectator);
}

TEST_CASE("re-joining a war the other way converts the intent") {
    // §3's spectator→player conversion and its reverse. The seat itself is
    // taken by the game server on auth, so this lands on the next connect.
    TwoRooms t;
    REQUIRE(t.rooms.JoinRoom(t.warId, 10, 0, "convert", "",
                             /*asSpectator=*/true, "union"));
    CHECK(t.rooms.GetRoom(t.warId)->FindPlayer(10)->spectateOnly);

    REQUIRE(t.rooms.JoinRoom(t.warId, 10, 0, "convert", "",
                             /*asSpectator=*/false, "union"));
    CHECK_FALSE(t.rooms.GetRoom(t.warId)->FindPlayer(10)->spectateOnly);

    REQUIRE(t.rooms.JoinRoom(t.warId, 10, 0, "convert", "",
                             /*asSpectator=*/true, "union"));
    CHECK(t.rooms.GetRoom(t.warId)->FindPlayer(10)->spectateOnly);
}

TEST_CASE("the watch intent survives a lobby restart") {
    TwoRooms t;
    REQUIRE(t.rooms.JoinRoom(t.warId, 10, 0, "watcher", "",
                             /*asSpectator=*/true, "union"));
    REQUIRE(t.rooms.JoinRoom(t.warId, 11, 0, "fighter", "",
                             /*asSpectator=*/false, "union"));

    RoomManager reloaded;
    reloaded.SetDatabase(t.db);
    reloaded.LoadFromDatabase();
    const auto* war = reloaded.GetRoom(t.warId);
    REQUIRE(war != nullptr);
    REQUIRE(war->FindPlayer(10) != nullptr);
    CHECK(war->FindPlayer(10)->spectateOnly);
    CHECK_FALSE(war->FindPlayer(11)->spectateOnly);
}

TEST_CASE("EnsureTables catches a room_members table that predates spectate_only") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    // The three sibling tables are created in their CURRENT shape on purpose
    // — the trap task 1 hit and wrote down: a migration probe can only be
    // tested against a tree where it is the ONLY probe that fires, or it
    // passes with and without its own fix because a sibling probe dropped the
    // tables for its own reasons.
    REQUIRE(sqlite3_exec(db,
        "CREATE TABLE rooms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, "
        " host_player_id INTEGER NOT NULL, map_id TEXT, game_id TEXT, "
        " max_players INTEGER NOT NULL DEFAULT 8, "
        " password TEXT NOT NULL DEFAULT '', state INTEGER NOT NULL DEFAULT 1, "
        " game_server_port INTEGER NOT NULL DEFAULT 0, "
        " persistent INTEGER NOT NULL DEFAULT 0, "
        " session_kind TEXT NOT NULL DEFAULT 'skirmish', "
        " created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), "
        " updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));"
        // Pre-task-6 room_members: no `spectate_only`.
        "CREATE TABLE room_members (room_id INTEGER NOT NULL, "
        " player_id INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', "
        " team INTEGER NOT NULL DEFAULT 0, start_pos INTEGER NOT NULL DEFAULT -1, "
        " ready INTEGER NOT NULL DEFAULT 0, is_spectator INTEGER NOT NULL DEFAULT 0, "
        " is_host INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_id, player_id));"
        "CREATE TABLE room_ai_slots (room_id INTEGER NOT NULL, "
        " slot_index INTEGER NOT NULL, ai_id TEXT NOT NULL, "
        " display_name TEXT NOT NULL DEFAULT '', team INTEGER NOT NULL DEFAULT 0, "
        " start_pos INTEGER NOT NULL DEFAULT -1, profile TEXT NOT NULL DEFAULT '', "
        " PRIMARY KEY (room_id, slot_index));"
        "CREATE TABLE room_mod_options (room_id INTEGER NOT NULL, "
        " key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', "
        " PRIMARY KEY (room_id, key));",
        nullptr, nullptr, nullptr) == SQLITE_OK);

    RoomManager::EnsureTables(db);

    // Without the probe, PersistMembersLocked's INSERT names a column that
    // does not exist: it fails (logged, not thrown), so the room's roster is
    // silently dropped on every write and a restart brings back an empty war.
    RoomManager rooms;
    rooms.SetDatabase(db);
    const uint32_t warId = rooms.CreateRoom(
        "the war", "meridian_basin", "metalstorm", 8, "", 1, 1, "host",
        /*persistent=*/false, /*hostFactionId=*/"", SessionKind::PersistentWar);
    rooms.SetRoomState(warId, ERoomState::Active);
    REQUIRE(rooms.JoinRoom(warId, 10, 0, "watcher", "",
                           /*asSpectator=*/true, "union"));

    RoomManager reloaded;
    reloaded.SetDatabase(db);
    reloaded.LoadFromDatabase();
    REQUIRE(reloaded.GetRoom(warId) != nullptr);
    REQUIRE(reloaded.GetRoom(warId)->FindPlayer(10) != nullptr);
    CHECK(reloaded.GetRoom(warId)->FindPlayer(10)->spectateOnly);

    sqlite3_close(db);
}
