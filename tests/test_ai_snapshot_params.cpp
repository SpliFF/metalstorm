// test_ai_snapshot_params — which GAME-scoped rulesParams reach an AI.
//
// BuildAISnapshot itself needs unitHandler/losHandler and is verified on the
// running stack; the visibility rule it applies to CSplitLuaHandle's game
// params is pure, and it is the rule that decides whether the strategos can
// even SEE a parley proposal addressed to it (journey-tutorial's recon_01
// stalled on exactly this: game_parley.lua publishes with the engine's
// default private los, and the F11 PUBLIC-only filter dropped every key).

#include <doctest/doctest.h>

#include "Server/AI/AIStateSnapshot.h"
#include "Lua/LuaRulesParams.h"

namespace {
constexpr int kPrivate = LuaRulesParams::RULESPARAMLOS_PRIVATE;
constexpr int kPublic  = LuaRulesParams::RULESPARAMLOS_PRIVATE
                       | LuaRulesParams::RULESPARAMLOS_PUBLIC;
}

TEST_CASE("AI snapshot game params: public entries always travel") {
    CHECK(AISnapshotGameParamVisible("region_grey_flat_team", kPublic));
    CHECK(AISnapshotGameParamVisible("objective_count", kPublic));
}

TEST_CASE("AI snapshot game params: private entries are dropped by default") {
    CHECK_FALSE(AISnapshotGameParamVisible("war_secret_thing", kPrivate));
    CHECK_FALSE(AISnapshotGameParamVisible("tutorial_beat_id", kPrivate));
    // A near-miss must not slip through the prefix test.
    CHECK_FALSE(AISnapshotGameParamVisible("parle", kPrivate));
    CHECK_FALSE(AISnapshotGameParamVisible("my_parley_count", kPrivate));
}

TEST_CASE("AI snapshot game params: the parley board is allow-listed") {
    // The exact keys game_parley.lua's publish() writes, and the trust ledger
    // the same board is valued against. All are readable by every player's
    // Lua already (GetGameRulesParam serves GAME scope with PRIVATE_MASK), so
    // this is parity with a human client, not a cheat channel.
    CHECK(AISnapshotGameParamVisible("parley_count", kPrivate));
    CHECK(AISnapshotGameParamVisible("parley_1_kind", kPrivate));
    CHECK(AISnapshotGameParamVisible("parley_1_to", kPrivate));
    CHECK(AISnapshotGameParamVisible("parley_1_state", kPrivate));
    CHECK(AISnapshotGameParamVisible("parley_event_0_kind", kPrivate));
    CHECK(AISnapshotGameParamVisible("trust_0_1", kPrivate));
    // …and stay visible when a gadget does mark them public.
    CHECK(AISnapshotGameParamVisible("parley_count", kPublic));
}
