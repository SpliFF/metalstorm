/**
 * ReplayStateBroadcast — what a replay server tells its watchers about the
 * playback (PLAN-replay.md task 4b).
 *
 * A live game never sends `ReplayState`. That is the whole mode signal: the
 * client shows a playback bar iff it has received one, so the same build
 * serves live games and replays with no flag, no URL parameter and no guess
 * from the lobby. (4a had to hand-inject a room object to point a browser at a
 * replay server at all — T4a-2 — so a client-side mode flag would have had
 * nowhere honest to come from.)
 *
 * Per-client, not broadcast, and that is not an optimisation: `pov_team` is
 * this watcher's own fog choice, and `controller_player_num` is only
 * meaningful next to the reader's own player number. Everything else in the
 * message is shared. There are a handful of spectators on a replay, so a
 * per-client build costs nothing worth engineering around.
 */
#pragma once

#include "GameServerContext.h"
#include "Protocol.h"
#include "ClientSession.h"
#include "ReplayPlayer.h"
#include "ReplayControlDeck.h"
#include "Simulation.h"
#include "WebTransport/WebTransportServer.h"

#include <cstdint>
#include <vector>

namespace Protocol {

/// Everything that is the same for every watcher. Read once per broadcast.
inline ReplayStateFields CollectReplayState(GameServerContext& ctx) {
    ReplayStateFields f;
    const replay::Player& feed = replay::Feed();
    const replay::ControlDeck& deck = replay::Controls();
    const replay::Header& h = feed.GetHeader();

    f.startFrame   = h.startFrame;
    f.endFrame     = feed.EndFrame();
    f.currentFrame = ctx.sim.GetFrameNum();
    f.paused       = deck.Paused();
    f.speed        = deck.Speed();
    f.seeking      = deck.Seeking();
    f.seekTarget   = deck.SeekTarget();
    f.controllerPlayerNum = deck.Controller();
    f.truncated    = feed.Truncated();
    f.gameId       = h.gameId;
    f.mapId        = h.mapId;
    // Seek-bar ticks. Empty on every file written so far — nothing produces
    // checkpoint blobs until PLAN-persistence's sim serializer lands — which
    // is the same fact that makes a backward seek refusable rather than slow
    // (ReplayControlDeck.h). The client draws no ticks and says why.
    for (const auto& cp : feed.Checkpoints())
        f.checkpointFrames.push_back(cp.frame);
    return f;
}

/// Send the playback state to one watcher, stamped with ITS pov.
inline void SendReplayStateTo(GameServerContext& ctx, ClientID clientId) {
    if (!replay::IsReplaying()) return;
    ReplayStateFields f = CollectReplayState(ctx);
    if (auto* s = ctx.sessions.GetSession(clientId)) {
        f.povTeam = (s->spectatorVisibilityMode == SpectatorVisibilityMode::Team)
            ? s->spectatorVisibilityTeam : -1;
    }
    auto msg = BuildReplayState(f);
    ctx.rtcServer.SendReliable(clientId, msg.data(), msg.size());
}

/// Send it to every attached watcher. Called on any control that lands and on
/// a slow heartbeat so a bar that missed an update self-heals.
inline void BroadcastReplayState(GameServerContext& ctx) {
    if (!replay::IsReplaying()) return;
    const ReplayStateFields shared = CollectReplayState(ctx);
    std::vector<std::pair<ClientID, int>> targets;
    ctx.sessions.ForEachSession([&](ClientID id, ClientSession& s) {
        // Only sessions admitted as replay watchers. The recorded connections
        // are virtual — they have no transport to send to — and a live server
        // never reaches this function at all.
        if (s.replaySpectatorPlayerNum < 0) return;
        const int pov =
            (s.spectatorVisibilityMode == SpectatorVisibilityMode::Team)
                ? s.spectatorVisibilityTeam : -1;
        targets.emplace_back(id, pov);
    });
    for (const auto& [id, pov] : targets) {
        ReplayStateFields f = shared;
        f.povTeam = pov;
        auto msg = BuildReplayState(f);
        ctx.rtcServer.SendReliable(id, msg.data(), msg.size());
    }
}

// ── Broadcast relay (PLAN-beta-broadcast.md lane S2) ──────────────────────
//
// A relay reuses `ReplayState` rather than inventing a second bar: the client
// already shows playback UI iff it has received one, so a broadcast needs no
// new mode signal, only three more fields on the message it already draws.
//
// What it does NOT reuse is the controller rule. A replay is one shared
// timeline with one driver (ReplayControlDeck.h); a broadcast gives every
// watcher its own cursor over the same file, so `controller_player_num` is
// always the watcher's OWN number — the buttons are always yours, and nobody
// else's seek moves your picture.

/// One watcher's answer, gathered by the relay loop (server_main.cpp), which
/// owns the cursors. Nothing here is read off a sim: a relay never ticks one.
struct BroadcastStateFields {
    int32_t startFrame    = 0;
    int32_t endFrame      = 0;   ///< last frame the LOG holds
    int32_t liveEdgeFrame = 0;   ///< last frame the DELAY allows
    int32_t currentFrame  = 0;
    int32_t behindSeconds = 0;
    bool    paused        = false;
    float   speed         = 1.0f;
    bool    truncated     = false;   ///< no trailer: the mission is still live
    int32_t playerNum     = -1;      ///< this watcher's own number
    std::string gameId;
    std::string mapId;
};

inline std::vector<uint8_t> BuildBroadcastState(const BroadcastStateFields& f) {
    flatbuffers::FlatBufferBuilder fbb(256);
    // A broadcast seeks by keyframe, so the seek-bar ticks are real for the
    // first time — but the relay addresses them by wall time, and the bar is
    // drawn in frames, so they are left empty until the client lane needs them.
    const std::vector<int32_t> noCheckpoints;
    auto st = SpringWeb::CreateReplayStateDirect(fbb,
        f.startFrame, f.endFrame, f.currentFrame, f.paused, f.speed,
        /*seeking=*/false, /*seek_target=*/f.currentFrame,
        /*controller_player_num=*/f.playerNum,
        &noCheckpoints, f.truncated,
        f.gameId.empty() ? nullptr : f.gameId.c_str(),
        f.mapId.empty() ? nullptr : f.mapId.c_str(),
        /*pov_team=*/-1,          // a `.msb` is the global view and only that
        /*broadcast=*/true, f.behindSeconds, f.liveEdgeFrame);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_ReplayState, st.Union());
}

}  // namespace Protocol
