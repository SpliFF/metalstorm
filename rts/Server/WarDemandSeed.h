// WarDemandSeed — the war that gets created because somebody had nowhere to
// fight.
//
// PLAN-metalstorm-wars.md §4 ("demand-driven seeding") and §5's last line,
// task 2. `WarDeploy.h` already answers *whether* this is needed: its `seed`
// outcome is exactly "every war that fields this faction is full". What it
// deliberately does not answer is WHICH war to create, and until something
// does, `seed` is a recommendation the player has to act on by hand — which is
// the state task 1 left it in.
//
// Two decisions, both pure, both here:
//
//   1. **who else is in it.** §4: "choosing a theatre where F's likely
//      opponents also have waiting players, so the new war fills". A war
//      seeded against a faction with nobody waiting is a war with one side in
//      it, and one side is not a war (`PlanWarSeed` refuses it outright).
//   2. **where it is fought.** A theatre is a map, and it has to be a map
//      whose authored content fields both factions — §7.6's rule that a war is
//      authored on a map its armies can cross is upstream of this, and the way
//      to honour it is to pick from the scenarios that already exist rather
//      than to pair a faction with a map and hope.
//
// ── The rule that makes this safe to run automatically ────────────────────
// Seeding is self-limiting *only* through `WarSeedPopulation::warsFielding`:
// the capacity rule divides a faction's population by the wars already
// fielding it, so the second war a faction gets has half-size sides and the
// fourth has quarter-size ones. Feed that field from
// `WarDirector::WarsFielding` — a JOIN over the live wars, not a counter — and
// a runaway seed loop cannot happen: each seeded war makes the next one
// smaller until `WAR_SEED_MIN_CAPACITY` is all that is left and a side of two
// fills from the queue that asked for it. Feed it a stale or hand-maintained
// number and that brake is gone, which is why this file takes the population
// as an argument and never counts anything itself.
#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "WarDirector.h"
#include "WarSides.h"
#include "WarTheatrePool.h"

/// What one faction's supply looks like right now, from the seeding side.
struct FactionDemand {
    std::string factionId;
    /// Registered accounts (`accounts.faction_id`) — the same count
    /// `SeedSideCapacities` sizes from.
    unsigned    registered = 0;
    /// Free seats for this faction across every live war: Σ over sides of
    /// `slot_cap - bound - reserved`. Zero is the condition §4 seeds on.
    unsigned    openSlots = 0;

    /// Players of this faction with nowhere to go. Deliberately a coarse
    /// measure — the lobby has no queue (WarDeploy.h's design call), so
    /// "waiting" is not a list anybody keeps and this is the closest honest
    /// stand-in: registered players minus the seats that exist for them.
    unsigned Waiting() const {
        return registered > openSlots ? registered - openSlots : 0u;
    }
};

/// Rank the factions a demand-seeded war should be fought against.
///
/// Ordering: most waiting players first (a war fills from both ends or it
/// fills from neither), then most registered, then faction id — so the same
/// lobby state always seeds the same war, which is what makes a seeded war
/// reproducible from its row.
///
/// The requesting faction is never among the opponents, and neither is a
/// faction with no registered players at all: seeding against a faction nobody
/// plays produces a war whose other side is a caretaker AI forever.
inline std::vector<std::string> ChooseDemandSeedOpponents(
    const std::string& factionId, const std::vector<FactionDemand>& supply,
    size_t maxOpponents = 1) {
    std::vector<const FactionDemand*> ranked;
    for (const auto& d : supply) {
        if (d.factionId.empty() || d.factionId == factionId)
            continue;
        if (d.registered == 0)
            continue;
        ranked.push_back(&d);
    }
    std::sort(ranked.begin(), ranked.end(),
              [](const FactionDemand* a, const FactionDemand* b) {
                  const unsigned wa = a->Waiting(), wb = b->Waiting();
                  if (wa != wb) return wa > wb;
                  if (a->registered != b->registered)
                      return a->registered > b->registered;
                  return a->factionId < b->factionId;
              });
    std::vector<std::string> out;
    for (const auto* d : ranked) {
        if (out.size() >= maxOpponents)
            break;
        out.push_back(d->factionId);
    }
    return out;
}

/// A candidate theatre: an authored scenario, the map it is authored for, and
/// the factions its sides declare.
struct TheatreOption {
    std::string mapId;
    std::string scenarioId;
    /// The factions this scenario's sides declare, in declaration order.
    std::vector<std::string> factions;
    /// Start positions the map publishes (`PlanWarSeed`'s refusal input).
    unsigned    startBoxCount = 0;
    /// Live wars already being fought here. A tie-break toward variety: two
    /// wars on one map is a smaller world than two maps with one each.
    unsigned    liveWars = 0;
    /// §3's pool rotation (task 7): when a war was last seeded here, or 0 for
    /// never. Derived from `wars.theatre`/`created_at`, so it needs no cursor
    /// and cannot go stale against a pool that grew a map.
    TheatreUse  use;

    bool Fields(const std::string& faction) const {
        return std::find(factions.begin(), factions.end(), faction) !=
               factions.end();
    }
};

