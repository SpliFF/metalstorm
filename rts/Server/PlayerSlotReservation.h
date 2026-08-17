// PlayerSlotReservation — how many human player slots does this process exist
// for, and which side does each one belong to?
//
// PLAN-metalstorm-wars.md §8.1, task 5. The keystone of lobby §2.1's dynamic
// join: the War Director knows every side's `slotCap` when it seeds a war, so
// the game server can be *sized for the war* instead of for the roster it
// happened to boot with.
//
// ── Why sizing is a real thing here and not bookkeeping ──
// `CPlayerHandler::players` is capacity-pinned to MAX_PLAYERS and nothing ever
// erases from it (PLAN-long-uptime S12): a row is minted per *account* and
// kept for the process's life. Every consumer of a player number draws from
// the same monotone counter — roster players, AI virtual players, and
// spectators alike — and a war admits spectators without limit by design
// (PLAN-metalstorm-onboarding.md §4). So a war advertising eight side seats
// could, with nothing else changed, find no player number left for its eighth
// fighter because two hundred people came to watch. Reserving the block up
// front is what makes the lobby's advertised seat a seat the game server can
// actually hand over.
//
// Everything here is a pure function of values — no sim, no database, no
// server — for the same reason DynamicJoin.h is: the lobby computes Σ slotCap
// with it at spawn time and the game server lays the block out with it at boot,
// and those two numbers agreeing is the whole contract.
#pragma once

#include <cstddef>
#include <vector>

#include "WarSides.h"

namespace playerslots {

/// Σ slotCap across a war's sides — the number of human player slots the game
/// server must be spawned with (`--player-slots`, `wars.spawned_slot_cap`).
///
/// Returns 0 for "cannot be known", which every consumer reads as *do not
/// pre-allocate* rather than as *no limit* — the same 0-means-UNKNOWN reading
/// `WarSideMaintenance`'s ceiling uses, and for the same reason: a slot block
/// sized from a guess is a promise the server cannot keep. Two inputs produce
/// it: a war with no sides at all (a legacy room, a skirmish), and a side
/// declared `WAR_SIDE_CAPACITY_UNLIMITED` — an unlimited side has no finite
/// block, so the war falls back to today's grow-on-demand behaviour.
///
/// @param sides            the war's sides, in declaration order
/// @param caps             per-side capacities (`war_side_capacities`)
/// @param fallbackPerSide  capacity for a side `caps` does not size
inline unsigned TotalSlotCap(const WarSides& sides,
                             const WarSideCapacities& caps,
                             unsigned fallbackPerSide) {
    if (sides.empty())
        return 0;
    unsigned total = 0;
    for (const auto& [faction, team] : sides) {
        (void)team;
        const unsigned cap = CapacityForSideIn(caps, faction, fallbackPerSide);
        if (cap == WAR_SIDE_CAPACITY_UNLIMITED)
            return 0;
        total += cap;
    }
    return total;
}

/// The block, laid out: one entry per reserved player number.
struct ReservedPlayerSlots {
    /// `teamOfSlot[n]` is the team player number `n` is reserved for, or -1 for
    /// a slot reserved without a side (see `PlanReservedSlots` for when those
    /// appear). Index IS the player number: the block always starts at 0, so
    /// the sim's low numbers belong to the war's fighters and everything that
    /// arrives later — AI virtual players, spectators — is numbered above it.
    std::vector<int> teamOfSlot;

    unsigned Size() const { return static_cast<unsigned>(teamOfSlot.size()); }
    bool Empty() const { return teamOfSlot.empty(); }

    bool Reserved(int playerNum) const {
        return playerNum >= 0 &&
               static_cast<size_t>(playerNum) < teamOfSlot.size();
    }
    /// The team a reserved number belongs to; -1 for an unassigned slot AND
    /// for a number outside the block, so a caller that forgets to check
    /// `Reserved` reads "no side" rather than team 0.
    int TeamOf(int playerNum) const {
        return Reserved(playerNum) ? teamOfSlot[static_cast<size_t>(playerNum)]
                                   : -1;
    }
    /// How many of the block's slots are reserved for one team.
    unsigned CountFor(int team) const {
        unsigned n = 0;
        for (int t : teamOfSlot)
            if (t == team)
                ++n;
        return n;
    }
};

/// Lay `totalSlots` player numbers out across the war's sides.
///
/// Sides take contiguous sub-blocks in declaration order, each as wide as its
/// own capacity — so a two-faction war at slotCap 2 lays out `[a, a, b, b]` and
/// the third arrival on side `a` is refused a seat by the capacity rule rather
/// than by silently eating side `b`'s block.
///
/// `totalSlots` is passed separately from the capacities rather than re-derived
/// from them because it is the number the *process was actually spawned with*
/// (§8.1: `wars.spawned_slot_cap`, deliberately distinct from the live per-side
/// caps, which task 2's maintenance pass may raise after boot). The two
/// disagreeing is therefore expected over a war's life, and each direction has
/// one honest reading:
///   * caps wider than the block — the sides were raised past what this process
///     was sized for. The layout is TRUNCATED to the block: a seat there is no
///     player number for is a promise broken at the game server, after the
///     lobby already made it, and truncating breaks it at boot instead where a
///     log line can say so.
///   * caps narrower than the block — trailing slots belong to no side (-1).
///     They stay claimable by any playing seat rather than being dropped: they
///     were paid for at spawn, and a war whose sides shrank should not hand
///     their numbers to spectators.
inline ReservedPlayerSlots PlanReservedSlots(unsigned totalSlots,
                                             const WarSides& sides,
                                             const WarSideCapacities& caps,
                                             unsigned fallbackPerSide) {
    ReservedPlayerSlots out;
    if (totalSlots == 0)
        return out;
    out.teamOfSlot.assign(totalSlots, -1);
    size_t next = 0;
    for (const auto& [faction, team] : sides) {
        if (next >= out.teamOfSlot.size())
            break;
        unsigned cap = CapacityForSideIn(caps, faction, fallbackPerSide);
        // An unlimited side cannot be given the rest of the block — the next
        // side would get nothing. It takes its fallback's worth, which is the
        // only finite number in play, and the truncation rule handles the rest.
        if (cap == WAR_SIDE_CAPACITY_UNLIMITED)
            cap = fallbackPerSide;
        for (unsigned i = 0; i < cap && next < out.teamOfSlot.size(); ++i)
            out.teamOfSlot[next++] = static_cast<int>(team);
    }
    return out;
}

/// The player number a joiner seated on `team` should take.
///
/// The lowest free slot of their own side, else the lowest free unassigned
/// slot, else -1 for "no reserved slot — allocate past the block". `isFree`
/// answers "is this player number still an unclaimed stub?"; the caller owns
/// that question because the answer lives in the sim's player list, and keeping
/// it out here is what makes this testable without one.
///
/// Own-side first, unassigned second: an unassigned slot is a leftover that any
/// side may use, so spending one while the joiner's own block still has room
/// would starve a side that has no leftovers to fall back on.
template <typename FreeFn>
inline int ClaimReservedSlot(const ReservedPlayerSlots& slots, int team,
                             FreeFn isFree) {
    if (team < 0)
        return -1;
    int spare = -1;
    for (size_t i = 0; i < slots.teamOfSlot.size(); ++i) {
        const int n = static_cast<int>(i);
        if (!isFree(n))
            continue;
        if (slots.teamOfSlot[i] == team)
            return n;
        if (spare < 0 && slots.teamOfSlot[i] < 0)
            spare = n;
    }
    return spare;
}

}  // namespace playerslots
