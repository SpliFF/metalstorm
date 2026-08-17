#include <doctest/doctest.h>

#include "Server/RoomManager.h"

// PLAN-endtoend D63. Start positions had ZERO test coverage in either
// direction — no case named SetPlayerStartPos or SetAIStartPos anywhere in
// tests/ — which is why a route that never read `target_ai_slot` at all
// survived: the host's "place this AI" control silently moved the host's own
// seat instead.
//
// ⚠️ Scope, stated so nobody reads more into these cases than they prove:
// both setters were always CORRECT. The defect was in
// lobby_main.cpp's /api/rooms/startpos, which called the player setter for an
// AI target. That route is registered inline in main() and cannot be reached
// from this suite (see the note at the top of test_route_auth.cpp), so these
// cases pass before and after that fix. What they pin is the invariant the
// route has to respect — an AI slot and a player are different subjects, and
// writing one must never move the other.
//
// No sqlite3* is attached, so this exercises the in-memory state machine only
// (every Persist* call is a no-op guarded by `if (!db) return;`).

namespace {

constexpr int8_t kMaxStartPos = 6;

/// Host (player 1) + one AI slot on team 1, mirroring the room the lobby
/// builds when a host presses "Add AI".
uint32_t makeRoomWithHostAndAI(RoomManager& rooms) {
    const uint32_t roomId = rooms.CreateRoom(
        "test room", "test_map", "test_game", /*maxPlayers=*/8,
        /*password=*/"", /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    REQUIRE(rooms.AddAISlot(roomId, /*requesterId=*/1, "strategos",
        "Strategos", /*team=*/1));
    return roomId;
}

} // namespace

TEST_CASE("SetAIStartPos: placing an AI does not move the host's own start position") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    // The host takes seat 1 first, exactly as a player does before seating
    // their opponent.
    REQUIRE(rooms.SetPlayerStartPos(roomId, /*requesterId=*/1,
        /*targetPlayerId=*/1, /*posIndex=*/1, kMaxStartPos));

    REQUIRE(rooms.SetAIStartPos(roomId, /*requesterId=*/1, /*slotIndex=*/0,
        /*posIndex=*/2, kMaxStartPos));

    GameRoom* room = rooms.GetRoom(roomId);
    REQUIRE(room != nullptr);
    REQUIRE(room->aiSlots.size() == 1);
    // This pair is the whole point: the AI moved, the human did not. The D63
    // route wrote the second number and left the first at -1.
    CHECK(static_cast<int>(room->aiSlots[0].startPos) == 2);
    REQUIRE(room->FindPlayer(1) != nullptr);
    CHECK(static_cast<int>(room->FindPlayer(1)->startPos) == 1);
}

TEST_CASE("SetAIStartPos: a fresh AI slot starts unassigned") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    CHECK(static_cast<int>(rooms.GetRoom(roomId)->aiSlots[0].startPos) == -1);
}

TEST_CASE("SetAIStartPos: -1 clears an assigned slot") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    REQUIRE(rooms.SetAIStartPos(roomId, 1, 0, 3, kMaxStartPos));

    REQUIRE(rooms.SetAIStartPos(roomId, 1, 0, -1, kMaxStartPos));
    CHECK(static_cast<int>(rooms.GetRoom(roomId)->aiSlots[0].startPos) == -1);
}

TEST_CASE("SetAIStartPos: host-only, and an unknown slot index is refused") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    CHECK_FALSE(rooms.SetAIStartPos(roomId, /*requesterId=*/999, 0, 2, kMaxStartPos));
    CHECK_FALSE(rooms.SetAIStartPos(roomId, 1, /*slotIndex=*/7, 2, kMaxStartPos));
    // Refused calls leave the slot alone rather than half-applying.
    CHECK(static_cast<int>(rooms.GetRoom(roomId)->aiSlots[0].startPos) == -1);
}

TEST_CASE("SetAIStartPos: out-of-range positions are refused") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    CHECK_FALSE(rooms.SetAIStartPos(roomId, 1, 0, kMaxStartPos, kMaxStartPos));
    CHECK_FALSE(rooms.SetAIStartPos(roomId, 1, 0, -2, kMaxStartPos));
    CHECK(static_cast<int>(rooms.GetRoom(roomId)->aiSlots[0].startPos) == -1);
}

TEST_CASE("Start positions are exclusive across players AND AI slots") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    REQUIRE(rooms.SetAIStartPos(roomId, 1, 0, /*posIndex=*/2, kMaxStartPos));

    // A human cannot take the seat the AI holds...
    CHECK_FALSE(rooms.SetPlayerStartPos(roomId, 1, 1, 2, kMaxStartPos));
    // ...and the reverse also holds.
    REQUIRE(rooms.SetPlayerStartPos(roomId, 1, 1, 4, kMaxStartPos));
    CHECK_FALSE(rooms.SetAIStartPos(roomId, 1, 0, 4, kMaxStartPos));

    GameRoom* room = rooms.GetRoom(roomId);
    CHECK(static_cast<int>(room->aiSlots[0].startPos) == 2);
    CHECK(static_cast<int>(room->FindPlayer(1)->startPos) == 4);
}

TEST_CASE("SetPlayerStartPos: targetPlayerId 0 is the 'my own slot' shorthand") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);

    REQUIRE(rooms.SetPlayerStartPos(roomId, /*requesterId=*/1,
        /*targetPlayerId=*/0, /*posIndex=*/5, kMaxStartPos));
    CHECK(static_cast<int>(rooms.GetRoom(roomId)->FindPlayer(1)->startPos) == 5);
}

TEST_CASE("SetPlayerStartPos: a non-host cannot move another player's seat") {
    RoomManager rooms;
    const uint32_t roomId = makeRoomWithHostAndAI(rooms);
    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2, "guest", ""));

    // The guest may take a seat of their own...
    REQUIRE(rooms.SetPlayerStartPos(roomId, /*requesterId=*/2,
        /*targetPlayerId=*/2, /*posIndex=*/3, kMaxStartPos));
    // ...but may not move the host, nor place an AI.
    CHECK_FALSE(rooms.SetPlayerStartPos(roomId, /*requesterId=*/2,
        /*targetPlayerId=*/1, /*posIndex=*/0, kMaxStartPos));
    CHECK_FALSE(rooms.SetAIStartPos(roomId, /*requesterId=*/2, 0, 0, kMaxStartPos));
}
