// SnapshotRoundTrip — the populated-fixture round-trip for the sim serializer
// (PLAN-persistence.md §8, the one row the walk's own tests could never cover).
//
// tests/test_sim_snapshot.cpp proves the CODEC: every section round-trips, a
// truncated payload refuses at every byte, the layout hash cannot drift from
// the table. What it cannot prove is the thing a resume actually promises —
// that a world restored from a checkpoint *goes on to behave the same way*.
// That needs a populated sim: a map, a def handler, a team handler, real
// units and live gadgets, none of which a doctest can stand up.
//
// So the assertion runs on the real binary, over the real content, and it is
// the one §8 asks for: checkpoint at frame F, run the sim on to F+N recording
// a determinism hash every tick, restore the checkpoint (the sim's frame
// counter rewinds to F), run the same N ticks again, and require the two hash
// tracks to be identical. Anything the walk fails to capture that influences
// the next N ticks shows up as a divergence with a frame number on it.
//
// Two checks ride along, because the hash is deliberately narrow (unit
// id/team/pos/health plus the synced RNG — statsdump::ComputeStateHash):
//
//   * the terminal payloads are compared BYTE for byte. That is the whole
//     captured state — 113 unit fields, the teams, the command queues, the
//     features, the gadgets' own Lua tables — not the four the hash folds.
//   * the checkpoint is re-captured immediately after being applied and
//     compared to itself, so capture→apply→capture idempotence is asserted
//     separately from the 100 ticks that follow it.
//
// This module is PURE — standard library only, no engine globals — in the same
// shape as HeadlessRun: the state machine and the verdict are covered by a
// plain doctest, and server_main.cpp feeds it plain values (a frame number, a
// hash, a payload) and performs the capture/restore it asks for. The division
// matters: the parts that can be tested off-engine are, and the part that
// cannot be is one function call wide.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace snapshotrt {

/// `--snapshot-roundtrip <frame>[:<ticks>]`.
struct Config {
    bool enabled = false;
    int64_t atFrame = 0;    ///< checkpoint here (the first frame >= this)
    int64_t ticks = 100;    ///< compare this many ticks per arm (§8 says 100)
    /// `--roundtrip-strict`: the original bar — the two hash tracks and the two
    /// terminal payloads must be IDENTICAL. That is what a resume would promise
    /// if move state were captured (PLAN-persistence Q-P2 option A), and it is
    /// still the right bar for a fixture with nothing under a move order. The
    /// default bar is the one Q-P2 decided (option D): see Result below.
    bool strict = false;
};

/// What the two arms' terminal `units` sections say, measured by the caller
/// (simsnapshot::CompareUnits) and handed back as plain numbers so this module
/// stays free of the engine. It is the metric Q-P2 option D asks for: the
/// count and the MAGNITUDE of the movement re-derivation, which is what says
/// whether capturing `AMoveType` (option A) is worth building.
struct Divergence {
    bool measured = false;   ///< false = the caller could not decode the arms
    size_t unitsA = 0;
    size_t unitsB = 0;
    size_t transform = 0;
    size_t vitals = 0;
    size_t onlyA = 0;
    size_t onlyB = 0;
    double maxPosDelta = 0.0;      ///< elmos
    double maxHeadingDelta = 0.0;  ///< degrees
};

/// Parse the CLI spec. Returns false with `err` set on anything malformed —
/// a typo'd spec must not silently become "checkpoint at frame 0", which is
/// before GameStart and would compare two empty worlds and pass.
bool ParseSpec(const std::string& spec, Config& out, std::string& err);

enum class Phase {
    Idle,      ///< before the checkpoint frame
    ArmA,      ///< the reference continuation: F+1 .. F+N
    ArmB,      ///< the restored continuation: F+1 .. F+N again
    Done,      ///< verdict reached (pass or fail)
};

/// What the caller must do for the frame it just handed to OnFrame(), in the
/// order the fields are listed. Several can be set on one frame: the last
/// frame of arm A records its hash, captures its terminal payload and then
/// restores the checkpoint.
struct Step {
    bool capture = false;          ///< serialize now → SetCheckpoint()
    bool record = false;           ///< hash now → RecordHash()
    bool captureTerminal = false;  ///< serialize now → SetTerminalPayload()
    bool restore = false;          ///< deserialize the checkpoint, then OnRestored()
    bool finish = false;           ///< the run is over; read Result()
};

