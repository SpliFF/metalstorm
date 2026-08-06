// ReplayPlayer — the re-execution driver behind `--replay <file>`
// (PLAN-replay.md §2 "playback architecture", task 2).
//
// WHAT IT DOES
// ------------
// The recorded stream (ReplayFile) is a total order of external inputs stamped
// `(frame, phase, seq)`. Re-execution is the *inverse* of the recording funnel:
// at each of the tick's five input phases the server asks this driver "what was
// due here?", and feeds exactly those records back through the same code paths
// the live run used. Nothing else about the tick changes — that is the whole
// design (PLAN-replay §2: "the replay server is just a game server whose inputs
// are prerecorded").
//
// This class is deliberately PURE — cursor arithmetic, seek state, verification
// bookkeeping, no engine globals — so its ordering guarantees are covered by
// tests/test_replay_player.cpp. server_main.cpp owns the engine-coupled half
// (turning a Record into a HandleMessage / GiveCommand / exec call).
//
// THE CURSOR IS MONOTONIC, AND THAT IS THE ORDERING GUARANTEE
// -----------------------------------------------------------
// `Due(frame, phase)` pops every record whose `(frame, phase)` is <= the
// requested one, in seq order. Two consequences worth stating:
//
//   * Records stamped at a frame the replay has already passed ("late") are
//     still fed rather than dropped — dropping one would silently change the
//     cause stream, which is the failure this subsystem exists to prevent — but
//     they are COUNTED, and a nonzero late count means the replay's frame
//     progression did not match the recording's. That is a divergence report,
//     not a warning to be ignored.
//   * Everything stamped before GameStart shares frame 0 (the sim frame does
//     not advance until then, see TickPhase's comment), so the whole pre-game
//     prologue is fed on the replay's first tick, in its recorded seq order.
//     That is correct: with the sim not ticking, seq order IS the semantics.
//
// SEEK (§2 "speed/pause/seek")
// ---------------------------
// Seek is "load the nearest checkpoint <= target, fast-forward the journal
// uncapped with streaming suppressed, resume at the target". Task 2 implements
// that algorithm against an EMPTY checkpoint index: the nearest checkpoint <=
// any target is the start of the recording, so a seek is a full uncapped
// fast-forward from frame 0. It is frame-exact — the state at the target is the
// same state either way — it is only slower than it will be once
// PLAN-persistence's sim serializer lands and checkpoints become real seek
// points. The suppression half is fully implemented here and there: outbound
// streaming is muted while FastForwarding() is true, so a spectator does not
// receive the fast-forwarded frames.
#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "ReplayFile.h"
#include "SyncedInputJournal.h"

namespace replay {

/// What the process is doing with a replay file.
enum class Mode {
    Off,      ///< normal game server
    Play,     ///< feed the stream, serve spectators
    Verify,   ///< feed the stream headless and compare state hashes (§4)
};

// `HashPoint` and `Checkpoint` now live in ReplayFile.h: task 3 embedded both
// series in the container, so they are file-format types that the player reads,
// not player-local ones. `--verify` therefore needs no second file; passing one
// is still supported and OVERRIDES the embedded track, which is exactly how the
// negative control is run (verify a stream against a different game's hashes).

/// Verification outcome (§4: "re-execution must reproduce the hash track
/// exactly"). A divergence is located to a frame, which is the whole point —
/// it bisects desyncs.
struct VerifyResult {
    int      checked  = 0;   ///< reference points the replay reached and hashed
    int      matched  = 0;
    int      missing  = 0;   ///< reference points the replay never reached
    int32_t  firstDivergenceFrame = -1;
    uint64_t expected = 0;
    uint64_t actual   = 0;

    /// Passing needs at least one checked point: a run that verified nothing
    /// must not report success (§4's "silently degrades from proof to usually
    /// works" is exactly the failure mode a vacuous pass creates).
    bool Passed() const {
        return checked > 0 && missing == 0 && firstDivergenceFrame < 0;
    }
};

class Player {
public:
    /// Load a replay file. Returns false with `err` set if it is unreadable or
    /// a version this binary does not speak. A TRUNCATED file loads fine (E1) —
    /// check Truncated() and expect the segment to end early.
    bool Load(const std::string& path, std::string& err);

