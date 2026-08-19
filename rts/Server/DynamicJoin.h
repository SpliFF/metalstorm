// DynamicJoin — may an authenticated account that is NOT in the launch roster
// take a *playing* seat in this session, and on which team?
//
// PLAN-metalstorm-lobby.md §2.1/§2.3, task 2. Task 1 removed the *start* gate
// (a persistent war fires GameStart without waiting for a roster); this is the
// *join* gate that made that start pointless.
//
// ── The premise the task was queued on was stale, and the correction matters ──
// §2.1 says the auth handler "rejects any username not in that roster
// (`:187`)". It does not, and has not for a long time: ClientMessageHandler
// admits a non-roster account as a **spectator** (team -1, the spectator
// role), because PLAN-metalstorm-onboarding.md §4's "spectate a running game"
// flow depends on exactly that. So nobody was refused — they were seated where
// they could watch a war and never fight in one. The gap is therefore not
// "accept the auth" (already accepted) but "let a war promote that spectator
// to a side", and the spectator fallback stays the answer for everything this
// function declines.
//
// Everything here is a pure function of values, so the whole policy is
// testable without a server, a database or a socket — the same discipline
// GameStartCoordinator.h's two gate expressions use.
#pragma once

#include <cstdint>
#include <string>

#include "RoomManager.h"   // SessionKind
#include "WarSides.h"

/// Why a dynamic join was admitted or declined. Every non-`Admit` outcome
/// leaves the connection on the pre-existing spectator path — none of them is
/// an error, and none of them refuses the connection.
enum class DynamicJoinOutcome : uint8_t {
    /// Not a persistent war. A skirmish's roster is its whole cast by
    /// definition: it was sized, seated and start-gated on that list, so an
    /// extra body would be playing a game nobody agreed to.
    NotAWar = 0,
    /// The account carries no faction (a dev account, a `/api/rooms/direct`
    /// manifest account, a pre-faction legacy account). Faction is the only
    /// thing that may choose a side (§2.3), so there is nothing to seat on.
    NoFaction,
    /// This war declares no side for that faction — including every legacy
    /// room, whose teams have no faction names at all.
    NoSideForFaction,
    /// The faction's side is at capacity.
    SideFull,
    /// Seat them on `team`.
    Admit,
};

/// Human-readable outcome, for the operator log. A dynamic join that silently
/// does not happen is indistinguishable from a spectator who meant to
/// spectate, and that is the whole class of bug this lane keeps finding.
inline const char* DynamicJoinOutcomeToString(DynamicJoinOutcome o) {
    switch (o) {
        case DynamicJoinOutcome::NotAWar:          return "not a persistent war";
        case DynamicJoinOutcome::NoFaction:        return "account has no faction";
        case DynamicJoinOutcome::NoSideForFaction: return "war declares no side for this faction";
        case DynamicJoinOutcome::SideFull:         return "the faction's side is full";
        case DynamicJoinOutcome::Admit:            return "admitted";
    }
    return "unknown";
}

struct DynamicJoinDecision {
    DynamicJoinOutcome outcome = DynamicJoinOutcome::NotAWar;
    /// The team to seat on. Only meaningful when `outcome == Admit`; -1
    /// otherwise, so a caller that forgets to branch seats a spectator rather
    /// than team 0.
    int team = -1;

    bool Admitted() const { return outcome == DynamicJoinOutcome::Admit; }
};

// `WAR_SIDE_CAPACITY_UNLIMITED` / `WAR_SIDE_CAPACITY_DEFAULT` moved to
// WarSides.h with task 7: capacity is now a per-side property OF the sides
// (`war_side_capacities`), read by the browser and the seeding rule as well as
// by this decision, so it belongs with the sides rather than with the one
// consumer that happened to need it first. Reachable from here unchanged —
// WarSides.h is included above.

/// Decide whether a non-roster authenticated account may take a playing seat.
///
/// @param kind            this session's kind (only a war admits)
/// @param factionId       the account's permanent faction (`users.faction_id`)
/// @param sides           the war's sides, from the `war_sides` modoption
/// @param humansOnSide    active, non-spectator, non-AI players already seated
///                        on the faction's team
/// @param capacityPerSide humans allowed per side, or
///                        `WAR_SIDE_CAPACITY_UNLIMITED`
///
/// The capacity comparison is `>=`, not `>`: `humansOnSide` is measured before
/// the joiner is bound, so a side at exactly capacity is full.
inline DynamicJoinDecision DecideDynamicJoin(SessionKind kind,
                                             const std::string& factionId,
                                             const WarSides& sides,
                                             unsigned humansOnSide,
                                             unsigned capacityPerSide) {
    if (kind != SessionKind::PersistentWar)
        return {DynamicJoinOutcome::NotAWar, -1};
    if (factionId.empty())
        return {DynamicJoinOutcome::NoFaction, -1};
    const auto team = TeamForFactionIn(sides, factionId);
    if (!team)
        return {DynamicJoinOutcome::NoSideForFaction, -1};
    if (capacityPerSide != WAR_SIDE_CAPACITY_UNLIMITED &&
        humansOnSide >= capacityPerSide)
        return {DynamicJoinOutcome::SideFull, -1};
    return {DynamicJoinOutcome::Admit, static_cast<int>(*team)};
}