/// Pick the theatre for a demand seed, or nullptr when no authored content
/// fields this faction against any of the ranked opponents.
///
/// Returning nullptr rather than inventing a pairing is the important half.
/// A map that does not declare a side for a faction has no start box, no
/// staged army and (§7.6) no guarantee its start positions can even reach each
/// other — so a war seeded onto one is a war that boots wrong, and the honest
/// answer to "nowhere to put this player" is to say so and leave `seed` a
/// recommendation, exactly as it was before.
///
/// Ordering among theatres that DO fit, in strict precedence:
///
///   1. the best-ranked opponent it can field — so the war seeds against the
///      faction with the longest queue;
///   2. fewest live wars — two wars on one map is a smaller world than two
///      maps with one each;
///   3. **least recently used** (§3's pool rotation, task 7), never-seeded
///      first. This is the key that was missing, and its absence was invisible
///      because the ordering LOOKED like a choice: with variety unrepresented,
///      a box with two idle theatres seeded the alphabetically-first one every
///      time, forever. Ranked below live-war count on purpose — spreading wars
///      across maps that are currently empty is a stronger claim on variety
///      than rotating onto a map that is already busy;
///   4. most start boxes, then map id, so the same lobby state always seeds
///      the same war and a seeded war is reproducible from its row.
///
/// Written as an explicit "is a better than b" rather than a chain of ||s on a
/// running best, because that chain is what let a candidate's third key be
/// compared against the incumbent's second.
inline const TheatreOption* ChooseDemandSeedTheatre(
    const std::vector<TheatreOption>& options, const std::string& factionId,
    const std::vector<std::string>& rankedOpponents) {
    auto opponentRank = [&](const TheatreOption& t) {
        for (size_t i = 0; i < rankedOpponents.size(); ++i)
            if (t.Fields(rankedOpponents[i]))
                return i;
        return rankedOpponents.size();
    };

    const TheatreOption* best = nullptr;
    size_t bestRank = rankedOpponents.size();
    for (const auto& t : options) {
        if (!t.Fields(factionId))
            continue;
        // The map must have room for the sides it declares, or `PlanWarSeed`
        // refuses the seed after we have already chosen it.
        if (t.startBoxCount > 0 && t.factions.size() > t.startBoxCount)
            continue;
        const size_t rank = opponentRank(t);
        if (rank == rankedOpponents.size())
            continue;  // fields nobody worth fighting

        bool better;
        if (best == nullptr) {
            better = true;
        } else if (rank != bestRank) {
            better = rank < bestRank;
        } else if (t.liveWars != best->liveWars) {
            better = t.liveWars < best->liveWars;
        } else if (!SameRecency(t.use, best->use)) {
            better = LessRecentlyUsed(t.use, best->use);
        } else if (t.startBoxCount != best->startBoxCount) {
            better = t.startBoxCount > best->startBoxCount;
        } else {
            better = t.mapId < best->mapId;
        }
        if (better) {
            best = &t;
            bestRank = rank;
        }
    }
    return best;
}

/// Rewrite a seed plan's sides from the room the boot actually produced.
///
/// **Why the plan does not simply win.** `PlanWarSeed` numbers its sides by
/// declaration order (side i → team i), which is the right answer for a war
/// with no authored content. A war seeded onto a scenario has authored
/// content, and the scenario is the authority on team NUMBERS because it is
/// what stages an army on them — Meridian Basin's compact side is teams 0–3
/// with its army on 0, and its union side is 4–7 with its army on 4 (§7.4).
/// Booting that scenario with the Director's `{0, 1}` would put the union's
/// whole army on a team nobody is seated on: the exact defect §7.4 was written
/// to fix, re-introduced from the other end.
///
/// So the boot path's `applyWarSides` stays the producer of the `war_sides`
/// modoption, and this reconciles the Director's row to what it produced. The
/// table remains the Director's durable authority over *which factions, how
/// big and whether incentivised*; the scenario keeps its authority over which
/// team a side sits on. An empty `roomSides` (a war booted with no scenario)
/// leaves the plan untouched — there is nothing to reconcile to.
inline WarSeedPlan ReconcileSeededSides(const WarSeedPlan& plan,
                                        const WarSides& roomSides,
                                        const WarSideCapacities& roomCaps) {
    if (!plan.ok || roomSides.empty())
        return plan;
    WarSeedPlan out = plan;
    out.sides.clear();
    out.sides.reserve(roomSides.size());
    int box = 0;
    for (const auto& [faction, team] : roomSides) {
        WarSideSeed s;
        s.factionId = faction;
        s.team      = team;
        s.startBox  = box++;
        // The room's capacity is the seeding rule's own output (applyWarSides
        // calls `SeedSideCapacities`) with the scenario's authored override on
        // top, so taking it here keeps the table and the modoption stating one
        // number — and preserves an author's deliberate side size, which
        // re-deriving would silently discard.
        s.slotCap = CapacityForSideIn(roomCaps, faction,
                                      WAR_SIDE_CAPACITY_DEFAULT);
        // A war with nobody in it has no underdog. Maintenance (§4, task 2's
        // flagging half) sets this from the bound population once there is
        // one.
        s.incentivised = false;
        out.sides.push_back(std::move(s));
    }
    return out;
}