    bool Active() const { return loaded; }
    const Header& GetHeader() const { return header; }
    bool Truncated() const { return truncated; }
    size_t RecordCount() const { return records.size(); }
    /// Seek index carried by the file (§1). Empty on every file written so far:
    /// nothing produces checkpoint blobs until PLAN-persistence's sim
    /// serializer lands. Reported at start-up so an operator can see that a
    /// seek is a full fast-forward rather than a jump (T2-d).
    const std::vector<Checkpoint>& Checkpoints() const { return checkpoints; }
    bool HasStartCheckpoint() const { return !startCheckpoint.empty(); }

    /// Identity the live run resolved for a recorded connection, or nullptr if
    /// that connection never authenticated successfully (PLAN-replay T2-a).
    ///
    /// Indexed at LOAD time, not consumed from the stream, and that ordering is
    /// the whole point: the AuthIdentity record necessarily FOLLOWS the
    /// AuthRequest it describes (the answer cannot precede the question), but
    /// replay needs it *while* re-entering that AuthRequest. Pre-indexing makes
    /// the lookup available from the first tick. The records stay in the stream
    /// so the container, the packer and `/api/journal` need no special case;
    /// feeding one is a documented no-op.
    ///
    /// The key is the RECORDED connection id, i.e. what `RecordedClientId()`
    /// recovers from the virtual id a replayed message arrives under.
    const syncedinput::AuthIdentity* IdentityFor(uint32_t recordedClientId) const;
    size_t IdentityCount() const { return identities.size(); }

    /// Frame the recording ended at: the trailer's value on a clean file, else
    /// the last record's frame (E1 — the segment truncates at the last
    /// consistent point and the caller stops there rather than running on into
    /// an unrecorded future).
    int32_t EndFrame() const { return endFrame; }

    /// Pop every record due at or before `(frame, phase)`, in seq order.
    /// Pointers stay valid for the Player's lifetime.
    std::vector<const syncedinput::Record*> Due(int32_t frame,
                                                syncedinput::TickPhase phase);

    bool Exhausted() const { return cursor >= records.size(); }
    uint64_t Fed() const { return fed; }
    uint64_t Late() const { return late; }

    // ── seek ──
    void SetSeekTarget(int32_t frame) { seekTarget = frame; }
    int32_t SeekTarget() const { return seekTarget; }
    bool Seeking() const { return seekTarget > kNoSeek; }
    /// True while the replay is racing to the seek target: pace uncapped and
    /// mute outbound streaming. Goes false for good once the target is reached.
    bool FastForwarding(int32_t curFrame) const { return curFrame < seekTarget; }

    // ── verify ──
    /// Replace the reference series. Load() already installs the file's own
    /// embedded track (task 3); this is the explicit `--verify <file>` override.
    void SetHashTrack(std::vector<HashPoint> track);
    bool HasHashTrack() const { return !hashTrack.empty(); }
    size_t HashTrackSize() const { return hashTrack.size(); }
    /// True when `frame` is one of the reference points — the caller should
    /// compute a state hash on exactly these frames and hand it to CheckHash.
    bool WantHashAt(int32_t frame) const;
    /// Compare and record. Returns false on the first mismatch (and every one
    /// after — the divergence frame is latched to the FIRST one, since
    /// everything downstream of a divergence is noise).
    bool CheckHash(int32_t frame, uint64_t hash);
    /// Fold in the reference points the run never reached. Call once at the end.
    void FinishVerify(int32_t lastFrame);
    const VerifyResult& Verify() const { return verify; }

    // ── abort ──
    /// Ask the server loop to end the replay early. Used for conditions a
    /// re-execution cannot honestly continue past — the SnapshotRestore
    /// discontinuity (§6 E2) being the standing one, since restoring a
    /// checkpoint needs PLAN-persistence's sim serializer. Continuing past one
    /// would apply the post-restore stream to the pre-restore world and produce
    /// a confident, wrong replay; stopping produces a short one that says why.
    void RequestStop(const std::string& reason) {
        if (!stopRequested) { stopRequested = true; stopReason = reason; }
    }
    bool StopRequested() const { return stopRequested; }
    const std::string& StopReason() const { return stopReason; }

private:
    bool loaded    = false;
    bool truncated = false;
    Header header;
    std::vector<syncedinput::Record> records;
    std::vector<Checkpoint> checkpoints;
    std::vector<uint8_t> startCheckpoint;
    /// recorded clientId (masked to the virtual range's payload bits) → the
    /// identity its last successful auth resolved to.
    std::unordered_map<uint32_t, syncedinput::AuthIdentity> identities;
    size_t   cursor    = 0;
    uint64_t fed       = 0;
    uint64_t late      = 0;
    int32_t  endFrame  = 0;
    /// No seek requested. NOT 0: the sim's frame counter starts at -1, so a
    /// zero target would read as "fast-forward to frame 0" and mute the wire
    /// for the first tick of every ordinary playback.
    static constexpr int32_t kNoSeek = -2;
    int32_t  seekTarget = kNoSeek;

