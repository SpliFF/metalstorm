#pragma once

#include <cstdint>
#include <vector>

struct GameServerContext;

// StateStreamer — owns the per-tick broadcast pipeline that used to be a long
// sequence of blocks at the tail of the server_main.cpp sim loop. Tick() calls
// each private streaming method in the EXACT source order (the order is
// behaviour: lanes, drains and LOS filtering depend on it). Pure relocation:
// each block body is carried over verbatim, referencing the same globals and
// event-collector singletons directly; the only main()-locals lifted to
// members are the win-check + team-stats cursors.
class StateStreamer {
public:
    explicit StateStreamer(GameServerContext& ctx) : ctx(ctx) {}

    void Tick(int frameNum);

private:
    void CheckWinCondition(int frameNum);
    void StreamResources(int frameNum);
    void StreamCommandQueues(int frameNum);
    void BroadcastGameInfo(int frameNum);
    void StreamEntityState(int frameNum);
    void StreamPieceState(int frameNum);
    void StreamBuildActivity(int frameNum);
    void EvaluateStandingOrders(int frameNum);
    void TickAI(int frameNum);
    void BroadcastCombatEvents(int frameNum);
    void BroadcastEntityDeaths(int frameNum);
    void BroadcastSensorUpdates(int frameNum);
    void BroadcastDecals(int frameNum);
    void BroadcastHeightmapUpdates(int frameNum);
    void BroadcastSendToUnsynced(int frameNum);
    void BroadcastPlayerTeamEvents(int frameNum);
    void BroadcastTeamStats(int frameNum);
    void PumpLuaRulesMsgLoopback(int frameNum);
    void BroadcastUnitLifecycle(int frameNum);
    void BroadcastFeatureLifecycle(int frameNum);
    void BroadcastUnitCommands(int frameNum);
    void StreamLosBitmaps(int frameNum);

    GameServerContext& ctx;

    // Last-team-standing fallback latch (was a function-static int in the loop):
    // the team the alive-unit count declared the winner, or -1 while undecided.
    int winningTeam = -1;
    // Set once the game-over GameInfo has been broadcast (via either the Lua
    // `Spring.GameOver` relay or the fallback). Gates the periodic BroadcastGameInfo
    // off afterward and stops CheckWinCondition re-firing. Distinct from
    // winningTeam so the Lua path (which has no single winning *team*) can latch
    // game-over without claiming team 0 won.
    bool gameOverSent = false;

    // Per-team stats-history send cursor (PLAN-bar Spring.GetTeamStatsHistory).
    std::vector<uint32_t> lastSentStatFinalized;
    int lastStatBroadcastClients = 0;

    // Newest-wins State-tier lanes (WebTransportServer GW2). Each distinct
    // logical State stream needs its own lane so a new send only supersedes the
    // prior send of the *same* stream.
    static constexpr uint32_t kStateLaneEntity = 0;
    static constexpr uint32_t kStateLanePiece  = 1;
};
