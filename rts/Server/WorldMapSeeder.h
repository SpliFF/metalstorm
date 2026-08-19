// WorldMapSeeder — PLAN-worldsim.md W3: gives each shipped battle map a real
// Earth location and a post-collapse name, and grows the POI graph from
// that curated list as the world ages.
//
// This is deliberately NOT part of WorldDirector: WorldDirector is the
// generic store (any POI, any edge); this file is the one piece of content
// — the "Randtown register" — that says WHICH real-world places this build's
// maps and world-only regions correspond to, and in what order a sparse
// world fills them in. Everything it writes goes through WorldDirector's
// UpsertPoi/UpsertEdge, so it inherits their idempotency and their refusal
// to touch sim state.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "WorldDirector.h"

struct sqlite3;

class WorldMapSeeder {
public:
    /// One entry in the Randtown register: a real Earth location, its
    /// post-collapse name, and (optionally) the shipped battle map based
    /// around it. `mapId` empty means a world-only POI — "not all regions
    /// will be visitable" (PLAN-metalstorm-worldbuilding.md Capture 10), and
    /// the register carries a couple of these to prove the seeder can place
    /// a POI with no battle map at all.
    struct Entry {
        std::string poiId;
        std::string name;
        double lat;
        double lon;
        std::string mapId;
        std::vector<std::string> tags;
    };

    /// The curated list, in seed priority order: entries earlier in the list
    /// are placed first when the world's POI budget is small (a sparse young
    /// world), and battle-map POIs are ordered ahead of world-only ones so a
    /// tight budget always buys somewhere playable before it buys flavour.
    static const std::vector<Entry>& Registry();

    /// How many POIs `worldId` should have right now, per Capture 10 ("POI
    /// count scales dynamically with world age / player count"): the world's
    /// own `WorldDefaults` (from `worlds.config_json`) is the only source of
    /// the rate — this function does no more than the arithmetic the header
    /// comment on `WorldDefaults` promises. `worldAgeMs` and
    /// `registeredPlayers` are both clamped to >= 0 before use.
    static int ComputePoiBudget(const WorldDefaults& cfg, int64_t worldAgeMs,
                                int registeredPlayers);

    /// Great-circle distance between two lat/lon points, in kilometres
    /// (haversine, mean Earth radius). Pure, exposed for tests: it is the
    /// one piece of arithmetic PLAN-worldsim.md's edge-weight rule depends
    /// on ("weight = world-hours from great-circle distance × a per-world
    /// rate").
    static double GreatCircleKm(double lat1, double lon1, double lat2, double lon2);

    /// Seed `worldId` from the register: add registry POIs (in order, most
    /// battle-map ones first) until the world's POI budget is met or the
    /// register is exhausted, then connect every POI the world now has with
    /// a minimum-spanning-tree of transit edges weighted by great-circle
    /// distance x `transitWorldMsPerKm`.
    ///
    /// Idempotent and additive only: an existing POI or edge is never
    /// removed or renamed, and a world with more POIs than the current
    /// budget allows is left alone (the budget is a floor on growth, not a
    /// cap enforced by deletion). Safe to call on every lobby boot.
    ///
    /// `registeredPlayers` feeds `poiPerRegisteredPlayer`; pass 0 if the
    /// caller has no player count yet (a fresh world has none anyway).
    /// Returns the number of NEW POI rows written.
    static int SeedFromRegistry(sqlite3* db, const std::string& worldId,
                                int64_t nowRealMs, int registeredPlayers = 0);
};