/// The verdict. `ran` distinguishes "compared and passed" from "never got far
/// enough to compare" — a run that ends before the checkpoint frame must not
/// report success, which is the failure mode a boolean `pass` alone invites.
struct Result {
    bool ran = false;                    ///< the comparison actually happened
    bool pass = false;
    std::string failure;                 ///< empty iff pass

    int64_t startFrame = -1;             ///< the checkpoint frame
    int64_t endFrame = -1;               ///< startFrame + ticks
    size_t hashesCompared = 0;

    int64_t firstDivergentFrame = -1;    ///< -1 when the tracks agree
    uint64_t expected = 0;               ///< arm A's hash at that frame
    uint64_t actual = 0;                 ///< arm B's

    size_t checkpointBytes = 0;
    bool restoreRecaptureIdentical = false;  ///< capture→apply→capture

    bool terminalPayloadIdentical = false;
    size_t terminalBytes = 0;            ///< arm A's terminal payload size
    int64_t firstDifferentByte = -1;     ///< -1 when identical

    /// The continuation's measured divergence, and the bar it was judged
    /// against. Under the default bar the hash track and the terminal bytes are
    /// REPORTED rather than asserted — a resumed world is world-identical, not
    /// track-identical (PLAN-persistence §7.1c: `inCommand` is forced false and
    /// no `AMoveType` state is captured, so every moving unit re-plans) — and
    /// what must hold is that nothing appeared, vanished or took damage
    /// differently. Under `strict` the old identity bar applies as well.
    Divergence divergence;
    bool strict = false;
};

/// The state machine. One instance per process; inert unless Configure() was
/// given an enabled Config.
class Controller {
public:
    void Configure(const Config& cfg) { cfg_ = cfg; }
    bool Enabled() const { return cfg_.enabled; }
    Phase CurrentPhase() const { return phase_; }
    int64_t StartFrame() const { return startFrame_; }
    const Config& Cfg() const { return cfg_; }

    /// Drive one loop iteration. `frame` is the sim's frame counter AFTER the
    /// tick. Iterations that do not advance the frame (the loop spins while
    /// paused, or before GameStart) are no-ops, so the controller counts sim
    /// ticks rather than loop passes.
    Step OnFrame(int64_t frame);

    void SetCheckpoint(std::vector<uint8_t> bytes);
    /// The bytes to hand back to the serializer when Step::restore is set.
    const std::vector<uint8_t>& Checkpoint() const { return checkpoint_; }
    /// Arm A's terminal payload — kept so a caller that can decode the framing
    /// (SimSnapshot::DescribeOffset) can say WHICH SECTION the two arms
    /// disagree in, rather than only at which byte.
    const std::vector<uint8_t>& TerminalA() const { return terminalA_; }
    const std::vector<uint8_t>& TerminalB() const { return terminalB_; }
    /// The hash for the frame the current Step said to record.
    void RecordHash(uint64_t hash);
    /// The arm's terminal payload (arm A's is kept for the byte comparison).
    /// Arm B's does NOT reach a verdict on its own: the caller still owes the
    /// units measurement, which only it can take. See Finish().
    void SetTerminalPayload(std::vector<uint8_t> bytes);
    /// Both arms are in and the caller has measured how their rosters differ:
    /// reach the verdict. A run whose divergence was never measured FAILS —
    /// "could not compare" must never read as "found no difference", the same
    /// rule `Result::ran` exists for.
    void Finish(const Divergence& d);
    /// Called after the checkpoint has been applied: the sim's frame counter
    /// as it now reads, and the payload re-captured from the restored world.
    void OnRestored(int64_t frameAfterRestore, const std::vector<uint8_t>& recaptured);

    /// An engine-side step the controller asked for could not be performed
    /// (the serializer refused, a restore failed). Terminal: the run stops and
    /// reports this reason rather than comparing tracks it does not trust.
    void Fail(std::string reason);

    const Result& Result_() const { return result_; }
    /// One line for the completion log. Safe to call in any phase.
    std::string FormatVerdict() const;

private:
    void Finalise();

    Config cfg_;
    Phase phase_ = Phase::Idle;
    int64_t startFrame_ = -1;
    int64_t lastFrame_ = -1;
    std::vector<uint64_t> armA_;
    std::vector<uint64_t> armB_;
    std::vector<uint8_t> checkpoint_;
    std::vector<uint8_t> terminalA_;
    std::vector<uint8_t> terminalB_;
    bool restoreOk_ = false;
    bool recaptureOk_ = false;
    Result result_;
};

}  // namespace snapshotrt
