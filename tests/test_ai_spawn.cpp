// test_ai_spawn — the mid-game AI spawn hook's decidable half
// (PLAN-metalstorm-ai.md §10 task 4(b), rts/Server/AI/AISpawn.h).
//
// The hook has three parts and only two of them are testable without a sim:
// the relay synced Lua declares into, the policy that decides one request, and
// the plugin resolver both staging paths share. The third — registering the
// virtual player, firing PlayerAdded into synced Lua and loading the VM — needs
// playerHandler/teamHandler/luaRules and is verified on the running stack
// (same split as PlayerOnboarding's, see test_player_onboarding.cpp).

#include <doctest/doctest.h>

#include "Server/AI/AISpawn.h"

#include <string>

TEST_CASE("task 4(b): a request for an emptied side with no AI is accepted") {
    CHECK(DecideAISpawn(/*teamId=*/1, "strategos", /*teamHasActiveAI=*/false,
                        /*gameStarted=*/true) == AISpawnVerdict::Spawn);
    // Team 0 is a real team, not a "no team" sentinel — the whole point of the
    // hook is a side that emptied, and side 0 empties as readily as any other.
    CHECK(DecideAISpawn(0, "strategos", false, true) == AISpawnVerdict::Spawn);
}

TEST_CASE("task 4(b): a side that still has an AI is refused") {
    // This is the case that already worked before the hook existed: an AI on
    // the team upgrades itself from co-commander to the full-side goal when the
    // humans leave. A second brain would contend with it for one authority pool
    // and one set of org groups.
    CHECK(DecideAISpawn(1, "strategos", /*teamHasActiveAI=*/true, true) ==
          AISpawnVerdict::RefuseTeamHasAI);
}

TEST_CASE("task 4(b): structural refusals name themselves") {
    CHECK(DecideAISpawn(-1, "strategos", false, true) == AISpawnVerdict::RefuseNoTeam);
    CHECK(DecideAISpawn(1, "", false, true) == AISpawnVerdict::RefuseNoId);
    // Pre-GameStart the `--ai` slots own the roster and are registered as a
    // block; a spawn racing that block would change which player leads a team.
    CHECK(DecideAISpawn(1, "strategos", false, /*gameStarted=*/false) ==
          AISpawnVerdict::RefuseNotStarted);
    // Every verdict has a distinct operator-facing name — a caretaker that did
    // not arrive is indistinguishable from one that arrived and did nothing
    // unless the log says which refusal it was.
    CHECK(std::string(AISpawnVerdictName(AISpawnVerdict::RefuseNoTeam)) !=
          std::string(AISpawnVerdictName(AISpawnVerdict::RefuseTeamHasAI)));
    CHECK(std::string(AISpawnVerdictName(AISpawnVerdict::Spawn)) == "spawn");
}

TEST_CASE("task 4(b): the relay keeps declaration order and drains once") {
    AISpawnRelay relay;
    CHECK(relay.PendingCount() == 0);
    CHECK(relay.Drain().empty());

    CHECK(relay.Request({/*teamId=*/2, "strategos"}));
    CHECK(relay.Request({/*teamId=*/5, "strategos"}));
    CHECK(relay.PendingCount() == 2);

    const auto drained = relay.Drain();
    REQUIRE(drained.size() == 2);
    CHECK(drained[0].teamId == 2);
    CHECK(drained[1].teamId == 5);
    // Drained means consumed: a second drain in the same tick must not re-seat
    // the same AI twice.
    CHECK(relay.PendingCount() == 0);
    CHECK(relay.Drain().empty());
}

TEST_CASE("task 4(b): a second request for one team is refused while pending") {
    // The caretaker hook fires from PlayerRemoved, which runs once per leaver:
    // a three-human side emptying calls ActivateCaretaker three times in one
    // frame. Without this the drain would seat three brains on one side —
    // the has-an-AI check cannot see a request that has not been drained yet.
    AISpawnRelay relay;
    CHECK(relay.Request({3, "strategos"}));
    CHECK_FALSE(relay.Request({3, "strategos"}));
    CHECK_FALSE(relay.Request({3, "other_ai"}));
    CHECK(relay.PendingCount() == 1);

    // Once drained the team is requestable again — the drain's own refusal
    // (team already has an AI) is what stops a duplicate from that point on,
    // and a request that the drain REFUSED must be retryable.
    relay.Drain();
    CHECK(relay.Request({3, "strategos"}));
}

TEST_CASE("task 4(b): the resolver finds the shipped strategos plugin") {
    // The same call the start-up `--ai` staging block makes, so this is a
    // regression test for both paths at once: if discovery or the entry-path
    // rule changes under one, this fails for both.
    const std::string gamePath = std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm";
    const std::string enginePath = std::string(SPRING_SOURCE_DIR) + "/content/engine";

    ResolvedAIPlugin plugin;
    std::string err;
    REQUIRE_MESSAGE(ResolveAIPlugin(enginePath, gamePath, "strategos", plugin, err),
                    err);
    CHECK(plugin.id == "strategos");
    CHECK_FALSE(plugin.isLuaAI);
    CHECK_FALSE(plugin.folderPath.empty());
    // The entry buffer is slurped, not merely located: the runtime spawn hands
    // this string straight to AIRuntimePool::AddAI.
    CHECK(plugin.code.find("function onUpdate") != std::string::npos);
}

TEST_CASE("task 4(b): an unknown plugin id fails with a reason, not a crash") {
    const std::string gamePath = std::string(SPRING_SOURCE_DIR) + "/data/games/metalstorm";
    const std::string enginePath = std::string(SPRING_SOURCE_DIR) + "/content/engine";

    ResolvedAIPlugin plugin;
    std::string err;
    CHECK_FALSE(ResolveAIPlugin(enginePath, gamePath, "no_such_ai", plugin, err));
    CHECK(err.find("no_such_ai") != std::string::npos);

    CHECK_FALSE(ResolveAIPlugin(enginePath, gamePath, "", plugin, err));
    CHECK_FALSE(err.empty());
}
