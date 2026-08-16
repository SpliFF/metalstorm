// WarTermination — when does a war end, and what does the Director do next.
//
// PLAN-metalstorm-wars.md §7, task 4. §2.4 gives the War Director "retire /
// archive a war on a terminal condition; trigger escrow settlement + digest"
// and §2.5 gives it the meta-state machine; this file is both, as arithmetic
// on values. No sqlite, no room registry, no sim — the same discipline
// WarDeploy.h, WarSeeding.h and DynamicJoin.h use, so the whole of "which wars
// are over" tests without a lobby.
//
// ── The three terminal conditions, and the one that is NOT a condition ──────
//
//   * **Victory objective met** — the primary intended end (§7). It is the
//     SIM's declaration, not a judgement made here: a scenario declares which
//     of its objectives is terminal (`victory = true`, §7.1) and
//     `game_gameover.lua` runs the whole `active → winding_down → resolving →
//     Spring.GameOver` chain in-sim. The Director's job is to *observe* that
//     and move its own row, because the sim cannot write the `wars` table and
//     the lobby cannot read rulesParams.
//   * **Faction elimination** — a faction has lost its last foothold in the
//     theatre. The sim publishes the census (which of a side's declared start
//     regions it still holds — `game_gameover.lua`'s `publishFootholds`) and
//     the rule is applied here, next to the other two, because it also has to
//     be weighed against operator input the sim cannot see.
//   * **Operator retire / season boundary** — live-ops, or a scheduled
//     `seasonId` rollover.
//
// **Last-player-out is emphatically NOT a terminal condition** (§7, teams
// §4.5). A war with nobody in it hibernates and freezes; its sides are empty,
// not eliminated, and they keep their ground and their pools while frozen.
// This is the single most likely wrong rule for someone to add here later —
// "no players, so it's over" is how every *skirmish* ends — so
// `WarTerminationFacts` deliberately carries no player count at all. The fact
// simply is not available to the rule that must not use it.
//
// ── Elimination is a comparison, never an absolute ─────────────────────────
// A side with zero footholds ends the war only when some OTHER side still has
// one. Two reasons, and the second is the one that bites:
//   * "everybody lost" is not a war ending, it is a broken census. A neutral
//     event that flipped every home region at once (a scenario edit, a region
//     gadget reload) would otherwise archive every live war on the box.
//   * a war whose census has not been taken yet reports all-zero, and the
//     first heartbeat of every freshly seeded war looks exactly like a total
//     wipe. `footholdsKnown` guards the rule and all-zero refuses regardless,
//     so the two independent ways of getting there are both closed.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "WarDirector.h"

/// Why a war ended. `None` is the ordinary answer for a live war.
enum class WarTerminalReason : uint8_t {
    None = 0,
    /// The scenario's `victory = true` objective resolved for one side (§7.1).
    /// The primary intended end.
    VictoryObjective,
    /// A faction lost its last foothold in the theatre (§7). NOT "a side has
    /// no players".
    FactionElimination,
    /// Live-ops retired the war explicitly.
    OperatorRetire,
    /// The war's `seasonId` is no longer the current one (§7 "season end").
    SeasonEnd,
};

inline const char* WarTerminalReasonToString(WarTerminalReason r) {
    switch (r) {
        case WarTerminalReason::None:               return "none";
        case WarTerminalReason::VictoryObjective:   return "victory_objective";
        case WarTerminalReason::FactionElimination: return "faction_elimination";
        case WarTerminalReason::OperatorRetire:     return "operator_retire";
        case WarTerminalReason::SeasonEnd:          return "season_end";
    }
    return "none";
}

/// The one sentence each ending carries into the war-over digest. Beside the
/// vocabulary rather than in the client for the same reason
/// `warevents::Headline` is: a new reason cannot be added without prose for
/// it, and the lobby's log line and the player's digest cannot drift.
inline const char* WarTerminalReasonHeadline(WarTerminalReason r) {
    switch (r) {
        case WarTerminalReason::None:
            return "The war continues.";
        case WarTerminalReason::VictoryObjective:
            return "The war was won on its objective.";
        case WarTerminalReason::FactionElimination:
            return "A faction was driven out of the theatre.";
        case WarTerminalReason::OperatorRetire:
            return "The war was retired.";
        case WarTerminalReason::SeasonEnd:
            return "The season ended.";
    }
    return "The war ended.";
}

/// Everything the terminal-condition rule is allowed to see. Values only.
///
/// Note what is absent and stays absent: any count of players, connections or
/// sessions. See the header block — last-player-out is not a terminal
/// condition, and the cheapest way to keep it from becoming one is to not
/// hand the rule the number.
struct WarTerminationFacts {
    /// What the sim last declared, verbatim from `game_gameover.lua`'s
    /// `war_state` rulesParam: "active" | "winding_down" | "resolving" |
    /// "over". Empty when no running server has reported (a hibernated war, or
    /// one whose scenario has no gameover gadget) — which is NOT an ending.
    std::string simWarState;
    /// The team the sim declared the winner, -1 if none.
    int winnerTeam = -1;

