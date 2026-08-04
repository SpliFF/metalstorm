#include <doctest/doctest.h>

#include "Server/RoomManager.h"

// PLAN-metalstorm-ai.md §10 task 6 — RoomAISlot.profile transport. No
// sqlite3* is attached, so these exercise the in-memory state machine only
// (RoomManager::SetDatabase is never called; every Persist* call is a
// no-op guarded by `if (!db) return;`).

namespace {

uint32_t makeRoomWithHostAndAI(RoomManager& rooms) {
    const uint32_t roomId = rooms.CreateRoom(
        "test room", "test_map", "test_game", /*maxPlayers=*/8,
        /*password=*/"", /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    REQUIRE(rooms.AddAISlot(roomId, /*requesterId=*/1, "strategos",
        "Strategos", /*team=*/1));
    return roomId;
}

} // namespace

TEST_CASE("SetAIProfile: host can set a profile on an AI slot") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    REQUIRE(rooms.SetAIProfile(roomId, /*requesterId=*/1, /*slotIndex=*/0,
        "aggressive"));

    GameRoom* room = rooms.GetRoom(roomId);
    REQUIRE(room != nullptr);
    REQUIRE(room->aiSlots.size() == 1);
    CHECK(room->aiSlots[0].profile == "aggressive");
}

TEST_CASE("SetAIProfile: empty string clears a previously-set profile") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    REQUIRE(rooms.SetAIProfile(roomId, 1, 0, "caretaker"));

    REQUIRE(rooms.SetAIProfile(roomId, 1, 0, ""));
    CHECK(rooms.GetRoom(roomId)->aiSlots[0].profile == "");
}

TEST_CASE("SetAIProfile: new AI slots default to an empty (unset) profile") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    CHECK(rooms.GetRoom(roomId)->aiSlots[0].profile == "");
}

TEST_CASE("SetAIProfile: rejects a non-host requester") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    CHECK_FALSE(rooms.SetAIProfile(roomId, /*requesterId=*/999, 0, "aggressive"));
    CHECK(rooms.GetRoom(roomId)->aiSlots[0].profile == "");
}

TEST_CASE("SetAIProfile: rejects an out-of-range slot index") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    CHECK_FALSE(rooms.SetAIProfile(roomId, 1, /*slotIndex=*/5, "aggressive"));
}

TEST_CASE("SetAIProfile: rejects an unknown room") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    CHECK_FALSE(rooms.SetAIProfile(roomId + 1000, 1, 0, "aggressive"));
}
