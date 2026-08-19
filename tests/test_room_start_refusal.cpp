#include <doctest/doctest.h>

#include "Server/RoomManager.h"

// PLAN-endtoend.md D41 — a refused Start Game has to say why.
//
// RoomManager::StartGame folds four distinct refusals into one bool, and the
// lobby route answered all of them with a flat "cannot start game" that the
// client then threw away. Net effect, measured live on the player path in
// fire 19: the host seats a Strategos AI, presses Start Game, and *nothing
// happens* — no transition, no message, no log line. The room sat at
// state=Filling and the fire lost a minute to it before reading the 400 by
// hand.
//
// The cause is not exotic: AllReady() counts the host like any other player,
// so a host who never pressed their own Ready is refused by their own room.
// That is a legitimate rule; being silent about it is not.
//
// These pin the reason strings to the same conditions StartGame tests, which
// is the point of keeping StartRefusalReason beside AllReady() rather than in
// the route — the two cannot drift apart without failing here.
//
// No sqlite3* is attached, so these exercise the in-memory state machine only.

namespace {

constexpr uint32_t kHost = 1;
constexpr uint32_t kGuest = 2;

uint32_t makeRoom(RoomManager& rooms) {
    return rooms.CreateRoom("war room", "meridian_basin", "metalstorm",
                            /*maxPlayers=*/4, /*password=*/"",
                            /*hostPlayerId=*/kHost, /*hostClientId=*/1, "host");
}

} // namespace

TEST_CASE("StartRefusal: the host's own un-pressed Ready is named") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms);

    // The exact live shape: a lone host who has seated an AI and reaches
    // straight for Start Game.
    const GameRoom* room = rooms.GetRoom(roomId);
    REQUIRE(room != nullptr);
    CHECK(room->StartRefusalReason(kHost) ==
          "waiting for players to ready up: host");

    // And it is a real refusal, not just a message.
    CHECK_FALSE(rooms.StartGame(roomId, kHost));
}

TEST_CASE("StartRefusal: every unready player is named, not just the first") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms);
    REQUIRE(rooms.JoinRoom(roomId, kGuest, /*clientId=*/2, "guest", /*password=*/""));

    const GameRoom* room = rooms.GetRoom(roomId);
    REQUIRE(room != nullptr);
    CHECK(room->StartRefusalReason(kHost) ==
          "waiting for players to ready up: host, guest");

    // Readying one leaves the other named — a host who reads the message
    // and acts on it must not be told the same thing twice.
    REQUIRE(rooms.SetReady(roomId, kHost, true));
    CHECK(rooms.GetRoom(roomId)->StartRefusalReason(kHost) ==
          "waiting for players to ready up: guest");
}

TEST_CASE("StartRefusal: silent when the room would actually start") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms);
    REQUIRE(rooms.JoinRoom(roomId, kGuest, /*clientId=*/2, "guest", /*password=*/""));
    REQUIRE(rooms.SetReady(roomId, kHost, true));
    REQUIRE(rooms.SetReady(roomId, kGuest, true));

    CHECK(rooms.GetRoom(roomId)->StartRefusalReason(kHost).empty());
    // The empty reason and the successful start are the same condition.
    CHECK(rooms.StartGame(roomId, kHost));
}

TEST_CASE("StartRefusal: a non-host is told it is not their button") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms);
    REQUIRE(rooms.JoinRoom(roomId, kGuest, /*clientId=*/2, "guest", /*password=*/""));
    REQUIRE(rooms.SetReady(roomId, kHost, true));
    REQUIRE(rooms.SetReady(roomId, kGuest, true));

    // Ready is not the problem here, so the host-check must win over the
    // ready-check rather than reporting whichever is evaluated first.
    CHECK(rooms.GetRoom(roomId)->StartRefusalReason(kGuest) ==
          "only the host can start the game");
}

TEST_CASE("StartRefusal: an already-started room says so") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms);
    REQUIRE(rooms.SetReady(roomId, kHost, true));
    REQUIRE(rooms.StartGame(roomId, kHost));

    // This is the double-click case, and the one D2's post-game policy
    // leaves reachable while a finished room waits for its server to exit.
    CHECK(rooms.GetRoom(roomId)->StartRefusalReason(kHost) ==
          "this room has already started");
}