    /// True when the sim's foothold census is usable
    /// (`war_footholds_known`). False for a war with no scenario, a scenario
    /// declaring no starting regions, or a war whose server is not running.
    /// The elimination rule is inert without it, deliberately: ending a war
    /// because a census was unavailable is the failure mode this flag makes
    /// unrepresentable.
    bool footholdsKnown = false;
    std::vector<WarSideFootholds> footholds;

    /// Live-ops pressed retire.
    bool operatorRetire = false;

    /// The war's own season, and the season the lobby is currently running.
    /// Both empty (the ordinary case — no seasons configured) never ends a
    /// war; a war with no season in a lobby that HAS one does not end either,
    /// because it predates the season system rather than belonging to a
    /// finished one.
    std::string warSeasonId;
    std::string currentSeasonId;
};

/// Which faction (if any) has been driven out. Empty when none has, when the
/// census is unusable, or when the answer would be "everybody" — see the
/// header block for why the last one is a refusal rather than a mass ending.
///
/// Deterministic when more than one side is out at once: the first in
/// declaration order, which is the same order `war_sides` and every other
/// war surface uses.
inline std::string EliminatedFaction(const WarTerminationFacts& f) {
    if (!f.footholdsKnown || f.footholds.size() < 2)
        return {};
    bool anySurvivor = false;
    for (const auto& s : f.footholds)
        if (s.held > 0) { anySurvivor = true; break; }
    if (!anySurvivor)
        return {};
    for (const auto& s : f.footholds)
        if (s.held == 0)
            return s.factionId;
    return {};
}

/// Has this war met a terminal condition, and which one?
///
/// Precedence, and each place in it is a decision:
///   1. **Operator retire** outranks everything. It is a human saying stop,
///      and a war that is also mid-wind-down should still stop when asked.
///   2. **The sim's declaration.** A war whose sim has left `active` is
///      ending on its own terms, and the Director's job there is to follow,
///      not to re-decide. In particular the elimination rule must not fire on
///      a war already winding down from its victory objective — the ending
///      that gets archived would then name the wrong reason.
///   3. **Faction elimination.**
///   4. **Season end**, last because a war actively finishing on its own
///      objective deserves to be recorded as having done so even if the
///      season boundary passes in the same sweep.
inline WarTerminalReason EvaluateWarTermination(const WarTerminationFacts& f) {
    if (f.operatorRetire)
        return WarTerminalReason::OperatorRetire;
    if (!f.simWarState.empty() && f.simWarState != "active")
        return WarTerminalReason::VictoryObjective;
    if (!EliminatedFaction(f).empty())
        return WarTerminalReason::FactionElimination;
    if (!f.warSeasonId.empty() && !f.currentSeasonId.empty() &&
        f.warSeasonId != f.currentSeasonId)
        return WarTerminalReason::SeasonEnd;
    return WarTerminalReason::None;
}

/// The state a war should be in, given where it is and what the facts say.
/// Returns `current` when nothing should move — so a caller can drive the
/// whole population by comparing and only writing the differences, and a war
/// that is already right costs one comparison and no transaction.
///
/// The chain is deliberately walked ONE step per call rather than jumped:
/// `seeding → open → active → winding_down → resolving → archived`. A war
/// observed for the first time in `resolving` still passes through
/// `winding_down` on the Director's row, because `IsLegalWarTransition` refuses
/// the jump and because the intermediate row is what the browser renders while
/// the sim is settling. The sweep runs every few seconds, so "one step per
/// call" costs at most a few seconds of lag on a state nobody can act on.
///
/// The one exception is the one `IsLegalWarTransition` already carves out:
/// an operator retire goes straight to `Archived` from anywhere. That is a
/// human overriding the machine, and making them wait four sweeps for a war
/// they have retired would be the machine overriding the human.
inline WarState NextWarState(WarState current, WarTerminalReason reason,
                             bool hasLiveHumans) {
    if (current == WarState::Archived)
        return current;

    if (reason == WarTerminalReason::OperatorRetire)
        return WarState::Archived;

    if (reason != WarTerminalReason::None) {
        switch (current) {
            // A war still seeding when a terminal condition fires never became
            // a war. It archives directly — there is no wind-down to play out
            // and nobody to notify, and leaving it in `seeding` would strand a
            // row that no legal transition can clean up.
            case WarState::Seeding:     return WarState::Archived;
            case WarState::Open:
            case WarState::Active:      return WarState::WindingDown;
            case WarState::WindingDown: return WarState::Resolving;
            case WarState::Resolving:   return WarState::Archived;
            case WarState::Archived:    return current;
        }
        return current;
    }

    // No terminal condition: the only live movement is open ⇄ active, and it
    // is one-way. `Active` means "this war has been fought in", which is what
    // §4's demand-driven seeding wants to know; dropping back to `Open` the
    // moment the last player logs off would make an established war look
    // freshly seeded and would re-introduce last-player-out by the back door.
    if (current == WarState::Open && hasLiveHumans)
        return WarState::Active;
    return current;
}
