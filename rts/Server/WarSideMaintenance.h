// WarSideMaintenance — keeping a LIVE war's sides the right size and the
// outnumbered one marked.
//
// PLAN-metalstorm-wars.md §4, task 2. `WarSeeding.h` sizes a war's sides once,
// at seed time, from the registered population. This is the other half: what
// happens to those numbers over the hours a persistent war then runs, when the
// populations that produced them have moved.
//
// Two maintenance rules, and the difference between them is the point of §4:
//
//   * **the cap is a soft target** — "the Director may raise it within the map
//     limit if one faction floods". A raise is a structural answer: more seats
//     on the side people are queuing for.
//   * **the incentive is a FLAG** — never a reassignment. A player always
//     fights their own faction (metalstorm §2), so the outnumbered side cannot
//     be topped up by moving anybody; all the Director can do is make that
//     side the one its own faction's next volunteer is pulled toward (Deploy's
//     ranking) and paid a bonus onboarding grant for taking (teams'
//     `JOIN_GRANT`).
//
// ── Why the map limit is a parameter and not a lookup ──────────────────────
// `WarDirector::SetSideSlotCap`'s doc comment states it: the table does not
// know the map. Neither does this file. The ceiling on a live war's total
// seats is not a fact about `war_sides` at all — it is what the RUNNING game
// server pre-allocated its player arrays for (`wars.spawned_slot_cap`, §8.1),
// plus whatever the map itself supports. A raise past the first of those
// produces a cap the dynamic join cannot honour: seats advertised in the
// lobby that the sim has no player slot for. So the caller — which is the only
// code that has the map and the spawn record in one place — supplies both, and
// this file refuses to raise past them.
//
// Pure planning here, the same discipline as `WarDeploy.h`; the db-driven pass
// at the bottom reads the facts and applies the plan through the existing
// `WarDirector` setters.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct sqlite3;

/// How far a side's bound population must trail the largest side before it is
/// flagged as the underdog.
///
/// Two, not one. A one-player difference is the ordinary state of a war
/// between two joins; flagging it would leave the incentive permanently on,
/// alternating between sides, which is the same as it being off — except that
/// it also pays a bonus grant to every second joiner in a balanced war.
inline constexpr unsigned WAR_UNDERDOG_DEFICIT = 2;

/// One side of a live war, as maintenance sees it.
struct WarSideFacts {
    std::string factionId;
    /// The side's current `slot_cap`. 0 is unlimited and is never raised —
    /// there is nothing to raise.
    unsigned    slotCap = 0;
    /// Durable seats held (`war_player_bindings`), including offline players.
    unsigned    bound = 0;
    /// Seats held by in-flight joins (`war_slot_reservations`, live only).
    unsigned    reserved = 0;
    bool        incentivised = false;

    /// Seats that are spoken for. A reservation is as real as a binding for
    /// sizing: the whole point of taking one is that the seat is gone.
    unsigned Used() const { return bound + reserved; }
    /// No free seat — the condition a raise responds to.
    bool IsPressed() const { return slotCap != 0 && Used() >= slotCap; }
};

/// The ceilings a raise may not cross. Both are 0 for "unknown", and unknown
/// is read as *no raise is possible*, not as "no limit" — the permissive
/// reading would let a war advertise seats the running server cannot seat, and
/// a joiner who is refused at the game server has already been promised a war
/// by the lobby.
struct WarSizingLimits {
    /// Σ slotCap the game server was actually spawned with (`wars.
    /// spawned_slot_cap`, §8.1). The hard one: it is the size of the player
    /// arrays.
    unsigned spawnedSlotCap = 0;
    /// What the map/theatre supports, if the caller knows. Applied as a second
    /// ceiling on the same total when non-zero.
    unsigned mapSlotLimit = 0;

    /// The binding total ceiling, or 0 when nothing is known.
    unsigned TotalCeiling() const {
        if (spawnedSlotCap == 0)
            return 0;
        if (mapSlotLimit == 0 || mapSlotLimit > spawnedSlotCap)
            return spawnedSlotCap;
        return mapSlotLimit;
    }
};

struct WarSideCapRaise {
    std::string factionId;
    unsigned    from = 0;
    unsigned    to = 0;
};

struct WarSideIncentiveChange {
    std::string factionId;
    bool        on = false;
};

struct WarSideMaintenancePlan {
    /// Only sides whose cap actually changes.
    std::vector<WarSideCapRaise> capRaises;
    /// Only sides whose flag actually changes — re-asserting a flag every
    /// sweep would make the war log unreadable and every write a lie about
    /// something having happened.
    std::vector<WarSideIncentiveChange> incentiveChanges;

    bool Empty() const {
        return capRaises.empty() && incentiveChanges.empty();
    }
};

/// Decide both maintenance rules for one war. Pure.
///
/// **Raises**, in order of pressure (most-oversubscribed side first, then by
/// faction name so the same war always maintains the same way):
///   * only a side with no free seat is raised — a raise is a response to
///     demand, not a policy;
///   * one seat per pass. A war grows with the queue rather than jumping to
///     the ceiling the first time somebody is turned away, which keeps §4's
///     "target per-war concurrency" meaningful and leaves headroom for the
///     other side to be raised when *it* fills;
///   * never past `WAR_SEED_MAX_CAPACITY` per side, and never past the total
///     ceiling across all sides. Headroom is computed against the CURRENT sum
///     of caps, so a war already at its spawn size raises nothing.
///
/// **Flags**: a side is incentivised exactly when the largest bound population
/// in the war exceeds its own by `WAR_UNDERDOG_DEFICIT` or more. Bound, not
/// used: a reservation is somebody who has not arrived, and paying a bonus for
/// a deficit that two in-flight joins are about to close would pay it to the
/// wrong people. The leader itself is never flagged.
WarSideMaintenancePlan PlanWarSideMaintenance(
    const std::vector<WarSideFacts>& sides, const WarSizingLimits& limits);

/// What one maintenance pass did.
struct WarMaintenanceResult {
    bool     ok = false;
    unsigned capsRaised = 0;
    unsigned flagsChanged = 0;
};

/// Read war `roomId`'s sides, its bindings and its live reservations, plan,
/// and apply — through `WarDirector::SetSideSlotCap` and
/// `SetSideIncentivised`, which stay the only writers of those two columns.
///
/// `limits.spawnedSlotCap` is filled from the `wars` row when the caller
/// leaves it 0, so the common call site does not have to load the war twice.
WarMaintenanceResult MaintainWarSides(sqlite3* db, uint32_t roomId,
                                      WarSizingLimits limits, int64_t now);
