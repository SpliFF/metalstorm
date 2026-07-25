#include <doctest/doctest.h>

#include "Server/RoomManager.h"

// PLAN-metalstorm-onboarding.md §4 — spectate-before-join minimal slice.
// No sqlite3* is attached, so these exercise the in-memory state machine
// only (RoomManager::SetDatabase is never called; every Persist* call is a
// no-op guarded by `if (!db) return;`).

namespace {

uint32_t makeRoomWithHostAndSpectator(RoomManager& rooms) {
    const uint32_t roomId = rooms.CreateRoom(
        "test room", "test_map", "test_game", /*maxPlayers=*/2,
        /*password=*/"", /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    // Host auto-joins as a player (team 0) inside CreateRoom.
    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2,
        "watcher", /*password=*/"", /*asSpectator=*/true));
    return roomId;
}

} // namespace

TEST_CASE("EnlistSpectator: converts a spectator to a player with an auto-assigned team") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndSpectator(rooms);

    REQUIRE(rooms.EnlistSpectator(roomId, /*playerId=*/2, /*team=*/255));

    GameRoom* room = rooms.GetRoom(roomId);
    REQUIRE(room != nullptr);
    RoomPlayer* enlisted = room->FindPlayer(2);
    REQUIRE(enlisted != nullptr);
    CHECK_FALSE(enlisted->isSpectator);
    // Host already holds team 0; auto-assign should skip it.
    CHECK(enlisted->team == 1);
    CHECK_FALSE(enlisted->ready);
}

TEST_CASE("EnlistSpectator: honours an explicit team request") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndSpectator(rooms);

    REQUIRE(rooms.EnlistSpectator(roomId, /*playerId=*/2, /*team=*/1));

    RoomPlayer* enlisted = rooms.GetRoom(roomId)->FindPlayer(2);
    REQUIRE(enlisted != nullptr);
    CHECK_FALSE(enlisted->isSpectator);
    CHECK(enlisted->team == 1);
}

TEST_CASE("EnlistSpectator: rejects a requester who is already a player") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndSpectator(rooms);

    // Host (playerId 1) is already a player, not a spectator.
    CHECK_FALSE(rooms.EnlistSpectator(roomId, /*playerId=*/1, /*team=*/255));
}

TEST_CASE("EnlistSpectator: rejects when the room is already full of non-spectators") {
    RoomManager rooms;
    const uint32_t roomId = rooms.CreateRoom(
        "test room", "test_map", "test_game", /*maxPlayers=*/1,
        "", /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2,
        "watcher", "", /*asSpectator=*/true));

    // maxPlayers=1 and the host already occupies the only non-spectator slot.
    CHECK_FALSE(rooms.EnlistSpectator(roomId, /*playerId=*/2, /*team=*/255));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->isSpectator);
}

TEST_CASE("EnlistSpectator: unknown room or player fails cleanly") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndSpectator(rooms);

    CHECK_FALSE(rooms.EnlistSpectator(roomId + 1000, /*playerId=*/2, 255));
    CHECK_FALSE(rooms.EnlistSpectator(roomId, /*playerId=*/999, 255));
}
