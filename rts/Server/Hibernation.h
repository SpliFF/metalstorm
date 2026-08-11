// Hibernation — the process-model half of PLAN-persistence task 3.
//
// WHAT THIS IS
// ------------
// §3's state machine is two decisions and a pile of wiring:
//
//   running ──(last client leaves)──► checkpoint → process EXITS → 'hibernated'
//   hibernated ──(join)──► respawn with --resume → snapshot load → listening
//
// The wiring (argv parsing, the sim loop's idle timer, the store, the boot
// order) is server_main's. The two DECISIONS are here, off-engine, because
// each of them is a policy question with more cases than any of them looks
// like from the state diagram, and neither can be exercised by a doctest if
// it is written as an `if` inside a 3 000-line main():
//
//   * DecideExitCheckpoint — should THIS exit leave a resumable world behind?
//     Six of its eight inputs say "no", and every "no" has to name itself in
//     the log, because the room is being lost either way and the operator's
//     only evidence is that line.
//   * DecideResume — a boot asked to resume must either resume or REFUSE. The
//     one outcome that must be unreachable is "silently started a fresh
//     world": the lobby marked this room hibernated at frame N, and a process
//     that comes up empty at frame -1 while reporting itself ready hands the
//     players a world their war is not in.
//
// SCOPE — this is task 3a; 3b/3c are declared, not written
// --------------------------------------------------------
// Named here rather than only in the plan file, per the lane's rule that a
// split is a declaration with an owner and not a hole:
//
//   * 3a (this file): the SERVER's two ends — checkpoint on the way out,
//     restore on the way in, both refusing loudly rather than half-working.
//   * 3b: the LOBBY's state machine — room states hibernated/resuming/crashed
//     on the existing `game_servers`/`game_status` tables, respawn-on-join
//     with `--resume`, and the E5 resume race (two joins racing one respawn
//     must produce one process). Until 3b exists nothing ever passes
//     `--resume`, which is why HibernateIdleSeconds defaults to OFF below.
//   * 3c: deploy drain — SIGTERM every game server, each checkpoints and
//     exits, and the §2 E1 policy decides which of them the NEW binary is
//     allowed to resume. The exit half of 3c is already covered here (a
//     signal exit checkpoints); what is missing is the lobby driving it and
//     the post-upgrade refusal being a tested policy rather than a side
//     effect of the engine-hash stamp.
//
// DEVIATION from §3's sketch — `--resume <gameId>`, and why it is `--resume`
// --------------------------------------------------------------------------
// §3 writes the boot flag as `--resume <gameId>`. It does not take one. A
// snapshot's partition key is the PAIR (gameId, roomId) — GameStateStore.h
// spends a paragraph on exactly this — and BOTH halves are already on the
// command line the lobby builds: `--game` is the gameId (content identity)
// and `--room` is the roomId. A third argument restating one of them creates
// a second source of truth with no correct reconciliation: refusing on
// disagreement breaks nothing but is noise, and preferring either silently
// discards a caller's argument. So `--resume` is a bare flag meaning "the
// world for the room you were already told to serve".

#pragma once

#include <cstdint>
#include <string>

