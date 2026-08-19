// WarSeeding — how big each side of a NEW war is.
//
// PLAN-metalstorm-lobby.md §6, task 7. §6's whole premise is that balance in
// this game cannot be done by moving players: a player always fights for their
// own faction (§1a), so "put the newcomer on the weaker side" is not available.
// Balance is therefore *structural* and is decided at exactly two moments —
// when a war is seeded, and when a player picks which war to join. This file is
// the first of those two.
//
// ── The rule ────────────────────────────────────────────────────────────────
// A side's capacity is the faction's registered population divided by the
// number of wars that will be fielding it once this one exists:
//
//     capacity(f) = clamp(ceil(registered(f) / (warsFielding(f) + 1)), MIN, MAX)
//
// The `+ 1` is this war, and it is what makes the rule self-limiting: seeding a
// second war for a faction halves the size of every side that faction fields,
// so a surplus faction gets *more wars* rather than one enormous one — which is
// §6's stated goal ("a faction with a player surplus spawns more wars/slots"),
// and also the only version that keeps an individual war winnable by the people
// in it.
//
// It is deliberately NOT symmetric. Sizing both sides to the *smaller*
// population is the obvious "fair" answer and it is wrong here: the surplus
// faction's extra players do not disappear, they queue — and a queue is the one
// outcome §6 names as the thing to avoid. An asymmetric war is a war where the
// outnumbered side is compensated by the underdog incentive (WarDeploy.h); an
// undersized war is a war half the population cannot enter at all.
//
// Pure function of numbers, like every other policy in this lane, so the whole
// rule is testable without a database, a lobby or a room.
#pragma once

#include <algorithm>
#include <string>
#include <unordered_map>

#include "WarSides.h"

/// Smallest side a seeded war will ever declare. A side of one human is not a
/// side — the first person to log off ends the war for everybody on it — and
/// the floor costs nothing, because capacity is a ceiling on joiners and not a
/// promise to fill it.
inline constexpr unsigned WAR_SEED_MIN_CAPACITY = 2;

/// Largest side a seeded war will ever declare. Sized to be well clear of any
/// population this game has, so that in practice the ceiling only ever bites a
/// misconfigured deployment (or a test): a runaway registered count must not
/// silently produce a war advertising four thousand seats.
inline constexpr unsigned WAR_SEED_MAX_CAPACITY = 32;

/// Per-faction registered account counts (`accounts.faction_id`), and how many
/// existing wars already field each faction.
struct WarSeedPopulation {
    std::unordered_map<std::string, unsigned> registered;
    std::unordered_map<std::string, unsigned> warsFielding;

    unsigned RegisteredFor(const std::string& faction) const {
        const auto it = registered.find(faction);
        return it == registered.end() ? 0u : it->second;
    }
    unsigned WarsFieldingFor(const std::string& faction) const {
        const auto it = warsFielding.find(faction);
        return it == warsFielding.end() ? 0u : it->second;
    }
};

/// Size every side of a war being seeded.
///
/// Returns one entry per side in declaration order, so the encoded modoption
/// lists sides in the same order `war_sides` does and the two read together.
/// A faction with no registered players still gets `WAR_SEED_MIN_CAPACITY` —
/// a war seeded before anybody has signed up for that faction must still be
/// joinable by the first person who does.
inline WarSideCapacities SeedSideCapacities(const WarSides& sides,
                                            const WarSeedPopulation& pop) {
    WarSideCapacities out;
    out.reserve(sides.size());
    for (const auto& [faction, team] : sides) {
        (void)team;
        const unsigned registered = pop.RegisteredFor(faction);
        const unsigned wars = pop.WarsFieldingFor(faction) + 1u;
        // Integer ceiling — a faction of 9 across 2 wars wants 5-a-side, not 4,
        // or the last player of every odd population has nowhere to go.
        const unsigned share = (registered + wars - 1u) / wars;
        out.emplace_back(faction,
                         std::clamp(share, WAR_SEED_MIN_CAPACITY,
                                    WAR_SEED_MAX_CAPACITY));
    }
    return out;
}
