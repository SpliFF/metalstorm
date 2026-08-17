// WarLifecycleSweep — the Director's half of §7, applied.
//
// PLAN-metalstorm-wars.md §2.4/§2.5 and §7, task 4. `WarTermination.h` decides
// whether a war has ended and what state it should be in; this file is the one
// that writes that decision down, in the same split `WarSideMaintenance` uses
// (`PlanWarSideMaintenance` is pure, `RunWarSideMaintenance` applies it).
//
// ── One step per sweep, and why that is not laziness ───────────────────────
// The lobby calls this on its existing maintenance cadence, once per live war.
// Each call moves a war at most one link along `seeding → open → active →
// winding_down → resolving → archived`, because `IsLegalWarTransition` refuses
// jumps and because the intermediate rows are what the browser renders while
// the sim settles. The cost of the lag is a few seconds on states nobody can
// act on; the cost of jumping would be a war that was never observably
// winding down, which is the state the "your war is ending" notification is
// hung on.
//
// The operator retire is the deliberate exception and goes straight to
// `archived` — a human overriding the machine should not wait four sweeps for
// a war they have retired.
//
// ── What archiving actually does ──────────────────────────────────────────
// §7 `archived` names three consequences and this does all three:
//
//   1. **the final scoreboard is recorded** — already durable in `war_outcome`
//      by the time we get here, because the game server wrote it when the sim
//      declared the ending. What archiving adds is the Director's own half:
//      the terminal REASON, which is the only field that exists for the
//      endings the sim never sees (operator retire, season end, a faction
//      driven out of the theatre).
//   2. **enlisted players get a war-over digest** — appended to `game_events`,
//      the table the while-you-were-away digest already reads
//      (`POST /api/wars/join-preview`). Deliberately NOT a new per-account
//      mailbox: every enlisted account already has a cursor into this stream,
//      the digest is already the surface that tells a returning player what
//      they missed, and "the war ended and X won" is the last line of that
//      story rather than a different feature.
//   3. **bindings are closed.** Modelled by the war leaving `ListLive` rather
//      than by a column: a binding to an archived war seats nobody, because
//      every path that consults one (Deploy's `iAmBound`, the rejoin policy,
//      the browser's "my wars") filters on live wars first. The rows stay, and
//      have to — §7 keeps the war "for history/stats" and the binding is the
//      record of who fought in it.
#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include "WarTermination.h"

struct sqlite3;

/// What one sweep did to one war. Returned rather than logged so the caller
/// owns the log line (and the tests can assert on the decision without
/// scraping stderr).
struct WarLifecycleStep {
    WarState from = WarState::Seeding;
    WarState to = WarState::Seeding;
    WarTerminalReason reason = WarTerminalReason::None;
    /// The faction driven out, when `reason == FactionElimination`.
    std::string eliminatedFaction;
    /// True when this step is the one that archived the war — i.e. the one
    /// that stamped the reason and emitted the digest. Exactly one sweep of a
    /// war's life reports true, which is what makes "notify once" fall out of
    /// the state machine instead of needing a separate latch.
    bool archived = false;
};

/// Advance one war by at most one step.
///
/// Returns nullopt when nothing moved — the ordinary answer for a live war,
/// and the reason the sweep is cheap enough to run over the whole population
/// on a short cadence: a war that is already right costs one read and no
/// transaction.
///
/// @param hasLiveHumans  whether anyone is connected to this war right now.
///   Used for exactly ONE thing — the `open → active` promotion, which is
///   §4's "which wars are actually being fought" — and deliberately never as
///   a terminal condition. See `WarTermination.h`: last-player-out is not an
///   ending, it is a hibernation, and a war with nobody in it keeps its
///   ground, its pools and its state.
std::optional<WarLifecycleStep> AdvanceWarLifecycle(
    sqlite3* db, uint32_t roomId, const WarTerminationFacts& facts,
    bool hasLiveHumans, int64_t now);

/// The digest line an archived war leaves in `game_events`. Exposed for the
/// test and for the lobby's log line, so the sentence a player reads and the
/// sentence the operator reads are the same string.
std::string WarOverDigestDetail(const WarLifecycleStep& step,
                                const std::string& winnerFactions);
