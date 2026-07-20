#pragma once

#include <cstdint>
#include <vector>

#include "Lua/LuaRulesParams.h"

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
    void BroadcastRulesParams(int frameNum);

    GameServerContext& ctx;

    // Rules-param wire producer baselines (BroadcastRulesParams). We diff the
    // live synced param maps against these last-sent copies each tick to
    // detect changes; deltas go to already-snapshotted sessions, a full
    // snapshot to fresh joiners. Copied by value so we retain the *old* `los`
    // of a key when it's deleted (needed to decide who to tell to drop it).
    LuaRulesParams::Params lastGameParams;
    std::vector<LuaRulesParams::Params> lastTeamParams;  // indexed by teamID

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

    // Per-topic EVENT lanes (PLAN-metalstorm-wire.md W1). Reliable streams on
    // distinct lanes prevent QUIC head-of-line blocking — a lost/retransmitted
    // bulk packet (defs, decals) can't delay a combat event. Lane values are
    // logical separators; the StreamClass (Control/Vision/Bulk) + lane pair
    // maps to an independent QUIC stream.
    static constexpr uint32_t kEventLaneCombat  = 0; // combat events, volleys, projectiles, sounds
    static constexpr uint32_t kEventLaneParams  = 1; // rulesParams (game/team)
    static constexpr uint32_t kEventLaneOrders  = 2; // directives, commands (future)
    static constexpr uint32_t kEventLaneDecals  = 3; // decals, track segments
    static constexpr uint32_t kEventLaneControl = 4; // GameInfo, game-over, player join/leave, chat
};
