#include <doctest/doctest.h>

#include "Server/RoomManager.h"

// PLAN-metalstorm-wars.md §7.4 / PLAN-endtoend.md D19 — a room slot picks a
// SIDE, and the room's `war_sides` modoption says which team each side is
// seated on.
//
// RoomManager knows nothing about scenarios and gains nothing here: as far as
// it is concerned `war_sides` is just "which team indices does this room use".
// That is the whole contract these tests pin down — the integers, the legacy
// fallback, and the two places a team gets chosen for somebody.
//
// The defect behind them: the room's team assignment was hardcoded to 0-vs-1,
// so on Meridian Basin (whose sides are teams 0 and 4) the AI opponent was
// seated on team 1 — a team the scenario declares a compact *teammate* and
// stages no units for. Measured live at frame 1169: team 0 = 13 units,
// team 1 = 0 units. The war had one army.
//
// No sqlite3* is attached, so these exercise the in-memory state machine only.

namespace {

uint32_t makeRoom(RoomManager& rooms, const std::string& warSides,
                  uint8_t maxPlayers = 4) {
    const uint32_t roomId = rooms.CreateRoom(
        "war room", "meridian_basin", "metalstorm", maxPlayers,
        /*password=*/"", /*hostPlayerId=*/1, /*hostClientId=*/1, "host");
    if (!warSides.empty())
        rooms.SetModOption(roomId, /*playerId=*/1, "war_sides", warSides);
    return roomId;
}

} // namespace

TEST_CASE("SlotTeams: reads the team indices out of war_sides") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{0, 4});
}

TEST_CASE("SlotTeams: no war_sides is the legacy two-team room") {
    // Paper Tanks and ZK ship no scenarios at all and must keep the room they
    // have always had.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{0, 1});
}

TEST_CASE("SlotTeams: an empty war_sides is also the legacy room") {
    // applyWarSides writes "" for a scenario-less room rather than leaving a
    // stale list behind, so this value is reached in normal operation.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "");
    rooms.SetModOption(roomId, 1, "war_sides", "");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{0, 1});
}

TEST_CASE("SlotTeams: a single-side scenario yields a single slot team") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "solo:3");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{3});
}

TEST_CASE("SlotTeams: garbage entries are dropped, not read as team 0") {
    // atoi() would turn "union:x" into team 0 and quietly seat two sides on
    // the same team, which looks exactly like a working room until nobody has
    // an opponent.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:x,third:,:9,,r:7");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{0, 7});
}

TEST_CASE("SlotTeams: wholly unparseable war_sides falls back to the legacy room") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "nonsense");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{0, 1});
}

TEST_CASE("SlotTeams: a duplicate team is listed once") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "a:2,b:2,c:5");
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{2, 5});
}

TEST_CASE("JoinRoom: a joiner lands on a side the war stages, not on team 1") {
    // The D19 shape. The host holds compact (team 0); the next player must
    // land on union (team 4), which is where the union's army is — not on
    // team 1, which is a compact teammate slot with nothing on it.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");

    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2, "joiner",
                           /*password=*/"", /*asSpectator=*/false));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4);
}

TEST_CASE("JoinRoom: an AI already holding a side pushes the joiner elsewhere") {
    // The auto-balance counts AI slots as occupants, so a human joining a room
    // whose only opponent is an AI does not land on top of it.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.AddAISlot(roomId, /*hostId=*/1, "strategos", "Strategos",
                            /*team=*/4));

    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2, "joiner",
                           /*password=*/"", /*asSpectator=*/false));
    // Both sides now hold one occupant each, so the joiner takes the
    // least-occupied side in offer order — compact, alongside the host.
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 0);
}

TEST_CASE("JoinRoom: a legacy room still round-robins 0 and 1") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "");

    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "b", "", false));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 1);
    REQUIRE(rooms.JoinRoom(roomId, 3, 3, "c", "", false));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(3)->team == 0);
}

TEST_CASE("EnlistSpectator: auto-assign picks a free side, not team index 1") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2, "watcher",
                           /*password=*/"", /*asSpectator=*/true));

    REQUIRE(rooms.EnlistSpectator(roomId, /*playerId=*/2, /*team=*/255));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4);
}

TEST_CASE("EnlistSpectator: falls back to the first side when all are taken") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.AddAISlot(roomId, 1, "strategos", "Strategos", 4));
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "watcher", "", /*asSpectator=*/true));

    REQUIRE(rooms.EnlistSpectator(roomId, 2, /*team=*/255));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 0);
}

// --- faction seating (PLAN-endtoend.md D40) ---------------------------------
//
// `war_sides` carries `faction:team` and SlotTeams() threw the names away, so
// an account's permanent faction — chosen at sign-up, validated, stored — was
// read by nothing and the balancer seated players against it. Measured live
// twice: `e2e19south` and `e2e26south` both registered `union` and both landed
// on team 0, compact.

TEST_CASE("SideTeams: keeps the faction names SlotTeams drops") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    const auto sides = rooms.GetRoom(roomId)->SideTeams();
    REQUIRE(sides.size() == 2);
    CHECK(sides.at(0) == std::pair<std::string, uint8_t>{"compact", 0});
    CHECK(sides.at(1) == std::pair<std::string, uint8_t>{"union", 4});
}

TEST_CASE("SideTeams: a legacy room declares no sides at all") {
    // SlotTeams() invents {0,1} for a room with no war_sides; SideTeams()
    // must NOT, or TeamForFaction would match a name nobody declared.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "");
    CHECK(rooms.GetRoom(roomId)->SideTeams().empty());
    CHECK(rooms.GetRoom(roomId)->SlotTeams() == std::vector<uint8_t>{0, 1});
}

