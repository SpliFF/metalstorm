// DeployDrain — stopping every game server on purpose, before the binary under
// them is replaced.
//
// PLAN-persistence task 3c, the third of task 3's three parts (3a = the
// server's two ends, 3b = the lobby's resume-on-join, this = the deploy). §3's
// one-line sketch is:
//
//   deploy: drain = SIGTERM all → each checkpoints + exits → upgrade → old
//           snapshots resumable only per the §2 policy
//
// The exit half already works (Hibernation.h: a Signal exit checkpoints). What
// was missing is the two things this file owns: the lobby DRIVING the drain,
// and the post-upgrade refusal being a tested policy instead of a side effect
// of the engine-hash stamp. The second half lives in WarResume.h
// (`DecideResumeEligibility`) because it is consumed at join time by the join
// planner; see the comment there. This file is the shutdown half plus the
// report the two produce together.
//
// ── WHY A DRAIN IS NOT `ActionOnLobbyExit` ──────────────────────────────────
// WarLifecycle.h's `ActionOnLobbyExit` deliberately LEAVES A WAR RUNNING when
// the lobby stops: the next lobby's adoption pass re-attaches to the pid and
// the sim never stopped, which is the cheapest and most exact resume there is.
// Reusing that rule for a deploy would be exactly wrong, and silently so:
//
//   * the whole point of a deploy is that the binary those processes are
//     running is about to be replaced. A war left running is a pre-upgrade
//     process serving players against post-upgrade content and defs, and the
//     lobby that adopts it cannot tell — `game_servers` records a pid, not a
//     build;
//   * a war that is signalled instead CHECKPOINTS, and that snapshot is the
//     only artefact that survives the upgrade at all.
//
// So a drain signals every server it owns, war or skirmish, and the difference
// between the two is what the report says about the outcome rather than whether
// the signal is sent. `--kill-wars-on-exit` is unrelated: it is a developer
// convenience on the exit path, not a deploy verb.
//
// ── WHY THE DRAIN DOES NOT TOUCH ROOM STATE ─────────────────────────────────
// It signals, waits, and reports. The room-level consequences of a game server
// exiting — hibernated vs crashed, held vs recycled, the port going back to the
// pool, the re-recorded `game_servers` row — are already owned by the lobby's
// health loop (and by `warresume`), and that classification is the one this
// lane has twice found in two places at once. A drain that re-implemented it
// would be a second policy for the same decision; instead the health loop
// observes the same exits it always does, a fraction of a second later.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "RoomManager.h"   // SessionKind
#include "WarResume.h"     // SnapshotFacts (the checkpoint evidence)