namespace hibernate {

// ─────────────────────────── exit checkpoint ───────────────────────────

/// Why the sim loop is ending. Every exit path in server_main maps to exactly
/// one of these, and the mapping is the caller's job — the policy below never
/// infers a reason from the other fields.
enum class ExitReason {
    Signal,       ///< SIGINT/SIGTERM: operator stop, or a deploy drain (3c)
    Idle,         ///< no connected clients for the hibernate window
    PostGame,     ///< the match ended and the observation window closed
    Restart,      ///< SIGHUP: re-exec of this same room
    HeadlessRun,  ///< a --headless-run reached its stop condition
    Harness,      ///< --snapshot-roundtrip / --replay / --verify: not a game
};

const char* Describe(ExitReason r);

struct ExitContext {
    ExitReason reason = ExitReason::Signal;
    /// Is hibernation switched on for this process at all?
    bool hibernationEnabled = true;
    /// Did the sim serializer attach? False = the walk or the gadget coverage
    /// is incomplete and a checkpoint would be a lie (see server_main's
    /// attach gate).
    bool serializerAttached = false;
    /// Has GameStart fired? Before it there is no world, only a staged lobby.
    bool gameStarted = false;
    /// Has the match been declared over? A finished war has nothing to resume.
    bool gameOverDeclared = false;
    /// Is this process re-executing a recording rather than playing a game?
    bool replaying = false;
};

struct CheckpointDecision {
    bool checkpoint = false;
    /// The snapshot's label when `checkpoint` — says what it is FOR, so an
    /// operator reading `List()` can tell a hibernation from a GM undo.
    std::string label;
    /// Human-readable, always populated. When `checkpoint` is false this is
    /// the sentence the exit path logs; six of the seven refusals are benign
    /// and one (`lossy`) is not.
    std::string reason;
    /// True when the world is being LOST rather than deliberately dropped —
    /// i.e. a resumable game is exiting with no snapshot because the machinery
    /// could not take one. The caller logs these at WARNING, the rest at
    /// NOTICE. This distinction is the entire value of the type: "no
    /// checkpoint taken" is unremarkable on a replay and is a data-loss event
    /// on a live war.
    bool lossy = false;
};

/// Pure. Order of evaluation is deliberate and is the specification:
///   1. a harness/replay run is not a game            → no (benign)
///   2. hibernation switched off                      → no (benign)
///   3. the game never started                        → no (benign)
///   4. the match is over                             → no (benign)
///   5. PostGame/HeadlessRun/Restart reasons          → no (benign)
///   6. the serializer never attached                 → no (LOSSY)
///   7. otherwise (Signal, Idle)                      → checkpoint
/// 6 sits BELOW 3-5 on purpose: a run that had nothing to save must not be
/// reported as a data-loss event just because the walk was also incomplete.
CheckpointDecision DecideExitCheckpoint(const ExitContext& c);

// ────────────────────────────── resume ──────────────────────────────

/// The store, narrowed to what a resume needs. GameStateStore satisfies this;
/// server_main passes an adapter. Narrow deliberately: a resume must not be
/// able to reach Checkpoint() or Prune().
class IResumeSource {
public:
    virtual ~IResumeSource() = default;
    /// Is a serializer attached (i.e. can anything be applied at all)?
    virtual bool Available() const = 0;
    /// Newest stored frame for the room, or -1 if the room has no history.
    virtual int32_t NewestFrame(uint32_t roomId) = 0;
    /// The E2 ladder: restore the newest blob that decodes cleanly.
    virtual bool RestoreNewestValid(uint32_t roomId, std::string& err,
                                    int32_t& restoredFrame) = 0;
};

enum class ResumeStatus {
    Ok,              ///< a world was applied; `frame` is where it resumed
    NotRequested,    ///< --resume absent: a normal boot, nothing to do
    WrongShape,      ///< this session shape never starts its game at set-up
    NoSerializer,    ///< the walk is incomplete — nothing could be applied
    NoSnapshot,      ///< the room has no snapshot history at all
    RestoreFailed,   ///< every retained rung was bad, or E1 refused the lot
};

struct ResumeOutcome {
    ResumeStatus status = ResumeStatus::NotRequested;
    int32_t frame = -1;
    std::string error;
    /// Should the process abort instead of serving? True for every status
    /// except Ok and NotRequested. There is no "resume failed, carry on":
    /// the lobby respawned this process to hand players a world at frame N,
    /// and coming up empty while publishing game_status.ready is how a war
    /// silently becomes a fresh match.
    bool fatal = false;
};

struct ResumeRequest {
    bool requested = false;
    /// Does this session shape fire GameStart during set-up? A resume applies
    /// over a fully-staged world (see server_main's call site for why), so a
    /// shape that waits for a roster before starting has nothing to apply
    /// over at the point the resume runs.
    bool startsGameAtSetup = false;
};

/// Pure but for the injected source. Never partially applies: every failure
/// leaves the world exactly as staging left it, and says so.
ResumeOutcome DoResume(IResumeSource& src, uint32_t roomId, const ResumeRequest& req);

/// One line, for the log, whatever the outcome. Kept next to the policy so a
/// new status cannot be added without a sentence to print for it.
std::string FormatResume(const ResumeOutcome& o);

}  // namespace hibernate
