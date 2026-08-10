// JoinPreview — what the lobby promises a player about a war BEFORE they join.
//
// PLAN-metalstorm-lobby.md §2.4, task 5, second half. §2.4 splits the
// onboarding work in two and is explicit about the split: the *grants* are
// sim-side (that is the hook contract in PlayerOnboarding.h), and "the lobby's
// job is to make this legible pre-join ('you'll join Side B near the River Line
// with 100 authority')".
//
// ── The one property that makes this worth a file ──────────────────────────
// A preview is a promise, and a promise built from a second, parallel reading
// of the seating rules is a promise the seating rule will eventually break. So
// this composes the SAME two pure functions the game server actually seats
// with — `DecideDynamicJoin` (task 2) and `DecideRejoin` (task 4) — rather than
// re-deriving "which side is this player on" from the room row. If the rules
// change, the promise changes with them or it does not compile.
//
// The lobby can do this because every input is in the shared SQLite db or the
// room row it already holds: the war's `war_sides` modoption, the account's
// immutable faction, the per-side population (`war_player_bindings`, which the
// game server writes and the lobby already links to read), and the account's
// own binding. Nothing here needs the running sim, which is the point —
// a preview has to answer for a war whose server is not even up (task 3).
#pragma once

#include <cstdint>
#include <string>

#include "DynamicJoin.h"
#include "WarRejoinPolicy.h"
#include "WarSides.h"

/// Where the authority a player arrives with comes from. Distinct outcomes
/// rather than a bare number, because the three read very differently to a
/// player and only one of them is new money.
enum class JoinAuthoritySource : uint8_t {
    /// Nothing: this account will not be fighting (spectator preview).
    None = 0,
    /// A fresh join grant, minted by `gadget:PlayerAdded` (`authority_join_grant`).
    JoinGrant,
    /// The pool they left with, moved back out of the team pool. Conserving —
    /// it is their own authority, not a new allotment.
    RestoredPool,
    /// A brand-new stipend because the saved pool went stale (§2.5).
    OnboardingStipend,
};

inline const char* JoinAuthoritySourceToString(JoinAuthoritySource s) {
    switch (s) {
        case JoinAuthoritySource::None:              return "none";
        case JoinAuthoritySource::JoinGrant:         return "join_grant";
        case JoinAuthoritySource::RestoredPool:      return "restored_pool";
        case JoinAuthoritySource::OnboardingStipend: return "onboarding_stipend";
    }
    return "unknown";
}

struct JoinPreview {
    /// Whether this account would take a PLAYING seat. False means the join
    /// still succeeds — as a spectator, which is what every declined dynamic
    /// join falls back to — so this is "will you fight", not "may you enter".
    bool willFight = false;
    /// Why not, when `willFight` is false. Straight from the seating rule, so
    /// the lobby can say "your faction fields no side in this war" rather than
    /// a generic refusal.
    DynamicJoinOutcome outcome = DynamicJoinOutcome::NotAWar;
    /// The team they would be seated on, -1 when spectating.
    int team = -1;
    /// The faction key of that side, as the war declares it. Empty when
    /// spectating.
    std::string side;
    /// Humans already bound to that side, and the per-side cap (0 = no cap).
    unsigned humansOnSide = 0;
    unsigned capacityPerSide = 0;
    /// The authority they will hold on arrival, and where it comes from.
    double authority = 0.0;
    JoinAuthoritySource authoritySource = JoinAuthoritySource::None;
    /// True when this account already holds this seat (a rejoin, not a join).
    bool returning = false;
};

/// Compose the preview.
///
/// @param kind            the room's session kind
/// @param factionId       the account's immutable faction (may be empty)
/// @param sides           the war's `war_sides`
/// @param humansOnSide    bindings already on the faction's side, EXCLUDING
///                        this account's own (a returning player must not be
///                        counted against the seat they are standing in —
///                        the same reason `DecideRejoin` grants
///                        `bypassCapacity`)
/// @param capacityPerSide humans per side, or `WAR_SIDE_CAPACITY_UNLIMITED`
/// @param hasBinding      whether this account is already bound to this war
/// @param boundTeam       the team that binding records
/// @param absenceSec      seconds since that binding was last seen
/// @param savedPool       the pool captured when they left
/// @param hasSavedState   whether a capture ever ran
/// @param joinGrant       the war's `authority_join_grant` modoption
///
/// Ordering mirrors the live path exactly: the rejoin decision is consulted
/// first, because a restored seat may bypass the capacity check, and only then
/// does the dynamic-join rule run for everyone else. Getting that backwards
/// would show "this side is full" to the one player who is guaranteed a place.
inline JoinPreview PreviewJoin(SessionKind kind, const std::string& factionId,
                               const WarSides& sides, unsigned humansOnSide,
                               unsigned capacityPerSide, bool hasBinding,
                               int boundTeam, int64_t absenceSec,
                               double savedPool, bool hasSavedState,
                               double joinGrant) {
    JoinPreview p;
    p.capacityPerSide = capacityPerSide;
    p.humansOnSide = humansOnSide;

    int factionTeam = -1;
    if (!factionId.empty()) {
        if (const auto t = TeamForFactionIn(sides, factionId))
            factionTeam = static_cast<int>(*t);
    }

    const RejoinDecision rj = DecideRejoin(hasBinding, boundTeam, factionTeam,
                                           absenceSec, savedPool, hasSavedState);

    // Capacity is only bypassed for a war; a skirmish never admits at all and
    // must not be talked out of that by a stale binding.
    const bool bypass = (kind == SessionKind::PersistentWar) && rj.bypassCapacity &&
                        rj.SeatRestored();
    const DynamicJoinDecision dj =
        DecideDynamicJoin(kind, factionId, sides, bypass ? 0 : humansOnSide,
                          bypass ? WAR_SIDE_CAPACITY_UNLIMITED : capacityPerSide);

    p.outcome = dj.outcome;
    p.returning = rj.SeatRestored();
    if (!dj.Admitted())
        return p;

    p.willFight = true;
    p.team = dj.team;
    p.side = factionId;

    switch (rj.state) {
        case RejoinState::RestorePool:
            // A top-up to the remembered level, so what they ARRIVE with is
            // that level — not the level plus a grant. Matching
            // GG.Authority.RestorePool's own shape here is what stops the
            // preview promising a number the sim will not produce.
            p.authority = savedPool;
            p.authoritySource = JoinAuthoritySource::RestoredPool;
            break;
        case RejoinState::OnboardingStipend:
            p.authority = joinGrant;
            p.authoritySource = JoinAuthoritySource::OnboardingStipend;
            break;
        case RejoinState::Nothing:
            // Either a first join (the PlayerAdded grant) or a binding that
            // never got as far as a state save — in both cases the once-per-
            // identity join grant is what they end up holding.
            p.authority = joinGrant;
            p.authoritySource = JoinAuthoritySource::JoinGrant;
            break;
    }
    return p;
}
