// WarRejoinPolicy — what a returning player gets back when they re-enter a
// persistent war they have fought in before.
//
// PLAN-metalstorm-lobby.md §2.5/§5.1, task 4. Task 2 seats a joiner by faction
// every time they connect and task 3 lets the war outlive the lobby that
// spawned it — but nothing about *that player's* war state survived either, so
// a returning player came back as a new player with the right badge.
//
// ── Two horizons, not one, and they answer different questions ──────────────
// §2.5 asks for two things that read as one: "the player's side persists and
// rejoin restores it" and "distinguish a brief disconnect (keep pools intact)
// from a long absence (authority may have been reclaimed)". They are separate
// because the two things being restored have different natures:
//
//   * The SEAT is an identity. A player who fought for the Union on team 1
//     yesterday is still a Union player today, and the only thing that can
//     take the seat away is the war retiring their side. It is held for
//     `WAR_SEAT_HOLD_SEC` against *capacity* — the one rule that would
//     otherwise turn a returning veteran into a spectator of their own war
//     because eight other people logged in first.
//   * The POOL is a resource, and it is conserved. game_authority.lua's
//     PlayerRemoved merges a departing player's pool into the TEAM pool on
//     every leave reason — so by the time this policy runs, the authority is
//     not sitting in limbo waiting to be handed back, it has already been
//     spent or is being spent by the player's own team. Restoring it means
//     moving it back out of the team pool, which is only defensible while the
//     absence is short enough that the team has not re-planned around it.
//     That is `WAR_BRIEF_ABSENCE_SEC`.
//
// Everything here is a pure function of values — no db, no socket, no sim —
// the same discipline DynamicJoin.h and GameStartCoordinator.h's gate
// expressions use, so the whole policy is testable on its own.
#pragma once

#include <cstdint>

/// How long a bound player's seat is held against the per-side capacity check.
/// A week: long enough that a player who plays on weekends keeps the side they
/// fought for, short enough that a war abandoned for a month is not permanently
/// full of accounts that never came back. This does NOT gate *which* team they
/// are seated on — that follows the faction, always — only whether a full side
/// may turn them away.
inline constexpr int64_t WAR_SEAT_HOLD_SEC = 7 * 24 * 60 * 60;

/// How long an absence may be before the saved authority pool is treated as
/// stale. Five minutes: a tab reload, a dropped connection, a browser crash and
/// a walk to the kettle are all inside it; a session boundary is not. Past it
/// §2.5's rule applies — "rejoin re-grants a small onboarding stipend rather
/// than restoring a stale pool".
inline constexpr int64_t WAR_BRIEF_ABSENCE_SEC = 5 * 60;

/// What happened to the seat.
enum class RejoinSeat : uint8_t {
    /// This account has never been bound to this war. Nothing to restore —
    /// the caller falls through to task 2's faction rule, which is also what
    /// mints the binding.
    NoBinding = 0,
    /// A binding exists but the war no longer seats this account's faction on
    /// the team it records (the sides were re-authored between sessions). The
    /// FACTION is the immutable identity and the team is derived from it, so
    /// the faction rule wins and the binding is re-written, never the reverse.
    Superseded,
    /// Seat restored: this is the team the account already holds in this war.
    Restored,
};

/// What happens to the per-player war state.
enum class RejoinState : uint8_t {
    /// No saved state to act on (a first join, or a binding that never got as
    /// far as a state save).
    Nothing = 0,
    /// Inside the brief-absence window: move the saved pool back out of the
    /// team pool it was merged into on leave. Conserving, never minting.
    RestorePool,
    /// Past it: the pool is stale (§2.5). The player gets the onboarding
    /// stipend instead — a small minted grant, so a returning player can give
    /// an order rather than sitting at zero until the next team payout.
    OnboardingStipend,
};

struct RejoinDecision {
    RejoinSeat  seat  = RejoinSeat::NoBinding;
    RejoinState state = RejoinState::Nothing;
    /// The team the binding restores. -1 unless `seat == Restored`, so a
    /// caller that forgets to branch seats a spectator rather than team 0.
    int    team = -1;
    /// Whether the per-side capacity check may be skipped for this joiner.
    /// True only for a restored seat inside `WAR_SEAT_HOLD_SEC`: the seat is
    /// already theirs, so counting them against it would refuse a player the
    /// place they are standing in.
    bool   bypassCapacity = false;
    /// The pool to move back, meaningful only for `RestorePool`.
    double pool = 0.0;

    bool SeatRestored() const { return seat == RejoinSeat::Restored; }
};

inline const char* RejoinSeatToString(RejoinSeat s) {
    switch (s) {
        case RejoinSeat::NoBinding:  return "no existing binding";
        case RejoinSeat::Superseded: return "binding superseded by the war's sides";
        case RejoinSeat::Restored:   return "seat restored from the binding";
    }
    return "unknown";
}

/// The seat as a WIRE key, kept separate from the prose above on purpose.
/// `RejoinSeatToString` is a log sentence ("binding superseded by the war's
/// sides"); a client that switched on it would be switching on English. These
/// three tokens are the vocabulary `/api/wars/join-preview` publishes and
/// `war-browser.ts` decodes — the same split `SessionKindToString` and
/// `warresume::ToString` already use.
inline const char* RejoinSeatKey(RejoinSeat s) {
    switch (s) {
        case RejoinSeat::NoBinding:  return "no_binding";
        case RejoinSeat::Superseded: return "superseded";
        case RejoinSeat::Restored:   return "restored";
    }
    return "no_binding";
}

inline const char* RejoinStateToString(RejoinState s) {
    switch (s) {
        case RejoinState::Nothing:           return "no saved state";
        case RejoinState::RestorePool:       return "pool restored (brief absence)";
        case RejoinState::OnboardingStipend: return "onboarding stipend (long absence)";
    }
    return "unknown";
}

/// Decide what a returning account gets back.
///
/// @param hasBinding      whether this account is bound to this war at all
/// @param boundTeam       the team the binding records
/// @param factionTeam     the team the war seats this account's faction on
///                        *now*, or -1 if it seats none
/// @param absenceSec      seconds since the binding was last seen
/// @param savedPool       the authority pool captured when they left
/// @param hasSavedState   whether a state capture ever ran for this binding
///                        (distinct from `savedPool > 0` — a player can
///                        legitimately leave with an empty pool, and that must
///                        not read as "never saved")
///
/// A negative `absenceSec` (clock skew between the two processes that write
/// this row) is treated as zero rather than as an enormous absence: skew must
/// not silently confiscate a player's pool.
inline RejoinDecision DecideRejoin(bool hasBinding, int boundTeam, int factionTeam,
                                   int64_t absenceSec, double savedPool,
                                   bool hasSavedState) {
    RejoinDecision d;
    if (!hasBinding)
        return d;                                  // NoBinding / Nothing
    if (factionTeam < 0 || factionTeam != boundTeam) {
        d.seat = RejoinSeat::Superseded;
        return d;
    }
    const int64_t absence = (absenceSec < 0) ? 0 : absenceSec;
    d.seat           = RejoinSeat::Restored;
    d.team           = boundTeam;
    d.bypassCapacity = absence <= WAR_SEAT_HOLD_SEC;
    if (!hasSavedState) {
        d.state = RejoinState::Nothing;
    } else if (absence <= WAR_BRIEF_ABSENCE_SEC) {
        d.state = RejoinState::RestorePool;
        d.pool  = savedPool;
    } else {
        d.state = RejoinState::OnboardingStipend;
    }
    return d;
}