TEST_CASE("TeamForFaction: resolves a declared side, refuses everything else") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    const GameRoom *room = rooms.GetRoom(roomId);
    CHECK(room->TeamForFaction("union") == 4);
    CHECK(room->TeamForFaction("compact") == 0);
    CHECK_FALSE(room->TeamForFaction("reavers").has_value());
    // An account with no faction never matches — that is what keeps dev and
    // manifest accounts on the old balance path.
    CHECK_FALSE(room->TeamForFaction("").has_value());
    // Exact match only: a faction id comes from the same sidedata.lua the
    // scenario names, so a near-miss is a bug to see, not to guess at.
    CHECK_FALSE(room->TeamForFaction("Union").has_value());
}

TEST_CASE("JoinRoom: a union account is seated on union, not on the emptier side") {
    // The D40 shape, and it fails pre-fix: compact holds the host, union is
    // empty, so the balancer would have put the union player on... union. To
    // make the balancer's answer the WRONG one, give union the occupants.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.AddAISlot(roomId, /*hostId=*/1, "strategos", "A", 4));
    REQUIRE(rooms.AddAISlot(roomId, /*hostId=*/1, "strategos", "B", 4));

    REQUIRE(rooms.JoinRoom(roomId, /*playerId=*/2, /*clientId=*/2, "southerner",
                           /*password=*/"", /*asSpectator=*/false,
                           /*factionId=*/"union"));
    // Balance says compact (1 occupant vs 3). Allegiance says union.
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4);
}

TEST_CASE("JoinRoom: two players of the same faction share the side") {
    // The corollary, stated so it is a decision and not a surprise: faction
    // seating does not balance, and cannot, because allegiance is permanent.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "a", "", false, "union"));
    REQUIRE(rooms.JoinRoom(roomId, 3, 3, "b", "", false, "union"));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4);
    CHECK(rooms.GetRoom(roomId)->FindPlayer(3)->team == 4);
}

TEST_CASE("JoinRoom: a faction the war does not declare falls back to balance") {
    // Not every scenario stages every faction. The joiner still gets a seat.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "reaver", "", false, "reavers"));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4); // least-occupied
}

TEST_CASE("JoinRoom: no faction is the old balance behaviour, unchanged") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "devacct", "", false, ""));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4);
}

TEST_CASE("JoinRoom: a legacy room ignores faction entirely") {
    // Paper Tanks has no sidedata and no war_sides; a faction-carrying account
    // joining one must not be seated by a name the room never declared.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "");
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "b", "", false, "union"));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 1);
}

TEST_CASE("JoinRoom: a spectator's faction seats nobody") {
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "watcher", "", /*asSpectator=*/true,
                           "union"));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->isSpectator);
}

TEST_CASE("EnlistSpectator: auto-assign honours the faction captured at join") {
    // The spectator's faction is remembered on RoomPlayer, so enlisting needs
    // no second lookup. Union is the more crowded side, so a balance answer
    // here would be compact.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.AddAISlot(roomId, 1, "strategos", "A", 4));
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "watcher", "", /*asSpectator=*/true,
                           "union"));

    REQUIRE(rooms.EnlistSpectator(roomId, 2, /*team=*/255));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 4);
    CHECK_FALSE(rooms.GetRoom(roomId)->FindPlayer(2)->isSpectator);
}

TEST_CASE("EnlistSpectator: an explicit team still wins over the faction") {
    // 255 means "choose for me". Anything else is somebody choosing on
    // purpose, and war_sides is an offer rather than a whitelist (§7.4) — the
    // direct-start manifests depend on that escape hatch.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.JoinRoom(roomId, 2, 2, "watcher", "", true, "union"));
    REQUIRE(rooms.EnlistSpectator(roomId, 2, /*team=*/0));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(2)->team == 0);
}

TEST_CASE("CreateRoom: the host's faction rides along for later seating") {
    // CreateRoom cannot seat by faction — the room has no war_sides yet, the
    // caller applies the scenario afterwards — so it records the faction and
    // the lobby's seatHostOnSide settles the side once the sides exist.
    RoomManager rooms;
    const uint32_t roomId = rooms.CreateRoom(
        "war room", "meridian_basin", "metalstorm", 4, "", /*hostPlayerId=*/1,
        /*hostClientId=*/1, "host", /*persistent=*/false,
        /*hostFactionId=*/"union");
    const RoomPlayer *host = rooms.GetRoom(roomId)->FindPlayer(1);
    CHECK(host->factionId == "union");
    CHECK(host->team == 0); // provisional, as documented
    rooms.SetModOption(roomId, 1, "war_sides", "compact:0,union:4");
    CHECK(rooms.GetRoom(roomId)->TeamForFaction(host->factionId) == 4);
}

TEST_CASE("AddAISlot still accepts a team no side declares") {
    // Deliberate (§7.4): war_sides is what the lobby OFFERS, not a whitelist.
    // The direct-start manifests seat Meridian's reaver NPC on team 8, and
    // that escape hatch is the only reason D19 was diagnosable at all — the
    // fix was proven by POSTing the AI onto team 4 before any of this existed.
    RoomManager rooms;
    const uint32_t roomId = makeRoom(rooms, "compact:0,union:4");
    REQUIRE(rooms.AddAISlot(roomId, 1, "strategos", "Reavers", /*team=*/8));
    CHECK(rooms.GetRoom(roomId)->aiSlots.at(0).team == 8);
    CHECK(rooms.SetTeam(roomId, /*playerId=*/1, /*team=*/6));
    CHECK(rooms.GetRoom(roomId)->FindPlayer(1)->team == 6);
}
