// WarTheatrePool — §3's three sources of a war's theatre, and the one of them
// that was missing.
//
// PLAN-metalstorm-wars.md §3, task 7. §3 names three ways a war gets its map:
//
//   * **Scenario-defined** — "a scenario file *is* a war template: it names the
//     map, factions, preset regions/objectives". Already true and already
//     wired: `ScenarioDiscovery` reads those fields, `applyRoomScenario`
//     applies them, and `WarDemandSeed`'s `TheatreOption` is that template
//     seen from the seeding side. Nothing here re-derives any of it.
//   * **Pool pick** — "choose from a pool of theatres … round-robin /
//     least-recently-used **to vary maps**". This was the missing one, and its
//     absence was invisible because the seeder LOOKED like it was choosing:
//     it broke ties on live-war count and then on map id, so a box with two
//     idle theatres seeded the alphabetically-first one every single time.
//     Variety was never a tie-break, it was the whole point.
//   * **Operator pick** — a war created explicitly. Also already there (Create
//     Game with a map and a scenario), with one hole that mattered more than
//     the pick itself: those wars had no `wars` row at all. See
//     `PlanWarFromRoom`.
//
// ── Why LRU and not a counter ─────────────────────────────────────────────
// Round-robin needs a cursor, which is state somebody has to store, migrate
// and keep consistent with a theatre list that changes when content ships.
// LRU needs no new state at all: `wars.theatre` and `wars.created_at` already
// record every war ever seeded, so "when was this map last used" is a GROUP BY
// over a table the Director already owns. A cursor and a pool that grew a map
// would also disagree — the cursor would point past it — which is the class of
// bug LRU cannot have, because it reads the world instead of remembering it.
//
// A never-seeded theatre sorts FIRST. That is what makes newly shipped content
// get its turn instead of waiting for every incumbent to age past it, and it
// is the property a counter-based round-robin gets only by accident.
#pragma once

#include <cstdint>
#include <string>

#include "WarDirector.h"

/// When a theatre was last used, for the pool's LRU rotation.
///
/// `0` means NEVER, and it is deliberately not "the epoch": `LessRecentlyUsed`
/// treats it as a distinct, winning case rather than as a very old timestamp,
/// so a never-seeded theatre cannot be edged out by a rounding argument about
/// clocks.
struct TheatreUse {
    int64_t lastSeededAt = 0;

    bool NeverUsed() const { return lastSeededAt <= 0; }
};

/// Strict "a should be picked before b" on the pool's variety rule alone.
/// Never-used first; otherwise the older stamp. Equal stamps are NOT ordered
/// here — the caller's remaining tie-breaks decide, which is what keeps this
/// a rule about variety and not a full ordering pretending to be one.
inline bool LessRecentlyUsed(const TheatreUse& a, const TheatreUse& b) {
    if (a.NeverUsed() != b.NeverUsed())
        return a.NeverUsed();
    return a.lastSeededAt < b.lastSeededAt;
}

inline bool SameRecency(const TheatreUse& a, const TheatreUse& b) {
    return a.NeverUsed() == b.NeverUsed() &&
           (a.NeverUsed() || a.lastSeededAt == b.lastSeededAt);
}

// ── §3's third source: the operator pick, and the hole underneath it ───────
//
// A war created the way a *player* or an operator creates one — Create Game,
// map, scenario, session kind PersistentWar — has always worked as a war. What
// it did not have was a `wars` ROW: `WarDirector::Register` was called from
// exactly one place, the demand seeder. Every consequence of that is invisible
// until something tries to use the Director's table as the population of live
// wars, and then all of them arrive at once:
//
//   * the §7 lifecycle sweep iterates `ListLive`, so an operator-created war
//     could never wind down, resolve or archive, however decisively its
//     victory objective resolved;
//   * `WarsFielding` — the brake that makes demand seeding self-limiting by
//     dividing a faction's population by the wars already fielding it —
//     counted none of them, so a box full of hand-made wars would keep
//     seeding new ones at full size;
//   * §5's "freshest" tie-break had no creation stamp to read.
//
// So the Director adopts them. `PlanWarFromRoom` builds the plan from the
// room's OWN facts — the `war_sides`/`war_side_capacities` modoptions the
// scenario produced — rather than re-running `PlanWarSeed`, for the same
// reason `ReconcileSeededSides` exists: the scenario is the authority on which
// team a side sits on and how wide it is, and a second sizing pass here would
// disagree with the process that is already running.

/// Build a `WarSeedPlan` describing a war that ALREADY EXISTS, so the Director
/// can register a row for it.
///
/// Not a sizing decision — a transcription. Every field comes from what the
/// room was actually launched with. `ok == false` (with `error` set) for a room
/// that declares fewer than two sides, which is a skirmish wearing a war's
/// session kind and is not something the Director should take responsibility
/// for.
inline WarSeedPlan PlanWarFromRoom(const std::string& name,
                                   const std::string& mapId,
                                   const std::string& gameId,
                                   const std::string& scenarioId,
                                   const WarSides& sides,
                                   const WarSideCapacities& capacities,
                                   WarOrigin origin) {
    WarSeedPlan plan;
    if (sides.size() < 2) {
        plan.error = "a war needs at least two sides";
        return plan;
    }
    plan.ok       = true;
    plan.name     = name;
    plan.theatre  = mapId;
    plan.gameId   = gameId;
    plan.scenario = scenarioId;
    plan.origin   = origin;
    int box = 0;
    for (const auto& [faction, team] : sides) {
        WarSideSeed s;
        s.factionId = faction;
        s.team      = team;
        s.startBox  = box++;
        s.slotCap   = CapacityForSideIn(capacities, faction,
                                        WAR_SIDE_CAPACITY_DEFAULT);
        // A war with nobody in it has no underdog; §4's maintenance sweep sets
        // this from the bound population once there is one.
        s.incentivised = false;
        plan.sides.push_back(std::move(s));
    }
    return plan;
}