    std::vector<HashPoint> hashTrack;   ///< sorted by frame
    VerifyResult verify;

    bool stopRequested = false;
    std::string stopReason;
};

/// Process-wide replay driver, mirroring syncedinput::Journal(). One server
/// process replays at most one file, and the feed sites (StateStreamer's AI
/// drain, server_main's tick) need to reach it without threading a pointer
/// through every constructor.
Player& Feed();

/// Mode the process is running in. Off unless --replay was given.
Mode CurrentMode();
void SetCurrentMode(Mode m);
inline bool IsReplaying() { return CurrentMode() != Mode::Off; }

/// Replayed wire messages re-enter the session layer under their RECORDED
/// connection id, offset into a reserved high range so they cannot collide with
/// a live spectator's transport id on the same server. Sends to these ids find
/// no connection and are dropped by the transport, which is the correct
/// behaviour: the original client is not there to receive them.
constexpr uint32_t kVirtualClientBase = 0x40000000u;
inline uint32_t VirtualClientId(uint32_t recordedId) {
    return kVirtualClientBase | (recordedId & 0x0FFFFFFFu);
}
inline bool IsVirtualClient(uint32_t id) {
    return (id & kVirtualClientBase) != 0;
}
/// Inverse of VirtualClientId — recovers the id the message was recorded
/// under, which is the key the identity index and the recording's own logs
/// use. Lossless for every id the transport actually allocates (they are
/// small counters, nowhere near the 28-bit payload width).
inline uint32_t RecordedClientId(uint32_t virtualId) {
    return virtualId & 0x0FFFFFFFu;
}

// ── live spectators on a replay server (PLAN-replay §7.11 T2-a-3) ──────────
//
// A replay server has to admit live clients for the plan to have a point —
// §2's whole architecture is "spectating clients connect through the
// completely standard wire". But a spectator arrives on a server whose synced
// state is being reconstructed from a file, so the rule it is admitted under
// is stricter than the one a spectator on a live game gets: it must be
// incapable of changing anything the recording determined.
//
// Two of the three mechanisms live here; the third (which verbs it may send at
// all) is server_main's inbound gate.
//
//   1. Its player number comes from a range disjoint from the recorded one.
//      The recorded auths are cross-checked against `nextPlayerNum` (§7.10
//      design point 2) — a spectator that consumed one would shift the
//      registration order and stop the replay with a spurious "player-number
//      divergence". So spectators never touch `nextPlayerNum`; they draw from
//      here instead. The base is a constant rather than "one past the highest
//      recorded number" deliberately: a constant cannot be wrong at a moment
//      when the recording's own auths have not been fed yet.
//   2. It is NOT registered in `playerHandler`, and therefore never appears in
//      `Spring.GetPlayerList()`. This is the load-bearing half. Metalstorm's
//      game_authority.lua runs `PlayerAdded` over the whole player list at
//      GameStart and grants an authority pool per player WITHOUT filtering
//      spectators — so a spectator visible to the sim at the wrong moment
//      would mint synced rules params the recording never had. That is a fork
//      of the replayed world, and it is one `--verify` could not even see: the
//      state hash folds units and the RNG, not rules params.
//
// The cost of (2) is stated rather than hidden: a replay spectator has no
// roster row and no `clientPlayerNum` entry, so the LuaUIMsg relay (which
// resolves senders and recipients through both) drops its messages. Spectator
// chat on a replay server is task 4b's problem, not a silent gap.
constexpr int kSpectatorPlayerNumBase = 200;

/// Next player number for a live spectator on a replay server. Monotonic and
/// process-wide, like Feed() — one server, one allocation sequence.
int AllocSpectatorPlayerNum();

/// True for a player number handed out by AllocSpectatorPlayerNum. Nothing the
/// recording contains can reach this range: it is above every roster the lobby
/// can spawn and below MAX_PLAYERS (251).
inline bool IsSpectatorPlayerNum(int playerNum) {
    return playerNum >= kSpectatorPlayerNumBase;
}

}  // namespace replay
