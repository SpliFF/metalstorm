// WarResume — what a HELD war IS, and what a join does about it.
//
// PLAN-persistence task 3b, the lobby half of the hibernation lifecycle whose
// server half is Hibernation.h (task 3a). 3a gave the game server two ends —
// checkpoint on the way out, `--resume` on the way in — and deliberately left
// `--hibernate-idle-seconds` defaulting to OFF, because a war that exits when
// the last player leaves is *unjoinable* until something respawns it. This is
// that something.
//
// WHY THIS IS A SEPARATE FILE FROM WarLifecycle.h
// ----------------------------------------------
// WarLifecycle.h answers "what happens to a war nobody is in" from the room's
// values alone (kind, state, a live pid). That was enough while a respawn
// restarted the world at frame 0: there was nothing to consult but the room.
// A resume has a second input — the STORE — and it changes two answers, so the
// policy moved here whole rather than growing a third parameter in two places:
//
//   * a respawn now passes `--resume` if and only if the room has snapshot
//     history, because `DoResume` treats a missing snapshot as FATAL (by
//     design: see Hibernation.h). Passing the flag unconditionally would turn
//     every first launch of a war into an aborted process.
//   * "hibernated" and "crashed" are only distinguishable by asking the store.
//     A war whose server exited cleanly left a `hibernate:*` checkpoint
//     behind; one that was SIGKILLed or segfaulted did not. The exit CODE
//     cannot be used for this — on a debug build the pre-existing
//     `~DynDamageArray` assert makes every exit look like 134 (task 3a's field
//     note), so the honest signal is the row in `game_snapshots`, not the
//     process's parting word.
//
// `DecideWarResume`, which used to live in WarLifecycle.h, is SUPERSEDED by
// `PlanJoin` below and was removed rather than left beside it — two policies
// for one decision is the trap this lane keeps finding. Its `ComingUp` outcome
// carried a liveness bug worth naming, because it is the reason a war could
// become permanently unjoinable: it gated on `state == Loading`, and a war
// held by `onOrphanedRoom` KEEPS the state it died in. A war whose server died
// while still Loading (a crash during staging, a lobby restart mid-launch) was
// therefore "already coming up" to every join that ever arrived afterwards —
// with nothing coming up, and nothing in the lobby able to change its mind.
// `PlanJoin` gates on a LIVE PID instead: a process exists or it does not, and
// the room's state is evidence about the world, never about the process.
//
// E5 (two joins race a resume) is unchanged by that: every route handler runs
// on the one network thread (NetworkServer.cpp), so the fork is serialised by
// construction and the second joiner observes the pid the first one created.
// What E5 actually asks for is that the second joiner be TOLD — "both joiners
// wait on the same 'resuming' state" — which is why `Classify` distinguishes a
// process that is up from one that is ready, and why the state is published in
// the room JSON the SSE stream already carries.

#pragma once

#include <cstdint>
#include <string>

#include "RoomManager.h"  // SessionKind, ERoomState

struct sqlite3;

