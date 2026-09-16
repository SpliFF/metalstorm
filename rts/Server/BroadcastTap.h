// BroadcastTap — the recorder half of delayed spectating (PLAN-beta.md
// "Design decisions — delayed spectating", PLAN-beta-broadcast.md lane S1).
//
// THE TAP IS A SPECTATOR, NOT A SERIALISER
// ----------------------------------------
// The tap is a `ClientSession` with `role="spectator"` and
// `SpectatorVisibilityMode::Global`, registered in the SessionManager under a
// reserved client id. Every per-session fan-out in StateStreamer therefore
// includes it *for free* and — this is the whole point — the intel filter has
// already run by the time the bytes reach the funnel. The log can only ever
// contain what a global spectator was entitled to see; there is no separate
// "what may a watcher see" rule to keep in sync, and so no way for the two to
// drift apart.
//
// It is deliberately NOT in `playerHandler` and NOT in `clientPlayerNum`, the
// same rule replay spectators follow (ReplayPlayer.h): a session visible to
// synced Lua mints rules params the untapped mission would not have, which
// would make recording a game change the game.
//
// `kTapClientId` must be disjoint from BOTH id spaces already in use: real
// QUIC clients (allocated from 1 upward) and replay's virtual range
// (`replay::kVirtualClientBase` = 0x40000000, tested by bit 30). 0x20000000
// clears bit 30, so `replay::IsVirtualClient(kTapClientId)` is false.
#pragma once

#include <chrono>
#include <cstdint>
#include <string>

#include "BroadcastLog.h"
#include "ClientSession.h"

namespace broadcast {

/// Reserved client id for the tap session. See the note above on disjointness.
constexpr ClientID kTapClientId = 0x20000000u;

/// Wall clock in ms — the pacing authority a relay replays the log against.
/// Safe to read here precisely because it is never fed back into the sim: the
/// tap records effects, it never causes one.
inline uint64_t NowMs() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

/// Keyframe cadence, pure so the cadence is testable without a server.
/// `lastKeyframeFrame < 0` means "none yet", which is why frame 0 keyframes.
inline bool ShouldKeyframe(int frame, int lastKeyframeFrame) {
    if (frame < 0) return false;
    if (lastKeyframeFrame < 0) return true;
    return frame - lastKeyframeFrame >= kKeyframeFrames;
}

/// The recorder. Owned by main(); reached by StateStreamer and the funnel
/// through `GameServerContext::broadcastTap`.
class Tap {
public:
    bool Open(const std::string& path, const replay::Header& h, std::string& err) {
        return log.Open(path, h, err);
    }
    bool Active() const { return log.Enabled(); }

    /// The frame every subsequent record is stamped with. Set once per tick;
    /// the funnel has no idea what frame it is and must not have to guess.
    void SetFrame(int f) { frame = f; }
    int Frame() const { return frame; }

    /// The funnel's sink. `cls`/`lane` come straight off the send; `broadcast`
    /// marks a `BroadcastStream` send, which a relay fans out to every watcher
    /// rather than addressing to one.
    void Sink(uint8_t cls, uint8_t lane, bool broadcastFlag,
              const uint8_t* data, size_t len) {
        log.AppendRecord(NowMs(), frame, cls, lane, broadcastFlag, data, len);
    }

    /// Write a `K` if the cadence says so. Returns true when one was written,
    /// which is the caller's cue to clear the tap session's join latches and
    /// re-emit the join bundle behind the marker.
    bool MaybeKeyframe(int f) {
        if (!Active() || !ShouldKeyframe(f, lastKeyframeFrame)) return false;
        log.AppendKeyframe(NowMs(), f);
        lastKeyframeFrame = f;
        return true;
    }

    void Flush() { log.Flush(); }
    void Close(int endFrame) {
        if (!Active()) return;
        Trailer t;
        t.endFrame  = endFrame;
        t.endWallMs = NowMs();
        log.Close(t);
    }

    const Writer& Log() const { return log; }

private:
    Writer log;
    int frame = 0;
    int lastKeyframeFrame = -1;
};

/// The stream-consumer rule (`GameServerContext::HasStreamConsumers`), pure so
/// the decision is testable without a server: a tapped mission must keep
/// streaming with nobody connected, because the log IS the audience.
inline bool HasStreamConsumers(int clientCount, const Tap* tap) {
    return clientCount > 0 || (tap != nullptr && tap->Active());
}

/// Register the tap's session. Called once, after the SessionManager exists and
/// before the first tick. Global visibility is the ClientSession default, but
/// it is set explicitly here because the log's intel guarantee rests on it.
inline void RegisterTapSession(SessionManager& sessions) {
    sessions.AddSession(kTapClientId, /*userId=*/0, "(broadcast-tap)", "spectator");
    if (ClientSession* s = sessions.GetSession(kTapClientId)) {
        s->spectatorVisibilityMode = SpectatorVisibilityMode::Global;
        s->spectatorVisibilityTeam = -1;
        s->team = -1;
    }
}

/// Clear everything that makes a session a *returning* one, so the next tick's
/// fan-out re-sends it the full picture instead of a delta. This is the
/// re-join behind a `K`: a watcher seeking to that keyframe replays the bundle
/// that follows and lands on a whole world, not half of one.
inline void ResetJoinLatches(ClientSession& s) {
    s.deltaCache.Clear();
    s.rulesParamsSnapshotSent = false;
    s.rulesParamsKeyDictRev = 0;
}

}  // namespace broadcast
