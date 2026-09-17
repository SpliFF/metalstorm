// BroadcastRelay — `spring-server --broadcast <log> --broadcast-delay-seconds N`
// (PLAN-beta.md "Design decisions — delayed spectating", PLAN-beta-broadcast.md
// lane S2).
//
// WHAT A RELAY IS
// ---------------
// A `.msb` log holds the EFFECTS a global-visibility spectator was sent, wall-
// stamped in send order (BroadcastLog.h). Relaying one is a memcpy and a clock:
// the process boots far enough to load the map and the game — so the content
// routes a client fetches defs and heightmaps from answer — and then never
// GameStarts and never ticks the sim. That is the whole reason the decision of
// record is "tap, not re-execution": a watch room costs no simulation.
//
// THE DELAY IS THE PRODUCT, SO IT IS ENFORCED HERE AND ONLY HERE
// --------------------------------------------------------------
// Delayed spectating exists so a mission can be watched without leaking intel
// to someone who is still fighting it. A client-side delay is not a delay, and
// neither is a modoption — a modoption is written by whoever spawns the room.
// So the floor is COMPILED IN (`kMinBroadcastDelaySec`), applied to the argv
// value with a max(), and the only thing that can lower it is
// `--dev-broadcast-floor`, a flag that exists for tests and says so in its name.
// Every cursor then answers to `liveEdgeMs = now - delayMs`: it never emits a
// record stamped past it, and a seek past it is clamped rather than refused.
//
// PER-WATCHER CURSORS
// -------------------
// Each watcher gets its own `Reader` over the same file and its own
// `BroadcastCursor`, so two people watch the same mission at independent
// positions with no shared timeline to fight over. `controller_player_num` is
// therefore the watcher's OWN number — unlike a replay cast, nobody drives
// anybody else, so there is no controller to hand around.
//
// BACKWARD SEEK WORKS, WHICH IS THE OTHER HALF OF THE DECISION
// ------------------------------------------------------------
// A replay cannot rewind (ReplayControlDeck.h: the sim cannot be un-run). A
// broadcast can, because a `K` keyframe is a re-emitted join bundle: seek to
// the nearest `K` at or before the target, then CATCH UP — replay the records
// between there and the target with Control/Vision/Bulk sent uncapped and only
// the LAST State record per lane. State lanes are newest-wins by construction
// (that is what a lane IS), so sending the intervening ones would be a slideshow
// of stale worlds ending on the same frame.
#pragma once

#include <cstdint>
#include <vector>

#include "BroadcastLog.h"

