#include "WorldMapSeeder.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include <sqlite3.h>

namespace {

constexpr double kEarthRadiusKm = 6371.0;
constexpr double kPi = 3.14159265358979323846;

double ToRadians(double deg) { return deg * kPi / 180.0; }

/// Merge a world's stored tunables blob over the compiled-in defaults: a key
/// the row doesn't carry (an older world, or one seeded before a knob
/// existed) falls back to the default rather than to zero.
WorldDefaults MergeDefaults(const nlohmann::json& config) {
    WorldDefaults d;
    if (!config.is_object()) return d;
    d.poiBudgetInitial       = config.value("poiBudgetInitial", d.poiBudgetInitial);
    d.poiBudgetMax           = config.value("poiBudgetMax", d.poiBudgetMax);
    d.poiPerWorldAgeDay      = config.value("poiPerWorldAgeDay", d.poiPerWorldAgeDay);
    d.poiPerRegisteredPlayer = config.value("poiPerRegisteredPlayer", d.poiPerRegisteredPlayer);
    d.transitWorldMsPerKm    = config.value("transitWorldMsPerKm", d.transitWorldMsPerKm);
    return d;
}

}  // namespace

const std::vector<WorldMapSeeder::Entry>& WorldMapSeeder::Registry() {
    // Real Earth locations, renamed for the post-collapse setting — the
    // "Randtown register" PLAN-worldsim.md W3 asks for. "randtown" /
    // "osprey_fen" at these exact coordinates are already load-bearing:
    // tests/test_world_director.cpp's W1 route-body test constructs those
    // two rows by hand as its worked example, so this registry reuses them
    // verbatim rather than mint a second "Randtown" that disagrees with it.
    static const std::vector<Entry> kRegistry = {
        // Battle-map POIs first: a budget-constrained young world should
        // always buy somewhere playable before it buys flavour.
        {"randtown", "Randtown", 51.5, -0.12, "meridian_basin", {"coastal", "ridge", "fords"}},
        {"driftreach", "Driftreach", 68.2, 14.6, "skerry_reach", {"archipelago", "coastal"}},
        {"cinderfall", "Cinderfall", 52.0, -176.0, "sundered_arc", {"volcanic", "island"}},
        // World-only regions: no battle map, legal per Capture 10 ("not all
        // regions will be visitable"). Placed last so they never crowd out a
        // playable POI under a tight budget.
        {"osprey_fen", "Osprey Fen", 52.6, 0.4, "", {"wetland", "world-only"}},
        {"verge_hollow", "Verge Hollow", 63.85, -22.6, "", {"frontier", "world-only"}},
    };
    return kRegistry;
}

double WorldMapSeeder::GreatCircleKm(double lat1, double lon1, double lat2, double lon2) {
    const double dLat = ToRadians(lat2 - lat1);
    const double dLon = ToRadians(lon2 - lon1);
    const double a = std::sin(dLat / 2) * std::sin(dLat / 2) +
                     std::cos(ToRadians(lat1)) * std::cos(ToRadians(lat2)) *
                         std::sin(dLon / 2) * std::sin(dLon / 2);
    const double c = 2 * std::atan2(std::sqrt(a), std::sqrt(std::max(0.0, 1 - a)));
    return kEarthRadiusKm * c;
}

int WorldMapSeeder::ComputePoiBudget(const WorldDefaults& cfg, int64_t worldAgeMs,
                                     int registeredPlayers) {
    const double ageDays = static_cast<double>(std::max<int64_t>(worldAgeMs, 0)) /
                           (24.0 * 60.0 * 60.0 * 1000.0);
    const double players = static_cast<double>(std::max(registeredPlayers, 0));
    const double raw = cfg.poiBudgetInitial +
                       ageDays * cfg.poiPerWorldAgeDay +
                       players * cfg.poiPerRegisteredPlayer;
    int budget = static_cast<int>(std::floor(raw));
    // The initial count is a floor, never a ceiling reached by rounding down
    // past it, and the max is the operator's hard cap on concurrent battles
    // (Capture 10) regardless of how old or populous the world gets.
    budget = std::max(budget, cfg.poiBudgetInitial);
    budget = std::min(budget, cfg.poiBudgetMax);
    return budget;
}

int WorldMapSeeder::SeedFromRegistry(sqlite3* db, const std::string& worldId,
                                     int64_t nowRealMs, int registeredPlayers) {
    if (!db || worldId.empty()) return 0;
    const auto world = WorldDirector::Load(db, worldId);
    if (!world) return 0;

    const WorldDefaults cfg = MergeDefaults(world->config);
    const int64_t ageMs = nowRealMs - world->createdAt;
    const int budget = ComputePoiBudget(cfg, ageMs, registeredPlayers);

    std::vector<WorldPoiRecord> pois = WorldDirector::PoisFor(db, worldId);
    int newlyAdded = 0;

    for (const Entry& e : Registry()) {
        if (static_cast<int>(pois.size()) >= budget) break;
        const bool present = std::any_of(pois.begin(), pois.end(),
            [&](const WorldPoiRecord& p) { return p.poiId == e.poiId; });
        if (present) continue;

        WorldPoiRecord rec;
        rec.worldId   = worldId;
        rec.poiId     = e.poiId;
        rec.name      = e.name;
        rec.lat       = e.lat;
        rec.lon       = e.lon;
        rec.kind      = e.mapId.empty() ? "region" : "battleground";
        rec.mapId     = e.mapId;
        rec.tags      = e.tags;
        rec.createdAt = nowRealMs;
        if (!WorldDirector::UpsertPoi(db, rec)) continue;
        pois.push_back(rec);
        ++newlyAdded;
    }

    // Connect whatever the world now has (existing rows included — a world
    // seeded incrementally across several boots must still end up fully
    // connected) with a minimum spanning tree over great-circle distance: the
    // graph needs to be traversable, not complete, and an MST is the fewest
    // edges that guarantees every POI can reach every other one.
    if (pois.size() >= 2) {
        std::vector<bool> inTree(pois.size(), false);
        std::vector<double> bestDistKm(pois.size(), std::numeric_limits<double>::infinity());
        std::vector<int> bestFrom(pois.size(), -1);
        bestDistKm[0] = 0.0;

        for (size_t iter = 0; iter < pois.size(); ++iter) {
            int u = -1;
            double best = std::numeric_limits<double>::infinity();
            for (size_t i = 0; i < pois.size(); ++i) {
                if (!inTree[i] && bestDistKm[i] < best) {
                    best = bestDistKm[i];
                    u = static_cast<int>(i);
                }
            }
            if (u < 0) break;
            inTree[u] = true;
            if (bestFrom[u] >= 0) {
                const double km = GreatCircleKm(pois[u].lat, pois[u].lon,
                                                pois[bestFrom[u]].lat, pois[bestFrom[u]].lon);
                WorldPoiEdgeRecord edge;
                edge.worldId        = worldId;
                edge.fromPoi        = pois[bestFrom[u]].poiId;
                edge.toPoi          = pois[u].poiId;
                edge.transitWorldMs = static_cast<int64_t>(std::llround(km * cfg.transitWorldMsPerKm));
                edge.kind           = "transit";
                edge.bidirectional  = true;
                WorldDirector::UpsertEdge(db, edge);
            }
            for (size_t v = 0; v < pois.size(); ++v) {
                if (inTree[v]) continue;
                const double km = GreatCircleKm(pois[u].lat, pois[u].lon, pois[v].lat, pois[v].lon);
                if (km < bestDistKm[v]) {
                    bestDistKm[v] = km;
                    bestFrom[v] = u;
                }
            }
        }
    }

    return newlyAdded;
}
