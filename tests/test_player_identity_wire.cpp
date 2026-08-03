#include <doctest/doctest.h>

#include "protocol_generated.h"

#include <cstdint>
#include <string>
#include <vector>

// The wire half of PLAN-endtoend.md D3: a session has TWO identities and the
// protocol must be able to carry both.
//
//   AuthResponse.player_id  = DB account id   (stable across games)
//   AuthResponse.player_num = Spring playerNum (per game server, sim-scoped)
//
// They coincide only by accident on low-id dev accounts. When the client had
// only the first and used it as the second, Metalstorm's authority HUD read
// `authority_player_<accountId>` — a key the server never writes — and showed
// 0 forever. These tests pin the shape the fix depends on; the identity
// contract itself is PLAN-native-ui.md §3.3.
//
// Deliberately against the generated bindings, not against Protocol.h's
// builders: `rts/protocol_generated.h` is a checked-in copy that shadows the
// generated one, so a schema edit that was never re-synced would otherwise
// compile fine and fail only at runtime.

using namespace SpringWeb;

TEST_CASE("AuthResponse carries the account id and the sim playerNum separately") {
    flatbuffers::FlatBufferBuilder fbb(256);
    // The measured live case: account 59, playerNum 1 (the strategos AI holds 0).
    auto resp = CreateAuthResponseDirect(fbb, AuthStatus_OK, "tok",
        /*player_id=*/59, /*message=*/"", /*team=*/0, "player", "cachekey",
        /*player_num=*/1);
    fbb.Finish(CreateServerMessage(fbb, ServerPayload_AuthResponse, resp.Union()));

    const auto* msg = flatbuffers::GetRoot<ServerMessage>(fbb.GetBufferPointer());
    REQUIRE(msg->payload_type() == ServerPayload_AuthResponse);
    const auto* ar = msg->payload_as_AuthResponse();
    REQUIRE(ar != nullptr);

    CHECK(ar->player_id() == 59u);
    CHECK(ar->player_num() == 1);
    CHECK(ar->team() == 0);
    // The bug in one line: these must be able to differ.
    CHECK(static_cast<int32_t>(ar->player_id()) != ar->player_num());
}

TEST_CASE("AuthResponse.player_num defaults to -1 when unset (the lobby has no sim)") {
    flatbuffers::FlatBufferBuilder fbb(256);
    auto resp = CreateAuthResponseDirect(fbb, AuthStatus_OK, "tok", /*player_id=*/59);
    fbb.Finish(CreateServerMessage(fbb, ServerPayload_AuthResponse, resp.Union()));

    const auto* ar = flatbuffers::GetRoot<ServerMessage>(fbb.GetBufferPointer())->payload_as_AuthResponse();
    REQUIRE(ar != nullptr);
    // -1, not 0 — 0 is a perfectly valid playerNum (the AI usually holds it),
    // so it can never double as "absent".
    CHECK(ar->player_num() == -1);
}

TEST_CASE("PlayerRoster round-trips humans and AI virtual players") {
    flatbuffers::FlatBufferBuilder fbb(512);
    std::vector<flatbuffers::Offset<PlayerEntry>> entries;
    // playerNum 0 is the AI: virtual players are registered before any client
    // connects, so a human's playerNum starts at 1.
    entries.push_back(CreatePlayerEntryDirect(fbb, 0, "AI:strategos@t1",
        /*team=*/1, /*ally_team=*/1, /*spectator=*/false, /*is_ai=*/true,
        /*active=*/true, /*account_id=*/0));
    entries.push_back(CreatePlayerEntryDirect(fbb, 1, "e2e_north",
        /*team=*/0, /*ally_team=*/0, /*spectator=*/false, /*is_ai=*/false,
        /*active=*/true, /*account_id=*/59));
    // A spectator has no team, so no ally team either.
    entries.push_back(CreatePlayerEntryDirect(fbb, 2, "watcher",
        /*team=*/-1, /*ally_team=*/-1, /*spectator=*/true, /*is_ai=*/false,
        /*active=*/false, /*account_id=*/61));
    auto roster = CreatePlayerRosterDirect(fbb, &entries);
    fbb.Finish(CreateServerMessage(fbb, ServerPayload_PlayerRoster, roster.Union()));

    const auto* msg = flatbuffers::GetRoot<ServerMessage>(fbb.GetBufferPointer());
    REQUIRE(msg->payload_type() == ServerPayload_PlayerRoster);
    const auto* pr = msg->payload_as_PlayerRoster();
    REQUIRE(pr != nullptr);
    REQUIRE(pr->players() != nullptr);
    REQUIRE(pr->players()->size() == 3);

    const auto* ai = pr->players()->Get(0);
    CHECK(ai->player_num() == 0);
    CHECK(ai->is_ai());
    CHECK(ai->name()->str() == "AI:strategos@t1");
    // An AI has no account, and that must not be mistaken for account 0.
    CHECK(ai->account_id() == 0u);

    const auto* human = pr->players()->Get(1);
    CHECK(human->player_num() == 1);
    CHECK_FALSE(human->is_ai());
    CHECK(human->account_id() == 59u);
    CHECK(human->team() == 0);
    CHECK(human->ally_team() == 0);

    const auto* spec = pr->players()->Get(2);
    CHECK(spec->spectator());
    CHECK(spec->team() == -1);
    CHECK(spec->ally_team() == -1);
    // Kept, not dropped, so a scoreboard can still name a player who left.
    CHECK_FALSE(spec->active());
}

TEST_CASE("PlayerEntry defaults describe an unknown, active, non-AI player") {
    flatbuffers::FlatBufferBuilder fbb(256);
    std::vector<flatbuffers::Offset<PlayerEntry>> entries{
        CreatePlayerEntryDirect(fbb, 4, "solo"),
    };
    auto roster = CreatePlayerRosterDirect(fbb, &entries);
    fbb.Finish(CreateServerMessage(fbb, ServerPayload_PlayerRoster, roster.Union()));

    const auto* p = flatbuffers::GetRoot<ServerMessage>(fbb.GetBufferPointer())
        ->payload_as_PlayerRoster()->players()->Get(0);
    CHECK(p->team() == -1);
    CHECK(p->ally_team() == -1);
    CHECK_FALSE(p->spectator());
    CHECK_FALSE(p->is_ai());
    CHECK(p->active());
    CHECK(p->account_id() == 0u);
}
