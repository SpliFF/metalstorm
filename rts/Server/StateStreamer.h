#pragma once

#include <cstdint>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <string>

#include "Lua/LuaRulesParams.h"
#include "AI/AICommandQueue.h"

#include "Server/RulesParamKeyDict.h"
#include "Server/IdRecycleAnnouncer.h"

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

    /// PLAN-long-uptime §3 (S1) growth metrics. Assigned interned ids,
    /// excluding the reserved id 0. Monotone between compactions, so pairing
    /// it with the revision below is what distinguishes "the dictionary is
    /// growing" from "compaction is running and it is still growing".
    size_t KeyDictionarySize() const {
        return idToKey.empty() ? 0 : idToKey.size() - 1;
    }
    uint32_t KeyDictionaryRev() const { return keyDictionaryRev; }

private:
    void CheckWinCondition(int frameNum);
    void ReannounceGameOver();
    void StreamResources(int frameNum);
    void StreamCommandQueues(int frameNum);
    void BroadcastGameInfo(int frameNum);
    void StreamEntityState(int frameNum);
    void StreamPieceState(int frameNum);
    void StreamBuildActivity(int frameNum);
    void EvaluateStandingOrders(int frameNum);
    void TickAI(int frameNum);
    /// Apply one batch of AI commands. Shared by the live drain and the replay
    /// feed so both go through the identical manager calls + charge callins
    /// (PLAN-replay task 2).
    void ApplyAICommands(const std::vector<AICommand>& cmds);
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

    // W3 helpers
    uint16_t InternKey(const std::string& key);
    void SendKeyDictionary(int clientId);

    /// PLAN-long-uptime S1: rebuild the interned-key dictionary from the keys
    /// that are still live, dropping ids nothing references any more, and bump
    /// keyDictionaryRev so every session re-syncs. `liveKeys` must be the
    /// complete set of keys any message on this tick can name — a key that is
    /// live but missing from the set would be re-interned to a *different* id
    /// than the one a client already holds. Returns true if it compacted.
    bool CompactKeyDictionary(const std::unordered_set<std::string>& liveKeys);

    GameServerContext& ctx;

    // Rules-param wire producer baselines (BroadcastRulesParams). We diff the
    // live synced param maps against these last-sent copies each tick to
    // detect changes; deltas go to already-snapshotted sessions, a full
    // snapshot to fresh joiners. Copied by value so we retain the *old* `los`
    // of a key when it's deleted (needed to decide who to tell to drop it).
    LuaRulesParams::Params lastGameParams;
    std::vector<LuaRulesParams::Params> lastTeamParams;  // indexed by teamID

    // W3: Key interning for rulesParams optimization
    std::unordered_map<std::string, uint16_t> keyToId;  // string key → interned ID
    std::vector<std::string> idToKey;                   // ID → string (0 reserved)
    uint32_t keyDictionaryRev = 1;                      // incremented on dictionary change
    // S1 compaction bookkeeping. The dictionary is append-only within a tick;
    // the question "how many of these ids are dead?" is only worth asking
    // occasionally, because answering it walks every live param map.
    uint32_t keyDictTickCounter = 0;
    static constexpr uint32_t kKeyDictCompactPeriodTicks = 9000;  // ~5 min at 30 Hz
    static constexpr size_t   kKeyDictCompactMinDead = 512;       // absolute floor
    static constexpr size_t   kKeyDictCompactMinDeadPct = 25;     // and ≥25% dead
    uint32_t gameParamsRev = 0;                         // generation counter for game params
    std::vector<uint32_t> teamParamsRev;                // per-team generation counters

    // Last-team-standing fallback latch (was a function-static int in the loop):
    // the team the alive-unit count declared the winner, or -1 while undecided.
    int winningTeam = -1;
    // Set once the game-over GameInfo has been broadcast (via either the Lua
    // `Spring.GameOver` relay or the fallback). Gates the periodic BroadcastGameInfo
    // off afterward and stops CheckWinCondition re-firing. Distinct from
    // winningTeam so the Lua path (which has no single winning *team*) can latch
    // game-over without claiming team 0 won.
    bool gameOverSent = false;
    // Ticks since the game-over GameInfo first went out, for the post-game
    // re-broadcast (PLAN-endtoend.md D36 — see StateStreamer::Tick). Counts
    // ticks, not frames: the frame is frozen after game over, so every
    // `frame % N` cadence in this file is unusable past that point.
    int postGameTicks = 0;
    // Re-announce the retained result about once a second at 1x. Cheap (a
    // GameInfo is ~100 bytes) and bounded by the post-game observation window,
    // after which the process exits.
    static constexpr int kPostGameResendTicks = 30;

    // Per-team stats-history send cursor (PLAN-bar Spring.GetTeamStatsHistory).
    std::vector<uint32_t> lastSentStatFinalized;
    int lastStatBroadcastClients = 0;

    // PLAN-long-uptime S5 task 6 — unit-id recycle announcement. The window
    // discipline (raise on the epoch move, retire on a LATER full snapshot)
    // lives in the pure header so it can be tested; this streamer only feeds
    // it the epoch and ORs the flag into the field mask.
    EntityState::IdRecycleAnnouncer idRecycleAnnouncer;

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