namespace warresume {

/// The newest snapshot the store holds for a room, or `has == false`.
///
/// Read-only and deliberately tolerant: `game_snapshots` is owned by
/// GameStateStore (the game server's schema, not the lobby's), so on a
/// database where no game has ever run the table does not exist and the
/// prepare fails. That is "no history", not an error to report — a lobby that
/// logged a warning per join for a table it does not own would be noise on
/// every fresh install.
struct SnapshotFacts {
    bool     has     = false;
    int32_t  frame   = -1;
    int64_t  takenAt = 0;
    std::string label;
    /// The E1 stamps, as `game_snapshots` stores them: `engine_hash` is 16
    /// lowercase hex of the writing binary's build-stamp hash (engineid::
    /// HashHex) and `map_hash` is the processed-map id. Read here rather than
    /// left in the blob because the LOBBY has to apply the E1 policy *before*
    /// it forks a server (PLAN-persistence task 3c) — the blob is only opened
    /// by the game server, by which point the process is committed.
    ///
    /// The blob also carries a `layoutHash` (the serializer's shape) which is
    /// deliberately NOT a column and is not checked here: any change to the
    /// walk is a rebuild, and a rebuild moves the build stamp, so the engine
    /// hash already refuses everything a layout check would. The game server
    /// still checks all three — this is a pre-flight, never the authority.
    std::string engineHash;
    std::string mapHash;
    /// The label is one of Hibernation.h's `hibernate:<reason>` values, i.e.
    /// the world was checkpointed *on the way out* rather than mid-game by a
    /// GM verb. This is the clean/dirty exit discriminator (see the header
    /// comment on why the exit code is not).
    bool fromHibernation = false;
};

/// One indexed SELECT against `game_snapshots` (the (game_id, room_id, id DESC)
/// index GameStateStore creates). `gameId` matters: a snapshot's partition key
/// is the PAIR, and two rooms of different games can share a room id.
SnapshotFacts LatestSnapshot(sqlite3* db, const std::string& gameId, uint32_t roomId);

/// True for the labels `DecideExitCheckpoint` produces. Exposed for the test
/// that pins the two files' agreement without linking the sim.
bool IsHibernationLabel(const std::string& label);

/// Drop every stored world for `roomId`, whatever game wrote it. Called when a
/// room is deleted, because room ids are reused: `LatestSnapshot` above is what
/// decides a war comes back on a stored world, and it partitions on
/// (game_id, room_id) — so a surviving blob under a recycled id is not a leak
/// but a world swap, handed to a brand-new room that never fought in it.
/// Deliberately NOT filtered by `gameId`: the room is gone, so every partition
/// under its number is orphaned, and one keyed on a game the caller happens not
/// to name would outlive the check that would have refused it.
///
/// Same tolerance as `LatestSnapshot` — a database no game server has ever
/// opened has no `game_snapshots` table, and that is nothing to report.
/// Returns the number of rows deleted (0 when the table is absent).
int DeleteSnapshotsForRoom(sqlite3* db, uint32_t roomId);

// ───────────── E1 at the lobby: may this binary load that world? ─────────────
//
// PLAN-persistence task 3c, and the reason it is a *policy* rather than a side
// effect of the stamp. §2's accepted policy is "engine upgrades end
// resumability for hibernated games", and until now that ended as follows: the
// join saw a snapshot row, passed `--resume`, the server's DecodeBlob refused
// with EngineMismatch, and `DoResume` aborted the process — by design, because
// coming up empty while publishing `game_status.ready` is worse. The room was
// then left with a dead pid, and `PlanJoin` gates on a live pid, so the NEXT
// join planned exactly the same spawn. A post-upgrade war was unjoinable
// forever, one aborting process per attempt, with nothing in the lobby able to
// say why.
//
// So the lobby now asks the question the blob would have answered, off the
// row's own stamps, before the fork. It is a PRE-FLIGHT and not the authority:
// the server still validates every blob it opens (and the layout hash, which
// is not a column). When the lobby cannot tell — the binary would not report
// its hash — the old behaviour is what happens: pass `--resume` and let the
// server decide.

/// What the current binary can do with the world the store holds.
enum class ResumeEligibility : uint8_t {
    /// Nothing stored: a war's first launch. Not an error.
    NoHistory = 0,
    /// The stamps match, or we could not check them (see UnknownBinary).
    Resumable,
    /// E1: the snapshot was taken by a different build. This is the
    /// post-upgrade case — and, because the build stamp carries a timestamp,
    /// also every ordinary developer rebuild.
    EngineChanged,
    /// E1: the room's map was re-processed (or the room changed map) since the
    /// snapshot was written. The world's heights are not this map's.
    MapChanged,
    /// The lobby has no engine hash for the binary it would spawn, so it
    /// cannot pre-check. Treated as Resumable by every caller, deliberately.
    UnknownBinary,
};

const char* ToString(ResumeEligibility e);

/// True for the two verdicts that mean "do not pass --resume".
bool RefusesResume(ResumeEligibility e);

/// The identity of the binary+map the resume would run under. An empty
/// `engineHash` means "not probed" → UnknownBinary.
struct BinaryIdentity {
    std::string engineHash;  ///< engineid::HashHex of the server binary's stamp
    std::string mapHash;     ///< the room's processed-map id (`--map`)
};

struct ResumeVerdict {
    ResumeEligibility eligibility = ResumeEligibility::NoHistory;
    /// Always populated, and written to be read by a player as well as an
    /// operator — it is what the room card and the log line both say.
    std::string reason;
};

/// Pure. Order: no history → nothing to judge; no probed hash → unknown;
/// engine before map, because an upgraded engine makes the map question moot.
ResumeVerdict DecideResumeEligibility(const SnapshotFacts& snap,
                                      const BinaryIdentity& cur);

// ───────────────────────── what the room card shows ─────────────────────────

/// What a war room IS at this instant. Published as `war.state` in the room
/// JSON, so the browser's card and the fleet view read the same word the log
/// does.
enum class WarState : uint8_t {
    /// Not a persistent war. A skirmish is started by its host and its room
    /// has no life of its own between matches.
    NotAWar = 0,
    /// A server process is up and has published `game_status.ready`.
    Live,
    /// A process is up but not serving yet — either a first launch or a
    /// resume in flight. This is the state E5's second joiner waits on.
    Resuming,
    /// No process, and the last thing the store holds is an exit checkpoint:
    /// the world is frozen at that frame and the next join brings it back.
    Hibernated,
    /// No process, and the world was NOT checkpointed on the way out. The war
    /// is still resumable if any older snapshot survives, but frames were
    /// lost, and a card that said "hibernated" here would be claiming a
    /// promise the store cannot keep.
    Crashed,
    /// A war that has never run: no process, no history, never in flight.
    Fresh,
    /// No process, a frozen world in the store, and this binary may not load
    /// it (E1 — see `ResumeEligibility`). The war is joinable and will come
    /// back at frame 0; the frame it froze at is still published, because
    /// "hibernated at 302" and "302 is gone" are different sentences and the
    /// card must not tell the first one.
    Unresumable,
};

const char* ToString(WarState s);

struct WarFacts {
    /// A game-server process for this room is alive NOW — by pid, not by the
    /// `game_servers` row (a stale row is precisely the case this exists for).
    bool serverProcessAlive = false;
    /// That process has published `game_status.ready`.
    bool serverReady = false;
    /// The room's own state. Evidence about the WORLD (was a match in flight
    /// when the process vanished?), never about the process.
    ERoomState roomState = ERoomState::Filling;
    SnapshotFacts snapshot;
    /// What the spawn would run (task 3c). Left empty by callers that have not
    /// probed the server binary — the E1 pre-flight then abstains rather than
    /// guessing, and behaviour is exactly what it was before 3c.
    BinaryIdentity binary;
};

/// Pure. Order of evaluation is the specification:
///   1. not a war                                → NotAWar
///   2. a live process                           → Live / Resuming
///   3. history this binary may not load (E1)    → Unresumable
///   4. was in flight and left no exit checkpoint→ Crashed
///   5. any snapshot history                     → Hibernated
///   6. otherwise                                → Fresh
/// 4 sits ABOVE 5 on purpose: a war that crashed with an old GM checkpoint on
/// disk is resumable *and* lost frames, and only one of those two facts is
/// worth putting on a card unprompted.
/// 3 sits above BOTH (task 3c): a war that crashed *and* was then upgraded past
/// its own snapshots has lost the frames since the last checkpoint and the
/// frames before it, so "crashed" would understate it — the whole world is
/// going back to frame 0 and that is the fact the next joiner needs.
WarState Classify(SessionKind kind, const WarFacts& f);

// ────────────────────────────── what a join does ─────────────────────────────

enum class WarJoinAction : uint8_t {
    /// Nothing: a skirmish joins a room, it does not launch one.
    None = 0,
    /// A process is already there; the joiner connects to it (or waits for it
    /// to become ready, which the existing readiness handshake drives).
    ConnectToLive,
    /// Fork a server for this room.
    Spawn,
};

struct WarJoinPlan {
    WarJoinAction action = WarJoinAction::None;
    /// Pass `--resume` to the spawned server. False when the room has no
    /// snapshot history at all, because `DoResume` aborts the process on
    /// `NoSnapshot` — a war's FIRST launch must not ask to resume.
    ///
    /// The check is not atomic with the fork (a prune could delete the row in
    /// between) and does not need to be: the server then refuses fatally, the
    /// room is left with a dead pid, and the next join re-plans and spawns it
    /// fresh. That self-healing is only true because `PlanJoin` gates on the
    /// pid rather than on `Loading` — see the header.
    bool withResume = false;
    /// The frame the world is expected to come back at, for the log and the
    /// card. −1 when there is nothing to resume.
    int32_t resumeFrame = -1;
    /// What the room is (or is about to be), for the card and the log.
    WarState state = WarState::NotAWar;
    /// Why a stored world is NOT being resumed, when one exists and E1 refuses
    /// it (task 3c). Empty otherwise. This is the sentence the player sees —
    /// the frames are being dropped either way, and the one thing the system
    /// must not do is drop them silently.
    ResumeEligibility eligibility = ResumeEligibility::NoHistory;
    std::string blockedReason;
    /// The frame the world was frozen at but will NOT come back at, when
    /// `blockedReason` is set. −1 otherwise. Kept separate from `resumeFrame`
    /// so no caller can print a promise out of a loss.
    int32_t lostFrame = -1;
};

WarJoinPlan PlanJoin(SessionKind kind, const WarFacts& f);

/// The sentence the join route logs, whatever the plan. Kept next to the
/// policy so a new action cannot be added without a line to print for it.
std::string Describe(const WarJoinPlan& p);

}  // namespace warresume