namespace broadcast {

/// The floor, in seconds, on how far behind live a broadcast may be served.
/// One hour. Compiled in, not configured: see the header comment.
constexpr int kMinBroadcastDelaySec = 3600;

/// Apply the floor. `floorSec` is `kMinBroadcastDelaySec` unless
/// `--dev-broadcast-floor` lowered it for a test; it is clamped to at least 0
/// so a negative flag value cannot turn the relay into a live feed.
inline int ClampDelaySeconds(int requestedSec, int floorSec = kMinBroadcastDelaySec) {
    if (floorSec < 0) floorSec = 0;
    return requestedSec < floorSec ? floorSec : requestedSec;
}

/// Wall-clock instant a watcher may not see past.
inline uint64_t LiveEdgeMs(uint64_t nowMs, int delaySec) {
    const uint64_t d = static_cast<uint64_t>(delaySec) * 1000ull;
    return nowMs > d ? nowMs - d : 0;
}

/// One record a cursor decided to send, flattened out of the reader so the
/// caller re-sends on the tier and lane it was recorded on rather than guessing.
struct Emission {
    uint8_t  cls   = 0;
    uint32_t lane  = 0;
    int32_t  frame = 0;
    uint64_t wallMs = 0;
    std::vector<uint8_t> payload;
};

/// Why a pump stopped, for the state message the watcher's bar is drawn from.
enum class PumpStop : uint8_t {
    Paused,    ///< the watcher paused
    AtEdge,    ///< the next record is past the live edge — the delay is biting
    AtTail,    ///< no complete record at the cursor (recorder mid-write, or done)
    Budget,    ///< hit the per-pump record cap; more is due immediately
};

/// Tracks the newest frame the delay currently lets ANYONE see, which is what
/// a watcher's bar draws its live-edge marker from. Advanced forward only (the
/// edge is `now - delay` and clocks do not run backwards), so the whole life of
/// a relay costs one pass over the log.
class LiveEdgeTracker {
public:
    void Attach(Reader* r) { reader = r; }
    void Advance(uint64_t liveEdgeMs);
    int32_t Frame() const { return frame; }
    uint64_t WallMs() const { return wallMs; }

private:
    Reader*  reader = nullptr;
    int32_t  frame  = 0;
    uint64_t wallMs = 0;
};

/// One watcher's position in one log.
///
/// Pure except for the `Reader` it drives, which is deliberately injected
/// rather than owned: tests/test_broadcast_relay.cpp points one at a file a
/// `Writer` just made, and the relay points one per watcher at the live log.
class BroadcastCursor {
public:
    /// `startWallMs` is where the watcher joins — normally the live edge, so a
    /// new watcher starts at the oldest thing they are allowed to see rather
    /// than at the beginning of a two-hour mission.
    void Attach(Reader* r, uint64_t startWallMs, uint64_t nowMs);

    void SetPaused(bool p) { paused = p; }
    bool Paused() const { return paused; }
    /// Clamped to a sane band — a 100x cursor outruns the reader's buffering
    /// for no viewing benefit, and a 0x one is a pause with no pause button.
    void SetSpeed(float s);
    float Speed() const { return speed; }

    uint64_t VirtualWallMs() const { return virtualWallMs; }
    int32_t  CurrentFrame() const { return currentFrame; }

    /// Advance by real elapsed time × speed and collect everything now due.
    /// Never emits a record stamped past `liveEdgeMs`; when the next one is,
    /// the cursor parks AT the edge rather than drifting past it, so a watcher
    /// who idles at the edge stays exactly `delay` behind instead of falling
    /// further behind forever.
    PumpStop Pump(uint64_t nowMs, uint64_t liveEdgeMs,
                  std::vector<Emission>& out, size_t maxRecords = 4096);

    /// Jump to `targetWallMs`, clamped into `[firstWallMs, liveEdgeMs]`.
    /// Emits the nearest keyframe bundle at or before the target and then the
    /// catch-up: every Control/Vision/Bulk record up to the target in order,
    /// and only the LAST State record per lane. Returns the clamped target.
    uint64_t Seek(uint64_t targetWallMs, uint64_t liveEdgeMs,
                  std::vector<Emission>& out);

    /// Reduce a catch-up span to what is worth sending: non-State records in
    /// order, plus the last State record per lane, in their original positions.
    /// Pure, and separated out because it is the one rule in this file that a
    /// test can state in isolation.
    static void CollapseCatchUp(std::vector<Emission>& span);

private:
    bool ReadDue(uint64_t limitWallMs, Emission& out);

    Reader*  reader        = nullptr;
    uint64_t virtualWallMs = 0;
    uint64_t lastPumpMs    = 0;
    int32_t  currentFrame  = 0;
    float    speed         = 1.0f;
    bool     paused        = false;
};

// ── process-wide relay mode ────────────────────────────────────────────────
// Mirrors `replay::CurrentMode()`: one process relays at most one log, and the
// sites that must know (the inbound admission gate, the GameStart suppression
// in boot) reach it without a pointer threaded through every constructor.
bool IsRelaying();
void SetRelaying(bool on);

/// The enforced delay, in seconds, already through `ClampDelaySeconds`.
int  DelaySeconds();
void SetDelaySeconds(int sec);

}  // namespace broadcast