namespace deploydrain {

// ─────────────────────────── what gets signalled ───────────────────────────

/// One game server the lobby owns, as the drain sees it.
struct DrainTarget {
    uint32_t roomId = 0;
    int pid = 0;
    SessionKind kind = SessionKind::Skirmish;
    /// A live process by pid, not by the `game_servers` row (the row is stale
    /// precisely when it matters — see WarResume.h).
    bool alive = false;
    /// A replay room's server is playing back a recording, not hosting a world.
    /// It is still signalled — it is a process running the old binary — but it
    /// has nothing to checkpoint and must not be reported as a lossy exit.
    bool isReplay = false;
};

enum class DrainAction : uint8_t {
    /// Nothing to do: no live process for this room.
    None = 0,
    /// SIGTERM it and wait for the exit. Every live server, every kind.
    Signal,
};

/// Pure, and deliberately trivial: the value of the function is that the
/// "every kind" rule is written down once, next to the reason it differs from
/// `ActionOnLobbyExit`, instead of being an absent `if` in the route handler.
DrainAction DecideDrainAction(const DrainTarget& t);

// ─────────────────────────── what came of it ───────────────────────────

enum class DrainOutcome : uint8_t {
    /// No live process when the drain ran.
    NotRunning = 0,
    /// Exited, and left an exit checkpoint newer than the one it started with.
    Checkpointed,
    /// Exited with nothing new in the store. Benign for a skirmish and for a
    /// replay; DATA LOSS for a war.
    ExitedWithoutCheckpoint,
    /// Did not exit within the deadline and was SIGKILLed. A war killed this
    /// way had no chance to checkpoint — always lossy.
    KilledAfterTimeout,
    /// Did not exit and was not killed (the caller declined to escalate). The
    /// deploy must not proceed.
    StillAlive,
};

const char* ToString(DrainOutcome o);

struct DrainResult {
    uint32_t roomId = 0;
    SessionKind kind = SessionKind::Skirmish;
    int pid = 0;
    DrainOutcome outcome = DrainOutcome::NotRunning;
    /// The frame the exit checkpoint captured, or −1.
    int32_t frame = -1;
    std::string label;
    /// Milliseconds spent waiting for this process to go away.
    int64_t waitedMs = 0;
    /// True when a resumable world was lost rather than deliberately dropped —
    /// the same distinction, and the same word, as
    /// `hibernate::CheckpointDecision::lossy`. This is what an operator has to
    /// read before upgrading.
    bool lossy = false;
    /// Populated for a war: can the world it just wrote be loaded by the binary
    /// that is about to replace this one? The drain cannot know the NEW hash, so
    /// this is the eligibility under the CURRENT one — i.e. "resumable until the
    /// rebuild", which is the honest statement and is why the report says so in
    /// those words rather than promising a post-upgrade resume.
    warresume::ResumeEligibility eligibility =
        warresume::ResumeEligibility::NoHistory;
};

/// Pure. `before`/`after` are the store's newest snapshot for the room either
/// side of the signal, which is how a *fresh* exit checkpoint is told from an
/// old one still lying there (the room-id + `id DESC` read of
/// `warresume::LatestSnapshot`). A war that exits without moving that row lost
/// its world, whatever the row says.
DrainOutcome ClassifyDrainExit(bool exited, bool escalated,
                               const warresume::SnapshotFacts& before,
                               const warresume::SnapshotFacts& after);

/// Pure: fills outcome/frame/label/lossy from the same inputs. `isReplay` and
/// `kind` decide only whether a missing checkpoint is loss or nothing.
DrainResult BuildResult(const DrainTarget& t, bool exited, bool escalated,
                        int64_t waitedMs,
                        const warresume::SnapshotFacts& before,
                        const warresume::SnapshotFacts& after);

/// One line per room, for the log and the JSON's `detail`.
std::string Describe(const DrainResult& r);

struct DrainSummary {
    int servers = 0;         ///< live processes the drain signalled
    int checkpointed = 0;    ///< wars (and skirmishes) that left a fresh world
    int lossy = 0;           ///< resumable worlds lost — the number that gates a deploy
    int killed = 0;          ///< escalated to SIGKILL
    int stillAlive = 0;      ///< never went away
    /// False when anything is still alive, i.e. the machine is not actually
    /// drained and replacing the binary now would leave old processes serving.
    bool drained = true;
};

DrainSummary Summarise(const std::vector<DrainResult>& results);

/// The sentence the drain logs and returns. Says the count that matters first.
std::string Describe(const DrainSummary& s);

// ───────────────────── probing the binary's engine hash ─────────────────────

/// Parse the output of `spring-server --print-engine-hash`. Accepts exactly a
/// 16-lowercase-hex token (surrounded by any whitespace), which is the spelling
/// `game_snapshots.engine_hash` stores. Returns "" on anything else — including
/// a binary that printed a usage error, which is what an OLD server binary
/// (one built before this flag existed) does, and is why the caller must treat
/// an empty result as "cannot pre-check" rather than as a mismatch.
std::string ParseEngineHashOutput(const std::string& out);

/// Run `<bin> --print-engine-hash` and return the hash, or "" plus `err`.
/// Not pure (fork/exec via popen) and not on any hot path: the lobby calls it
/// once per server binary and caches on (path, mtime, size).
std::string ProbeServerEngineHash(const std::string& bin, std::string& err);

}  // namespace deploydrain
