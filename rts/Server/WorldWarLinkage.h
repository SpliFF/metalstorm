// WorldWarLinkage — the READ-ONLY join between a POI's battle map and any
// live war playing on it.
//
// PLAN-worldsim.md W5: "POIs reference their battle map; active wars surface
// on the map at their POI (marker state: quiet / staging / active battle).
// Read-only: clicking through to the room uses existing lobby room UI. No
// write-back yet."
//
// ── Why this is not inside WorldDirector ────────────────────────────────────
// WorldDirector.h draws the boundary explicitly: "Nothing here reads, writes
// or extends a `war*` table, and no world column is keyed by a room." A war
// is keyed by `room_id`, a POI by `world_id`/`poi_id`; the only thing they
// share is a map id string, so the join belongs beside neither table's
// director — it is arithmetic on two already-loaded lists, same discipline as
// WarTermination.h: no sqlite, no room registry, no sim, pure and header-only
// so it tests without a socket or a lobby.
//
// The caller (a lobby_main.cpp route handler) is the one place that already
// holds both a RoomManager and a WarDirector handle; it builds the small
// `RoomBattleInfo` list (room id + map id + war state, one per LIVE war) and
// this file turns that into a per-POI status merged onto WorldPoisJson's
// output. Nothing here writes anything — it only reads two in-memory lists
// and returns a new json value.

#pragma once

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "WarDirector.h"

/// One live war's room + the map it is being fought on, as the caller
/// assembled it from `WarDirector::ListLive` (state) joined against
/// `RoomManager::GetRoom` (map id) — the only two facts this file needs, and
/// exactly what a route handler already has in scope.
struct RoomBattleInfo {
    uint32_t    roomId = 0;
    std::string mapId;
    WarState    state = WarState::Seeding;
};

/// The three marker states PLAN-worldsim.md W5 asks for. A POI with no
/// battle map is always Quiet — the world layer never invents a battle for a
/// world-only region.
enum class BattleStatus : uint8_t { Quiet, Staging, Active };

inline const char *BattleStatusToString(BattleStatus s) {
    switch (s) {
        case BattleStatus::Quiet:   return "quiet";
        case BattleStatus::Staging: return "staging";
        case BattleStatus::Active:  return "active";
    }
    return "quiet";
}

/// A war that has been seeded but has not yet gone Active is "staging" (§4.5:
/// players are gathering); a war actively fighting through its winddown is
/// still the live battle a POI should show as "active" — the marker is about
/// whether a player who clicks through finds a fight, not the Director's
/// internal state name. Archived wars never appear here at all (ListLive
/// excludes them), so there is no Archived case to map.
inline BattleStatus BattleStatusForWarState(WarState s) {
    switch (s) {
        case WarState::Seeding:
        case WarState::Open:        return BattleStatus::Staging;
        case WarState::Active:
        case WarState::WindingDown:
        case WarState::Resolving:   return BattleStatus::Active;
        case WarState::Archived:    return BattleStatus::Quiet;
    }
    return BattleStatus::Quiet;
}

/// Merge battle status onto `poisJson` (the object `WorldDirector::
/// WorldPoisJson` returns — a `{"worldId":..., "pois":[...], "edges":[...]}`
/// object). Every POI gains `battleStatus` ("quiet"/"staging"/"active") and
/// `warRoomId` (the live war's room id, or null). A map id can in principle
/// carry more than one live war (a rehost while an old one is winding down);
/// the higher-ranked status wins, and its room is the one surfaced — Active
/// outranks Staging so a player is never pointed at a war that already ended
/// staging while another on the same map is mid-fight.
inline nlohmann::json AttachBattleStatus(nlohmann::json poisJson,
                                         const std::vector<RoomBattleInfo> &battles) {
    if (!poisJson.contains("pois") || !poisJson["pois"].is_array())
        return poisJson;

    for (auto &poi : poisJson["pois"]) {
        BattleStatus best = BattleStatus::Quiet;
        uint32_t bestRoomId = 0;
        bool haveMatch = false;

        if (poi.contains("mapId") && poi["mapId"].is_string()) {
            const std::string mapId = poi["mapId"].get<std::string>();
            for (const auto &b : battles) {
                if (b.mapId != mapId) continue;
                const BattleStatus s = BattleStatusForWarState(b.state);
                if (!haveMatch || s > best) {
                    best = s;
                    bestRoomId = b.roomId;
                    haveMatch = true;
                }
            }
        }

        poi["battleStatus"] = BattleStatusToString(best);
        if (haveMatch) poi["warRoomId"] = bestRoomId;
        else           poi["warRoomId"] = nullptr;
    }

    return poisJson;
}
