// Journey — the two pure decisions the first-time-player lobby routes make.
//
// PLAN-beta-journey.md §(c) (SOLO boot) and §0 (standing accrual). Both are
// arithmetic over values, so both live here rather than inside a route: the
// allow-list is what keeps `POST /api/rooms/solo` from becoming a public
// "boot any scenario" verb, and the accrual is the only place standing is
// ever computed. A rule that decides who may spawn a process and a rule that
// decides what a session is worth are exactly the two things a reader should
// be able to check without a lobby, a database or a socket.
#pragma once

namespace Journey {

// ── SOLO scenario allow-list (§(c)) ────────────────────────────────────────

/// May `POST /api/rooms/solo` boot this scenario?
///
/// `/api/rooms/direct` is admin/localhost-gated because a manifest names its
/// own map, sides, AI and modoptions — it is arbitrary process creation. The
/// solo route is player-facing, so the scenario must have been AUTHORED for
/// one human: `tutorial = true` or `solo = true` is the author saying so, and
/// nothing else qualifies. A war scenario booted this way would stage a
/// multi-faction front for a single Recruit.
///
/// `retired` refuses even a flagged scenario, for the reason
/// ScenarioDiscovery::DefaultForMap already states: the one thing a
/// player-facing boot must not do is hand somebody a mission that cannot be
/// fought.
inline constexpr bool SoloAllowed(bool tutorial, bool solo, bool retired) {
    if (retired) return false;
    return tutorial || solo;
}

// ── Standing accrual (§0) ──────────────────────────────────────────────────

/// A completed session, whatever happened in it. Finishing is the thing being
/// rewarded — a Recruit who loses their first mission has still played it.
inline constexpr int kStandingPerSession = 10;
/// Per objective the summary credits this player with.
inline constexpr int kStandingPerObjective = 5;
/// Per mentor endorsement, rate-limited to one per mentor→mentee per day by
/// Mentorship::Endorse (which owns the once-a-day rule, not this file).
inline constexpr int kStandingPerEndorsement = 15;

struct Accrual {
    int standing = 0;
    int sessions = 0;
};

/// What one finished mission is worth to one player.
///
/// `objectivesCredited` is 0 whenever the war summary carries no per-player
/// credit — which is every mission at beta until the sim publishes it — and
/// that is deliberately the SAME code path as "credited with none", not a
/// special case: a mission is worth its session either way, so an absent
/// field can never cost a player the +10 they earned by finishing.
///
/// Negative input is clamped rather than rejected: this is called once per
/// player per mission end, in a loop that must not have a failure mode.
inline constexpr Accrual SessionAccrual(int objectivesCredited) {
    Accrual a;
    a.sessions = 1;
    a.standing = kStandingPerSession +
                 kStandingPerObjective *
                     (objectivesCredited > 0 ? objectivesCredited : 0);
    return a;
}

}  // namespace Journey
